"""Speech buffering (#278): when ready clips are announced to the renderer."""

import asyncio
import json
import unittest
from argparse import Namespace
from unittest.mock import patch

from controller.bridge import THINKING, build_parser, handle_connection, load_catalog, speak_segments, speech_settings
from controller.speech import ApplioSettings, Segment
from controller.speech_buffer import ADAPTIVE_MARGIN, BUFFERING_MODES, SpeechHold

ORIGIN = "http://127.0.0.1:8000"


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class SpeechHoldTests(unittest.TestCase):
    def test_modes(self):
        self.assertEqual(BUFFERING_MODES, ("stream", "full", "adaptive"))
        with self.assertRaises(ValueError):
            SpeechHold("turbo")

    def test_stream_never_holds(self):
        hold = SpeechHold("stream")
        self.assertTrue(hold.released)
        self.assertIsNone(hold.time_left())

    def test_full_holds_until_every_known_segment_is_ready(self):
        hold = SpeechHold("full", clock=Clock())
        hold.add({"id": "a"}, audio_seconds=30, chars=10)
        self.assertFalse(hold.due(remaining_chars=5, input_done=True))
        self.assertFalse(hold.due(remaining_chars=0, input_done=False), "more text may still come")
        self.assertTrue(hold.due(remaining_chars=0, input_done=True))
        self.assertEqual(hold.take(), [{"id": "a"}])
        self.assertTrue(hold.released)
        self.assertEqual(hold.take(), [])

    def test_adaptive_starts_once_ready_audio_covers_the_rest(self):
        clock = Clock()
        hold = SpeechHold("adaptive", clock=clock)
        clock.now += 10  # 10 s to make 20 characters: 0.5 s per character
        hold.add({"id": "a"}, audio_seconds=4, chars=20)
        # 10 characters left ≈ 5 s of work; 4 s of audio does not cover it with the margin.
        self.assertFalse(hold.due(remaining_chars=10, input_done=True))
        hold.add({"id": "b"}, audio_seconds=3, chars=0)
        self.assertGreaterEqual(7, ADAPTIVE_MARGIN * 5)
        self.assertTrue(hold.due(remaining_chars=10, input_done=True))

    def test_adaptive_holds_while_the_reply_is_still_streaming(self):
        clock = Clock()
        hold = SpeechHold("adaptive", clock=clock)
        clock.now += 1
        hold.add({"id": "a"}, audio_seconds=60, chars=10)
        self.assertFalse(hold.due(remaining_chars=0, input_done=False))

    def test_adaptive_without_a_measured_clip_waits(self):
        hold = SpeechHold("adaptive", clock=Clock())
        self.assertFalse(hold.due(remaining_chars=10, input_done=True))

    def test_max_hold_releases_whatever_is_ready(self):
        clock = Clock()
        hold = SpeechHold("full", max_hold=20, clock=clock)
        hold.add({"id": "a"}, audio_seconds=1, chars=5)
        self.assertEqual(hold.time_left(), 20)
        clock.now += 20
        self.assertEqual(hold.time_left(), 0)
        self.assertTrue(hold.due(remaining_chars=50, input_done=False))


class FakeWorker:
    def __init__(self, mode="stream", max_hold=20.0):
        self.settings = ApplioSettings(speech_buffering=mode, speech_max_hold=max_hold)
        self.cancelled = []

    def cancel(self, run):
        self.cancelled.append(run)


class BufferedSpeakingTests(unittest.IsolatedAsyncioTestCase):
    async def speak(self, texts, worker, delays=None, log=None):
        delays = delays or {}
        log = [] if log is None else log

        async def fake_synthesise(segment, worker, run=None):
            await asyncio.sleep(delays.get(segment.text, 0.01))
            log.append(("ready", segment.text))
            return segment.text.ljust(16, "0")[:16], {"audioSeconds": 1.0}

        async def send(event):
            log.append(("sent", event.get("text", event.get("name"))))

        queue = asyncio.Queue()
        for text in texts:
            queue.put_nowait(Segment(text))
        queue.put_nowait(None)
        with patch("controller.speech.synthesise", fake_synthesise):
            spoken = await speak_segments(queue, send, worker, "run-1")
        return spoken, log

    async def test_stream_announces_before_later_clips_are_ready(self):
        _, log = await self.speak(["one", "two", "three"], FakeWorker("stream"), delays={"three": 0.2})
        self.assertLess(log.index(("sent", "one")), log.index(("ready", "three")))
        self.assertNotIn(("sent", THINKING), log)

    async def test_full_announces_nothing_until_every_clip_is_ready_then_all_in_order(self):
        spoken, log = await self.speak(
            ["one", "two", "three"], FakeWorker("full"), delays={"one": 0.1, "three": 0.2}
        )
        self.assertEqual(spoken, 3)
        last_ready = max(i for i, (kind, _) in enumerate(log) if kind == "ready")
        speaks = [(i, text) for i, (kind, text) in enumerate(log) if kind == "sent" and text != THINKING]
        self.assertTrue(all(i > last_ready for i, _ in speaks), log)
        self.assertEqual([text for _, text in speaks], ["one", "two", "three"])
        self.assertLess(log.index(("sent", THINKING)), log.index(("ready", "three")),
                        "she shows the thinking face while clips are held")

    async def test_cancel_during_a_hold_drops_every_held_clip(self):
        worker, log = FakeWorker("full"), []
        task = asyncio.create_task(self.speak(["one", "two"], worker, delays={"two": 5}, log=log))
        await asyncio.sleep(0.1)
        self.assertIn(("ready", "one"), log)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.05)
        self.assertNotIn(("sent", "one"), log)
        self.assertEqual(worker.cancelled, ["run-1"])

    async def test_max_hold_starts_playback_anyway(self):
        _, log = await self.speak(["one", "two"], FakeWorker("full", max_hold=0.05), delays={"two": 0.4})
        self.assertLess(log.index(("sent", "one")), log.index(("ready", "two")))
        self.assertGreater(log.index(("sent", "two")), log.index(("ready", "two")))

    async def test_mode_is_read_when_each_reply_starts(self):
        worker = FakeWorker("stream")
        worker.settings.speech_buffering = "full"
        _, log = await self.speak(["one", "two"], worker, delays={"two": 0.2})
        self.assertGreater(log.index(("sent", "one")), log.index(("ready", "two")))


class FlagTests(unittest.TestCase):
    def test_flags_default_to_stream_and_reach_the_settings(self):
        args = build_parser().parse_args([])
        self.assertEqual(args.speech_buffering, "stream")
        self.assertEqual(args.speech_max_hold, 20.0)
        args = build_parser().parse_args(["--speech-buffering", "adaptive", "--speech-max-hold", "8"])
        settings = speech_settings(args)
        self.assertEqual((settings.speech_buffering, settings.speech_max_hold), ("adaptive", 8.0))

    def test_unknown_mode_is_refused(self):
        with self.assertRaises(SystemExit), patch("sys.stderr"):
            build_parser().parse_args(["--speech-buffering", "turbo"])
        with self.assertRaises(ValueError):
            ApplioSettings(speech_buffering="turbo")


class SettingsFrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_renderer_sets_and_resets_the_mode(self):
        from websockets.asyncio.client import connect
        from websockets.asyncio.server import serve

        settings = ApplioSettings(speech_buffering="adaptive")
        args = Namespace(mode="demo", prompt=None, speech_settings=settings, speech_buffering="adaptive")

        async def handler(ws):
            await handle_connection(ws, args, load_catalog())

        async with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            async with connect(url, origin=ORIGIN) as ws:
                async def frame(value):
                    await ws.send(json.dumps({"type": "settings", "speechBuffering": value}))
                    return json.loads(await asyncio.wait_for(ws.recv(), 3))

                self.assertEqual(await frame("full"), {"type": "settings", "speechBuffering": "full"})
                self.assertEqual(settings.speech_buffering, "full")
                # Invalid values are dropped without a reply; the next valid frame answers.
                await ws.send(json.dumps({"type": "settings", "speechBuffering": "turbo"}))
                await ws.send(json.dumps({"type": "settings", "speechBuffering": 3}))
                # null returns to the launch flag's mode.
                self.assertEqual(await frame(None), {"type": "settings", "speechBuffering": "adaptive"})
                self.assertEqual(settings.speech_buffering, "adaptive")


if __name__ == "__main__":
    unittest.main()
