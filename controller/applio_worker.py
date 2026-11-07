"""Persistent Applio worker: Edge TTS + RVC with the model kept loaded.

Runs under Applio's own Python environment, never the avatar's:

    <Applio>/.venv/bin/python controller/applio_worker.py '<settings JSON>'
    (working directory: the Applio installation)

Only the standard library and Applio's own packages may be imported here.

Protocol: one JSON object per line. After loading and a warm-up conversion it
writes {"ready": true, ...}. Each request {"id", "run", "text", "source",
"output"} gets one reply {"id", "ok", ...}. {"cancel": "<run>"} drops that run's
requests that have not started RVC yet (reply: ok false, cancelled true).
Applio's own prints go to stderr so stdout carries only protocol lines.

Requests are pipelined: Edge TTS for later sentences runs while RVC converts an
earlier one. RVC runs on one thread, strictly in request order, so replies come
back in order unless a request fails or is cancelled.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
from concurrent.futures import ThreadPoolExecutor
import math
import os
import struct
import sys
import tempfile
import time
import wave

EDGE_ATTEMPTS = 3
EDGE_CONCURRENCY = 2  # more parallel Edge requests make HTTP 429 likelier
MAX_PITCH_SHIFT = 12  # semitones; mood prosody itself stays within ±2
MAX_BENDS = 4         # pitch bends per sentence
MAX_BEND = 12.0       # semitones at a bend's peak; beyond ~+15 st total RVC turns rough
BEND_PEAK = 0.4       # a bend rises to its peak 40 % of the way through its span


def validate_bends(bends) -> None:
    """Check per-sentence pitch bends: up to MAX_BENDS [start, end, semitones(, peak)] in source seconds."""
    def number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if not isinstance(bends, list) or len(bends) > MAX_BENDS:
        raise ValueError(f'bend must be a list of up to {MAX_BENDS} [start, end, semitones]')
    for bend in bends:
        if not isinstance(bend, (list, tuple)) or len(bend) not in (3, 4) or not all(map(number, bend)):
            raise ValueError('each bend must be [start, end, semitones] or [start, end, semitones, peak]')
        start, end, semitones = bend[:3]
        if len(bend) == 4 and not 0.05 <= bend[3] <= 1.0:
            raise ValueError('a bend peak must be between 0.05 and 1 of its span')
        if not 0 <= start < end <= 60 or abs(semitones) > MAX_BEND:
            raise ValueError(f'bend needs 0 <= start < end <= 60 s and at most ±{MAX_BEND} semitones')


def bend_shape(t: float, start: float, end: float, peak: float = BEND_PEAK) -> float:
    """0 outside the span; a smooth rise to 1 at ``peak`` (fraction of the span), then a fall.

    With ``peak`` 1 the bend rises all the way to the end of the span (a question).
    """
    if t <= start or t >= end:
        return 0.0
    u = (t - start) / (end - start)
    if u < peak:
        return math.sin(math.pi / 2 * u / peak) ** 2
    return math.cos(math.pi / 2 * (u - peak) / (1 - peak)) ** 2


def bend_factors(frames: int, frame_seconds: float, offset_seconds: float, bends) -> list[float]:
    """F0 multipliers per frame; frame i is at i * frame_seconds - offset_seconds in the source."""
    factors = []
    for i in range(frames):
        t = i * frame_seconds - offset_seconds
        semitones = sum(bend[2] * bend_shape(t, bend[0], bend[1], *bend[3:4]) for bend in bends)
        factors.append(2 ** (semitones / 12))
    return factors


def coarse_pitch(f0, mel_min: float, mel_max: float) -> list[int]:
    """Applio's 255-bucket coarse pitch for an F0 curve (same formula as Pipeline.get_f0)."""
    coarse = []
    for value in f0:
        mel = 1127 * math.log(1 + float(value) / 700)
        if mel > 0:
            mel = (mel - mel_min) * 254 / (mel_max - mel_min) + 1
        coarse.append(int(round(min(255.0, max(1.0, mel)))))
    return coarse


def install_f0_bend(pipeline_class, current_bends) -> bool:
    """Wrap ``pipeline_class.get_f0`` so the F0 curve is bent by ``current_bends()``.

    Applio builds the F0 curve and its coarse version in ``get_f0``; the wrapper
    multiplies the bends into the float curve and rebuilds the coarse one. It is
    installed only when ``get_f0(self, x, p_len, ...)`` looks as expected, so a
    changed Applio speaks without bends instead of failing. Returns True if active.
    """
    original = getattr(pipeline_class, 'get_f0', None)
    if original is None or not callable(original):
        return False
    original = getattr(original, '__bend_original__', original)
    try:
        names = list(inspect.signature(original).parameters)[:3]
    except (TypeError, ValueError):
        return False
    if names != ['self', 'x', 'p_len']:
        return False

    def get_f0(pipe, x, p_len, *args, **kwargs):
        coarse, f0 = original(pipe, x, p_len, *args, **kwargs)
        bends = current_bends()
        if not bends:
            return coarse, f0
        factors = bend_factors(len(f0), pipe.window / pipe.sample_rate,
                               pipe.t_pad / pipe.sample_rate, bends)
        bent = [float(value) * factor for value, factor in zip(f0, factors)]
        new_coarse = coarse_pitch(bent, pipe.f0_mel_min, pipe.f0_mel_max)
        if hasattr(f0, 'dtype'):  # Applio's numpy arrays; keep their types
            import numpy
            return (numpy.asarray(new_coarse, dtype=coarse.dtype),
                    numpy.asarray(bent, dtype=f0.dtype))
        return new_coarse, bent

    get_f0.__bend_original__ = original
    pipeline_class.get_f0 = get_f0
    return True


class Pipeline:
    """Run Edge ahead of RVC while keeping RVC serial and in request order.

    ``edge(text, path)`` is a coroutine returning retries used; ``convert(source,
    output, pitch)`` is a blocking call run on one dedicated thread; ``pitch`` is
    the request's optional semitone shift (default 0). ``reply`` receives
    each result dict. Standard library only, so it can be tested without Applio.
    """

    def __init__(self, edge, convert, reply, edge_concurrency: int = EDGE_CONCURRENCY):
        self.edge, self.convert, self.reply = edge, convert, reply
        self.edge_slots = asyncio.Semaphore(edge_concurrency)
        self.rvc_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix='rvc')
        self.cancelled_runs: set[str] = set()
        self.previous: asyncio.Task | None = None
        self.tasks: set[asyncio.Task] = set()

    def submit(self, request: dict) -> None:
        task = asyncio.create_task(self._process(request, self.previous))
        self.previous = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def cancel(self, run: str) -> None:
        self.cancelled_runs.add(run)

    def _cancelled(self, request: dict) -> bool:
        return request.get('run') is not None and request['run'] in self.cancelled_runs

    async def _process(self, request: dict, previous: asyncio.Task | None) -> None:
        request_id = request.get('id')
        try:
            bends = request.get('bend', [])
            validate_bends(bends)
            pitch = request.get('pitch', 0)
            # Per-sentence semitone shift from mood prosody; checked again here.
            if isinstance(pitch, bool) or not isinstance(pitch, int) or abs(pitch) > MAX_PITCH_SHIFT:
                raise ValueError(f'pitch must be an integer from -{MAX_PITCH_SHIFT} to {MAX_PITCH_SHIFT}')
            if self._cancelled(request):
                self.reply({'id': request_id, 'ok': False, 'cancelled': True})
                return
            started = time.perf_counter()
            async with self.edge_slots:
                retries = await self.edge(request['text'], request['source'])
            edge_seconds = time.perf_counter() - started
            # RVC strictly in request order: wait for the previous request to finish.
            if previous is not None:
                await asyncio.wait([previous])
            if self._cancelled(request):
                self.reply({'id': request_id, 'ok': False, 'cancelled': True})
                return
            started = time.perf_counter()
            await asyncio.get_running_loop().run_in_executor(
                self.rvc_thread, self.convert, request['source'], request['output'], pitch, bends)
            self.reply({'id': request_id, 'ok': True, 'edgeSeconds': round(edge_seconds, 2),
                        'edgeRetries': retries, 'rvcSeconds': round(time.perf_counter() - started, 2)})
        except Exception as error:
            self.reply({'id': request_id, 'ok': False, 'error': f'{type(error).__name__}: {error}'[:800]})

    async def drain(self) -> None:
        if self.tasks:
            await asyncio.wait(set(self.tasks))
        self.rvc_thread.shutdown(wait=True)


async def serve_lines(lines: asyncio.Queue, pipeline: Pipeline, reply) -> None:
    """Dispatch protocol lines until end of input (None)."""
    while (line := await lines.get()) is not None:
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError('request must be an object')
            if 'cancel' in message:
                pipeline.cancel(str(message['cancel']))
            else:
                pipeline.submit(message)
        except Exception as error:
            reply({'id': None, 'ok': False, 'error': f'{type(error).__name__}: {error}'[:800]})
    await pipeline.drain()


def read_stdin(loop: asyncio.AbstractEventLoop, lines: asyncio.Queue) -> None:
    """Thread: forward stdin lines to the event loop, then None at end of input."""
    for line in sys.stdin:
        loop.call_soon_threadsafe(lines.put_nowait, line)
    loop.call_soon_threadsafe(lines.put_nowait, None)


def protocol_stream():
    """Keep the real stdout for replies; send everything else printed to stderr."""
    replies = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return replies


def write_tone(path: str, seconds: float = 1.0, rate: int = 16000) -> None:
    """A short voiced tone for the warm-up conversion; no network needed."""
    frames = b''.join(
        struct.pack('<h', int(8000 * math.sin(2 * math.pi * 220 * i / rate)))
        for i in range(int(seconds * rate)))
    with wave.open(path, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)


class Worker:
    def __init__(self, settings: dict):
        sys.path.insert(0, os.getcwd())
        if settings.get('rvc_threads'):
            import torch
            torch.set_num_threads(int(settings['rvc_threads']))
        from rvc.infer.infer import VoiceConverter
        if settings.get('tts_provider', 'edge') == 'edge':
            import edge_tts
            from rvc.lib.tools.edge_tts_patch import apply_edge_tts_fix
            apply_edge_tts_fix()
            self.edge_tts = edge_tts
        self.settings = settings
        self.converter = VoiceConverter()
        self.current_bends = ()
        from rvc.infer.pipeline import Pipeline as RvcPipeline
        if not install_f0_bend(RvcPipeline, lambda: self.current_bends):
            print('Applio get_f0 changed; pitch bends are disabled.', file=sys.stderr)

    def convert(self, source: str, output: str, pitch: int = 0, bends=()) -> None:
        """Convert with the configured pitch plus a per-sentence semitone ``pitch`` shift.

        ``bends`` ([start, end, semitones] in source seconds) are bent into the F0
        curve by the get_f0 wrapper while this conversion runs.
        """
        self.current_bends = bends
        try:
            self._convert(source, output, pitch)
        finally:
            self.current_bends = ()

    def _convert(self, source: str, output: str, pitch: int) -> None:
        s = self.settings
        self.converter.convert_audio(
            audio_input_path=source, audio_output_path=output,
            model_path=s['pth'], index_path=s['index'], pitch=s['pitch'] + pitch,
            index_rate=s['index_rate'], volume_envelope=s['volume_envelope'],
            protect=s['protect'], f0_method=s['f0_method'], export_format='WAV',
            embedder_model=s['embedder'], sid=s['sid'])

    def warm_up(self) -> float:
        started = time.perf_counter()
        with tempfile.TemporaryDirectory() as scratch:
            tone, output = os.path.join(scratch, 'tone.wav'), os.path.join(scratch, 'out.wav')
            write_tone(tone)
            self.convert(tone, output)
        return time.perf_counter() - started

    async def edge(self, text: str, path: str) -> int:
        """Synthesise with Edge TTS; retry its intermittent 429s. Returns retries used."""
        if self.settings.get('tts_provider') == 'kokoro':
            if not os.path.isfile(path):
                raise FileNotFoundError(f'Kokoro source WAV is missing: {path}')
            return 0
        rate = self.settings['rate']
        for attempt in range(EDGE_ATTEMPTS):
            try:
                await self.edge_tts.Communicate(
                    text, self.settings['voice'], rate=f'{rate:+d}%').save(path)
                return attempt
            except Exception as error:  # aiohttp raises WSServerHandshakeError for 429.
                if '429' not in str(error) or attempt == EDGE_ATTEMPTS - 1:
                    raise
                print(f'Edge TTS rate limited; retry {attempt + 1}', file=sys.stderr)
                await asyncio.sleep(1 + attempt)
        raise AssertionError('unreachable')


def main() -> None:
    replies = protocol_stream()
    def reply(message: dict) -> None:
        replies.write(json.dumps(message) + '\n')
    started = time.perf_counter()
    worker = Worker(json.loads(sys.argv[1]))
    load_seconds = time.perf_counter() - started
    reply({'ready': True, 'loadSeconds': round(load_seconds, 2),
           'warmSeconds': round(worker.warm_up(), 2)})
    async def run() -> None:
        lines: asyncio.Queue = asyncio.Queue()
        threading.Thread(target=read_stdin, args=(asyncio.get_running_loop(), lines), daemon=True).start()
        await serve_lines(lines, Pipeline(worker.edge, worker.convert, reply), reply)
    asyncio.run(run())


if __name__ == '__main__':
    main()
