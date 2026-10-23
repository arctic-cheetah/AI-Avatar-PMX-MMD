"""CPU Kokoro synthesis, either a standalone WAV audition or a JSON-line worker."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from pathlib import Path
import tempfile
import threading
import time

from controller.applio_worker import protocol_stream, read_stdin

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models' / 'kokoro'


def validate_settings(voice: str, speed: float, threads: int) -> None:
    if not voice or not isinstance(voice, str):
        raise ValueError('Kokoro voice must be a nonempty voice ID.')
    if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise ValueError('Kokoro speed must be between 0.5 and 2.0.')
    if threads < 1:
        raise ValueError('Kokoro threads must be at least 1.')


class Synthesizer:
    def __init__(self, voice: str = 'af_heart', speed: float = 1.0, threads: int = 2):
        validate_settings(voice, speed, threads)
        import onnxruntime
        from kokoro_onnx import Kokoro
        import soundfile

        onnxruntime.disable_telemetry_events()
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        session = onnxruntime.InferenceSession(
            str(MODEL_DIR / 'kokoro-v1.0.onnx'), sess_options=options,
            providers=['CPUExecutionProvider'])
        self.model = Kokoro.from_session(session, str(MODEL_DIR / 'voices-v1.0.bin'))
        if voice not in self.model.voices:
            raise ValueError(f'Unknown Kokoro voice: {voice}; use --list-voices.')
        if not voice.startswith(('a', 'b')):
            raise ValueError('This test deployment supports American and British English voices.')
        self.voice, self.speed, self.soundfile = voice, speed, soundfile

    def synthesize(self, text: str, path: str) -> dict:
        if not isinstance(text, str) or not text.strip() or len(text) > 16000:
            raise ValueError('Speech text must contain 1–16000 characters.')
        started = time.perf_counter()
        samples, rate = self.model.create(
            text, voice=self.voice, speed=self.speed,
            lang='en-gb' if self.voice.startswith('b') else 'en-us', trim=False)
        if not len(samples):
            raise RuntimeError('Kokoro returned empty audio.')
        self.soundfile.write(path, samples, rate, subtype='PCM_16')
        seconds = time.perf_counter() - started
        duration = len(samples) / rate
        return {'ttsProvider': 'kokoro', 'ttsSeconds': round(seconds, 3),
                'sourceSeconds': round(duration, 3), 'sampleRate': rate,
                'ttsRtf': round(seconds / duration, 3)}


async def serve(lines: asyncio.Queue, synthesize, reply) -> None:
    slots = asyncio.Semaphore(1)
    cancelled_runs: set[str] = set()
    tasks: set[asyncio.Task] = set()

    async def process(request):
        try:
            async with slots:
                if request.get('run') in cancelled_runs:
                    reply({'id': request.get('id'), 'ok': False, 'cancelled': True})
                    return
                metrics = await asyncio.to_thread(synthesize, request['text'], request['source'])
            reply({'id': request.get('id'), 'ok': True, **metrics})
        except Exception as error:
            reply({'id': request.get('id'), 'ok': False,
                   'error': f'{type(error).__name__}: {error}'[:800]})

    while (line := await lines.get()) is not None:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('Request must be an object.')
            if 'cancel' in request:
                cancelled_runs.add(str(request['cancel']))
            else:
                task = asyncio.create_task(process(request))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        except (ValueError, TypeError) as error:
            reply({'id': None, 'ok': False, 'error': str(error)})
    if tasks:
        await asyncio.gather(*tasks)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--text', default='Hello, I am ready to keep you company. What shall we work on?')
    parser.add_argument('--output', type=Path, default=ROOT / 'assets/private/speech/kokoro-test.wav')
    parser.add_argument('--voice', default='af_heart')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--list-voices', action='store_true')
    args = parser.parse_args()
    replies = protocol_stream() if args.worker else None
    started = time.perf_counter()
    synthesizer = Synthesizer(args.voice, args.speed, args.threads)
    load_seconds = time.perf_counter() - started
    if args.list_voices:
        print('\n'.join(sorted(name for name in synthesizer.model.voices if name.startswith(('a', 'b')))))
        return
    if not args.worker:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        metrics = synthesizer.synthesize(args.text, str(args.output))
        print(json.dumps({'output': str(args.output.resolve()), 'loadSeconds': round(load_seconds, 3),
                          **metrics}, indent=2))
        return

    def reply(message):
        replies.write(json.dumps(message) + '\n')

    with tempfile.TemporaryDirectory() as scratch:
        warm = synthesizer.synthesize('Hello, I am ready.', str(Path(scratch) / 'warm.wav'))
    reply({'ready': True, 'loadSeconds': round(load_seconds, 3), 'warmSeconds': warm['ttsSeconds']})

    async def run():
        lines = asyncio.Queue()
        threading.Thread(target=read_stdin, args=(asyncio.get_running_loop(), lines), daemon=True).start()
        await serve(lines, synthesizer.synthesize, reply)

    asyncio.run(run())


if __name__ == '__main__':
    main()
