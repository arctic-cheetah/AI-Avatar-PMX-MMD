"""Phase 2 tests: clip trimming, the worker's Edge/RVC pipeline, ordered sending."""
import asyncio
import json
import math
import random
import struct
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path

from controller.applio_worker import Pipeline, serve_lines
from controller.bridge import MAX_IN_FLIGHT, speak_segments
from controller.speech import Segment
from controller.speech_trim import speech_bounds, tail_keep, trim_clip


def write_wav(path, rate, parts):
    """parts: (seconds, kind) with kind 'silence', 'tone' (speech stand-in) or 'breath' (soft noise)."""
    rng = random.Random(1)
    samples = []
    for seconds, kind in parts:
        for i in range(int(seconds * rate)):
            if kind == 'tone':
                samples.append(int(12000 * math.sin(2 * math.pi * 220 * i / rate)))
            elif kind == 'breath':
                samples.append(int(rng.uniform(-600, 600)))  # about -35 dBFS
            else:
                samples.append(0)
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(struct.pack(f'<{len(samples)}h', *samples))


def duration(path):
    with wave.open(str(path), 'rb') as clip:
        return clip.getnframes() / clip.getframerate()


class TrimTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)
        # The Edge source has clean silence; RVC output adds a breath after the speech.
        self.source = self.path / 'source.wav'
        write_wav(self.source, 24000, [(0.5, 'silence'), (1.0, 'tone'), (1.0, 'silence')])
        self.output = self.path / 'output.wav'
        write_wav(self.output, 40000, [(0.5, 'silence'), (1.0, 'tone'), (0.3, 'silence'),
                                       (0.4, 'breath'), (0.3, 'silence')])

    def tearDown(self):
        self.dir.cleanup()

    def test_bounds_from_source(self):
        start, end = speech_bounds(self.source)
        self.assertAlmostEqual(start, 0.5, delta=0.011)
        self.assertAlmostEqual(end, 1.5, delta=0.011)

    def test_sentence_trim_removes_padding_and_breath(self):
        result = trim_clip(self.source, self.output, 'Hello there.')
        self.assertTrue(result['trimmed'])
        self.assertAlmostEqual(result['beforeSeconds'], 2.5, delta=0.001)
        # 0.05 s lead + 1.0 s speech + 0.25 s tail; the breath at 1.8–2.2 s is gone.
        self.assertAlmostEqual(duration(self.output), 1.30, delta=0.02)

    def test_fragment_keeps_shorter_tail(self):
        trim_clip(self.source, self.output, 'Well')
        self.assertAlmostEqual(duration(self.output), 1.15, delta=0.02)

    def test_silent_source_leaves_clip_alone(self):
        silent = self.path / 'silent.wav'
        write_wav(silent, 24000, [(1.0, 'silence')])
        result = trim_clip(silent, self.output, 'Hello.')
        self.assertFalse(result['trimmed'])
        self.assertAlmostEqual(duration(self.output), 2.5, delta=0.001)

    def test_tail_keep(self):
        self.assertEqual(tail_keep('Hello.'), 0.25)
        self.assertEqual(tail_keep('He said "Hi!"'), 0.25)
        self.assertEqual(tail_keep('Well'), 0.1)


class FakeStages:
    """Edge and RVC stand-ins that record timing, order and concurrency."""

    def __init__(self, edge_delays=None, fail=()):
        self.edge_delays = edge_delays or {}
        self.fail = set(fail)
        self.events = []  # (time, what, text)
        self.converted = []
        self.edge_active = self.edge_peak = 0
        self.rvc_lock = threading.Lock()
        self.overlapping_rvc = False

    async def edge(self, text, path):
        self.edge_active += 1
        self.edge_peak = max(self.edge_peak, self.edge_active)
        self.events.append((time.perf_counter(), 'edge-start', text))
        try:
            await asyncio.sleep(self.edge_delays.get(text, 0.01))
            if text in self.fail:
                raise RuntimeError(f'edge failed for {text}')
            return 0
        finally:
            self.edge_active -= 1

    def convert(self, source, output):
        if not self.rvc_lock.acquire(blocking=False):
            self.overlapping_rvc = True
            return
        try:
            self.events.append((time.perf_counter(), 'rvc-start', source))
            time.sleep(0.1)
            self.converted.append(source)
            self.events.append((time.perf_counter(), 'rvc-end', source))
        finally:
            self.rvc_lock.release()


def request(text, run='run-a'):
    return {'id': text, 'run': run, 'text': text, 'source': text, 'output': text + '.wav'}


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def run_pipeline(self, stages, requests, cancel=None, edge_concurrency=2):
        replies = []
        pipeline = Pipeline(stages.edge, stages.convert, replies.append, edge_concurrency)
        for item in requests:
            pipeline.submit(item)
        if cancel:
            pipeline.cancel(cancel)
        await pipeline.drain()
        return replies

    async def test_rvc_serial_and_in_request_order(self):
        # s1's Edge is slowest, but RVC must still convert s1 first.
        stages = FakeStages(edge_delays={'s1': 0.2, 's2': 0.01, 's3': 0.01})
        replies = await self.run_pipeline(stages, [request(t) for t in ('s1', 's2', 's3')])
        self.assertEqual(stages.converted, ['s1', 's2', 's3'])
        self.assertEqual([r['id'] for r in replies], ['s1', 's2', 's3'])
        self.assertTrue(all(r['ok'] for r in replies))
        self.assertFalse(stages.overlapping_rvc)

    async def test_edge_runs_ahead_of_rvc_with_limit(self):
        stages = FakeStages()
        await self.run_pipeline(stages, [request(f's{i}') for i in range(5)])
        self.assertLessEqual(stages.edge_peak, 2)
        rvc_end = {text: t for t, what, text in stages.events if what == 'rvc-end'}
        edge_start = {text: t for t, what, text in stages.events if what == 'edge-start'}
        # Overlap: s2's Edge request starts before s1's conversion has finished.
        self.assertLess(edge_start['s2'], rvc_end['s1'])

    async def test_cancelled_run_skips_rvc(self):
        stages = FakeStages()
        replies = await self.run_pipeline(
            stages, [request('a1'), request('a2'), request('b1', run='run-b')], cancel='run-a')
        self.assertEqual(stages.converted, ['b1'])
        by_id = {r['id']: r for r in replies}
        self.assertTrue(by_id['a1']['cancelled'] and by_id['a2']['cancelled'])
        self.assertTrue(by_id['b1']['ok'])

    async def test_cancel_during_edge_skips_rvc(self):
        stages = FakeStages(edge_delays={'a1': 0.1})
        replies = []
        pipeline = Pipeline(stages.edge, stages.convert, replies.append)
        pipeline.submit(request('a1'))
        await asyncio.sleep(0.03)  # a1 is now waiting on Edge
        pipeline.cancel('run-a')
        await pipeline.drain()
        self.assertEqual(stages.converted, [])
        self.assertTrue(replies[0]['cancelled'])

    async def test_failure_does_not_block_later_requests(self):
        stages = FakeStages(fail={'s2'})
        replies = await self.run_pipeline(stages, [request(t) for t in ('s1', 's2', 's3')])
        by_id = {r['id']: r for r in replies}
        self.assertTrue(by_id['s1']['ok'] and by_id['s3']['ok'])
        self.assertFalse(by_id['s2']['ok'])
        self.assertIn('edge failed', by_id['s2']['error'])
        self.assertEqual(stages.converted, ['s1', 's3'])

    async def test_serve_lines_dispatch(self):
        stages = FakeStages()
        replies = []
        pipeline = Pipeline(stages.edge, stages.convert, replies.append)
        lines = asyncio.Queue()
        for line in ['not json', '[1]', json.dumps({'cancel': 'run-x'}),
                     json.dumps(request('x1', run='run-x')), json.dumps(request('s1')), None]:
            lines.put_nowait(line)
        await serve_lines(lines, pipeline, replies.append)
        errors = [r for r in replies if r['id'] is None]
        self.assertEqual(len(errors), 2)
        by_id = {r['id']: r for r in replies if r['id']}
        self.assertTrue(by_id['x1']['cancelled'])
        self.assertTrue(by_id['s1']['ok'])


class FakeWorker:
    def __init__(self):
        self.cancelled = []

    def cancel(self, run):
        self.cancelled.append(run)


class OrderedSendingTests(unittest.IsolatedAsyncioTestCase):
    async def speak(self, texts, delays=None, fail=(), worker=None):
        delays = delays or {}
        active = peak = 0
        async def fake_synthesise(segment, worker, run=None):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(delays.get(segment.text, 0.01))
                if segment.text in fail:
                    raise RuntimeError('synthesis failed')
                return segment.text.ljust(16, '0')[:16], {}
            finally:
                active -= 1
        queue, sent = asyncio.Queue(), []
        async def send(event):
            sent.append(event)
        for text in texts:
            queue.put_nowait(Segment(text))
        queue.put_nowait(None)
        from unittest.mock import patch
        with patch('controller.speech.synthesise', fake_synthesise):
            await speak_segments(queue, send, worker or FakeWorker(), 'run-1')
        return sent, peak

    async def test_slow_middle_clip_keeps_order(self):
        sent, _ = await self.speak(['one', 'two', 'three'], delays={'two': 0.2})
        self.assertEqual([e['text'] for e in sent], ['one', 'two', 'three'])

    async def test_failed_middle_clip_is_skipped_with_notice(self):
        sent, _ = await self.speak(['one', 'two', 'three'], fail={'two'})
        self.assertEqual([e['type'] for e in sent], ['speak', 'notice', 'speak'])
        self.assertEqual([e['text'] for e in sent if e['type'] == 'speak'], ['one', 'three'])

    async def test_in_flight_limit(self):
        _, peak = await self.speak([f's{i}' for i in range(8)], delays={'s0': 0.1})
        self.assertEqual(peak, MAX_IN_FLIGHT)

    async def test_cancel_tells_worker_and_stops(self):
        worker = FakeWorker()
        task = asyncio.create_task(self.speak(['one', 'two'], delays={'one': 5, 'two': 5}, worker=worker))
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(worker.cancelled, ['run-1'])


if __name__ == '__main__':
    unittest.main()
