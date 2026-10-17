"""Align a final speech WAV to timed mouth shapes with Rhubarb Lip Sync.

Run after Applio conversion, on the audio that will actually play:

    .venv/bin/python -m controller.speech_align assets/private/speech/sample-01.wav \
        --transcript assets/private/speech/sample-01.txt

Writes ``<name>.visemes.json`` next to the WAV for the renderer's speech player.
The LLM never supplies these timings; they are measured from the audio.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

# Rhubarb's basic shapes A-F plus the extended G (F/V), H (L) and X (rest).
SHAPES = frozenset('ABCDEFGHX')
RECOGNIZERS = ('pocketSphinx', 'phonetic')
# Rhubarb rounds times to 10 ms; allow that much past the reported duration.
TOLERANCE = 0.011


def validate_cues(cues: object, duration: float) -> list[dict]:
    """Return ordered, bounded cues as {start, end, shape}, or raise ValueError."""
    if not isinstance(cues, list) or not cues:
        raise ValueError('No mouth cues')
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid duration')
    track, previous_end = [], 0.0
    for cue in cues:
        if not isinstance(cue, dict):
            raise ValueError('Invalid cue')
        start, end, shape = cue.get('start'), cue.get('end'), cue.get('value')
        if shape not in SHAPES:
            raise ValueError(f'Unknown shape: {shape!r}')
        if not all(isinstance(t, (int, float)) and math.isfinite(t) for t in (start, end)):
            raise ValueError('Non-finite cue time')
        if start < previous_end - TOLERANCE or end <= start or end > duration + TOLERANCE:
            raise ValueError(f'Cue out of order or bounds at {start}')
        track.append({'start': float(start), 'end': float(end), 'shape': shape})
        previous_end = end
    return track


def rhubarb_version(rhubarb: str) -> str:
    """Return the installed Rhubarb version string."""
    result = subprocess.run([rhubarb, '--version'], capture_output=True, text=True, check=True)
    return result.stdout.strip().rsplit(' ', 1)[-1]


def align(wav: Path, transcript: Path | None, recognizer: str = 'pocketSphinx',
          rhubarb: str = 'rhubarb', ffmpeg: str = 'ffmpeg') -> dict:
    """Resample ``wav`` for Rhubarb, run it and return a validated viseme track."""
    if recognizer not in RECOGNIZERS:
        raise ValueError(f'Unknown recognizer: {recognizer}')
    for tool in (rhubarb, ffmpeg):
        if shutil.which(tool) is None:
            raise FileNotFoundError(f'{tool} is not on PATH')
    started = time.perf_counter()
    with tempfile.TemporaryDirectory() as scratch:
        mono = Path(scratch) / 'mono16k.wav'
        output = Path(scratch) / 'cues.json'
        subprocess.run([ffmpeg, '-loglevel', 'error', '-y', '-i', str(wav),
                        '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', str(mono)], check=True)
        command = [rhubarb, '-q', '-f', 'json', '--extendedShapes', 'GHX',
                   '-r', recognizer, '-o', str(output)]
        if transcript is not None:
            command += ['-d', str(transcript)]
        subprocess.run([*command, str(mono)], check=True)
        result = json.loads(output.read_text(encoding='utf-8'))
    duration = float(result['metadata']['duration'])
    return {
        'audio': wav.name,
        'duration': duration,
        'transcript': transcript.read_text(encoding='utf-8').strip() if transcript else None,
        'aligner': {'tool': 'rhubarb', 'version': rhubarb_version(rhubarb), 'recognizer': recognizer},
        'alignSeconds': round(time.perf_counter() - started, 3),
        'visemes': validate_cues(result.get('mouthCues'), duration),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Align a speech WAV to Rhubarb mouth shapes.')
    parser.add_argument('wav', type=Path)
    parser.add_argument('--transcript', type=Path, help='Exact spoken text; improves recognition.')
    parser.add_argument('--recognizer', choices=RECOGNIZERS, default='pocketSphinx',
                        help='pocketSphinx: English, slower, more detail. phonetic: faster, any language.')
    args = parser.parse_args()
    track = align(args.wav, args.transcript, args.recognizer)
    out = args.wav.with_suffix('.visemes.json')
    out.write_text(json.dumps(track, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f"{out}: {len(track['visemes'])} cues, {track['duration']:.2f}s audio, "
          f"aligned in {track['alignSeconds']:.2f}s")


if __name__ == '__main__':
    main()
