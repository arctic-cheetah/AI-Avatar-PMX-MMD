"""Compare legacy summary and direct narration to first audio-ready event (#56).

Uses an isolated Stage, never the live avatar socket. Full mode runs the real
speech pipeline; --source-only measures Kokoro WAV readiness without RVC,
alignment, renderer transport or playback. --summary-delay replaces the LLM
with an explicitly simulated delay and identical narration for paired trials.
"""

import asyncio
import json
import math
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from controller import bridge
from controller.agent import AgentRouter, Stage
from controller.speech import ApplioWorker

NARRATION = "[happy] The tests pass and the report is ready."
REPORT = "# Validation\n\nThe tests pass and the report is ready."


async def measure(args):
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    settings = bridge.speech_settings(args)
    parent = ApplioWorker(settings, log_path=output / "applio-worker.log")
    worker = parent.kokoro if args.source_only else parent
    if args.source_only and worker is None:
        raise ValueError("--source-only requires --tts kokoro")
    if not args.source_only:
        settings.check()
    # Keep the benchmark's source worker log alongside its clips.
    if parent.kokoro is not None:
        parent.kokoro.log_path = output / "kokoro-worker.log"

    config = None
    if args.summary_delay is None:
        config = bridge.resolve_llm_config(
            args.llama_url, args.model, args.api_key_env, args.llm_header,
            allow_no_key=args.allow_no_key,
        )

    trials = []
    clip_number = 0

    async def source_speech(queue, send, worker, run=None, turn=None):
        nonlocal clip_number
        while (segment := await queue.get()) is not None:
            clip_number += 1
            path = output / f"source-{clip_number}.wav"
            await worker.request(segment.text, path, path, run)
            if not path.is_file() or path.stat().st_size <= 44:
                raise RuntimeError("Kokoro did not produce audio")
            await send({"type": "speak", "text": segment.text})

    try:
        # Load and warm once outside the timed trials, with a bounded startup.
        ready = await asyncio.wait_for(worker.start(), args.timeout)
        with patch("controller.agent.speak_segments",
                   source_speech if args.source_only else bridge.speak_segments):
            for sample in range(args.samples):
                # Alternate ordering to reduce warm/cache ordering bias.
                order = (False, True) if sample % 2 == 0 else (True, False)
                for direct in order:
                    first_audio = asyncio.get_running_loop().create_future()
                    llm_calls = 0
                    started = time.perf_counter()

                    async def send(event):
                        if event["type"] == "speak" and not first_audio.done():
                            first_audio.set_result(time.perf_counter() - started)

                    async def llm(messages, on_reasoning=None):
                        nonlocal llm_calls
                        llm_calls += 1
                        if args.summary_delay is not None:
                            await asyncio.sleep(args.summary_delay)
                            yield NARRATION
                        else:
                            async for chunk in bridge.llama_chunks(
                                args.llama_url, args.model, messages, on_reasoning,
                                headers=config.headers,
                            ):
                                yield chunk

                    stage = Stage(send, worker, bridge.load_catalog(), llm)
                    router = AgentRouter(stage.catalog)
                    router.attach(stage)
                    try:
                        request = {"tool": "report", "text": REPORT}
                        if direct:
                            request["spoken_text"] = NARRATION
                        started = time.perf_counter()
                        result = await router.handle(request)
                        if result != "queued":
                            raise RuntimeError(result)
                        seconds = await asyncio.wait_for(first_audio, args.timeout)
                        # Let the lane finish before reusing the warm worker.
                        while stage.pending:
                            await asyncio.sleep(0.01)
                        if direct and llm_calls:
                            raise RuntimeError("Direct narration called the LLM")
                        trials.append({"mode": "direct" if direct else "summary",
                                       "seconds": round(seconds, 4), "llmCalls": llm_calls})
                    finally:
                        await stage.close()
        result = {
            "metric": "report acceptance to first audio-ready event (not audible playback)",
            "pipeline": "Kokoro source only" if args.source_only else "TTS + RVC + alignment",
            "summary": ("real upstream" if args.summary_delay is None else
                        f"simulated {args.summary_delay}s delay, identical narration"),
            "worker": ready,
            "trials": trials,
            "medianSeconds": {
                mode: round(statistics.median(t["seconds"] for t in trials if t["mode"] == mode), 4)
                for mode in ("summary", "direct")
            },
        }
        (output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
    finally:
        await worker.close()


def main():
    parser = bridge.build_parser()
    parser.description = __doc__
    parser.set_defaults(tts="kokoro")
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--source-only", action="store_true")
    parser.add_argument("--summary-delay", type=float, default=None,
                        help="Simulate this many seconds of summary latency instead of calling an LLM.")
    parser.add_argument("--output", type=Path, default=ROOT / "assets/private/speech/56/latency")
    args = parser.parse_args()
    if args.samples < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("samples and timeout must be positive")
    if args.summary_delay is not None and (not math.isfinite(args.summary_delay) or args.summary_delay < 0):
        parser.error("summary delay must be finite and nonnegative")
    asyncio.run(measure(args))


if __name__ == "__main__":
    main()
