"""Renderer-server side of voice input: upload checks and the STT worker handle.

Standard library only; runs in the main ``.venv`` inside ``renderer/serve.py``.
Audio arrives as one POST /stt from the renderer page, is written to a private
temporary file for the worker, and is deleted as soon as the reply is in. Only
the transcript goes back to the browser; the bridge WebSocket never sees audio.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import queue
import secrets
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
WORK_DIR = ROOT / "assets" / "private" / "stt"
MAX_UPLOAD = 2 * 1024 * 1024  # ~8 minutes of 32 kbit/s Opus; the renderer stops at 30 s
SUFFIXES = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/wav": ".wav"}
LOG = logging.getLogger(__name__)


class UploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def check_upload(headers, origin: str) -> tuple[int, str]:
    """Validate an upload's headers; return (byte length, file suffix) or raise UploadError."""
    if headers.get("Origin") != origin:
        # Blocks other web pages (and DNS-rebinding hosts) from posting to localhost.
        raise UploadError(403, "Voice uploads are accepted only from the renderer page.")
    kind = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if kind not in SUFFIXES:
        raise UploadError(415, "Unsupported recording format.")
    try:
        length = int(headers.get("Content-Length", ""))
    except ValueError:
        raise UploadError(411, "Recording size is missing.") from None
    if length <= 0:
        raise UploadError(400, "Recording is empty.")
    if length > MAX_UPLOAD:
        raise UploadError(413, "Recording is too large.")
    return length, SUFFIXES[kind]


class SttWorker:
    """Handle on stt_worker.py: started once and kept warm, one request at a time, restarted if it dies."""

    def __init__(self, model: str = "base.en", threads: int = 4, command: list[str] | None = None,
                 work_dir: Path = WORK_DIR, timeout: float = 30.0, start_timeout: float = 120.0):
        self.command = command or [
            str(ROOT / ".venv-stt" / "bin" / "python"), "-m", "controller.stt_worker",
            "--worker", "--model", model, "--threads", str(threads)]
        self.work_dir, self.timeout, self.start_timeout = work_dir, timeout, start_timeout
        self.log_path = work_dir / "stt-worker.log"
        self.process: subprocess.Popen | None = None
        self.lines: queue.Queue = queue.Queue()
        self.lock = threading.Lock()
        self.ready: dict = {}

    def start(self) -> dict:
        with self.lock:
            return self._start()

    def _start(self) -> dict:
        if self.process is not None and self.process.poll() is None:
            return self.ready
        self._stop()
        self.work_dir.mkdir(parents=True, exist_ok=True)
        # Offline at runtime: models come only from models/whisper.
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
        with open(self.log_path, "wb") as log:
            self.process = subprocess.Popen(self.command, cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=log, text=True)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, args=(self.process, self.lines), daemon=True).start()
        message = self._reply(self.start_timeout)
        if not message.get("ready"):
            self._stop()
            raise RuntimeError(f"STT worker failed to start; see {self.log_path}")
        self.ready = message
        return message

    @staticmethod
    def _read(process: subprocess.Popen, lines: queue.Queue) -> None:
        with process.stdout:
            for line in process.stdout:
                lines.put(line)
        lines.put(None)

    def _reply(self, timeout: float) -> dict:
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            self._stop()
            raise RuntimeError("STT worker timed out.") from None
        if line is None:
            self._stop()
            raise RuntimeError(f"STT worker exited; see {self.log_path}")
        try:
            message = json.loads(line)
        except ValueError:
            message = None
        if not isinstance(message, dict):
            self._stop()
            raise RuntimeError("STT worker sent an invalid reply.")
        return message

    def transcribe(self, audio: bytes, suffix: str = ".webm") -> dict:
        """Return the worker's reply dict ({"ok": true, "text": ...} or {"ok": false, "error": ...})."""
        with self.lock:
            self._start()
            descriptor, name = tempfile.mkstemp(suffix=suffix, dir=self.work_dir)  # mode 0600
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(audio)
                request_id = secrets.token_hex(8)
                self.process.stdin.write(json.dumps({"id": request_id, "audio": name}) + "\n")
                self.process.stdin.flush()
                message = self._reply(self.timeout)
                if message.get("id") != request_id:
                    self._stop()
                    raise RuntimeError("STT worker replied out of order.")
                return message
            except (BrokenPipeError, OSError) as error:
                self._stop()
                raise RuntimeError(f"STT worker unavailable: {error}") from error
            finally:
                Path(name).unlink(missing_ok=True)

    def close(self) -> None:
        with self.lock:
            self._stop()

    def _stop(self) -> None:
        process, self.process = self.process, None
        if process is None:
            return
        if process.poll() is None:
            process.kill()
        process.wait()
        # stdout is left to the reader thread, which ends at EOF.
        try:
            process.stdin.close()
        except OSError:
            pass
