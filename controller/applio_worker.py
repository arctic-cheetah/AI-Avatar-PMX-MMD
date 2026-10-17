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


class Pipeline:
    """Run Edge ahead of RVC while keeping RVC serial and in request order.

    ``edge(text, path)`` is a coroutine returning retries used; ``convert(source,
    output)`` is a blocking call run on one dedicated thread. ``reply`` receives
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
                self.rvc_thread, self.convert, request['source'], request['output'])
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
        import edge_tts
        from rvc.lib.tools.edge_tts_patch import apply_edge_tts_fix
        from rvc.infer.infer import VoiceConverter
        apply_edge_tts_fix()  # Applio's fix for Edge's 403 on the old endpoint.
        self.edge_tts = edge_tts
        self.settings = settings
        self.converter = VoiceConverter()

    def convert(self, source: str, output: str) -> None:
        s = self.settings
        self.converter.convert_audio(
            audio_input_path=source, audio_output_path=output,
            model_path=s['pth'], index_path=s['index'], pitch=s['pitch'],
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
