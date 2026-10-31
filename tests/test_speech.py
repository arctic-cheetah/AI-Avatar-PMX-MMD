import asyncio
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from controller.bridge import ORIGIN, TagParser, handle_connection, load_catalog
from controller.speech import ApplioSettings, ApplioWorker, Segment, Segmenter, clean_for_tts


def segments(chunks):
    parser, segmenter = TagParser(load_catalog()), Segmenter()
    out = [
        s for c in chunks for e in parser.feed(c) for s in segmenter.feed(e)
    ] + segmenter.finish()
    return [(s.text, s.expression, s.weight) for s in out]


class SegmenterTests(unittest.TestCase):
    def test_sentences_and_moods(self):
        self.assertEqual(
            segments(
                [
                    "[soft-smile:0.6] Good morning. How are",
                    " you? [thinking:0.5]Let me think",
                    " about that.",
                ]
            ),
            [
                ("Good morning.", "soft-smile", 0.6),
                ("How are you?", "soft-smile", 0.6),
                ("Let me think about that.", "thinking", 0.5),
            ],
        )

    def test_mood_tag_mid_sentence_splits(self):
        self.assertEqual(
            segments(["Well [happy]that is great!"]),
            [("Well", "neutral", 1.0), ("that is great!", "happy", 1.0)],
        )

    def test_unspeakable_fragments_dropped(self):
        self.assertEqual(
            segments(["🌸 ", "[happy] ... ", "**Hi** there"]),
            [("Hi there", "happy", 1.0)],
        )

    def test_clean_for_tts(self):
        self.assertEqual(
            clean_for_tts("  **Bold** `code` 💕 ✨\n# Title  "), "Bold code Title"
        )
        self.assertEqual(clean_for_tts("-- --pth-path=evil"), "pth-path=evil")


class ApplioSettingsTests(unittest.TestCase):
    def test_applio_dir_selects_matching_model_and_index(self):
        root = Path("/tmp/Applio-rocm")
        settings = ApplioSettings(applio_dir=root)
        self.assertEqual(
            settings.pth, root / "logs/Yidhari-zzz/Yidhari-zzz_75e_21450s.pth"
        )
        self.assertEqual(settings.index, root / "logs/Yidhari-zzz/Yidhari-zzz.index")
        config = settings.worker_config()
        self.assertEqual(config["pth"], str(settings.pth))
        self.assertEqual(config["index"], str(settings.index))

    def test_explicit_model_and_index_override_applio_dir(self):
        settings = ApplioSettings(
            applio_dir=Path("/tmp/Applio-rocm"),
            pth=Path("/tmp/custom.pth"),
            index=Path("/tmp/custom.index"),
        )
        self.assertEqual(settings.pth, Path("/tmp/custom.pth"))
        self.assertEqual(settings.index, Path("/tmp/custom.index"))


class SpeechBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_speak_events_in_order_without_early_moods(self):
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect

        async def fast_demo():
            yield "[soft-smile:0.6] Hello there. [thinking]Hmm, "
            yield "let me see."

        spoken = []

        async def fake_synthesise(segment, worker, run=None):
            spoken.append(segment.text)
            return f"{len(spoken):016x}", {}

        args = Namespace(mode="demo", speech_worker=object())

        async def handler(ws):
            await handle_connection(ws, args, load_catalog())

        with patch("controller.bridge.demo_chunks", fast_demo), patch(
            "controller.speech.synthesise", fake_synthesise
        ), patch("controller.speech.clear_live_clips"):
            async with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
                async with connect(
                    f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}",
                    origin=ORIGIN,
                ) as ws:
                    await ws.send('{"type":"start"}')
                    events = []
                    while not events or events[-1]["type"] != "end":
                        events.append(json.loads(await asyncio.wait_for(ws.recv(), 3)))
        speaks = [e for e in events if e["type"] == "speak"]
        self.assertEqual(
            [(e["id"], e["expression"], e["text"]) for e in speaks],
            [
                ("0000000000000001", "soft-smile", "Hello there."),
                ("0000000000000002", "thinking", "Hmm, let me see."),
            ],
        )
        # Only the initial neutral reset; later moods travel with their clip.
        self.assertEqual(
            [e["name"] for e in events if e["type"] == "expression"], ["neutral"]
        )


async def run_llm(worker, chunks_with_reasoning, filler_id=None):
    """Run one LLM-mode generation over a fake stream; return the events sent."""
    from websockets.asyncio.server import serve
    from websockets.asyncio.client import connect

    async def fake_llama(base_url, model, messages, on_reasoning=None, headers=None):
        for kind, text in chunks_with_reasoning:
            if kind == "reasoning":
                await on_reasoning()
            else:
                yield text

    async def fake_synthesise(segment, worker, run=None):
        return "0123456789abcdef", {}

    args = Namespace(
        mode="llm",
        llama_url="",
        model=None,
        prompt="Hi",
        context_tokens=65536,
        speech_worker=worker,
        filler_id=filler_id,
    )

    async def handler(ws):
        await handle_connection(ws, args, load_catalog())

    with patch("controller.bridge.llama_chunks", fake_llama), patch(
        "controller.speech.synthesise", fake_synthesise
    ), patch("controller.speech.clear_live_clips"):
        async with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
            async with connect(
                f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}", origin=ORIGIN
            ) as ws:
                await ws.send('{"type":"start"}')
                events = []
                while not events or events[-1]["type"] != "end":
                    events.append(json.loads(await asyncio.wait_for(ws.recv(), 3)))
    return events


class ThinkingMoodTests(unittest.IsolatedAsyncioTestCase):
    STREAM = [("reasoning", ""), ("reasoning", ""), ("content", "[happy] Hello there.")]

    async def test_text_mode_shows_thinking_then_answer(self):
        events = await run_llm(None, self.STREAM)
        moods = [e["name"] for e in events if e["type"] == "expression"]
        self.assertEqual(moods, ["neutral", "thinking", "neutral", "happy"])

    async def test_speech_mode_keeps_thinking_until_clip(self):
        events = await run_llm(object(), self.STREAM)
        self.assertEqual(
            [e["name"] for e in events if e["type"] == "expression"],
            ["neutral", "thinking"],
        )
        self.assertEqual(
            [e["expression"] for e in events if e["type"] == "speak"], ["happy"]
        )

    async def test_filler_is_opt_in_and_sent_once_per_reasoning_reply(self):
        stream = [("reasoning", ""), ("reasoning", ""), ("content", "[happy] Hello.")]
        without_filler = await run_llm(object(), stream)
        self.assertEqual([e for e in without_filler if e["type"] == "filler"], [])

        with_filler = await run_llm(object(), stream, filler_id="0123456789abcdef")
        fillers = [e for e in with_filler if e["type"] == "filler"]
        self.assertEqual(len(fillers), 1)
        self.assertEqual(fillers[0]["id"], "0123456789abcdef")
        self.assertEqual(fillers[0]["expression"], "thinking")
        self.assertLess(
            with_filler.index(fillers[0]),
            next(i for i, e in enumerate(with_filler) if e["type"] == "speak"),
        )

    async def test_filler_does_not_speak_when_reasoning_is_absent(self):
        events = await run_llm(object(), [("content", "Hello.")], filler_id="0123456789abcdef")
        self.assertEqual([e for e in events if e["type"] == "filler"], [])

    async def test_speech_mode_clears_thinking_when_nothing_spoken(self):
        # Reasoning, then an answer with nothing speakable: no clip will replace the thinking face.
        events = await run_llm(object(), [("reasoning", ""), ("content", "[happy] 🌸")])
        self.assertEqual([e["type"] for e in events if e["type"] == "speak"], [])
        self.assertEqual(
            [e["name"] for e in events if e["type"] == "expression"],
            ["neutral", "thinking", "neutral"],
        )


FAKE_WORKER = """
import json, sys
print(json.dumps({"ready": True, "loadSeconds": 0, "warmSeconds": 0}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request["text"] == "crash":
        sys.exit(3)
    if request["text"] == "fail":
        print(json.dumps({"id": request["id"], "ok": False, "error": "boom"}), flush=True)
        continue
    print(json.dumps({"id": request["id"], "ok": True, "edgeSeconds": 0, "edgeRetries": 0,
                      "rvcSeconds": 0, "echo": request["text"]}), flush=True)
"""


class ApplioWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_requests_errors_and_restart(self):
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / "fake_worker.py"
            script.write_text(FAKE_WORKER)
            worker = ApplioWorker(
                ApplioSettings(applio_dir=Path(scratch)),
                command=[sys.executable, str(script)],
                log_path=Path(scratch) / "log",
            )
            try:
                self.assertTrue((await worker.start())["ready"])
                replies = await asyncio.gather(
                    *(worker.request(t, Path("s"), Path("o")) for t in ("a", "b"))
                )
                self.assertEqual([r["echo"] for r in replies], ["a", "b"])
                with self.assertRaisesRegex(RuntimeError, "boom"):
                    await worker.request("fail", Path("s"), Path("o"))
                with self.assertRaisesRegex(RuntimeError, "exited"):
                    await worker.request("crash", Path("s"), Path("o"))
                # The next request restarts the worker transparently.
                self.assertEqual(
                    (await worker.request("again", Path("s"), Path("o")))["echo"],
                    "again",
                )
            finally:
                await worker.close()

    async def test_start_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as scratch:
            worker = ApplioWorker(
                ApplioSettings(applio_dir=Path(scratch)),
                command=[sys.executable, "-c", 'print("not ready")'],
                log_path=Path(scratch) / "log",
            )
            with self.assertRaisesRegex(RuntimeError, "failed to start"):
                await worker.start()


if __name__ == "__main__":
    unittest.main()
