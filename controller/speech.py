"""Turn streamed LLM text into spoken, lip-synced clips.

Each completed sentence is synthesised by a persistent Applio worker
(Edge TTS -> RVC, model kept loaded; see applio_worker.py), trimmed of silence
and tail breaths (speech_trim.py), aligned with Rhubarb, and announced to the
renderer as a clip ID. The worker pipelines Edge ahead of RVC; the bridge keeps
a few sentences in flight and announces them in order.

Clips are written to ``assets/private/speech/live/`` (gitignored). Only the
generated ID crosses the WebSocket; the renderer builds the URL itself.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import math
import re
import secrets
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from controller.kokoro_worker import AWW_WORD, MAX_EMPHASIS, MAX_SPANS, WORD_EDGES as AWW_EDGES
from controller.prosody import Prosody, combine, prosody_for, punctuation_prosody
from controller.speech_align import align
from controller.speech_trim import FRAGMENT_TAIL_KEEP, MAX_TAIL_KEEP, apply_gain, ending, trim_clip

ROOT = Path(__file__).resolve().parents[1]
LIVE_DIR = ROOT / "assets" / "private" / "speech" / "live"
APPLIO_DIR = ROOT.parent / "Applio"
DEFAULT_MODEL = Path("logs") / "Yidhari-zzz" / "Yidhari-zzz_75e_21450s.pth"
DEFAULT_INDEX = Path("logs") / "Yidhari-zzz" / "Yidhari-zzz.index"
CLIP_ID = re.compile(r"[0-9a-f]{16}")
# A sentence ends at . ! ? or … (optionally followed by closing quotes) plus whitespace.
# Closing quotes, brackets and emphasis asterisks stay with their sentence (captured).
SENTENCE_END = re.compile(r'(?<=[.!?…])(["\')\]*]*)\s+')
# An ellipsis run straight into a word ("Wait...what") still ends the sentence.
ELLIPSIS_TOUCH = re.compile(r"(\.\.\.|…)(?=[^\W\d_])")
DIGIT_RANGE = re.compile(r"(?<=\d)\s*[–—]\s*(?=\d)")
# Single-asterisk emphasis such as *really*; **bold** and a * b are not emphasis.
# Only one word: multi-word spans like *giggles softly* are roleplay actions (PR #88 review).
EMPHASIS = re.compile(r"(?<![*\w])\*([^\s*]+)\*(?![*\w])")
EMPHASIS_MARK = "\ue000"  # private-use marker kept through cleaning, then removed
# Interjections Kokoro says flat but the actor lifts: aw/aww, ooh, ohh (a plain "oh" is left alone).
INTERJECTION = re.compile(r"(?:a+w+|o{2,}h*|oh{2,})", re.IGNORECASE)
WORD_EDGES = ".,!?…;:\"'()[]—–-*“”‘’"
# Terms of endearment; lifted only when used to address someone (followed by punctuation).
ENDEARMENTS = frozenset({
    "sweetheart", "honey", "darling", "dear", "dearest", "sweetie", "love", "babe",
    "baby", "cutie", "hun", "sweetpea", "sugar", "angel", "precious", "pumpkin", "treasure",
})
QUESTION_PEAK = 0.7  # a question's rise peaks 70 % into its last word (measured on RVC)
# Dynamic emphasis (#83): words said deeper and drawn out ("buuut", sarcastic "suuure").
DRAWL_OPENERS = frozenset({"but", "well", "so", "now", "okay"})
ATTITUDE_WORDS = frozenset({"sure", "really", "right", "totally", "obviously"})
SKEPTICAL_MOODS = frozenset({
    "skeptical", "suspicious", "unimpressed", "rueful", "annoyed", "sulky", "pout", "smug",
})
QUOTE_PEAK = 0.5  # a quotation's pitch dip is deepest in its middle
SURPRISE_WORDS = frozenset({"what", "really", "seriously", "wow", "whoa"})
SURPRISED_MOODS = frozenset({"surprised", "shocked", "gasp", "excited", "wtf-dude"})
# Fond words said warmly and drawn out ("sooo cute"); endearments such as "sweetie" keep their own lift.
AFFECTION_WORDS = frozenset({"cute", "adorable", "sweet", "lovely", "beautiful", "gorgeous", "wonderful"})
AFFECTION_INTENSIFIERS = frozenset({"so", "too"})  # only right before an affection word
HESITATION_WORDS = frozenset({"hmm", "hm", "umm", "um", "uh", "er", "erm"})  # in any mood; "mmm" is pleasure
AFFECTIONATE_MOODS = frozenset({
    "tender", "happy", "joyful", "soft-smile", "lovestruck", "shy", "excited", "grin", "serene",
})
# Elongated spellings (#83): espeak reads "whaaat" letter by letter (wˈæææt, heard as "whyat").
# Each run of one letter is tried as 1-3 letters and checked against a lexicon (#121 review).
LETTER_RUN = re.compile(r"([^\W\d_])\1+")
MAX_RUNS = 4  # at most 3**4 candidates per word
SYSTEM_WORDS = "/usr/share/dict/words"  # Debian/Ubuntu wamerican
SPOKEN_WORDS = frozenset({  # said aloud, missing from word lists, and need no vowel
    "hmm", "mmm", "shh", "umm", "yay", "yep", "nope", "oops", "psst",
})
FALLBACK_WORDS = frozenset({  # used only when there is no system word list
    "so", "no", "but", "what", "sure", "okay", "yes", "why", "hey", "please", "cute", "now",
    "wow", "yeah", "right", "really", "well", "all", "still", "will", "tell", "hello", "kiss",
    "miss", "less", "cool", "good", "too", "see", "soon", "food", "sweet", "need", "feel",
    "free", "sleep", "keep", "sorry", "happy", "pretty", "yummy", "silly", "little", "funny",
})
OPENING_QUOTES, CLOSING_QUOTES = '"“', '"”'
CLOSING = "\"'”’)]*"
DASH = re.compile(r"\s*[—–]\s*|\s+-(?:\s+|$)")
WORKER_SCRIPT = Path(__file__).with_name("applio_worker.py")
WORKER_LOG = LIVE_DIR.parent / "applio-worker.log"
LOG = logging.getLogger(__name__)


def ready_summary(ready: dict) -> str:
    """The worker's ready message as one line: device first, then start-up times."""
    times = f"load {ready['loadSeconds']}s, warm-up {ready['warmSeconds']}s"
    device = ready.get("device")
    if not isinstance(device, dict):
        return times
    if device.get("device") != "gpu":
        return f"on CPU: {times}"
    details = ", ".join(str(device[key]) for key in ("backend", "gpu", "arch") if device.get(key))
    return f"on GPU ({details}): {times}"


@dataclass
class ApplioSettings:
    """Values from the user's Applio TTS tab; CLI defaults differ for some."""

    applio_dir: Path = APPLIO_DIR
    pth: Path | None = None  # None selects DEFAULT_MODEL below ``applio_dir``.
    index: Path | None = None  # None selects DEFAULT_INDEX below ``applio_dir``.
    voice: str = "en-US-JennyNeural"
    rate: int = -15
    pitch: int = 0
    index_rate: float = 0.7
    volume_envelope: float = 1.0
    protect: float = 0.5
    f0_method: str = "rmvpe"
    embedder: str = "contentvec"
    sid: int = 0
    recognizer: str = "phonetic"
    rvc_threads: int = 0  # PyTorch CPU threads for RVC; 0 keeps PyTorch's default
    rvc_device: str = "auto"  # auto, gpu (refuse to start without one) or cpu (hide GPUs), #111
    tts_provider: str = "edge"
    # Kokoro cadence and voice defaults chosen by listening on 7 Nov 2026 (#29).
    kokoro_voice: str = "af_heart:0.7,af_bella:0.3"
    kokoro_speed: float = 1.0
    kokoro_clause_pause: float = 0.25  # seconds at commas etc., inside one sentence
    kokoro_threads: int = 2
    kokoro_device: str = "cpu"
    kokoro_backend: str = "auto"
    kokoro_python: Path | None = None
    sentence_tail: float = 0.4  # silence kept after a sentence: the gap between clips
    fragment_tail: float = FRAGMENT_TAIL_KEEP  # after a mood-tag fragment
    mood_prosody: bool = True  # mood tags also nudge speed, pauses and RVC pitch (#29)
    punctuation_cadence: bool = True  # endings, ! pitch, … pace, dashes shape delivery (#84)
    ellipsis_tail: float = 0.6  # used with punctuation_cadence
    exclaim_tail: float = 0.3
    question_tail: float = 0.4
    emphasis: bool = True  # Kokoro: pause before *word* emphasis from the LLM (#84)
    emphasis_pause: float = 0.12
    interjection_contours: bool = True  # Kokoro: "Aww"/"Ooh" rise then fall (#84)
    interjection_bend: float = 8.0  # semitones at the peak: about one octave with Kokoro's rise (#84)
    word_lifts: bool = True  # Kokoro: lift endearments in address and the word before ! (#84)
    word_lift_bend: float = 4.0  # semitones at the lift's peak
    surprise_bend: float = 5.0  # a surprised word's rise ("whaaat"); not yet listened to (#83)
    hesitation_bend: float = -1.0  # a thinking "hmmm"/"umm" dips slightly; approved by listening (14 Nov 2026, #83)
    # "Hmm?" rises to its end: the usual 9 st rise, falling after 70 %, was no question (14 Nov 2026)
    hesitation_question_bend: float = 10.0  # 10 of 10/12 st (14 Nov 2026)
    affection_bend: float = 5.0  # a fond word's warm rise-fall: 5 of 3/5 st sounded best (14 Nov 2026, #83)
    affection_intensifier_bend: float = 7.0  # the "sooo" in "sooo cute", a little higher (14 Nov 2026)
    replay_cap_mb: int = 500  # spoken turns kept on disk for bubble replay; oldest go first (#152)
    endearment_bend: float = 9.0  # an endearment's own lift: 8 of 4/6/8 st sounded best (9 Nov 2026, #83)
    dynamic_emphasis: bool = True  # Kokoro: deeper, drawn-out "buuut"; brighter *word* (listened 9 Nov 2026, #83)
    drawl_bend: float = -2.0  # semitones at a drawl's dip (slightly deeper; listened 8 Nov 2026)
    drawl_hold: float = 0.0  # off: short vowels break up when held; only used without drawl_stretch
    drawl_stretch: float = 0.125  # seconds per drawn-out sound, said by Kokoro itself (per-token speed, #83)
    quote_voice: bool = True  # Kokoro: pause before and a slight pitch dip across quotes (#84)
    quote_bend: float = -2.0  # semitones at the quote's dip
    quote_pace: float = 0.8  # a quotation's speed × the sentence's, by per-token speed: 0.8 of 0.8/0.9/1 (14 Nov 2026)
    question_rise_bend: float = 9.0  # semitones a question's last word rises (peak at 70 %)
    interjection_hold: float = 0.0  # seconds an "aww" is held; 0 keeps Kokoro's ~0.36 s (#84)
    exclaim_gain: float = 3.0  # dB louder for a clip ending in !, with punctuation_cadence

    def __post_init__(self) -> None:
        self.applio_dir = Path(self.applio_dir).expanduser()
        if self.kokoro_python is not None:
            self.kokoro_python = Path(self.kokoro_python).expanduser()
        if self.pth is None:
            self.pth = self.applio_dir / DEFAULT_MODEL
        if self.index is None:
            self.index = self.applio_dir / DEFAULT_INDEX

    def worker_config(self) -> dict:
        """Settings in the form applio_worker.py expects."""
        return {
            "pth": str(self.pth),
            "index": str(self.index),
            "voice": self.voice,
            "rate": self.rate,
            "pitch": self.pitch,
            "index_rate": self.index_rate,
            "volume_envelope": self.volume_envelope,
            "protect": self.protect,
            "f0_method": self.f0_method,
            "embedder": self.embedder,
            "sid": self.sid,
            "rvc_threads": self.rvc_threads,
            "rvc_device": self.rvc_device,
            "tts_provider": self.tts_provider,
        }

    def check(self) -> None:
        """Fail early, before the first sentence, if Applio is not where expected."""
        if self.tts_provider not in ("edge", "kokoro"):
            raise ValueError("TTS provider must be edge or kokoro.")
        if self.rvc_device not in ("auto", "gpu", "cpu"):
            raise ValueError("RVC device must be auto, gpu or cpu.")
        if self.tts_provider == "kokoro":
            from controller.kokoro_runtime import validate_selection
            validate_selection(self.kokoro_device, self.kokoro_backend)
        if self.rvc_threads < 0:
            raise ValueError("RVC threads must be nonnegative.")
        if not isinstance(self.replay_cap_mb, int) or self.replay_cap_mb < 0:
            raise ValueError("replay_cap_mb must be a nonnegative whole number of MB.")
        for name in ("sentence_tail", "fragment_tail", "ellipsis_tail", "exclaim_tail", "question_tail"):
            value = getattr(self, name)
            if not math.isfinite(value) or not 0.0 <= value <= MAX_TAIL_KEEP:
                raise ValueError(f"{name} must be between 0 and {MAX_TAIL_KEEP} seconds.")
        if not math.isfinite(self.interjection_bend) or abs(self.interjection_bend) > 12.0:
            raise ValueError("interjection_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.word_lift_bend) or abs(self.word_lift_bend) > 12.0:
            raise ValueError("word_lift_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.surprise_bend) or abs(self.surprise_bend) > 12.0:
            raise ValueError("surprise_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.hesitation_bend) or abs(self.hesitation_bend) > 12.0:
            raise ValueError("hesitation_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.hesitation_question_bend) or abs(self.hesitation_question_bend) > 12.0:
            raise ValueError("hesitation_question_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.affection_bend) or abs(self.affection_bend) > 12.0:
            raise ValueError("affection_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.affection_intensifier_bend) or abs(self.affection_intensifier_bend) > 12.0:
            raise ValueError("affection_intensifier_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.endearment_bend) or abs(self.endearment_bend) > 12.0:
            raise ValueError("endearment_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.drawl_bend) or abs(self.drawl_bend) > 12.0:
            raise ValueError("drawl_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.drawl_hold) or not 0.0 <= self.drawl_hold <= 0.45:
            raise ValueError("drawl_hold must be between 0 and 0.45 seconds.")
        if not math.isfinite(self.drawl_stretch) or not 0.0 <= self.drawl_stretch <= 0.125:
            raise ValueError("drawl_stretch must be between 0 and 0.125 seconds.")
        if not math.isfinite(self.quote_bend) or abs(self.quote_bend) > 12.0:
            raise ValueError("quote_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.quote_pace) or not 0.5 <= self.quote_pace <= 1.5:
            raise ValueError("quote_pace must be between 0.5 and 1.5.")
        if not math.isfinite(self.question_rise_bend) or abs(self.question_rise_bend) > 12.0:
            raise ValueError("question_rise_bend must be between -12 and 12 semitones.")
        if not math.isfinite(self.interjection_hold) or not 0.0 <= self.interjection_hold <= 1.2:
            raise ValueError("interjection_hold must be between 0 and 1.2 seconds.")
        if not math.isfinite(self.emphasis_pause) or not 0.0 <= self.emphasis_pause <= 0.3:
            raise ValueError("emphasis_pause must be between 0 and 0.3 seconds.")
        if not math.isfinite(self.exclaim_gain) or not 0.0 <= self.exclaim_gain <= 6.0:
            raise ValueError("exclaim_gain must be between 0 and 6 dB.")
        if self.tts_provider == "kokoro":
            from controller.kokoro_worker import MODEL_DIR, validate_settings

            validate_settings(
                self.kokoro_voice,
                self.kokoro_speed,
                self.kokoro_threads,
                self.kokoro_clause_pause,
            )
            from controller.kokoro_runtime import choose_python
            paths = [choose_python(ROOT, self.kokoro_device, self.kokoro_backend, self.kokoro_python),
                     MODEL_DIR / "voices-v1.0.bin"]
            if self.kokoro_backend != "native" and self.kokoro_device != "gpu":
                paths.append(MODEL_DIR / "kokoro-v1.0.onnx")
            for path in paths:
                if not path.is_file():
                    raise FileNotFoundError(
                        f"Kokoro file not found: {path}; see docs/kokoro-native-worker.md for setup"
                    )
        for path in (
            self.applio_dir / ".venv" / "bin" / "python",
            WORKER_SCRIPT,
            self.pth,
            self.index,
        ):
            if not path.exists():
                raise FileNotFoundError(f"Applio file not found: {path}")


@dataclass
class Segment:
    text: str
    expression: str = "neutral"
    weight: float = 1.0
    emphasis: tuple[int, ...] = ()  # spoken-word indices marked *word* by the LLM


def spoken_words(text: str) -> list[str]:
    """Words that are spoken: any letter or digit (a lone dash or comma is not)."""
    return [word for word in text.split() if any(char.isalnum() for char in word)]


def interjection_words(text: str) -> tuple[int, ...]:
    """Spoken-word indices of interjections that get a rise-fall pitch contour."""
    return tuple(
        index
        for index, word in enumerate(spoken_words(text))
        if INTERJECTION.fullmatch(word.strip(WORD_EDGES))
    )


def _addressed(word: str) -> bool:
    """An endearment used to address someone: followed by punctuation ("sweetheart!")."""
    return word.strip(WORD_EDGES).lower() in ENDEARMENTS and word.rstrip(CLOSING)[-1:] in ",.!?…;:"


def endearment_words(text: str) -> tuple[int, ...]:
    """Spoken-word indices of endearments used in address; they get the higher endearment lift."""
    return tuple(index for index, word in enumerate(spoken_words(text)) if _addressed(word))


@functools.cache
def lexicon() -> frozenset[str]:
    """Lower-case words for checking elongations: the system word list, else a small built-in one."""
    try:
        with open(SYSTEM_WORDS, encoding="utf-8") as source:
            words = {line.strip().lower() for line in source if line.strip().isalpha()}
    except OSError:
        words = set(FALLBACK_WORDS)
    return frozenset(words | SPOKEN_WORDS)


def _with_case(word: str, like: str) -> str:
    if len(like) > 1 and like.isupper():
        return word.upper()
    return word[:1].upper() + word[1:] if like[:1].isupper() else word


def _unstretch(core: str, words: frozenset[str]) -> tuple[str, int] | None:
    """(real word, longest run written) for an elongated spelling, or None if it is not one.

    Each run of one letter is tried as 1, 2 or 3 letters, and the longest candidate
    in ``words`` wins (coooool → cool, not "col"). A candidate needs a vowel unless
    it is a spoken word such as "hmm", so "brrr" is left alone. Two-letter runs only
    change a word that is not itself in ``words`` ("soo" → so, "too" stays).
    """
    lower = core.lower()
    if INTERJECTION.fullmatch(core) or any(mark in core for mark in "./@"):
        return None
    runs = [match.span() for match in LETTER_RUN.finditer(lower)]
    longest = max((end - start for start, end in runs), default=0)
    if not runs or len(runs) > MAX_RUNS or (longest < 3 and lower in words):
        return None
    candidates = [""]
    cut = 0
    for start, end in runs:
        letter, choices = lower[start], range(1, min(3, end - start) + 1)
        candidates = [head + lower[cut:start] + letter * n for head in candidates for n in choices]
        cut = end
    candidates = [candidate + lower[cut:] for candidate in candidates]
    valid = [candidate for candidate in candidates
             if candidate != lower and (candidate in words or candidate in SPOKEN_WORDS)
             and (candidate in SPOKEN_WORDS or any(vowel in candidate for vowel in "aeiouy"))]
    if not valid:
        return None
    return _with_case(max(valid, key=len), core), longest


def elongation_stretch(letters: int, seconds: float) -> float:
    """Seconds per drawn-out sound for a run of ``letters``: two letters get 60 %.

    It cannot grow past ``seconds``: 5 frames (0.125 s) is the most one sound may take.
    """
    return round(seconds * (0.6 if letters < 3 else 1.0), 4)


def unstretch_spellings(
    text: str, words: frozenset[str] | None = None
) -> tuple[str, tuple[tuple[int, int], ...]]:
    """Speak elongated spellings as the real word.

    Returns the text and (spoken-word index, longest run written) for each one.
    Punctuation, case and the word count are kept, so word indices still line up.
    """
    if not LETTER_RUN.search(text):  # most lines: nothing repeated
        return text, ()
    words = lexicon() if words is None else words
    found, index = [], 0

    def replace(match: re.Match) -> str:
        nonlocal index
        token = match.group(0)
        if not any(char.isalnum() for char in token):
            return token
        start = len(token) - len(token.lstrip(WORD_EDGES))
        end = len(token.rstrip(WORD_EDGES))
        result = _unstretch(token[start:end], words) if start < end else None
        if result is not None:
            found.append((index, result[1]))
            token = token[:start] + result[0] + token[end:]
        index += 1
        return token

    return re.sub(r"\S+", replace, text), tuple(found)


def lift_words(text: str) -> tuple[int, ...]:
    """Spoken-word indices that get a pitch lift: endearments in address, and the word before "!".

    Interjections are skipped; they have their own, larger contour.
    """
    words = spoken_words(text)
    lifts = []
    for index, word in enumerate(words):
        core = word.strip(WORD_EDGES)
        if INTERJECTION.fullmatch(core):
            continue
        addressed = _addressed(word)
        exclaimed = index == len(words) - 1 and ending(text) == "exclaim"
        if addressed or exclaimed:
            lifts.append(index)
    return tuple(lifts)


@dataclass(frozen=True)
class Delivery:
    """How a family of words is said (#83): which words, in which moods, its bend and length."""

    family: str
    words: frozenset[str]
    moods: frozenset[str] | None = None  # None: any mood
    opener_only: bool = False  # only as the sentence's first word
    bend: str = "drawl_bend"  # ApplioSettings field with the bend's semitones
    peak: float | None = None  # where the bend peaks; None keeps the default rise-fall
    stretch: bool = True  # Kokoro draws its stressed sound out (drawl_stretch)
    # Only when said on its own: before ?!,…;: or an elongated spelling ("whaaat"); not "What do…".
    # Keeps intensifier "really" ("I'm really happy!") and relative "what" out (#123 review).
    standalone: bool = False
    before: frozenset[str] | None = None  # only right before one of these words ("so" in "so cute")
    # ApplioSettings field with the row's own rise when the word ends a question, rising to its end
    # ("Hmm?"); None: the usual question rise wins and the word is only drawn out ("Really?").
    question_bend: str | None = None


# The first row that matches a word wins. Docs: docs/testing-kokoro.md §2g.
DELIVERIES: tuple[Delivery, ...] = (
    # Before the drawls, so a fond "So cute!" is warm rather than a deeper "Sooo…".
    Delivery("affection", AFFECTION_INTENSIFIERS, moods=AFFECTIONATE_MOODS,
             bend="affection_intensifier_bend", before=AFFECTION_WORDS),  # "sooo cute", "too sweet"
    Delivery("affection", AFFECTION_WORDS, moods=AFFECTIONATE_MOODS, bend="affection_bend"),
    Delivery("drawl", DRAWL_OPENERS, opener_only=True),  # "Buuut…", "Wellll…"
    Delivery("drawl", ATTITUDE_WORDS, moods=SKEPTICAL_MOODS),  # sarcastic "suuure"
    Delivery("surprise", SURPRISE_WORDS, moods=SURPRISED_MOODS, bend="surprise_bend",
             peak=QUESTION_PEAK, standalone=True),  # "Whaaat?", "Reeeally?" rising
    Delivery("hesitation", HESITATION_WORDS, bend="hesitation_bend",
             question_bend="hesitation_question_bend"),  # "Hmmm…", "Ummm", a rising "Hmm?"
)


def delivered_words(
    text: str, expression: str, rows: tuple[Delivery, ...] = DELIVERIES,
    elongated: tuple[int, ...] = (),
) -> dict[int, Delivery]:
    """Spoken-word index → the first delivery row that matches the word, mood and position.

    ``elongated`` are word indices written drawn out ("whaaat"); they count as said on their own.
    """
    found = {}
    words = spoken_words(text)
    for index, word in enumerate(words):
        core = word.strip(WORD_EDGES).lower()
        alone = word.rstrip(CLOSING)[-1:] in "?!,…;:" or index in elongated
        after = words[index + 1].strip(WORD_EDGES).lower() if index + 1 < len(words) else None
        for row in rows:
            if (core in row.words and (row.moods is None or expression in row.moods)
                    and (index == 0 or not row.opener_only) and (alone or not row.standalone)
                    and (row.before is None or after in row.before)):
                found[index] = row
                break
    return found


def drawl_words(
    text: str, expression: str, emphasis: tuple[int, ...] = (), found: dict[int, Delivery] | None = None
) -> tuple[int, ...]:
    """Spoken-word indices to say deeper and drawn out.

    The drawl rows of DELIVERIES (a sentence-opening But/Well/So/Now/Okay; in
    skeptical moods the attitude words), plus ``*word*`` marks in skeptical moods.
    """
    found = delivered_words(text, expression) if found is None else found
    drawls = {i for i, row in found.items() if row.family == "drawl"}
    if expression in SKEPTICAL_MOODS:
        drawls |= {i for i in emphasis if i < len(spoken_words(text))}
    return tuple(sorted(drawls))


def quote_words(text: str) -> list[tuple[int, int]]:
    """(first, last) spoken-word indices of each balanced "…" or “…” quotation."""
    quotes, start = [], None
    for index, word in enumerate(spoken_words(text)):
        opens = word.lstrip("([*")[:1] in OPENING_QUOTES
        closes = word.rstrip(".,!?…;:)]*")[-1:] in CLOSING_QUOTES and (start is not None or opens)
        if start is None and opens:
            start = index
        if start is not None and closes and (index > start or word.count('"') + word.count("“") + word.count("”") >= 2):
            quotes.append((start, index))
            start = None
    return quotes


def question_words(text: str) -> tuple[int, ...]:
    """The last spoken word of a question, which should rise rather than fall."""
    words = spoken_words(text)
    return (len(words) - 1,) if words and ending(text) == "question" else ()


def clean_for_tts(text: str) -> str:
    """Remove Markdown symbols, emoji and control characters; collapse whitespace."""
    kept = []
    for char in text:
        category = unicodedata.category(char)
        # So: emoji and other symbols; C*: control, format and unassigned; FE0x: emoji variation selectors.
        drop = char != EMPHASIS_MARK and (
            char in "*_`#>~|"
            or category == "So"
            or category.startswith("C")
            or 0xFE00 <= ord(char) <= 0xFE0F
        )
        kept.append(" " if drop else char)
    # A leading dash could be read as a command-line option further down.
    return " ".join("".join(kept).split()).lstrip("-– ")


def shape_punctuation(text: str) -> str:
    """Turn dashes into commas so Kokoro's clause pause applies; keep number ranges and hyphenated words."""
    text = DIGIT_RANGE.sub(" to ", text)
    text = DASH.sub(", ", text)
    text = re.sub(r",(\s*,)+", ",", text)
    text = re.sub(r",\s*(?=[.!?…])", "", text)
    # Leading junk goes; a trailing comma from a dash stays, so its pause is kept.
    return " ".join(text.split()).lstrip(" ,")


def speakable(text: str) -> bool:
    return any(char.isalnum() for char in text)


@dataclass
class Segmenter:
    """Group parsed bridge events into sentences, each with the mood active at its start.

    A mood tag closes the current fragment so the new mood starts with the
    following text, matching where the LLM placed the tag.
    """

    expression: str = "neutral"
    weight: float = 1.0
    buffer: str = ""
    _done: list[Segment] = field(default_factory=list)

    def _emit(self, text: str) -> None:
        # A stray marker from the LLM must not create a phantom emphasis.
        text = text.replace(EMPHASIS_MARK, "")
        marked = clean_for_tts(EMPHASIS.sub(lambda m: EMPHASIS_MARK + m.group(1), text))
        # Untrusted markup: keep the first marks the worker accepts rather than fail the sentence.
        emphasis = tuple(
            index
            for index, word in enumerate(spoken_words(marked))
            if EMPHASIS_MARK in word
        )[:MAX_EMPHASIS]
        cleaned = " ".join(marked.replace(EMPHASIS_MARK, "").split())
        if speakable(cleaned):
            self._done.append(Segment(cleaned, self.expression, self.weight, emphasis))

    def feed(self, event: dict) -> list[Segment]:
        if event["type"] == "expression":
            self._emit(self.buffer)
            self.buffer = ""
            self.expression, self.weight = event["name"], event["weight"]
        elif event["type"] == "say":
            self.buffer = ELLIPSIS_TOUCH.sub(r"\1 ", self.buffer + event["text"])
            pieces = SENTENCE_END.split(self.buffer)
            # split() alternates text and captured closers; reattach each closer.
            parts = [a + b for a, b in zip(pieces[0::2], pieces[1::2] + [""])]
            for sentence in parts[:-1]:
                self._emit(sentence)
            self.buffer = parts[-1]
        done, self._done = self._done, []
        return done

    def finish(self) -> list[Segment]:
        self._emit(self.buffer)
        self.buffer = ""
        done, self._done = self._done, []
        return done


def clear_live_clips(directory: Path = LIVE_DIR) -> None:
    """Delete clips from earlier runs. Only touches files named by clip ID."""
    if not directory.is_dir():
        return
    for path in directory.iterdir():
        if path.is_file() and CLIP_ID.fullmatch(path.name.split(".", 1)[0]):
            path.unlink()


class ApplioWorker:
    """Bridge-side handle on applio_worker.py: started once, kept warm, restarted if it dies.

    Replies are matched to requests by ID, so a cancelled request's late reply
    is simply dropped. Requests carry a run ID so a cancelled reply's queued
    sentences can be dropped by the worker (see applio_worker.py).
    """

    def __init__(
        self,
        settings: ApplioSettings,
        command: list[str] | None = None,
        log_path: Path = WORKER_LOG,
        cwd: Path | None = None,
        name: str = "Applio",
    ):
        self.settings = settings
        self.name = name
        self.cwd = cwd or settings.applio_dir
        self.kokoro = None
        if command is None and settings.tts_provider == "kokoro":
            from controller.kokoro_runtime import choose_python
            self.kokoro = ApplioWorker(
                settings,
                command=[
                    str(choose_python(ROOT, settings.kokoro_device, settings.kokoro_backend, settings.kokoro_python)),
                    "-m",
                    "controller.kokoro_worker",
                    "--worker",
                    "--voice",
                    settings.kokoro_voice,
                    "--speed",
                    str(settings.kokoro_speed),
                    "--clause-pause",
                    str(settings.kokoro_clause_pause),
                    "--threads",
                    str(settings.kokoro_threads),
                    "--device", settings.kokoro_device,
                    "--backend", settings.kokoro_backend,
                ],
                name="Kokoro",
                log_path=WORKER_LOG.with_name("kokoro-worker.log"),
                cwd=ROOT,
            )
        self.command = command or self.applio_command(settings)
        self.log_path = log_path
        self.process: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.starting = asyncio.Lock()
        self.ready: dict = {}

    @staticmethod
    def applio_command(settings: ApplioSettings) -> list[str]:
        """The Applio worker's command line under the selected installation."""
        return [
            str(settings.applio_dir / ".venv" / "bin" / "python"),
            str(WORKER_SCRIPT),
            json.dumps(settings.worker_config()),
        ]

    def alive(self) -> bool:
        return (
            self.process is not None
            and self.process.returncode is None
            and self.reader is not None
            and not self.reader.done()
        )

    async def start(self) -> dict:
        """Start and warm the worker if it is not running; return its ready message."""
        async with self.starting:
            if self.alive():
                return self.ready
            await self.close()
            if self.kokoro is not None:
                await self.kokoro.start()
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_path, "wb") as log:
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    cwd=self.cwd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=log,
                )
            line = await self.process.stdout.readline()
            try:
                message = json.loads(line)
            except ValueError:
                message = {}
            if not isinstance(message, dict) or not message.get("ready"):
                await self.close()
                reason = message.get("error") if isinstance(message, dict) else None
                raise RuntimeError(
                    f"{self.name} worker failed to start: {reason}; see {self.log_path}"
                    if reason else f"{self.name} worker failed to start; see {self.log_path}"
                )
            self.ready, self.pending = message, {}
            self.reader = asyncio.create_task(self._read(self.process, self.pending))
            return message

    async def _read(self, process: asyncio.subprocess.Process, pending: dict) -> None:
        while line := await process.stdout.readline():
            try:
                message = json.loads(line)
                future = pending.pop(message.get("id"), None)
            except (ValueError, AttributeError):
                LOG.warning("Dropped invalid %s worker line", self.name)
                continue
            if future is not None and not future.done():
                future.set_result(message)
        for future in pending.values():
            if not future.done():
                future.set_exception(
                    RuntimeError(f"{self.name} worker exited; see {self.log_path}")
                )
        pending.clear()

    def _kokoro_fields(
        self,
        prosody: Prosody | None,
        emphasis: tuple[int, ...] = (),
        contours: tuple[int, ...] = (),
    ) -> dict:
        """Per-sentence Kokoro fields: speed and clause pause in the worker's ranges, emphasis, spans."""
        s = self.settings
        fields = {}
        if emphasis:
            fields = {"emphasis": list(emphasis), "emphasis_pause": s.emphasis_pause}
        if contours:
            fields["spans"] = list(contours)
        if prosody is None:
            return fields
        return {
            **fields,
            "speed": round(min(2.0, max(0.5, s.kokoro_speed * prosody.speed)), 4),
            "clause_pause": round(min(0.5, max(0.0, s.kokoro_clause_pause * prosody.clause_pause)), 4),
        }

    async def request(
        self,
        text: str,
        source: Path,
        output: Path,
        run: str | None = None,
        prosody: Prosody | None = None,
        fields: dict | None = None,
        emphasis: tuple[int, ...] = (),
        contours: tuple[int, ...] = (),
        holds: tuple[tuple[int, float], ...] = (),
        lifts: tuple[int, ...] = (),
        rises: tuple[int, ...] = (),
        quotes: tuple[tuple[int, int], ...] = (),
        drawls: tuple[int, ...] = (),
        endearments: tuple[int, ...] = (),
        elongated: tuple[tuple[int, float], ...] = (),
        delivered: tuple[tuple[int, float | None, float | None, bool], ...] = (),
    ) -> dict:
        """Synthesise ``text`` into ``source`` and convert into ``output``.

        ``prosody`` adds optional per-sentence fields: speed and clause pause for
        Kokoro, a semitone shift for RVC. ``fields`` are extra protocol fields for
        this worker's own line (used for the nested Kokoro worker). ``contours``
        are word indices whose Kokoro time spans become RVC pitch bends.
        """
        await self.start()
        source_metrics = None
        # Interjections first, so they keep their contour if the per-sentence cap is reached.
        quoted = [index for pair in quotes for index in pair]
        # A drawl keeps Kokoro's own vowel ("bˈʌːːt" was heard as "boot"); Kokoro says it
        # longer with per-token speed, or, with that off, the vowel is held.
        stretching = self.settings.drawl_stretch > 0
        # Delivery rows other than drawls: (word, semitones or None, peak or None, stretch).
        row_bends = {index: (semitones, peak) for index, semitones, peak, _ in delivered if semitones is not None}
        # Drawls first (with their own stretch), then elongated spellings, then delivery rows.
        seconds = {index: self.settings.drawl_stretch for index in drawls}
        for index, stretched in elongated:
            seconds.setdefault(index, stretched)
        for index, _, _, stretched in delivered:
            if stretched:
                seconds.setdefault(index, self.settings.drawl_stretch)
        stretch = [[index, value] for index, value in seconds.items()][:MAX_SPANS] if stretching else []
        held = [list(hold) for hold in holds]
        if not stretching and self.settings.drawl_hold > 0:
            held += [[index, self.settings.drawl_hold] for index in drawls
                     if index not in {hold[0] for hold in holds}]
        held = held[:MAX_SPANS]
        # A quotation's own pace (#83): Kokoro says its words at quote_pace × the sentence's speed.
        pace = self.settings.quote_pace
        paces = [[first, last, pace] for first, last in quotes][:MAX_SPANS] if pace != 1.0 else []
        spanned = tuple(dict.fromkeys([*contours, *drawls, *row_bends, *rises, *quoted, *lifts]))[:MAX_SPANS]
        if self.kokoro is not None:
            source_metrics = await self.kokoro.request(
                text, source, output, run,
                fields={
                    **self._kokoro_fields(prosody, emphasis, spanned),
                    **({"holds": held} if held else {}),
                    **({"stretch": stretch} if stretch else {}),
                    **({"paces": paces} if paces else {}),
                },
            )
        request_id = secrets.token_hex(8)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        own = dict(fields or {})
        if prosody is not None:
            own["pitch"] = prosody.pitch
        bends, bent, dipped = [], [], 0
        if spanned and source_metrics:
            spans = source_metrics.get("wordSpans", [])
            words = source_metrics.get("spanWords", list(spanned[: len(spans)]))
            found = dict(zip(words, spans))
            for word, (start, end) in found.items():
                if word in contours:
                    bends.append([start, end, self.settings.interjection_bend])
                elif word in drawls:  # deeper as well as longer
                    bends.append([start, end, self.settings.drawl_bend])
                elif word in row_bends:  # a delivery row's own bend (surprise rises)
                    semitones, peak = row_bends[word]
                    bends.append([start, end, semitones, *([] if peak is None else [peak])])
                elif word in rises:  # a question rises against Kokoro's fall
                    bends.append([start, end, self.settings.question_rise_bend, QUESTION_PEAK])
                elif word in lifts:
                    lift = self.settings.endearment_bend if word in endearments else self.settings.word_lift_bend
                    bends.append([start, end, lift])
                else:
                    continue
                bent.append(word)
            dipped = 0
            for first, last in quotes:  # one gentle dip across the whole quotation
                if first in found and last in found:
                    bends.append([found[first][0], found[last][1], self.settings.quote_bend, QUOTE_PEAK])
                    dipped += 1
            bends = bends[:MAX_SPANS]
            if bends:
                own["bend"] = bends
        line = json.dumps(
            {
                **own,
                "id": request_id,
                "run": run,
                "text": text,
                "source": str(source),
                "output": str(output),
            }
        )
        self.process.stdin.write(line.encode() + b"\n")
        await self.process.stdin.drain()
        message = await future
        if not message.get("ok"):
            raise RuntimeError(f"{self.name} worker: {message.get('error')}")
        if source_metrics is not None:
            message.pop("edgeSeconds", None)
            message.pop("edgeRetries", None)
            message.update(
                {
                    key: source_metrics[key]
                    for key in (
                        "ttsProvider",
                        "ttsSeconds",
                        "sourceSeconds",
                        "sampleRate",
                        "ttsRtf",
                        "emphasisPauses",
                        "stretched",
                        "stretchSkipped",
                        "paced",
                        "paceSkipped",
                    )
                    if key in source_metrics
                }
            )
        if contours:
            message["contours"] = sum(word in contours for word in bent)
        if drawls:
            message["drawls"] = sum(word in drawls and word not in contours for word in bent)
        if delivered:
            # Row words that were bent, or drawn out (a question's own rise may have won).
            drawn_rows = {index for index, _, _, stretched in delivered
                          if stretched and any(item[0] == index for item in stretch)}
            message["delivered"] = len({word for word in bent if word in row_bends and word not in contours}
                                       | drawn_rows)
        if quotes:
            message["quotes"] = dipped
        if rises:
            message["rises"] = sum(word in rises and word not in contours for word in bent)
        if lifts:
            message["lifts"] = sum(
                word in lifts and word not in contours and word not in rises for word in bent
            )
        return message

    def cancel(self, run: str) -> None:
        """Ask the worker to drop this run's sentences that have not started RVC."""
        if self.kokoro is not None:
            self.kokoro.cancel(run)
        if self.alive():
            self.process.stdin.write(json.dumps({"cancel": run}).encode() + b"\n")

    async def close(self) -> None:
        """Stop the worker: end its input, then kill it if it does not exit."""
        if self.kokoro is not None:
            await self.kokoro.close()
        process, self.process = self.process, None
        if process is not None and process.returncode is None:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()
        if self.reader is not None:
            await asyncio.gather(self.reader, return_exceptions=True)
            self.reader = None


async def synthesise(
    segment: Segment,
    worker: ApplioWorker,
    run: str | None = None,
    directory: Path = LIVE_DIR,
) -> tuple[str, dict]:
    """Create ``<id>.wav`` and ``<id>.visemes.json``; return the ID and stage timings."""
    directory.mkdir(parents=True, exist_ok=True)
    clip_id = secrets.token_hex(8)
    text_path = directory / f"{clip_id}.txt"
    extension = "wav" if worker.settings.tts_provider == "kokoro" else "mp3"
    source = directory / f"{clip_id}.src.{extension}"
    wav = directory / f"{clip_id}.wav"
    settings = worker.settings
    text = shape_punctuation(segment.text) if settings.punctuation_cadence else segment.text
    elongated = ()
    if settings.tts_provider == "kokoro":
        text, elongated = unstretch_spellings(text)
    text_path.write_text(text + "\n", encoding="utf-8")
    tails = {"sentence_tail": settings.sentence_tail, "fragment_tail": settings.fragment_tail}
    if settings.punctuation_cadence:
        tails.update(
            ellipsis_tail=settings.ellipsis_tail,
            exclaim_tail=settings.exclaim_tail,
            question_tail=settings.question_tail,
            clause_tail=settings.kokoro_clause_pause,
        )
    prosody = None
    if settings.mood_prosody or settings.punctuation_cadence:
        prosody = combine(
            prosody_for(segment.expression, segment.weight)
            if settings.mood_prosody
            else Prosody(),
            punctuation_prosody(
                text, segment.expression, segment.weight, settings.exclaim_gain
            )
            if settings.punctuation_cadence
            else Prosody(),
        )
    try:
        options = {}
        if (
            settings.emphasis
            and settings.tts_provider == "kokoro"
            and segment.emphasis
            # Dash shaping can change the word count ("1–5" → "1 to 5"); skip rather than misplace.
            and len(spoken_words(text)) == len(spoken_words(segment.text))
        ):
            options["emphasis"] = segment.emphasis
        if settings.interjection_contours and settings.tts_provider == "kokoro":
            contours = interjection_words(text)
            if contours:
                options["contours"] = contours
                words = spoken_words(text)
                holds = tuple(
                    (index, settings.interjection_hold)
                    for index in contours
                    if settings.interjection_hold > 0
                    and AWW_WORD.fullmatch(words[index].strip(AWW_EDGES))
                )
                if holds:
                    options["holds"] = holds
        if settings.quote_voice and settings.tts_provider == "kokoro":
            quotes = tuple(quote_words(text))
            if quotes:
                options["quotes"] = quotes
                firsts = [first for first, _ in quotes]
                merged = tuple(dict.fromkeys([*options.get("emphasis", ()), *firsts]))
                options["emphasis"] = merged[:MAX_EMPHASIS]  # a pause before each quote
        if settings.word_lifts and settings.tts_provider == "kokoro":
            rises = question_words(text)
            lifts = tuple(index for index in lift_words(text) if index not in rises)
            if rises:
                options["rises"] = rises
            if lifts:
                options["lifts"] = lifts
        if settings.dynamic_emphasis and settings.tts_provider == "kokoro":
            same_words = len(spoken_words(text)) == len(spoken_words(segment.text))
            marked = segment.emphasis if same_words else ()
            found = delivered_words(text, segment.expression, elongated=tuple(i for i, _ in elongated))
            drawls = drawl_words(text, segment.expression, marked, found)
            if drawls:
                options["drawls"] = drawls
                for key in ("rises", "lifts"):
                    kept = tuple(i for i in options.get(key, ()) if i not in drawls)
                    if kept:
                        options[key] = kept
                    else:
                        options.pop(key, None)
            rows = {i: row for i, row in found.items() if row.family != "drawl" and i not in drawls}
            if rows:  # a question's own rise wins and the word is only drawn out, unless the row has its own
                own_rise = {i for i, row in rows.items() if row.question_bend and i in options.get("rises", ())}
                if own_rise:
                    kept = tuple(i for i in options["rises"] if i not in own_rise)
                    if kept:
                        options["rises"] = kept
                    else:
                        options.pop("rises")
                rising = options.get("rises", ())
                options["delivered"] = tuple(
                    (i, getattr(settings, row.question_bend), 1.0, row.stretch) if i in own_rise
                    else (i, None, None, row.stretch) if i in rising
                    else (i, getattr(settings, row.bend), row.peak, row.stretch)
                    for i, row in sorted(rows.items())
                )
                kept = tuple(i for i in options.get("lifts", ()) if i not in rows or i in rising)
                if kept:
                    options["lifts"] = kept
                else:
                    options.pop("lifts", None)
            bright = tuple(i for i in marked if i not in drawls and i not in rows)
            if bright:  # a *word* in a non-skeptical mood is lifted as well as paused
                options["lifts"] = tuple(dict.fromkeys([*options.get("lifts", ()), *bright]))
        if elongated and settings.dynamic_emphasis:
            options["elongated"] = tuple(
                (index, elongation_stretch(letters, settings.drawl_stretch)) for index, letters in elongated
            )
        if "lifts" in options:
            endearments = tuple(i for i in endearment_words(text) if i in options["lifts"])
            if endearments:
                options["endearments"] = endearments
        reply = await worker.request(text, source, wav, run, prosody=prosody, **options)
        # Trim before aligning so the lip-sync timings match the audio that plays.
        trim = await asyncio.to_thread(trim_clip, source, wav, text, **tails)
        gain = None
        if prosody is not None and prosody.gain_db > 0:
            gain = await asyncio.to_thread(apply_gain, wav, prosody.gain_db)
        source.unlink(missing_ok=True)
        track = await asyncio.to_thread(
            align, wav, text_path, worker.settings.recognizer
        )
        (directory / f"{clip_id}.visemes.json").write_text(
            json.dumps(track, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    except BaseException:
        for path in directory.glob(f"{clip_id}.*"):
            path.unlink(missing_ok=True)
        raise
    finally:
        source.unlink(missing_ok=True)
    metrics = {
        key: reply[key]
        for key in (
            "edgeSeconds",
            "edgeRetries",
            "ttsProvider",
            "ttsSeconds",
            "sourceSeconds",
            "sampleRate",
            "ttsRtf",
            "emphasisPauses",
            "stretched",
            "stretchSkipped",
            "paced",
            "paceSkipped",
            "contours",
            "lifts",
            "rises",
            "quotes",
            "drawls",
            "delivered",
        )
        if key in reply
    }
    if prosody is not None:
        metrics["prosody"] = {
            "speed": prosody.speed,
            "clausePause": prosody.clause_pause,
            "pitch": prosody.pitch,
        }
        if gain is not None:
            metrics["prosody"]["gainDb"] = gain["gainDb"]
            metrics["prosody"]["limitDb"] = gain.get("limitDb", 0.0)
    return clip_id, {
        **metrics,
        "rvcSeconds": reply["rvcSeconds"],
        "alignSeconds": track["alignSeconds"],
        "untrimmedSeconds": trim["beforeSeconds"],
        "audioSeconds": track["duration"],
    }
