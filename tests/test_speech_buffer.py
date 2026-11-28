"""Speech buffering (#278): when ready clips are announced to the renderer."""

import asyncio
import json
import unittest
from argparse import Namespace
from unittest.mock import patch

from controller.bridge import THINKING, build_parser, handle_connection, load_catalog, speak_segments, speech_settings
from controller.speech import ApplioSettings, Segment
from controller.speech_buffer import ADAPTIVE_MARGIN, BUFFERING_MODES, MIN_RATE_SAMPLES, SpeechHold, SynthesisRate

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

    def test_adaptive_starts_at_the_boundary_of_ready_audio_and_work_left(self):
        rate = warm_rate(0.5)  # measured: 0.5 s of synthesis per character
        hold = SpeechHold("adaptive", clock=Clock(), rate=rate)
        needed = ADAPTIVE_MARGIN * 10 * 0.5  # 10 characters left
        hold.add({"id": "a"}, audio_seconds=needed - 0.1, chars=20)
        self.assertFalse(hold.due(remaining_chars=10, input_done=True))
        hold.add({"id": "b"}, audio_seconds=0.2, chars=5)
        self.assertTrue(hold.due(remaining_chars=10, input_done=True))

    def test_adaptive_ignores_time_spent_waiting_for_the_llm(self):
        # #279 review: a slow LLM stream must not inflate the synthesis estimate.
        clock = Clock()
        hold = SpeechHold("adaptive", clock=clock, rate=warm_rate(0.1))
        clock.now += 60
        hold.add({"id": "a"}, audio_seconds=2, chars=10)
        self.assertTrue(hold.due(remaining_chars=10, input_done=True))

    def test_adaptive_holds_while_the_reply_is_still_streaming(self):
        hold = SpeechHold("adaptive", clock=Clock(), rate=warm_rate(0.01))
        hold.add({"id": "a"}, audio_seconds=60, chars=10)
        self.assertFalse(hold.due(remaining_chars=0, input_done=False))

    def test_adaptive_waits_like_full_until_the_rate_has_enough_samples(self):
        rate = SynthesisRate()
        hold = SpeechHold("adaptive", clock=Clock(), rate=rate)
        hold.add({"id": "a"}, audio_seconds=600, chars=10)
        for _ in range(MIN_RATE_SAMPLES - 1):
            rate.sample(1.0, 10)
            self.assertFalse(hold.due(remaining_chars=10, input_done=True))
        rate.sample(1.0, 10)
        self.assertTrue(hold.due(remaining_chars=10, input_done=True))

    def test_max_hold_is_timed_from_the_first_held_clip(self):
        # #279 review: a slow first sentence must not turn full into stream.
        clock = Clock()
        hold = SpeechHold("full", max_hold=20, clock=clock)
        clock.now += 100
        self.assertIsNone(hold.time_left(), "nothing held yet, so no clock")
        self.assertFalse(hold.due(remaining_chars=50, input_done=False))
        hold.add({"id": "a"}, audio_seconds=1, chars=5)
        self.assertEqual(hold.time_left(), 20)
        clock.now += 20
        self.assertEqual(hold.time_left(), 0)
        self.assertTrue(hold.due(remaining_chars=50, input_done=False))


def warm_rate(per_char):
    rate = SynthesisRate()
    for _ in range(MIN_RATE_SAMPLES):
        rate.sample(per_char * 10, 10)
    return rate


class SynthesisRateTests(unittest.TestCase):
    def test_unknown_until_enough_samples_then_a_moving_average(self):
        rate = SynthesisRate()
        self.assertIsNone(rate.per_char)
        for _ in range(MIN_RATE_SAMPLES):
            rate.sample(2.0, 10)
        self.assertAlmostEqual(rate.per_char, 0.2)
        rate.sample(6.0, 10)  # a slower clip moves the average part of the way
        self.assertGreater(rate.per_char, 0.2)
        self.assertLess(rate.per_char, 0.6)

    def test_empty_or_invalid_samples_are_ignored(self):
        rate = SynthesisRate()
        for seconds, chars in ((1.0, 0), (-1.0, 5), (float("nan"), 5)):
            rate.sample(seconds, chars)
        self.assertEqual(rate.samples, 0)


class FakeWorker:
    def __init__(self, mode="stream", max_hold=20.0, rate=None):
        self.settings = ApplioSettings(speech_buffering=mode, speech_max_hold=max_hold)
        self.synthesis_rate = rate or SynthesisRate()
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

    async def test_max_hold_applies_while_the_reply_text_is_still_coming(self):
        sent = []

        async def fake_synthesise(segment, worker, run=None):
            return "0" * 16, {"audioSeconds": 1.0}

        async def send(event):
            sent.append(event)

        queue = asyncio.Queue()
        queue.put_nowait(Segment("one"))  # the reply is never finished
        with patch("controller.speech.synthesise", fake_synthesise):
            task = asyncio.create_task(speak_segments(queue, send, FakeWorker("full", max_hold=0.05), "run-1"))
            await asyncio.sleep(0.2)
            self.assertIn("one", [event.get("text") for event in sent])
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_adaptive_starts_before_the_last_clip_when_synthesis_is_fast(self):
        worker = FakeWorker("adaptive", rate=warm_rate(0.001))
        _, log = await self.speak(["one", "two", "three"], worker, delays={"three": 0.3})
        self.assertLess(log.index(("sent", "one")), log.index(("ready", "three")))

    async def test_adaptive_waits_for_every_clip_when_synthesis_is_slow(self):
        worker = FakeWorker("adaptive", rate=warm_rate(100.0))
        _, log = await self.speak(["one", "two", "three"], worker, delays={"three": 0.2})
        self.assertGreater(log.index(("sent", "one")), log.index(("ready", "three")))

    async def test_replies_teach_the_worker_its_synthesis_rate(self):
        worker = FakeWorker("stream")
        await self.speak(["one one", "two two", "three three"], worker)
        # The first clip carries warm-up and is skipped; the next two were queued behind it.
        self.assertEqual(worker.synthesis_rate.samples, 2)
        self.assertIsNotNone(worker.synthesis_rate.per_char)

    async def test_a_slow_first_sentence_does_not_end_the_hold(self):
        sent = []

        async def fake_synthesise(segment, worker, run=None):
            await asyncio.sleep(0.01)
            return segment.text.ljust(16, "0")[:16], {"audioSeconds": 1.0}

        async def send(event):
            sent.append(event)

        async def slow_llm(queue):
            await asyncio.sleep(0.3)  # longer than the maximum hold
            queue.put_nowait(Segment("one"))
            await asyncio.sleep(0.05)
            queue.put_nowait(Segment("two"))
            queue.put_nowait(None)

        queue = asyncio.Queue()
        with patch("controller.speech.synthesise", fake_synthesise):
            feeder = asyncio.create_task(slow_llm(queue))
            task = asyncio.create_task(speak_segments(queue, send, FakeWorker("full", max_hold=0.2), "run-1"))
            await asyncio.sleep(0.33)
            self.assertEqual([e for e in sent if e["type"] == "speak"], [], "one is ready but still held")
            await asyncio.gather(feeder, task)
        self.assertEqual([e["text"] for e in sent if e["type"] == "speak"], ["one", "two"])

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
    async def test_renderer_sets_queries_and_resets_the_mode_for_every_page(self):
        from websockets.asyncio.client import connect
        from websockets.asyncio.server import serve

        settings = ApplioSettings(speech_buffering="adaptive")
        args = Namespace(mode="demo", prompt=None, speech_settings=settings, speech_buffering="adaptive")

        async def handler(ws):
            await handle_connection(ws, args, load_catalog())

        async def recv(ws):
            return json.loads(await asyncio.wait_for(ws.recv(), 3))

        async with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            async with connect(url, origin=ORIGIN) as a, connect(url, origin=ORIGIN) as b:
                # A page with no stored choice only asks; it does not reset anyone.
                await b.send(json.dumps({"type": "settings"}))
                self.assertEqual(await recv(b), {"type": "settings", "speechBuffering": "adaptive"})

                # A change reaches every page, so each status note stays right (#279 review).
                await a.send(json.dumps({"type": "settings", "speechBuffering": "full"}))
                self.assertEqual(await recv(a), {"type": "settings", "speechBuffering": "full"})
                self.assertEqual(await recv(b), {"type": "settings", "speechBuffering": "full"})
                self.assertEqual(settings.speech_buffering, "full")

                # Invalid values are dropped without a reply.
                await a.send(json.dumps({"type": "settings", "speechBuffering": "turbo"}))
                await a.send(json.dumps({"type": "settings", "speechBuffering": 3}))
                # A query leaves the mode alone and answers only the asker.
                await b.send(json.dumps({"type": "settings"}))
                self.assertEqual(await recv(b), {"type": "settings", "speechBuffering": "full"})
                # null returns everyone to the launch flag's mode.
                await b.send(json.dumps({"type": "settings", "speechBuffering": None}))
                self.assertEqual(await recv(a), {"type": "settings", "speechBuffering": "adaptive"})
                self.assertEqual(await recv(b), {"type": "settings", "speechBuffering": "adaptive"})
                self.assertEqual(settings.speech_buffering, "adaptive")


if __name__ == "__main__":
    unittest.main()
