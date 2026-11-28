"""Speech buffering (#278): decide when ready clips are announced to the renderer.

``stream`` announces each clip as soon as it is ready. ``full`` holds them
until every sentence of the reply is ready. ``adaptive`` starts once the
reply's text is complete and the held audio covers the estimated time to make
the rest, from the measured synthesis throughput. A maximum hold, timed from
the first held clip, releases whatever is ready, so a long reply never leaves
her silent indefinitely. See docs/speech-buffering.md.
"""

from __future__ import annotations

import math
import time

BUFFERING_MODES = ("stream", "full", "adaptive")
DEFAULT_MAX_HOLD = 20.0  # seconds from the first held clip
ADAPTIVE_MARGIN = 1.2  # ready audio must cover this × the estimated time left
MIN_RATE_SAMPLES = 2  # throughput samples before adaptive trusts the estimate
RATE_SMOOTHING = 0.3  # weight of the newest sample in the moving average


class SynthesisRate:
    """Seconds of synthesis per character: a moving average kept between replies.

    Each sample is the time between one clip finishing and the next, over the
    next clip's characters, taken only while the pipeline was busy. RVC converts
    one clip at a time, so this throughput is what the remaining clips will take.
    """

    def __init__(self, smoothing=RATE_SMOOTHING, min_samples=MIN_RATE_SAMPLES):
        self.smoothing, self.min_samples = smoothing, min_samples
        self.samples = 0
        self._average = None

    def sample(self, seconds, chars):
        if chars <= 0 or not math.isfinite(seconds) or seconds < 0:
            return
        value = seconds / chars
        if self._average is None:
            self._average = value
        else:
            self._average += self.smoothing * (value - self._average)
        self.samples += 1

    @property
    def per_char(self):
        """The average, or None until there are enough samples."""
        return self._average if self.samples >= self.min_samples else None


class SpeechHold:
    """One reply's held clips, and whether they are due to be announced."""

    def __init__(self, mode="stream", max_hold=DEFAULT_MAX_HOLD, clock=time.monotonic,
                 margin=ADAPTIVE_MARGIN, rate=None):
        if mode not in BUFFERING_MODES:
            raise ValueError(f"unknown speech buffering mode: {mode!r}")
        self.mode, self.max_hold, self.clock, self.margin = mode, max_hold, clock, margin
        self.rate = rate if rate is not None else SynthesisRate()
        self.first_held = None  # the maximum hold is timed from here
        self.released = mode == "stream"
        self.held = []
        self.held_audio = 0.0
        self.done_chars = 0

    def add(self, event, audio_seconds, chars):
        """A clip is ready: hold it (unless released) and count its work."""
        self.done_chars += chars
        if not self.released:
            if self.first_held is None:
                self.first_held = self.clock()
            self.held.append(event)
            self.held_audio += audio_seconds

    def skip(self, chars):
        """A sentence failed: its characters are no longer left to make."""
        self.done_chars += chars

    def time_left(self):
        """Seconds until the maximum hold releases the clips; None if released or nothing is held."""
        if self.released or self.first_held is None:
            return None
        return max(0.0, self.first_held + self.max_hold - self.clock())

    def due(self, remaining_chars, input_done):
        """True when the held clips should be announced now."""
        if self.released or self.time_left() == 0:
            return True
        if not input_done:
            return False
        if remaining_chars <= 0:
            return True
        per_char = self.rate.per_char
        if self.mode != "adaptive" or per_char is None or not self.held:
            return False
        return self.held_audio >= self.margin * remaining_chars * per_char

    def take(self):
        """Release: return the held clips in order; later clips are not held."""
        self.released = True
        held, self.held, self.held_audio = self.held, [], 0.0
        return held
