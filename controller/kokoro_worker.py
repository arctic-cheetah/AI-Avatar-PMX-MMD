"""Kokoro synthesis with CPU ONNX or an optional native ROCm JSON-line worker."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from pathlib import Path
import re
import sys
import tempfile
import threading
import time

from controller.applio_worker import protocol_stream, read_stdin

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models' / 'kokoro'
PER_TOKEN_MODEL = MODEL_DIR / 'kokoro-v1.0-pertoken.onnx'  # speed declared [n]: setup_kokoro (#83)
VOICE_ID = re.compile(r'[ab][a-z]_[a-z]+')
MAX_BLEND_VOICES = 4
MAX_CLAUSE_PAUSE = 0.5
# Optional per-sentence request fields.
PROSODY_FIELDS = ('speed', 'clause_pause', 'emphasis', 'emphasis_pause', 'spans', 'holds', 'stretch')
MAX_HOLD = 1.5        # seconds a held vowel may last
AUDIBLE_FLOOR_DB = -30.0  # a word's frames this far below its loudest are not part of it
HOLD_WINDOW = 0.025   # seconds either side of the vowel's middle used to find its period
MAX_SPANS = 4  # word spans reported per sentence (for RVC pitch bends)
# espeak says "aww" as ɔːwə ("aw-wuh", heard as "awah"); one long vowel sounds right.
AWW_WORD = re.compile(r'a+w{2,}h*', re.IGNORECASE)
# Any LLM spelling of "aww" (Awwww, Aaww, aWWW, Awwh); a plain "aw" is left alone.
AWW_FAMILY = re.compile(r'\b(a)(?:a*w{2,}h*|a+w+h*|w+h+)\b', re.IGNORECASE)
AWW_PHONEMES = re.compile('ɔːʊ?wə')
# espeak spells some hums out: Mmm → ˌɛmˌɛmˈɛm, Hm → ˌeɪtʃˈɛm. Its own Hmm (həm) is already the hmm
# sound (listening, 14 Nov 2026, after hmm, mmm and ˈʌm respellings sounded off), so Hm is said like it.
HMM_PHONEMES = 'həm'
# A questioning həm? had a "th" sound (listening, 14 Nov 2026); said like "Umm" it works.
ASKING_HMM_PHONEMES = 'ˈʌm'
HMM_WORD = re.compile(r'hm{1,3}', re.IGNORECASE)
MM_WORD = re.compile(r'm{2,3}', re.IGNORECASE)
WORD_EDGES = '.,!?…;:"\'()[]—–-*“”‘’'
SPAN_PUNCTUATION = frozenset(',.!?…;:—"\'()')
MAX_EMPHASIS = 3          # emphasised words per sentence
MAX_EMPHASIS_PAUSE = 0.3  # seconds
SPLICE_FADE = 0.005       # seconds faded out and in around a spliced pause
PAUSE_QUIET_DB = -40.0    # spaces can contain coarticulated speech; only splice into actual quiet
FRAME = 0.025             # seconds per Kokoro duration frame (600 samples at 24 kHz)
MAX_STRETCH = 0.125       # seconds one sound may be drawn out to: 5 frames sounded natural, 8 broke up
STRESS_MARKS = ('ˈ', 'ˌ')  # primary first
VOWELS = frozenset('aeiouyæɐɑɒɔəɘɚɛɜɝɞɤɨɪɯɵøœɶʉʊʌʏᵻː')  # ː lengthens the vowel before it
HOLDABLE = frozenset('lmnŋɹrɾsʃzʒfvθðjwɫ')  # consonants that can be held; stops cannot be drawn out
HUMMABLE = frozenset('mn')  # what a word with no vowel ("hmm") draws out
DIPHTHONGS = frozenset({'aɪ', 'aʊ', 'eɪ', 'oʊ', 'ɔɪ', 'əʊ'})  # both halves are drawn out


def parse_voice(spec) -> list[tuple[str, float]]:
    """Parse ``af_heart`` or ``af_heart:0.7,af_bella:0.3`` into normalised (voice, weight) pairs.

    Voices must be American or British English IDs of one accent, at most four,
    without repeats; weights must be positive and finite and are scaled to sum to 1.
    """
    if not isinstance(spec, str) or not spec.strip():
        raise ValueError('Kokoro voice must be a nonempty voice ID or blend.')
    parts = []
    for item in spec.split(','):
        name, sep, weight = (part.strip() for part in item.partition(':'))
        if not VOICE_ID.fullmatch(name):
            raise ValueError(f'Invalid Kokoro voice in blend: {name!r}; use American or British English IDs.')
        try:
            value = float(weight) if sep else 1.0
        except ValueError:
            raise ValueError(f'Invalid weight for Kokoro voice {name}.') from None
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f'Kokoro voice weight for {name} must be positive and finite.')
        parts.append((name, value))
    names = [name for name, _ in parts]
    if len(parts) > MAX_BLEND_VOICES:
        raise ValueError(f'A Kokoro blend may use at most {MAX_BLEND_VOICES} voices.')
    if len(set(names)) != len(names):
        raise ValueError('A Kokoro blend must not repeat a voice.')
    if len({name[0] for name in names}) != 1:
        raise ValueError('A Kokoro blend must use voices of one accent (all a… or all b…).')
    total = sum(weight for _, weight in parts)
    return [(name, weight / total) for name, weight in parts]


def blend_style(parts: list[tuple[str, float]], get_style):
    """Weighted sum of the voices' style vectors (or the single voice's own vector)."""
    if len(parts) == 1:
        return get_style(parts[0][0])
    return sum(weight * get_style(name) for name, weight in parts)


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_prosody(speed: float, clause_pause: float) -> None:
    """Check speed and clause pause, whether configured or sent per sentence."""
    if not _number(speed) or not 0.5 <= speed <= 2.0:
        raise ValueError('Kokoro speed must be between 0.5 and 2.0.')
    if not _number(clause_pause) or not 0.0 <= clause_pause <= MAX_CLAUSE_PAUSE:
        raise ValueError(f'Kokoro clause pause must be between 0 and {MAX_CLAUSE_PAUSE} seconds.')


def _is_word(token: str) -> bool:
    """A word that is spoken: any letter or digit, so a lone dash or comma does not count."""
    return any(char.isalnum() for char in token)


def aligned(text: str, phonemes: str) -> bool:
    """True when the phonemes have one spoken word per spoken word of the text."""
    return sum(map(_is_word, text.split())) == sum(map(_is_word, phonemes.split()))


def _spoken_words(timings):
    """Yield (spoken-word index, middle of the space before it or None, its phoneme timings)."""
    current, gap, before, index = [], None, None, 0
    for timing in [*timings, None]:
        if timing is None or timing.phoneme == ' ':
            if _is_word(''.join(t.phoneme for t in current)):
                yield index, before, current
                index += 1
            if timing is not None:
                gap = (timing.start + timing.end) / 2
                before = gap
            current = []
        else:
            current.append(timing)


def canonical_aww(text: str) -> str:
    """Rewrite every spelling of "aww" as Aww/aww, which respell_phonemes() knows how to fix."""
    return AWW_FAMILY.sub(lambda m: 'Aww' if m.group(1) == 'A' else 'aww', text)


def hum_phonemes(word: str) -> str | None:
    """Phonemes for a hum (without its punctuation), or None to keep espeak's.

    A questioning hm/hmm ("Hmm?") is said like "Umm", a plain "Hm" like espeak's
    own "Hmm" (həm, which is kept), and mm/mmm as closed-lip m sounds.
    """
    core = word.strip(WORD_EDGES)
    if HMM_WORD.fullmatch(core):
        if '?' in word[len(word.rstrip(WORD_EDGES)):]:
            return ASKING_HMM_PHONEMES
        return HMM_PHONEMES if len(core) == 2 else None
    return 'm' * len(core) if MM_WORD.fullmatch(core) else None


def needs_respelling(text: str) -> bool:
    return any(AWW_WORD.fullmatch(word.strip(WORD_EDGES)) or hum_phonemes(word) for word in text.split())


def respell_phonemes(text: str, phonemes: str) -> str:
    """Fix espeak's aww and hums; other words are untouched.

    "aw-wuh" for aww/awww becomes one long ɔːɔː, and a hum (hm, hmm, mm, mmm) is
    said like espeak's own "Hmm" (hm → həm) or as m sounds (mm, mmm), keeping the punctuation around it.

    Only applied when the phoneme words line up with the text's spoken words.
    """
    if not aligned(text, phonemes):
        return phonemes
    words = [word for word in text.split() if _is_word(word)]
    tokens = phonemes.split(' ')
    spoken = (i for i, token in enumerate(tokens) if _is_word(token))
    for word, index in zip(words, spoken):
        core = word.strip(WORD_EDGES)
        if AWW_WORD.fullmatch(core):
            tokens[index] = AWW_PHONEMES.sub('ɔːɔː', tokens[index])
        elif (hum := hum_phonemes(word)) is not None:
            token = tokens[index]
            lead = len(token) - len(token.lstrip(WORD_EDGES))
            tail = len(token.rstrip(WORD_EDGES))
            tokens[index] = token[:lead] + hum + token[tail:]
    return ' '.join(tokens)


def _period(samples: list[float], rate: int, low_hz: float = 120, high_hz: float = 600) -> int | None:
    """Pitch period in samples of a voiced stretch, or None if it is not clearly periodic."""
    n = len(samples)
    lags = range(max(1, int(rate / high_hz)), min(int(rate / low_hz), n // 2) + 1)
    scores = []
    for lag in lags:
        a, b = samples[:n - lag], samples[lag:]
        energy = math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
        scores.append((sum(x * y for x, y in zip(a, b)) / energy) if energy > 1e-12 else 0.0)
    if not scores or max(scores) < 0.8:
        return None
    best = max(scores)
    # The first local peak near the best: neighbouring lags of a smooth vowel also
    # score highly, and multiples of the period score as well as the period itself.
    for i in range(1, len(scores) - 1):
        if scores[i] >= 0.9 * best and scores[i - 1] <= scores[i] >= scores[i + 1]:
            return lags[i]
    return lags[scores.index(best)]


def hold_vowel(samples: list[float], rate: int, start: float, end: float,
               target: float) -> tuple[list[float], float]:
    """Lengthen the word at ``start``-``end`` seconds to ``target`` seconds.

    Whole pitch periods from the steady middle of the vowel are repeated (so the
    pitch and timbre stay the same), with crossfades of half a period at both
    seams. Returns the new samples and the seconds added (0 if left alone).
    """
    duration = end - start
    if target <= duration:
        return samples, 0.0
    low, high = int((start + 0.3 * duration) * rate), int((start + 0.7 * duration) * rate)
    middle, half = (low + high) // 2, int(HOLD_WINDOW * rate)
    period = _period(samples[max(low, middle - half):min(high, middle + half)], rate)
    if not period or high - low < 3 * period:
        return samples, 0.0
    length = period * max(1, (high - low) // period // 2)  # whole periods, about half the steady part
    first = middle - length // 2
    chunk, seam = samples[first:first + length], first + length
    size = round((target - duration) * rate / period) * period
    insert = (chunk * (size // length + 1))[:size]
    fade = max(1, period // 2)
    for i in range(min(fade, size)):  # ease in from what would have followed the chunk
        w = i / fade
        insert[i] = (1 - w) * samples[seam + i] + w * insert[i]
        k = size - fade + i            # ease out towards the lead-in to the rest
        insert[k] = (1 - w) * insert[k] + w * samples[seam - fade + i]
    return samples[:seam] + insert + samples[seam:], size / rate


def validate_holds(holds) -> None:
    if not isinstance(holds, list) or len(holds) > MAX_SPANS:
        raise ValueError(f'Holds must be a list of up to {MAX_SPANS} [word index, seconds].')
    for hold in holds:
        if (not isinstance(hold, (list, tuple)) or len(hold) != 2 or isinstance(hold[0], bool)
                or not isinstance(hold[0], int) or not 0 <= hold[0] < 1000
                or not _number(hold[1]) or not 0 < hold[1] <= MAX_HOLD):
            raise ValueError(f'Each hold must be [word index, seconds up to {MAX_HOLD}].')


def stretch_sounds(word: str) -> list[int]:
    """Positions in one word's phonemes to draw out.

    The stressed vowel (primary stress, else secondary, else the first vowel),
    with its length mark or a real diphthong's second half, and a consonant that
    can be held when it ends the word ("wellll", "suuure"). A consonant that
    starts the next syllable is left alone: "really" over i, ə and l sounded
    like "reality". Stops such as t are never drawn out. A word with no vowel
    draws out its hum instead (both m sounds of "hmm"), or nothing ("psst").
    """
    after = next((word.index(mark) + 1 for mark in STRESS_MARKS if mark in word), 0)
    first = next((i for i in range(after, len(word)) if word[i] in VOWELS), None)
    if first is None:
        if any(char in VOWELS for char in word):
            return []
        return [i for i, char in enumerate(word) if char in HUMMABLE]
    last = first
    if word[first:first + 2] in DIPHTHONGS:
        last += 1
    while last + 1 < len(word) and word[last + 1] == 'ː':
        last += 1
    spoken_end = len(word.rstrip(WORD_EDGES))
    if last + 2 == spoken_end and word[last + 1] in HOLDABLE:
        last += 1
    return list(range(first, last + 1))


def validate_stretch(stretch) -> None:
    if not isinstance(stretch, list) or len(stretch) > MAX_SPANS:
        raise ValueError(f'Stretch must be a list of up to {MAX_SPANS} [word index, seconds].')
    for item in stretch:
        if (not isinstance(item, (list, tuple)) or len(item) != 2 or isinstance(item[0], bool)
                or not isinstance(item[0], int) or not 0 <= item[0] < 1000
                or not _number(item[1]) or not 0 < item[1] <= MAX_STRETCH):
            raise ValueError(f'Each stretch must be [word index, seconds up to {MAX_STRETCH}].')


def _phoneme_words(phonemes: str):
    """(first character position, word) for each spoken word of a phoneme string."""
    position = 0
    for token in phonemes.split(' '):
        if _is_word(token):
            yield position, token
        position += len(token) + 1


def stretch_factors(timings, phonemes: str, stretch, speed: float = 1.0) -> list[float] | None:
    """Per-phoneme speed factors (1 = unchanged) that draw out each [word, seconds] in ``stretch``.

    ``phonemes`` are the ones Kokoro kept (one per token) and ``timings`` the
    first pass's. Each sound picked by stretch_sounds() gets frames ÷ target, so
    it lasts ``seconds`` ÷ ``speed`` (at most MAX_STRETCH) and is never sped up.
    Returns None if the timings' words do not line up with the phonemes'.
    """
    factors = [1.0] * len(phonemes)
    timed = {index: word for index, _, word in _spoken_words(timings)}
    words = list(_phoneme_words(phonemes))
    if len(timed) != len(words):
        return None
    for index, seconds in stretch:
        if index >= len(words) or index not in timed:
            continue
        position, word = words[index]
        sounds = timed[index]
        target = round(min(MAX_STRETCH, seconds / speed) / FRAME)
        for i in stretch_sounds(word):
            if i >= len(sounds) or sounds[i].phoneme != word[i]:
                continue
            frames = round((sounds[i].end - sounds[i].start) / FRAME)
            if 0 < frames < target:
                factors[position + i] = frames / target
    return factors


class TokenPlan:
    """Speed factors for a sentence's tokens, handed out to Kokoro's batches in order."""

    def __init__(self, tokens: list[int], factors: list[float]):
        self.tokens, self.factors, self.cursor = list(tokens), list(factors), 0

    def take(self, window) -> list[float] | None:
        """Factors for the next run of tokens equal to ``window``, or None if there is none."""
        window, n = list(window), len(window)
        for start in range(self.cursor, len(self.tokens) - n + 1):
            if self.tokens[start:start + n] == window:
                self.cursor = start + n
                return self.factors[start:start + n]
        return None


def token_speed_vector(factors: list[float], speed: float) -> list[float]:
    """One speed per model input: the padding token at each end, then every token."""
    return [speed, *(round(speed * factor, 6) for factor in factors), speed]


def install_token_speeds(model, current_plan) -> bool:
    """Wrap the Kokoro wrapper's ``_infer`` so a batch can run with one speed per token.

    While ``current_plan()`` returns a TokenPlan, each batch takes its factors
    from it; otherwise (or if the batch is not found) the original runs. Returns
    False, leaving the model alone, if the wrapper lacks the internals used here.
    """
    if not all(hasattr(model, name) for name in ('_infer', 'sess', '_tokens_input', '_input_dtypes')):
        return False
    original = model._infer

    def infer(tokens, style, speed):
        plan = current_plan()
        factors = plan.take(tokens) if plan is not None else None
        if not factors or all(factor == 1.0 for factor in factors):
            return original(tokens, style, speed)
        import numpy as np
        dtypes = model._input_dtypes
        inputs = {
            model._tokens_input: np.array([[0, *tokens, 0]], dtype=dtypes[model._tokens_input]),
            'style': np.asarray(style, dtype=dtypes['style']),
            'speed': np.array(token_speed_vector(factors, float(speed)), dtype=dtypes['speed']),
        }
        audio, duration = model.sess.run(None, inputs)[:2]
        return np.asarray(audio).ravel(), np.asarray(duration).ravel()

    model._infer = infer
    return True


def per_token_session(session) -> bool:
    """True when the session's speed input takes one value per token (a named, dynamic size)."""
    speed = next((i for i in session.get_inputs() if i.name == 'speed'), None)
    return speed is not None and len(speed.shape) == 1 and isinstance(speed.shape[0], str)


def word_spans(timings, words) -> dict[int, tuple[float, float]]:
    """Seconds from the first to the last sounding phoneme of each requested spoken word."""
    wanted, spans = set(words), {}
    for index, _, phonemes in _spoken_words(timings):
        sounding = [t for t in phonemes if t.phoneme not in SPAN_PUNCTUATION]
        if index in wanted and sounding:
            spans[index] = (round(sounding[0].start, 6), round(sounding[-1].end, 6))
    return spans


def audible_span(samples, rate: int, start: float, end: float,
                 floor_db: float = AUDIBLE_FLOOR_DB) -> tuple[float, float]:
    """Shrink ``start``-``end`` seconds to the 10 ms frames within ``floor_db`` of the loudest.

    Kokoro's last phoneme often absorbs trailing silence, which would put a pitch
    rise where nothing is heard. The span is returned unchanged if it is silent.
    """
    frame = max(1, int(0.01 * rate))
    first = int(start * rate)
    levels = []
    for i in range(first, int(end * rate), frame):
        chunk = samples[i:i + frame]
        levels.append(math.sqrt(sum(x * x for x in chunk) / len(chunk)) if len(chunk) else 0.0)
    loudest = max(levels, default=0.0)
    if loudest <= 0:
        return start, end
    floor = loudest * 10 ** (floor_db / 20)
    kept = [i for i, level in enumerate(levels) if level >= floor]
    new_start = max(start, (first + kept[0] * frame) / rate)
    new_end = min(end, (first + (kept[-1] + 1) * frame) / rate)
    return round(new_start, 6), round(new_end, 6)


def shift_spans(spans: dict, points: list[float], seconds: float) -> dict:
    """Move spans later by ``seconds`` for every spliced pause at or before their start."""
    return {index: tuple(round(t + seconds * sum(p <= start for p in points), 6) for t in (start, end))
            for index, (start, end) in spans.items()}


def pause_points(timings, words, *, samples=None, rate=None) -> list[float]:
    """Pause locations inside the space before each requested word.

    Timing-only callers receive candidate midpoints. With audio, require a quiet
    window wide enough for both splice fades, inside that space's timing span.
    A text space can be fully voiced: skip it rather than break coarticulation.
    """
    spaces, current, gap, index = {}, '', None, 0
    for timing in [*timings, None]:
        if timing is None or timing.phoneme == ' ':
            if _is_word(current):
                if gap is not None:
                    spaces[index] = gap
                index += 1
            if timing is not None:
                gap = (timing.start, timing.end)
            current = ''
        else:
            current += timing.phoneme
    gaps = [spaces[word] for word in sorted(set(words)) if word in spaces]
    if samples is None:
        return [round((start + end) / 2, 6) for start, end in gaps]
    if not gaps:
        return []
    if rate is None or rate <= 0:
        raise ValueError('Audio pause selection needs a positive sample rate.')
    peak = max((abs(float(sample)) for sample in samples), default=0.0)
    if peak == 0:
        return []
    fade = max(1, int(SPLICE_FADE * rate))
    width = 2 * fade
    limit = width * (peak * 10 ** (PAUSE_QUIET_DB / 20)) ** 2
    points = []
    for start, end in gaps:
        first, last = max(0, math.ceil(start * rate)), min(len(samples), math.floor(end * rate))
        if last - first < width:
            continue
        middle = (start + end) * rate / 2
        energy = sum(float(sample) ** 2 for sample in samples[first:first + width])
        best = None
        for at in range(first, last - width + 1):
            if at > first:
                energy += float(samples[at + width - 1]) ** 2 - float(samples[at - 1]) ** 2
            if energy <= limit:
                center = at + fade
                if best is None or abs(center - middle) < abs(best - middle):
                    best = center
        if best is not None:
            points.append(round(best / rate, 6))
    return points


def splice_silence(samples: list[float], rate: int, points: list[float], seconds: float) -> list[float]:
    """Insert ``seconds`` of silence at each point, fading out before and in after."""
    if not points or seconds <= 0:
        return samples
    fade = max(1, int(SPLICE_FADE * rate))
    out, cut = [], 0
    for point in sorted(points):
        at = min(len(samples), max(cut, int(round(point * rate))))
        head = samples[cut:at]
        for k in range(1, min(fade, len(head)) + 1):
            head[-k] *= (k - 1) / fade
        out += head + [0.0] * int(round(seconds * rate))
        cut = at
    tail = samples[cut:]
    for k in range(min(fade, len(tail))):
        tail[k] *= (k + 1) / fade
    return out + tail


def validate_spans(spans) -> None:
    if (not isinstance(spans, list) or len(spans) > MAX_SPANS
            or any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < 1000 for i in spans)):
        raise ValueError(f'Spans must be a list of up to {MAX_SPANS} word indices.')


def validate_emphasis(emphasis, pause) -> None:
    if (not isinstance(emphasis, list) or len(emphasis) > MAX_EMPHASIS
            or any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < 1000 for i in emphasis)):
        raise ValueError(f'Emphasis must be a list of up to {MAX_EMPHASIS} word indices.')
    if not _number(pause) or not 0.0 <= pause <= MAX_EMPHASIS_PAUSE:
        raise ValueError(f'Emphasis pause must be between 0 and {MAX_EMPHASIS_PAUSE} seconds.')


def validate_settings(voice: str, speed: float, threads: int, clause_pause: float = 0.25) -> None:
    parse_voice(voice)
    validate_prosody(speed, clause_pause)
    if threads < 1:
        raise ValueError('Kokoro threads must be at least 1.')


class Synthesizer:
    def __init__(self, voice: str = 'af_heart:0.7,af_bella:0.3', speed: float = 1.0, threads: int = 2,
                 clause_pause: float = 0.25, *, device: str = 'cpu', backend: str = 'auto'):
        validate_settings(voice, speed, threads, clause_pause)
        import onnxruntime
        from kokoro_onnx import Kokoro
        import soundfile

        from controller.kokoro_runtime import select_session

        def onnx_session():
            onnxruntime.disable_telemetry_events()
            options = onnxruntime.SessionOptions()
            options.intra_op_num_threads = threads
            options.inter_op_num_threads = 1
            options.add_session_config_entry('session.intra_op.allow_spinning', '0')
            options.add_session_config_entry('session.inter_op.allow_spinning', '0')
            path = PER_TOKEN_MODEL if PER_TOKEN_MODEL.is_file() else MODEL_DIR / 'kokoro-v1.0.onnx'
            session = onnxruntime.InferenceSession(
                str(path), sess_options=options, providers=['CPUExecutionProvider'])
            return session, {'device': 'cpu', 'backend': 'onnx', 'provider': 'CPUExecutionProvider',
                             'onnxruntime': onnxruntime.__version__, 'model': path.name}

        def native_session(selected):
            from controller.kokoro_native import load_session
            session = load_session(selected, threads)
            return session, session.runtime

        session, self.runtime = select_session(device, backend, onnx_session, native_session)
        self.session = session
        try:
            self.model = Kokoro.from_session(session, str(MODEL_DIR / 'voices-v1.0.bin'))
            self.plan = None
            self.token_speeds = (per_token_session(session) and self.model.has_timings
                                 and install_token_speeds(self.model, lambda: self.plan))
            parts = parse_voice(voice)
            for name, _ in parts:
                if name not in self.model.voices:
                    raise ValueError(f'Unknown Kokoro voice: {name}; use --list-voices.')
            # Mixed once here, so a blend costs nothing per sentence.
            self.style = blend_style(parts, self.model.get_voice_style)
            self.voice, self.speed, self.clause_pause, self.soundfile = voice, speed, clause_pause, soundfile
        except Exception:
            self.close()
            raise

    def close(self):
        if hasattr(self.session, 'close'):
            self.session.close()
        self.session = None
        self.model = None

    def synthesize(self, text: str, path: str, speed: float | None = None,
                   clause_pause: float | None = None, emphasis: list[int] | None = None,
                   emphasis_pause: float = 0.12, spans: list[int] | None = None,
                   holds: list | None = None, stretch: list | None = None) -> dict:
        """Write ``text`` to ``path``.

        ``speed``/``clause_pause`` override the settings for one sentence.
        ``emphasis`` lists spoken-word indices that get ``emphasis_pause`` seconds
        of silence before them, when Kokoro's phonemes line up with the words.
        ``spans`` lists spoken-word indices whose time spans are reported as
        ``wordSpans`` (seconds in the written file, after any pauses and holds).
        ``holds`` ([word index, seconds]) lengthen those words' vowels.
        ``stretch`` ([word index, seconds]) has Kokoro itself say those words'
        stressed sounds longer, with per-token speed (a second pass).
        """
        if not isinstance(text, str) or not text.strip() or len(text) > 16000:
            raise ValueError('Speech text must contain 1–16000 characters.')
        text = canonical_aww(text)  # word count is unchanged, so spans and emphasis still line up
        speed = self.speed if speed is None else speed
        clause_pause = self.clause_pause if clause_pause is None else clause_pause
        validate_prosody(speed, clause_pause)
        if emphasis is not None:
            validate_emphasis(emphasis, emphasis_pause)
        if spans is not None:
            validate_spans(spans)
        if holds is not None:
            validate_holds(holds)
        if stretch is not None:
            validate_stretch(stretch)
        lang = 'en-gb' if self.voice.lstrip().startswith('b') else 'en-us'
        started = time.perf_counter()
        pauses, found, skipped = None, {}, 'misaligned'
        stretched, stretch_skipped = 0, 'misaligned'
        timed = bool(emphasis or spans or holds or stretch)
        phonemes = (self.model.tokenizer.phonemize(text, lang)
                    if timed or needs_respelling(text) else None)
        spoken = respell_phonemes(text, phonemes) if phonemes else None
        if timed and phonemes and aligned(text, phonemes):
            def create_timed():
                return self.model.create_timed(
                    spoken, voice=self.style, speed=speed, lang=lang, is_phonemes=True,
                    trim=False, clause_pause=clause_pause)

            samples, rate, timings = create_timed()
            if stretch:
                stretched, stretch_skipped, redone = self._stretch(spoken, timings, stretch, speed, create_timed)
                if redone is not None:
                    samples, rate, timings = redone
            candidates = pause_points(timings, emphasis or [])
            points = pause_points(timings, emphasis or [], samples=samples, rate=rate)
            wanted = [*(spans or []), *(index for index, _ in holds or [])]
            heard = {index: audible_span(samples, rate, start, end)
                     for index, (start, end) in word_spans(timings, wanted).items()}
            found = shift_spans(heard, points, emphasis_pause)
            if points:
                samples = splice_silence(list(samples), rate, points, emphasis_pause)
            # Latest word first, so earlier holds do not move the spans still to be held.
            for index, seconds in sorted(holds or [], key=lambda h: -found.get(h[0], (0, 0))[0]):
                if index not in found:
                    continue
                start, end = found[index]
                samples, added = hold_vowel(list(samples), rate, start, end, seconds)
                found = {k: ((s, round(e + added, 6)) if k == index else
                             (round(s + added, 6), round(e + added, 6)) if s >= end else (s, e))
                         for k, (s, e) in found.items()}
            if emphasis:
                pauses = len(points)
                if not points:
                    skipped = ('no-timings' if not timings else
                               'first-word' if all(i == 0 for i in emphasis) else
                               'no-safe-gap' if candidates else 'not-found')
        elif spoken and spoken != phonemes:  # pronunciation fix only
            samples, rate = self.model.create(
                spoken, voice=self.style, speed=speed, lang=lang, trim=False,
                clause_pause=clause_pause, is_phonemes=True)
            if emphasis:
                pauses = 0
        else:
            samples, rate = self.model.create(
                text, voice=self.style, speed=speed, lang=lang, trim=False,
                clause_pause=clause_pause)
            if emphasis:
                pauses = 0
        if not len(samples):
            raise RuntimeError('Kokoro returned empty audio.')
        self.soundfile.write(path, samples, rate, subtype='PCM_16')
        seconds = time.perf_counter() - started
        duration = len(samples) / rate
        metrics = {'ttsProvider': 'kokoro', 'ttsSeconds': round(seconds, 3),
                   'sourceSeconds': round(duration, 3), 'sampleRate': rate,
                   'ttsRtf': round(seconds / duration, 3)}
        if pauses is not None:
            metrics['emphasisPauses'] = pauses
            if pauses == 0:
                metrics['emphasisSkipped'] = skipped
        if stretch is not None:
            metrics['stretched'] = stretched
            if not stretched:
                metrics['stretchSkipped'] = stretch_skipped
        if spans is not None:
            metrics['wordSpans'] = [list(found[i]) for i in spans if i in found]
            metrics['spanWords'] = [i for i in spans if i in found]
        return metrics


    def _stretch(self, spoken: str, timings, stretch, speed: float, create_timed):
        """Second pass with per-token speed: (words stretched, reason if none, new result or None)."""
        if not getattr(self, 'token_speeds', False):
            return 0, 'no-model', None
        known = self.model.tokenizer.known(spoken)
        if not timings or known != ' '.join(spoken.split()):
            return 0, 'misaligned', None
        factors = stretch_factors(timings, known, stretch, speed)
        if factors is None:
            return 0, 'misaligned', None
        words = list(_phoneme_words(known))
        drawn = sum(any(factors[p] < 1.0 for p in range(position, position + len(word)))
                    for position, word in (words[index] for index, _ in stretch if index < len(words)))
        if not drawn:
            return 0, 'nothing-to-stretch', None
        self.plan = TokenPlan(self.model.tokenizer.tokenize(known), factors)
        try:
            return drawn, '', create_timed()
        finally:
            self.plan = None


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
                options = {key: request[key] for key in PROSODY_FIELDS if key in request}
                metrics = await asyncio.to_thread(synthesize, request['text'], request['source'], **options)
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
    parser.add_argument('--voice', default='af_heart:0.7,af_bella:0.3')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--clause-pause', type=float, default=0.25)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--list-voices', action='store_true')
    parser.add_argument('--device', choices=('cpu', 'gpu', 'auto'), default='cpu')
    parser.add_argument('--backend', choices=('auto', 'onnx', 'native'), default='auto')
    args = parser.parse_args()
    replies = protocol_stream() if args.worker else None
    from controller.kokoro_runtime import prepare_synthesizer
    synthesizer = None
    try:
        if args.list_voices:
            synthesizer = Synthesizer(args.voice, args.speed, args.threads, args.clause_pause,
                                      device=args.device, backend=args.backend)
            print('\n'.join(sorted(name for name in synthesizer.model.voices if name.startswith(('a', 'b')))))
            return
        synthesizer, ready = prepare_synthesizer(
            Synthesizer, device=args.device, backend=args.backend, voice=args.voice,
            speed=args.speed, threads=args.threads, clause_pause=args.clause_pause)
        if not args.worker:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            metrics = synthesizer.synthesize(args.text, str(args.output))
            print(json.dumps({'output': str(args.output.resolve()), **ready, **metrics}, indent=2))
            return

        def reply(message):
            replies.write(json.dumps(message) + '\n')
            replies.flush()

        reply(ready)

        async def run():
            lines = asyncio.Queue()
            threading.Thread(target=read_stdin, args=(asyncio.get_running_loop(), lines), daemon=True).start()
            await serve(lines, synthesizer.synthesize, reply)

        asyncio.run(run())
    except Exception as error:
        if replies:
            replies.write(json.dumps({'ready': False, 'error': f'Kokoro: {type(error).__name__}: {error}'}) + '\n')
            replies.flush()
        else:
            print(f'Kokoro: {error}', file=sys.stderr)
        raise SystemExit(1) from error
    finally:
        if synthesizer is not None:
            synthesizer.close()


if __name__ == '__main__':
    main()
