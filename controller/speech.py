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
import json
import logging
import re
import secrets
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from controller.speech_align import align
from controller.speech_trim import trim_clip

ROOT = Path(__file__).resolve().parents[1]
LIVE_DIR = ROOT / "assets" / "private" / "speech" / "live"
APPLIO_DIR = ROOT.parent / "Applio"
DEFAULT_MODEL = Path("logs") / "Yidhari-zzz" / "Yidhari-zzz_75e_21450s.pth"
DEFAULT_INDEX = Path("logs") / "Yidhari-zzz" / "Yidhari-zzz.index"
CLIP_ID = re.compile(r"[0-9a-f]{16}")
# A sentence ends at . ! ? or … (optionally followed by closing quotes) plus whitespace.
SENTENCE_END = re.compile(r'(?<=[.!?…])["\')\]]*\s+')
WORKER_SCRIPT = Path(__file__).with_name("applio_worker.py")
WORKER_LOG = LIVE_DIR.parent / "applio-worker.log"
LOG = logging.getLogger(__name__)


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
    tts_provider: str = "edge"
    kokoro_voice: str = "af_heart"
    kokoro_speed: float = 1.0
    kokoro_threads: int = 2

    def __post_init__(self) -> None:
        self.applio_dir = Path(self.applio_dir).expanduser()
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
            "tts_provider": self.tts_provider,
        }

    def check(self) -> None:
        """Fail early, before the first sentence, if Applio is not where expected."""
        if self.tts_provider not in ("edge", "kokoro"):
            raise ValueError("TTS provider must be edge or kokoro.")
        if self.rvc_threads < 0:
            raise ValueError("RVC threads must be nonnegative.")
        if self.tts_provider == "kokoro":
            from controller.kokoro_worker import MODEL_DIR, validate_settings

            validate_settings(self.kokoro_voice, self.kokoro_speed, self.kokoro_threads)
            for path in (
                ROOT / ".venv-kokoro/bin/python",
                MODEL_DIR / "kokoro-v1.0.onnx",
                MODEL_DIR / "voices-v1.0.bin",
            ):
                if not path.is_file():
                    raise FileNotFoundError(
                        f"Kokoro file not found: {path}; run python3 -m controller.setup_kokoro"
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


def clean_for_tts(text: str) -> str:
    """Remove Markdown symbols, emoji and control characters; collapse whitespace."""
    kept = []
    for char in text:
        category = unicodedata.category(char)
        # So: emoji and other symbols; C*: control, format and unassigned; FE0x: emoji variation selectors.
        drop = (
            char in "*_`#>~|"
            or category == "So"
            or category.startswith("C")
            or 0xFE00 <= ord(char) <= 0xFE0F
        )
        kept.append(" " if drop else char)
    # A leading dash could be read as a command-line option further down.
    return " ".join("".join(kept).split()).lstrip("-– ")


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
        cleaned = clean_for_tts(text)
        if speakable(cleaned):
            self._done.append(Segment(cleaned, self.expression, self.weight))

    def feed(self, event: dict) -> list[Segment]:
        if event["type"] == "expression":
            self._emit(self.buffer)
            self.buffer = ""
            self.expression, self.weight = event["name"], event["weight"]
        elif event["type"] == "say":
            self.buffer += event["text"]
            parts = SENTENCE_END.split(self.buffer)
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
    ):
        self.settings = settings
        self.cwd = cwd or settings.applio_dir
        self.kokoro = None
        if command is None and settings.tts_provider == "kokoro":
            self.kokoro = ApplioWorker(
                settings,
                command=[
                    str(ROOT / ".venv-kokoro/bin/python"),
                    "-m",
                    "controller.kokoro_worker",
                    "--worker",
                    "--voice",
                    settings.kokoro_voice,
                    "--speed",
                    str(settings.kokoro_speed),
                    "--threads",
                    str(settings.kokoro_threads),
                ],
                log_path=WORKER_LOG.with_name("kokoro-worker.log"),
                cwd=ROOT,
            )
        self.command = command or [
            str(settings.applio_dir / ".venv" / "bin" / "python"),
            str(WORKER_SCRIPT),
            json.dumps(settings.worker_config()),
        ]
        self.log_path = log_path
        self.process: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.starting = asyncio.Lock()
        self.ready: dict = {}

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
                raise RuntimeError(
                    f"Applio worker failed to start; see {self.log_path}"
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
                LOG.warning("Dropped invalid Applio worker line")
                continue
            if future is not None and not future.done():
                future.set_result(message)
        for future in pending.values():
            if not future.done():
                future.set_exception(
                    RuntimeError(f"Applio worker exited; see {self.log_path}")
                )
        pending.clear()

    async def request(
        self, text: str, source: Path, output: Path, run: str | None = None
    ) -> dict:
        """Synthesise ``text`` into ``source`` and convert into ``output``."""
        await self.start()
        source_metrics = None
        if self.kokoro is not None:
            source_metrics = await self.kokoro.request(text, source, output, run)
        request_id = secrets.token_hex(8)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        line = json.dumps(
            {
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
            raise RuntimeError(f"Applio worker: {message.get('error')}")
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
                    )
                }
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
    text_path.write_text(segment.text + "\n", encoding="utf-8")
    try:
        reply = await worker.request(segment.text, source, wav, run)
        # Trim before aligning so the lip-sync timings match the audio that plays.
        trim = await asyncio.to_thread(trim_clip, source, wav, segment.text)
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
        )
        if key in reply
    }
    return clip_id, {
        **metrics,
        "rvcSeconds": reply["rvcSeconds"],
        "alignSeconds": track["alignSeconds"],
        "untrimmedSeconds": trim["beforeSeconds"],
        "audioSeconds": track["duration"],
    }
