"""Trim silence and RVC breath artifacts from the start and end of a clip.

Speech bounds come from the Edge TTS source, which has clean silence. RVC keeps
timing, so cutting the converted WAV at the source's bounds also removes the
breath-like noise RVC sometimes adds in the silent tail. Run before alignment so
lip-sync timings match the trimmed audio.
"""

from __future__ import annotations

import math
import subprocess
import wave
from array import array
from pathlib import Path

ANALYSIS_RATE = 16000
WINDOW = 0.01            # seconds per loudness window
THRESHOLD_DB = -50.0     # dBFS; Edge's silence is far below this, soft endings above it
LEAD_KEEP = 0.05         # seconds kept before speech
TAIL_KEEP = 0.25         # seconds kept after a sentence end
FRAGMENT_TAIL_KEEP = 0.1 # seconds kept after a fragment split by a mood tag
SENTENCE_ENDINGS = tuple('.!?…')


def speech_bounds(source: Path, threshold_db: float = THRESHOLD_DB,
                  ffmpeg: str = 'ffmpeg') -> tuple[float, float] | None:
    """Return (start, end) seconds of audible speech in ``source``, or None if silent."""
    pcm = subprocess.run(
        [ffmpeg, '-loglevel', 'error', '-i', str(source), '-ac', '1', '-ar', str(ANALYSIS_RATE),
         '-f', 's16le', '-'], capture_output=True, check=True).stdout
    samples = array('h')
    samples.frombytes(pcm[:len(pcm) - len(pcm) % 2])
    size = int(ANALYSIS_RATE * WINDOW)
    floor = 32768 * 10 ** (threshold_db / 20)
    loud = [i for i in range(0, len(samples), size)
            if math.sqrt(sum(s * s for s in samples[i:i + size]) / len(samples[i:i + size])) > floor]
    if not loud:
        return None
    return loud[0] / ANALYSIS_RATE, (loud[-1] + size) / ANALYSIS_RATE


def tail_keep(text: str) -> float:
    """A full stop earns a natural pause; a mood-tag split should flow on."""
    return TAIL_KEEP if text.rstrip('"\')] ').endswith(SENTENCE_ENDINGS) else FRAGMENT_TAIL_KEEP


def trim_clip(source: Path, wav: Path, text: str) -> dict:
    """Trim ``wav`` in place to the speech in ``source`` plus margins; return before/after seconds."""
    with wave.open(str(wav), 'rb') as clip:
        params = clip.getparams()
        frames = clip.readframes(params.nframes)
    before = params.nframes / params.framerate
    bounds = speech_bounds(source)
    if bounds is None:
        return {'beforeSeconds': round(before, 3), 'afterSeconds': round(before, 3), 'trimmed': False}
    start = max(0.0, bounds[0] - LEAD_KEEP)
    end = min(before, bounds[1] + tail_keep(text))
    if end <= start:
        return {'beforeSeconds': round(before, 3), 'afterSeconds': round(before, 3), 'trimmed': False}
    width = params.sampwidth * params.nchannels
    first, last = int(start * params.framerate), int(end * params.framerate)
    with wave.open(str(wav), 'wb') as clip:
        clip.setparams(params)
        clip.writeframes(frames[first * width:last * width])
    return {'beforeSeconds': round(before, 3), 'afterSeconds': round((last - first) / params.framerate, 3),
            'trimmed': True}
