"""Persistent Applio worker: Edge TTS + RVC with the model kept loaded.

Runs under Applio's own Python environment, never the avatar's:

    <Applio>/.venv/bin/python controller/applio_worker.py '<settings JSON>'
    (working directory: the Applio installation)

Only the standard library and Applio's own packages may be imported here.

Protocol: one JSON object per line. After loading and a warm-up conversion it
writes {"ready": true, ...}. Each request {"id", "text", "source", "output"}
gets one reply {"id", "ok", ...} in request order. Applio's own prints go to
stderr so stdout carries only protocol lines.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import sys
import tempfile
import time
import wave

EDGE_ATTEMPTS = 3


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

    def handle(self, request: dict) -> dict:
        started = time.perf_counter()
        retries = asyncio.run(self.edge(request['text'], request['source']))
        edge_seconds = time.perf_counter() - started
        started = time.perf_counter()
        self.convert(request['source'], request['output'])
        return {'edgeSeconds': round(edge_seconds, 2), 'edgeRetries': retries,
                'rvcSeconds': round(time.perf_counter() - started, 2)}


def main() -> None:
    replies = protocol_stream()
    def reply(message: dict) -> None:
        replies.write(json.dumps(message) + '\n')
    started = time.perf_counter()
    worker = Worker(json.loads(sys.argv[1]))
    load_seconds = time.perf_counter() - started
    reply({'ready': True, 'loadSeconds': round(load_seconds, 2),
           'warmSeconds': round(worker.warm_up(), 2)})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            reply({'id': request['id'], 'ok': True, **worker.handle(request)})
        except Exception as error:
            reply({'id': request.get('id') if isinstance(request, dict) else None,
                   'ok': False, 'error': f'{type(error).__name__}: {error}'[:800]})


if __name__ == '__main__':
    main()
