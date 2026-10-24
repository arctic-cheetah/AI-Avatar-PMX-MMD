"""CPU Whisper transcription, either one file or a JSON-line worker.

Runs under the isolated ``.venv-stt`` (faster-whisper, CTranslate2 int8):

    .venv-stt/bin/python -m controller.stt_worker --audio clip.webm
    .venv-stt/bin/python -m controller.stt_worker --worker --model base.en --threads 4

Protocol: after loading and a warm-up it writes {"ready": true, ...}. Each
request {"id", "audio": "<path>"} gets one reply {"id", "ok", "text", ...}.
Requests are handled one at a time, in order. Models load from ``models/whisper``
only; ``controller.setup_stt`` downloads them at pinned revisions.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

from controller.applio_worker import protocol_stream

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models' / 'whisper'
MODELS = {
    'base.en': ('Systran/faster-whisper-base.en', '3d3d5dee26484f91867d81cb899cfcf72b96be6c'),
    'small.en': ('Systran/faster-whisper-small.en', 'd1d751a5f8271d482d14ca55d9e2deeebbae577f'),
}
MAX_AUDIO_SECONDS = 60.0
# Whisper's own silence rule: likely no speech and a low-confidence decode.
NO_SPEECH_PROB, LOW_LOGPROB = 0.6, -1.0
# Stock phrases Whisper invents for noise; nobody says these alone to Yidhari.
HALLUCINATIONS = {'thanks for watching', 'thank you for watching', 'please subscribe',
                  'subtitles by the amaraorg community'}


def validate_settings(model: str, threads: int) -> None:
    if model not in MODELS:
        raise ValueError(f'Unknown Whisper model {model!r}; choose one of {", ".join(MODELS)}.')
    if threads < 1:
        raise ValueError('STT threads must be at least 1.')


def clean_transcript(segments) -> str:
    """Join kept segment texts; return '' for silence, noise or stock hallucinations."""
    kept = [segment.text for segment in segments
            if not (segment.no_speech_prob > NO_SPEECH_PROB and segment.avg_logprob < LOW_LOGPROB)]
    text = ' '.join(' '.join(kept).split())
    if not re.search(r'\w', text):
        return ''
    if re.sub(r'[^a-z ]', '', text.lower()).strip() in HALLUCINATIONS:
        return ''
    return text


class Transcriber:
    def __init__(self, model: str = 'base.en', threads: int = 4):
        validate_settings(model, threads)
        import numpy
        from faster_whisper import WhisperModel
        from faster_whisper.utils import download_model

        repo, revision = MODELS[model]
        path = download_model(repo, cache_dir=str(MODEL_DIR), revision=revision, local_files_only=True)
        self.model = WhisperModel(path, device='cpu', compute_type='int8', cpu_threads=threads)
        list(self.model.transcribe(numpy.zeros(16000, dtype=numpy.float32), language='en')[0])

    def transcribe(self, path: str) -> dict:
        started = time.perf_counter()
        segments, info = self.model.transcribe(
            path, language='en', beam_size=1, vad_filter=True, condition_on_previous_text=False)
        if info.duration > MAX_AUDIO_SECONDS:
            raise ValueError(f'Recording is longer than {MAX_AUDIO_SECONDS:.0f} seconds.')
        text = clean_transcript(segments)
        seconds = time.perf_counter() - started
        return {'text': text, 'audioSeconds': round(info.duration, 3),
                'sttSeconds': round(seconds, 3),
                'sttRtf': round(seconds / max(info.duration, 0.01), 3)}


def serve(lines, transcribe, reply) -> None:
    """Answer each request line in order; a bad request never stops the worker."""
    for line in lines:
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get('audio'), str):
                raise ValueError('Request must be an object with an audio path.')
            request_id = request.get('id')
            reply({'id': request_id, 'ok': True, **transcribe(request['audio'])})
        except Exception as error:
            reply({'id': request_id, 'ok': False, 'error': f'{type(error).__name__}: {error}'[:800]})


def main() -> None:
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--audio', type=Path, help='Transcribe one file and print the result.')
    parser.add_argument('--model', default='base.en', choices=sorted(MODELS))
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    if not args.worker and args.audio is None:
        parser.error('use --worker or --audio')
    replies = protocol_stream() if args.worker else None
    started = time.perf_counter()
    transcriber = Transcriber(args.model, args.threads)
    if not args.worker:
        print(json.dumps(transcriber.transcribe(str(args.audio)), ensure_ascii=False))
        return
    replies.write(json.dumps({'ready': True, 'sttProvider': 'faster-whisper', 'model': args.model,
                              'loadSeconds': round(time.perf_counter() - started, 3)}) + '\n')
    serve(sys.stdin, transcriber.transcribe,
          lambda message: replies.write(json.dumps(message, ensure_ascii=False) + '\n'))


if __name__ == '__main__':
    main()
