"""Measure RVC on this machine the way the bridge runs it (#111).

    .venv/bin/python -m controller.rvc_check --applio-dir ../Applio-rocm --rvc-device gpu

Starts the bridge's own Applio worker (no Kokoro, no LLM), times the spool-up
from launch to ready, then converts one real speech clip ``--runs`` times and
prints a JSON summary: the device and backend actually used, spool-up, load and
warm-up seconds, conversion times and the real-time factor. Run it once per
``--rvc-device`` and compare; listen to ``--output`` as well.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import statistics
import tempfile
import time
import wave
from pathlib import Path

from controller.speech import ApplioSettings, ApplioWorker

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "assets/private/speech/sample-01.wav"


def summarise(ready: dict, spool_seconds: float, clip_seconds: float, rvc_seconds: list[float]) -> dict:
    """One JSON-ready summary of a check run."""
    median = statistics.median(rvc_seconds)
    return {
        "device": ready.get("device"),
        "spoolSeconds": round(spool_seconds, 2),
        "loadSeconds": ready.get("loadSeconds"),
        "warmSeconds": ready.get("warmSeconds"),
        "clipSeconds": round(clip_seconds, 2),
        "runs": len(rvc_seconds),
        "rvcMedian": round(median, 2),
        "rvcMin": round(min(rvc_seconds), 2),
        "rvcMax": round(max(rvc_seconds), 2),
        "rtf": round(median / clip_seconds, 3),
    }


def check_worker(settings: ApplioSettings) -> ApplioWorker:
    """An Applio worker that converts an existing source WAV: no Edge, no Kokoro worker."""
    settings.tts_provider = "kokoro"  # the Applio worker then takes ``source`` as it is
    return ApplioWorker(settings, command=ApplioWorker.applio_command(settings))


def clip_length(path: Path) -> float:
    with wave.open(str(path), "rb") as clip:
        return clip.getnframes() / clip.getframerate()


async def run(settings: ApplioSettings, source: Path, runs: int, output: Path | None) -> dict:
    worker = check_worker(settings)
    started = time.perf_counter()
    try:
        ready = await worker.start()
        spool = time.perf_counter() - started
        seconds = []
        with tempfile.TemporaryDirectory() as scratch:
            converted = Path(scratch) / "converted.wav"
            for _ in range(runs):
                reply = await worker.request("rvc check", source, converted)
                if not reply.get("ok"):
                    raise RuntimeError(f"conversion failed: {reply.get('error')}")
                seconds.append(float(reply["rvcSeconds"]))
            if output is not None:
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(converted, output)
    finally:
        await worker.close()
    return summarise(ready, spool, clip_length(source), seconds)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--applio-dir", type=Path, default=ApplioSettings().applio_dir)
    parser.add_argument("--rvc-device", choices=("auto", "gpu", "cpu"), default="auto")
    parser.add_argument("--rvc-threads", type=int, default=0)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Speech WAV to convert.")
    parser.add_argument("--runs", type=int, default=3, help="Timed conversions after warm-up.")
    parser.add_argument("--output", type=Path, help="Keep the last converted WAV here to listen to.")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    source = args.source.expanduser().resolve()
    if not source.is_file():
        parser.error(f"source WAV not found: {source}")
    settings = ApplioSettings(
        applio_dir=args.applio_dir.expanduser().resolve(),
        rvc_device=args.rvc_device,
        rvc_threads=args.rvc_threads,
    )
    settings.check()
    try:
        summary = asyncio.run(run(settings, source, args.runs, args.output))
    except RuntimeError as error:
        parser.exit(1, f"rvc_check: {error}\n")
    print(json.dumps({"applioDir": str(settings.applio_dir), "requested": args.rvc_device,
                      "source": str(source), **summary}, indent=2))


if __name__ == "__main__":
    main()
