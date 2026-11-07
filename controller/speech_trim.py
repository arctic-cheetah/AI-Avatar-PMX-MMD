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
MAX_TAIL_KEEP = 0.8     # an ellipsis may linger; silence past the source's own is padded
SENTENCE_ENDINGS = tuple('.!?…')
CLOSERS = '"\')] ”’'


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


def ending(text: str) -> str:
    """The clip's final mark, ignoring closing quotes: ellipsis, exclaim, question, sentence or fragment."""
    end = text.rstrip(CLOSERS)
    if end.endswith(('…', '...')):
        return 'ellipsis'
    if end.endswith('!'):  # also ?! and !!
        return 'exclaim'
    if end.endswith('?'):
        return 'question'
    return 'sentence' if end.endswith(SENTENCE_ENDINGS) else 'fragment'


def tail_keep(text: str, sentence_tail: float = TAIL_KEEP,
              fragment_tail: float = FRAGMENT_TAIL_KEEP, ellipsis_tail: float | None = None,
              exclaim_tail: float | None = None, question_tail: float | None = None) -> float:
    """A full stop earns a natural pause; a mood-tag split should flow on.

    Ellipsis, exclamation and question tails default to the sentence tail.
    """
    kind = ending(text)
    if kind == 'fragment':
        return fragment_tail
    chosen = {'ellipsis': ellipsis_tail, 'exclaim': exclaim_tail, 'question': question_tail}.get(kind)
    return sentence_tail if chosen is None else chosen


def trim_clip(source: Path, wav: Path, text: str, sentence_tail: float = TAIL_KEEP,
              fragment_tail: float = FRAGMENT_TAIL_KEEP, **ending_tails: float) -> dict:
    """Trim ``wav`` in place to the speech in ``source`` plus margins; return before/after seconds."""
    with wave.open(str(wav), 'rb') as clip:
        params = clip.getparams()
        frames = clip.readframes(params.nframes)
    before = params.nframes / params.framerate
    bounds = speech_bounds(source)
    if bounds is None:
        return {'beforeSeconds': round(before, 3), 'afterSeconds': round(before, 3), 'trimmed': False}
    start = max(0.0, bounds[0] - LEAD_KEEP)
    end = bounds[1] + tail_keep(text, sentence_tail, fragment_tail, **ending_tails)
    if end <= start:
        return {'beforeSeconds': round(before, 3), 'afterSeconds': round(before, 3), 'trimmed': False}
    width = params.sampwidth * params.nchannels
    first, last = int(start * params.framerate), int(end * params.framerate)
    # A tail longer than the silence the clip has is padded with digital silence.
    padding = max(0, last - params.nframes)
    with wave.open(str(wav), 'wb') as clip:
        clip.setparams(params)
        clip.writeframes(frames[first * width:last * width] + bytes(padding * width))
    return {'beforeSeconds': round(before, 3), 'afterSeconds': round((last - first) / params.framerate, 3),
            'trimmed': True}
