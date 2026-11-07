"""CPU Kokoro synthesis, either a standalone WAV audition or a JSON-line worker."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
from pathlib import Path
import re
import tempfile
import threading
import time

from controller.applio_worker import protocol_stream, read_stdin

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models' / 'kokoro'
VOICE_ID = re.compile(r'[ab][a-z]_[a-z]+')
MAX_BLEND_VOICES = 4
MAX_CLAUSE_PAUSE = 0.5
# Optional per-sentence request fields.
PROSODY_FIELDS = ('speed', 'clause_pause', 'emphasis', 'emphasis_pause', 'spans', 'holds')
MAX_HOLD = 1.5        # seconds a held vowel may last
AUDIBLE_FLOOR_DB = -30.0  # a word's frames this far below its loudest are not part of it
HOLD_WINDOW = 0.025   # seconds either side of the vowel's middle used to find its period
MAX_SPANS = 4  # word spans reported per sentence (for RVC pitch bends)
# espeak says "aww" as ɔːwə ("aw-wuh", heard as "awah"); one long vowel sounds right.
AWW_WORD = re.compile(r'a+w{2,}h*', re.IGNORECASE)
AWW_PHONEMES = re.compile('ɔːʊ?wə')
WORD_EDGES = '.,!?…;:"\'()[]—–-*“”‘’'
SPAN_PUNCTUATION = frozenset(',.!?…;:—"\'()')
MAX_EMPHASIS = 3          # emphasised words per sentence
MAX_EMPHASIS_PAUSE = 0.3  # seconds
SPLICE_FADE = 0.005       # seconds faded out and in around a spliced pause


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


def needs_respelling(text: str) -> bool:
    return any(AWW_WORD.fullmatch(word.strip(WORD_EDGES)) for word in text.split())


def respell_phonemes(text: str, phonemes: str) -> str:
    """Replace espeak's "aw-wuh" for aww/awww with one long ɔːɔː; other words are untouched.

    Only applied when the phoneme words line up with the text's spoken words.
    """
    if not aligned(text, phonemes):
        return phonemes
    words = [word for word in text.split() if _is_word(word)]
    tokens = phonemes.split(' ')
    spoken = (i for i, token in enumerate(tokens) if _is_word(token))
    for word, index in zip(words, spoken):
        if AWW_WORD.fullmatch(word.strip(WORD_EDGES)):
            tokens[index] = AWW_PHONEMES.sub('ɔːɔː', tokens[index])
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


def pause_points(timings, words) -> list[float]:
    """Seconds, in the middle of the space before each spoken word index in ``words``.

    ``timings`` are Kokoro's per-phoneme timings (``phoneme``, ``start``, ``end``),
    spaces included. The first word and indices past the end get no pause.
    """
    spaces, current, gap, index = {}, '', None, 0
    for timing in [*timings, None]:
        if timing is None or timing.phoneme == ' ':
            if _is_word(current):
                if gap is not None:
                    spaces[index] = gap
                index += 1
            if timing is not None:
                gap = (timing.start + timing.end) / 2
            current = ''
        else:
            current += timing.phoneme
    return [round(spaces[word], 6) for word in sorted(set(words)) if word in spaces]


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
                 clause_pause: float = 0.25):
        validate_settings(voice, speed, threads, clause_pause)
        import onnxruntime
        from kokoro_onnx import Kokoro
        import soundfile

        onnxruntime.disable_telemetry_events()
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        session = onnxruntime.InferenceSession(
            str(MODEL_DIR / 'kokoro-v1.0.onnx'), sess_options=options,
            providers=['CPUExecutionProvider'])
        self.model = Kokoro.from_session(session, str(MODEL_DIR / 'voices-v1.0.bin'))
        parts = parse_voice(voice)
        for name, _ in parts:
            if name not in self.model.voices:
                raise ValueError(f'Unknown Kokoro voice: {name}; use --list-voices.')
        # Mixed once here, so a blend costs nothing per sentence.
        self.style = blend_style(parts, self.model.get_voice_style)
        self.voice, self.speed, self.clause_pause, self.soundfile = voice, speed, clause_pause, soundfile

    def synthesize(self, text: str, path: str, speed: float | None = None,
                   clause_pause: float | None = None, emphasis: list[int] | None = None,
                   emphasis_pause: float = 0.12, spans: list[int] | None = None,
                   holds: list | None = None) -> dict:
        """Write ``text`` to ``path``.

        ``speed``/``clause_pause`` override the settings for one sentence.
        ``emphasis`` lists spoken-word indices that get ``emphasis_pause`` seconds
        of silence before them, when Kokoro's phonemes line up with the words.
        ``spans`` lists spoken-word indices whose time spans are reported as
        ``wordSpans`` (seconds in the written file, after any pauses and holds).
        ``holds`` ([word index, seconds]) lengthen those words' vowels.
        """
        if not isinstance(text, str) or not text.strip() or len(text) > 16000:
            raise ValueError('Speech text must contain 1–16000 characters.')
        speed = self.speed if speed is None else speed
        clause_pause = self.clause_pause if clause_pause is None else clause_pause
        validate_prosody(speed, clause_pause)
        if emphasis is not None:
            validate_emphasis(emphasis, emphasis_pause)
        if spans is not None:
            validate_spans(spans)
        if holds is not None:
            validate_holds(holds)
        lang = 'en-gb' if self.voice.lstrip().startswith('b') else 'en-us'
        started = time.perf_counter()
        pauses, found = None, {}
        timed = bool(emphasis or spans or holds)
        phonemes = (self.model.tokenizer.phonemize(text, lang)
                    if timed or needs_respelling(text) else None)
        spoken = respell_phonemes(text, phonemes) if phonemes else None
        if timed and phonemes and aligned(text, phonemes):
            samples, rate, timings = self.model.create_timed(
                spoken, voice=self.style, speed=speed, lang=lang, is_phonemes=True,
                trim=False, clause_pause=clause_pause)
            points = pause_points(timings, emphasis or [])
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
        if spans is not None:
            metrics['wordSpans'] = [list(found[i]) for i in spans if i in found]
            metrics['spanWords'] = [i for i in spans if i in found]
        return metrics


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
    args = parser.parse_args()
    replies = protocol_stream() if args.worker else None
    started = time.perf_counter()
    synthesizer = Synthesizer(args.voice, args.speed, args.threads, args.clause_pause)
    load_seconds = time.perf_counter() - started
    if args.list_voices:
        print('\n'.join(sorted(name for name in synthesizer.model.voices if name.startswith(('a', 'b')))))
        return
    if not args.worker:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        metrics = synthesizer.synthesize(args.text, str(args.output))
        print(json.dumps({'output': str(args.output.resolve()), 'loadSeconds': round(load_seconds, 3),
                          **metrics}, indent=2))
        return

    def reply(message):
        replies.write(json.dumps(message) + '\n')

    with tempfile.TemporaryDirectory() as scratch:
        warm = synthesizer.synthesize('Hello, I am ready.', str(Path(scratch) / 'warm.wav'))
    reply({'ready': True, 'loadSeconds': round(load_seconds, 3), 'warmSeconds': warm['ttsSeconds']})

    async def run():
        lines = asyncio.Queue()
        threading.Thread(target=read_stdin, args=(asyncio.get_running_loop(), lines), daemon=True).start()
        await serve(lines, synthesizer.synthesize, reply)

    asyncio.run(run())


if __name__ == '__main__':
    main()
