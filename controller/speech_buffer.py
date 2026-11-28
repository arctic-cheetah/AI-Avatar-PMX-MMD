"""Speech buffering (#278): decide when ready clips are announced to the renderer.

``stream`` announces each clip as soon as it is ready. ``full`` holds them
until every sentence of the reply is ready. ``adaptive`` starts once the
reply's text is complete and the held audio covers the estimated time to make
the rest. A maximum hold time releases whatever is ready, so a long reply never
leaves her silent indefinitely. See docs/speech-buffering.md.
"""

from __future__ import annotations

import time

BUFFERING_MODES = ("stream", "full", "adaptive")
DEFAULT_MAX_HOLD = 20.0  # seconds from the start of a reply
ADAPTIVE_MARGIN = 1.2  # ready audio must cover this × the estimated time left


class SpeechHold:
    """One reply's held clips, and whether they are due to be announced."""

    def __init__(self, mode="stream", max_hold=DEFAULT_MAX_HOLD, clock=time.monotonic,
                 margin=ADAPTIVE_MARGIN):
        if mode not in BUFFERING_MODES:
            raise ValueError(f"unknown speech buffering mode: {mode!r}")
        self.mode, self.max_hold, self.clock, self.margin = mode, max_hold, clock, margin
        self.started = clock()
        self.released = mode == "stream"
        self.held = []
        self.held_audio = 0.0
        self.done_chars = 0

    def add(self, event, audio_seconds, chars):
        """A clip is ready: hold it (unless released) and count its work."""
        self.done_chars += chars
        if not self.released:
            self.held.append(event)
            self.held_audio += audio_seconds

    def skip(self, chars):
        """A sentence failed: its characters are no longer left to make."""
        self.done_chars += chars

    def time_left(self):
        """Seconds until the maximum hold releases the clips; None once released."""
        if self.released:
            return None
        return max(0.0, self.started + self.max_hold - self.clock())

    def due(self, remaining_chars, input_done):
        """True when the held clips should be announced now."""
        if self.released or self.time_left() == 0:
            return True
        if not input_done:
            return False
        if remaining_chars <= 0:
            return True
        if self.mode != "adaptive" or self.done_chars <= 0 or not self.held:
            return False
        per_char = (self.clock() - self.started) / self.done_chars
        return self.held_audio >= self.margin * remaining_chars * per_char

    def take(self):
        """Release: return the held clips in order; later clips are not held."""
        self.released = True
        held, self.held, self.held_audio = self.held, [], 0.0
        return held
