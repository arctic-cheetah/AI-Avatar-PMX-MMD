"""Trim silence and RVC breath artifacts from the start and end of a clip.

Speech bounds come from the Edge TTS source, which has clean silence. RVC keeps
timing, so cutting the converted WAV at the source's bounds also removes the
breath-like noise RVC sometimes adds in the silent tail. Run before alignment so
lip-sync timings match the trimmed audio.
"""

from __future__ import annotations

import math
import subprocess
import sys
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
PEAK_LIMIT_DB = -1.0    # gain never pushes a sample above this
LIMITER_BLOCK = 0.001   # seconds per limiter gain step
LIMITER_LOOKAHEAD = 0.003  # start reducing this long before a peak
LIMITER_ATTACK = 0.002  # time constant easing into a peak
LIMITER_RELEASE = 0.05  # time constant recovering after a peak
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
    if end.endswith(SENTENCE_ENDINGS):
        return 'sentence'
    return 'clause' if end.endswith((',', ';', ':')) else 'fragment'


def tail_keep(text: str, sentence_tail: float = TAIL_KEEP,
              fragment_tail: float = FRAGMENT_TAIL_KEEP, ellipsis_tail: float | None = None,
              exclaim_tail: float | None = None, question_tail: float | None = None,
              clause_tail: float | None = None) -> float:
    """A full stop earns a natural pause; a mood-tag split should flow on.

    Ellipsis, exclamation and question tails default to the sentence tail. A
    clip ending in a clause mark (often a trailing dash) gets ``clause_tail``,
    or the fragment tail when none is given.
    """
    kind = ending(text)
    if kind == 'fragment' or (kind == 'clause' and clause_tail is None):
        return fragment_tail
    if kind == 'clause':
        return clause_tail
    chosen = {'ellipsis': ellipsis_tail, 'exclaim': exclaim_tail, 'question': question_tail}.get(kind)
    return sentence_tail if chosen is None else chosen


def _limiter_gains(peaks: list[float], limit: float, look: int, attack: float,
                   release: float) -> list[float]:
    """Per-block gain (<= 1) that keeps every block's peak at or below ``limit``.

    Each block needs ``limit / peak`` at most. Looking ``look`` blocks ahead and
    behind starts the reduction before a transient; a backward attack ramp and a
    forward release ramp keep the changes smooth. Every step only lowers the
    gain, so no block ends above what it needs.
    """
    need = [min(1.0, limit / peak) if peak else 1.0 for peak in peaks]
    count = len(need)
    ahead = [min(need[max(0, i - look):i + look + 1]) for i in range(count)]
    gains, level = [], 1.0
    for value in ahead:  # release: recover slowly after a peak
        level = value if value < level else level + (value - level) * release
        gains.append(level)
    level = 1.0
    for i in range(count - 1, -1, -1):  # attack: ease down into a peak
        level = gains[i] if gains[i] < level else level + (gains[i] - level) * attack
        gains[i] = min(gains[i], level)
    return gains


def apply_gain(wav: Path, gain_db: float) -> dict:
    """Make a 16-bit PCM clip ``gain_db`` louder, soft-limiting peaks to PEAK_LIMIT_DB.

    Returns the gain applied and the largest peak reduction, both in dB.
    """
    unchanged = {'gainDb': 0.0, 'limitDb': 0.0}
    with wave.open(str(wav), 'rb') as clip:
        params = clip.getparams()
        frames = clip.readframes(params.nframes)
    if gain_db <= 0 or params.sampwidth != 2:
        return unchanged
    samples = array('h')
    samples.frombytes(frames)
    if sys.byteorder == 'big':
        samples.byteswap()
    if not any(samples):
        return unchanged
    gain = 10 ** (gain_db / 20)
    limit = 32767 * 10 ** (PEAK_LIMIT_DB / 20)
    block = max(1, int(params.framerate * params.nchannels * LIMITER_BLOCK))
    starts = range(0, len(samples), block)
    peaks = [max(abs(x) for x in samples[i:i + block]) * gain for i in starts]
    blocks_per_second = 1 / LIMITER_BLOCK
    gains = _limiter_gains(
        peaks, limit, look=round(LIMITER_LOOKAHEAD * blocks_per_second),
        attack=1 - math.exp(-1 / (LIMITER_ATTACK * blocks_per_second)),
        release=1 - math.exp(-1 / (LIMITER_RELEASE * blocks_per_second)))
    louder = array('h')
    for index, i in enumerate(starts):
        scale = gain * gains[index]
        # The clamp is a last safety net; the limiter already holds peaks at the limit.
        louder.extend(int(max(-limit, min(limit, round(x * scale)))) for x in samples[i:i + block])
    if sys.byteorder == 'big':
        louder.byteswap()
    with wave.open(str(wav), 'wb') as clip:
        clip.setparams(params)
        clip.writeframes(louder.tobytes())
    return {'gainDb': round(gain_db, 2), 'limitDb': round(-20 * math.log10(min(gains)), 2)}


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
