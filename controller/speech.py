"""Turn streamed LLM text into spoken, lip-synced clips.

First integration version: each completed sentence is synthesised with
Applio (Edge TTS -> RVC), aligned with Rhubarb, and announced to the renderer
as a clip ID. Sentences are processed one at a time, in order.

Clips are written to ``assets/private/speech/live/`` (gitignored). Only the
generated ID crosses the WebSocket; the renderer builds the URL itself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from controller.speech_align import align

ROOT = Path(__file__).resolve().parents[1]
LIVE_DIR = ROOT / 'assets' / 'private' / 'speech' / 'live'
APPLIO_DIR = ROOT.parent / 'Applio'
CLIP_ID = re.compile(r'[0-9a-f]{16}')
# A sentence ends at . ! ? or … (optionally followed by closing quotes) plus whitespace.
SENTENCE_END = re.compile(r'(?<=[.!?…])["\')\]]*\s+')
EDGE_ATTEMPTS = 3
LOG = logging.getLogger(__name__)


@dataclass
class ApplioSettings:
    """Values from the user's Applio TTS tab; CLI defaults differ for some."""
    applio_dir: Path = APPLIO_DIR
    # The UI used Yidhari-zzz_75e_14475s.pth, which is not on this laptop yet.
    pth: Path = APPLIO_DIR / 'logs' / 'Yidhari-zzz' / 'Yidhari-zzz_75e_21450s.pth'
    index: Path = APPLIO_DIR / 'logs' / 'Yidhari-zzz' / 'Yidhari-zzz.index'
    voice: str = 'en-US-JennyNeural'
    rate: int = -15
    pitch: int = 0
    index_rate: float = 0.7
    volume_envelope: float = 1.0
    protect: float = 0.5
    f0_method: str = 'rmvpe'
    embedder: str = 'contentvec'
    sid: int = 0
    recognizer: str = 'phonetic'

    def check(self) -> None:
        """Fail early, before the first sentence, if Applio is not where expected."""
        for path in (self.applio_dir / 'core.py', self.applio_dir / '.venv' / 'bin' / 'python',
                     self.pth, self.index):
            if not path.exists():
                raise FileNotFoundError(f'Applio file not found: {path}')


@dataclass
class Segment:
    text: str
    expression: str = 'neutral'
    weight: float = 1.0


def clean_for_tts(text: str) -> str:
    """Remove Markdown symbols, emoji and control characters; collapse whitespace."""
    kept = []
    for char in text:
        category = unicodedata.category(char)
        # So: emoji and other symbols; C*: control, format and unassigned; FE0x: emoji variation selectors.
        drop = char in '*_`#>~|' or category == 'So' or category.startswith('C') or 0xFE00 <= ord(char) <= 0xFE0F
        kept.append(' ' if drop else char)
    # A leading dash could be read as a command-line option further down.
    return ' '.join(''.join(kept).split()).lstrip('-– ')


def speakable(text: str) -> bool:
    return any(char.isalnum() for char in text)


@dataclass
class Segmenter:
    """Group parsed bridge events into sentences, each with the mood active at its start.

    A mood tag closes the current fragment so the new mood starts with the
    following text, matching where the LLM placed the tag.
    """
    expression: str = 'neutral'
    weight: float = 1.0
    buffer: str = ''
    _done: list[Segment] = field(default_factory=list)

    def _emit(self, text: str) -> None:
        cleaned = clean_for_tts(text)
        if speakable(cleaned):
            self._done.append(Segment(cleaned, self.expression, self.weight))

    def feed(self, event: dict) -> list[Segment]:
        if event['type'] == 'expression':
            self._emit(self.buffer)
            self.buffer = ''
            self.expression, self.weight = event['name'], event['weight']
        elif event['type'] == 'say':
            self.buffer += event['text']
            parts = SENTENCE_END.split(self.buffer)
            for sentence in parts[:-1]:
                self._emit(sentence)
            self.buffer = parts[-1]
        done, self._done = self._done, []
        return done

    def finish(self) -> list[Segment]:
        self._emit(self.buffer)
        self.buffer = ''
        done, self._done = self._done, []
        return done


def clear_live_clips(directory: Path = LIVE_DIR) -> None:
    """Delete clips from earlier runs. Only touches files named by clip ID."""
    if not directory.is_dir():
        return
    for path in directory.iterdir():
        if path.is_file() and CLIP_ID.fullmatch(path.name.split('.', 1)[0]):
            path.unlink()


async def synthesise(segment: Segment, settings: ApplioSettings,
                     directory: Path = LIVE_DIR) -> tuple[str, dict]:
    """Create ``<id>.wav`` and ``<id>.visemes.json``; return the ID and stage timings."""
    directory.mkdir(parents=True, exist_ok=True)
    clip_id = secrets.token_hex(8)
    text_path = directory / f'{clip_id}.txt'
    source = directory / f'{clip_id}.src.mp3'
    wav = directory / f'{clip_id}.wav'
    text_path.write_text(segment.text + '\n', encoding='utf-8')
    command = [
        str(settings.applio_dir / '.venv' / 'bin' / 'python'), 'core.py', 'tts',
        f'--tts-file={text_path}', f'--tts-text={segment.text}',
        f'--tts-voice={settings.voice}', f'--tts-rate={settings.rate}',
        f'--output-tts-path={source}', f'--output-rvc-path={wav}',
        f'--pth-path={settings.pth}', f'--index-path={settings.index}',
        f'--pitch={settings.pitch}', f'--index-rate={settings.index_rate}',
        f'--volume-envelope={settings.volume_envelope}', f'--protect={settings.protect}',
        f'--f0-method={settings.f0_method}', f'--embedder-model={settings.embedder}',
        f'--sid={settings.sid}', '--export-format=WAV',
    ]
    started = time.perf_counter()
    try:
        for attempt in range(1, EDGE_ATTEMPTS + 1):
            returncode, output = await _run(command, settings.applio_dir)
            if returncode == 0 and wav.exists():
                break
            # Edge TTS intermittently answers 429 (rate limited); it fails fast, so retry.
            if '429' not in output or attempt == EDGE_ATTEMPTS:
                raise RuntimeError(f'Applio TTS failed ({returncode}): {output[-800:]}')
            LOG.warning('Edge TTS rate limited; retry %d/%d', attempt, EDGE_ATTEMPTS - 1)
            await asyncio.sleep(attempt)
        tts_seconds = time.perf_counter() - started
        track = await asyncio.to_thread(align, wav, text_path, settings.recognizer)
        (directory / f'{clip_id}.visemes.json').write_text(
            json.dumps(track, ensure_ascii=False) + '\n', encoding='utf-8')
    except BaseException:
        for path in directory.glob(f'{clip_id}.*'):
            path.unlink(missing_ok=True)
        raise
    finally:
        source.unlink(missing_ok=True)
    return clip_id, {'ttsSeconds': round(tts_seconds, 2), 'alignSeconds': track['alignSeconds'],
                     'audioSeconds': track['duration']}


async def _run(command: list[str], cwd: Path) -> tuple[int, str]:
    """Run a command, killing it if the caller is cancelled; return code and output."""
    process = await asyncio.create_subprocess_exec(
        *command, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        stdout, _ = await process.communicate()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    return process.returncode, stdout.decode(errors='replace')
