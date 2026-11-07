"""Map a sentence's mood tag to small, clamped voice changes (#29 tier 2).

RVC keeps the source's rhythm and pitch contour, so speed and pauses are set at
Kokoro; RVC can only shift the overall register. Changes are scaled by the mood
tag's weight and clamped narrowly so neighbouring clips do not sound stitched.
Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

MAX_SPEED_CHANGE = 0.08  # ±8 % of the configured Kokoro speed
MAX_PITCH = 2            # ±2 semitones; larger shifts bend the voice's character
CLAUSE_PAUSE_RANGE = (0.5, 2.0)  # multiplier on the configured clause pause


@dataclass(frozen=True)
class Prosody:
    speed: float = 1.0         # multiplier on kokoro_speed
    clause_pause: float = 1.0  # multiplier on kokoro_clause_pause
    pitch: int = 0             # semitones added to the RVC pitch


ENERGETIC = Prosody(1.05, 0.7, 1)
REFLECTIVE = Prosody(0.95, 1.4, 0)
LOW = Prosody(0.92, 1.4, -1)

# Moods not listed (neutral, soft-smile, tender, angry, surprised, …) are unchanged.
MOOD_GROUPS = {
    **dict.fromkeys(('excited', 'joyful', 'happy', 'grin', 'cocky', 'smug',
                     'mischievous', 'hopeful'), ENERGETIC),
    **dict.fromkeys(('thinking', 'skeptical', 'confused', 'suspicious', 'serious',
                     'worried', 'nervous', 'troubled'), REFLECTIVE),
    **dict.fromkeys(('sad', 'sad-v2', 'sad-sceptical', 'sleepy', 'disappointed',
                     'cry', 'sulky'), LOW),
}


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def prosody_for(expression: str, weight) -> Prosody:
    """Return the clamped prosody for a mood at ``weight`` (0–1; out of range is clamped)."""
    base = MOOD_GROUPS.get(expression)
    if base is None or not isinstance(weight, (int, float)) or not math.isfinite(weight):
        return Prosody()
    w = _clamp(float(weight), 0.0, 1.0)
    if w == 0:
        return Prosody()
    speed = _clamp(1 + (base.speed - 1) * w, 1 - MAX_SPEED_CHANGE, 1 + MAX_SPEED_CHANGE)
    pause = _clamp(1 + (base.clause_pause - 1) * w, *CLAUSE_PAUSE_RANGE)
    shift = base.pitch * w
    pitch = int(math.copysign(math.floor(abs(shift) + 0.5), shift))  # round half away from zero
    return Prosody(round(speed, 4), round(pause, 4), int(_clamp(pitch, -MAX_PITCH, MAX_PITCH)))
