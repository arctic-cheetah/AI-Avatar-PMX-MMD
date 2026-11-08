"""Map a sentence's mood tag to small, clamped voice changes (#29 tier 2).

RVC keeps the source's rhythm and pitch contour, so speed and pauses are set at
Kokoro; RVC can only shift the overall register. Changes are scaled by the mood
tag's weight and clamped narrowly so neighbouring clips do not sound stitched.
Standard library only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from controller.speech_trim import ending

MAX_SPEED_CHANGE = 0.08  # ±8 % of the configured Kokoro speed
MAX_PITCH = 2            # ±2 semitones; larger shifts bend the voice's character
CLAUSE_PAUSE_RANGE = (0.5, 2.0)  # multiplier on the configured clause pause
MAX_GAIN_DB = 6.0


@dataclass(frozen=True)
class Prosody:
    speed: float = 1.0         # multiplier on kokoro_speed
    clause_pause: float = 1.0  # multiplier on kokoro_clause_pause
    pitch: int = 0             # semitones added to the RVC pitch
    gain_db: float = 0.0       # loudness boost applied to the final clip


ENERGETIC = Prosody(1.05, 0.7, 1)
REFLECTIVE = Prosody(0.95, 1.4, 0)
LOW = Prosody(0.92, 1.4, -1)

# Moods not listed (neutral, soft-smile, tender, angry, surprised, …) are unchanged.
MOOD_GROUPS = {
    **dict.fromkeys(('excited', 'joyful', 'happy', 'grin', 'cocky', 'smug',
                     'mischievous', 'hopeful'), ENERGETIC),
    **dict.fromkeys(('thinking', 'skeptical', 'confused', 'suspicious', 'serious',
                     'worried', 'nervous', 'troubled'), REFLECTIVE),
    **dict.fromkeys(('sad', 'sorrowful', 'rueful', 'sleepy', 'disappointed',
                     'cry', 'sulky'), LOW),
}


ELLIPSIS_SPEED = 0.96  # a sentence trailing off into an ellipsis lingers


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _weight(weight) -> float:
    if not isinstance(weight, (int, float)) or not math.isfinite(weight):
        return 0.0
    return _clamp(float(weight), 0.0, 1.0)


def _semitones(shift: float) -> int:
    """Round half away from zero, then clamp to ±MAX_PITCH."""
    pitch = int(math.copysign(math.floor(abs(shift) + 0.5), shift))
    return int(_clamp(pitch, -MAX_PITCH, MAX_PITCH))


def prosody_for(expression: str, weight) -> Prosody:
    """Return the clamped prosody for a mood at ``weight`` (0–1; out of range is clamped)."""
    base = MOOD_GROUPS.get(expression)
    w = _weight(weight)
    if base is None or w == 0:
        return Prosody()
    speed = _clamp(1 + (base.speed - 1) * w, 1 - MAX_SPEED_CHANGE, 1 + MAX_SPEED_CHANGE)
    pause = _clamp(1 + (base.clause_pause - 1) * w, *CLAUSE_PAUSE_RANGE)
    return Prosody(round(speed, 4), round(pause, 4), _semitones(base.pitch * w))


def punctuation_prosody(text: str, expression: str, weight,
                        exclaim_gain_db: float = 3.0) -> Prosody:
    """Prosody from the clip's final mark: slower ellipses, louder exclamations.

    Exclamations change loudness, not pitch: an extra ±1 semitone on ``!`` was
    too strong when listened to (7 Nov 2026). Mood pitch still applies.
    """
    kind = ending(text)
    if kind == 'ellipsis':
        return Prosody(ELLIPSIS_SPEED, 1.0, 0)
    if kind == 'exclaim' and exclaim_gain_db > 0:
        return Prosody(gain_db=round(_clamp(exclaim_gain_db, 0.0, MAX_GAIN_DB), 2))
    return Prosody()


def combine(first: Prosody, second: Prosody) -> Prosody:
    """Stack two prosodies: speeds and pauses multiply, pitches add; then clamp."""
    speed = _clamp(first.speed * second.speed, 1 - MAX_SPEED_CHANGE, 1 + MAX_SPEED_CHANGE)
    pause = _clamp(first.clause_pause * second.clause_pause, *CLAUSE_PAUSE_RANGE)
    gain = _clamp(first.gain_db + second.gain_db, 0.0, MAX_GAIN_DB)
    return Prosody(round(speed, 4), round(pause, 4), _semitones(first.pitch + second.pitch),
                   round(gain, 2))
