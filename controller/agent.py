"""Agent voice (#27): a coding agent's tool calls, received on an owner-only Unix socket.

controller/mcp_server.py forwards each MCP tool call as one JSON line. The
router validates it and hands it to the speech lane (Stage) of the newest
renderer connection. Agent text is untrusted: it is capped, stripped of control
characters, rate limited, and parsed with the same tag allowlist as LLM replies.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import secrets
import socket
import stat
import struct
import tempfile
import time
import unicodedata
from pathlib import Path

from controller.bridge import TagParser, speak_segments

MAX_SAY = 500  # characters of spoken agent text
MAX_SOURCE = 40  # characters of agent name on chat bubbles
MAX_QUEUED = 10  # agent items queued or speaking per renderer
MAX_LINE = 65536  # bytes in one socket request
MAX_SOCKET_PATH = 107  # bytes; Linux sun_path holds 108 including the final NUL
MIN_INTERVAL = {"say": 1.0, "set_mood": 0.2}  # seconds between calls of one tool
DEFAULT_SOURCE = "Agent"
LOG = logging.getLogger(__name__)


class AgentError(ValueError):
    """A tool call or socket setup that the bridge refuses."""


def clean_text(text):
    """Turn control and format characters into spaces; collapse whitespace."""
    return " ".join(
        "".join(
            " " if unicodedata.category(char).startswith("C") else char for char in text
        ).split()
    )


def _text(request, key, limit):
    value = request.get(key)
    if not isinstance(value, str):
        raise AgentError(f"{key} must be text")
    value = clean_text(value)
    if not value:
        raise AgentError(f"{key} is empty")
    if len(value) > limit:
        raise AgentError(f"{key} is longer than {limit} characters")
    return value


def _weight(request):
    value = request.get("weight", 1.0)
    if value is None:
        return 1.0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AgentError("weight must be a number from 0 to 1")
    return max(0.0, min(1.0, float(value)))


def _mood(name, catalog):
    if not isinstance(name, str) or name not in catalog:
        raise AgentError(f"unknown mood: {str(name)[:40]}")
    return name


def validate(request, catalog):
    """Return a normalised tool call, or raise AgentError."""
    if not isinstance(request, dict):
        raise AgentError("request must be a JSON object")
    source = request.get("source", DEFAULT_SOURCE)
    if not isinstance(source, str):
        raise AgentError("source must be text")
    source = clean_text(source)[:MAX_SOURCE].strip() or DEFAULT_SOURCE
    tool = request.get("tool")
    if tool == "say":
        mood = request.get("mood")
        return {
            "tool": "say",
            "source": source,
            "text": _text(request, "text", MAX_SAY),
            "mood": None if mood is None else _mood(mood, catalog),
            "weight": _weight(request),
        }
    if tool == "set_mood":
        return {
            "tool": "set_mood",
            "source": source,
            "name": _mood(request.get("name"), catalog),
            "weight": _weight(request),
        }
    raise AgentError("unknown tool")


class Stage:
    """One renderer's speech lane for agent items, shared with its chat replies.

    Agent items speak in order, after any running chat reply. A chat reply
    cancels the agent item speaking now and drops queued ones.
    """

    def __init__(self, send, worker, catalog):
        self.send, self.worker, self.catalog = send, worker, catalog
        self.items = asyncio.Queue()
        self.chat_idle = asyncio.Event()
        self.chat_idle.set()
        self.current = None
        self.epoch = 0  # bumped by cancel_agent; items from an older epoch are dropped
        self.runner = asyncio.create_task(self._run())

    @property
    def pending(self):
        """Agent items queued or speaking."""
        return self.items.qsize() + (self.current is not None and not self.current.done())

    def enqueue(self, item):
        self.items.put_nowait((self.epoch, item))

    def chat_started(self):
        self.chat_idle.clear()
        self.cancel_agent()

    def chat_finished(self):
        self.chat_idle.set()

    def cancel_agent(self):
        self.epoch += 1
        while not self.items.empty():
            self.items.get_nowait()
        if self.current is not None:
            self.current.cancel()

    async def close(self):
        self.cancel_agent()
        self.runner.cancel()
        await asyncio.gather(self.runner, return_exceptions=True)

    async def _run(self):
        while True:
            epoch, item = await self.items.get()
            await self.chat_idle.wait()
            if epoch != self.epoch:
                continue
            self.current = asyncio.create_task(self._speak(item))
            try:
                await asyncio.gather(self.current, return_exceptions=True)
            finally:
                if not self.current.done():
                    self.current.cancel()
                    await asyncio.gather(self.current, return_exceptions=True)
                self.current = None

    async def _speak(self, item):
        try:
            if self.worker is None:
                if item["mood"] is not None:
                    await self.send(
                        {"type": "expression", "name": item["mood"], "weight": item["weight"]}
                    )
                return
            from controller.speech import Segmenter

            parser, queue = TagParser(self.catalog), asyncio.Queue()
            segmenter = Segmenter()
            if item["mood"] is not None:
                segmenter.feed(
                    {"type": "expression", "name": item["mood"], "weight": item["weight"]}
                )
            for event in parser.feed(item["text"]):
                for segment in segmenter.feed(event):
                    queue.put_nowait(segment)
            parser.finish()
            for segment in segmenter.finish():
                queue.put_nowait(segment)
            queue.put_nowait(None)
            await speak_segments(queue, self.send, self.worker, secrets.token_hex(8))
        except asyncio.CancelledError:
            raise
        except Exception:
            LOG.exception("Agent speech failed")


class AgentRouter:
    """Validate agent tool calls and send them to the newest renderer's stage."""

    def __init__(self, catalog, clock=time.monotonic):
        self.catalog, self.clock = catalog, clock
        self.stages = []
        self.last = {}

    def attach(self, stage):
        self.stages.append(stage)

    def detach(self, stage):
        if stage in self.stages:
            self.stages.remove(stage)

    def _limited(self, tool):
        now = self.clock()
        if now - self.last.get(tool, -math.inf) < MIN_INTERVAL[tool]:
            return True
        self.last[tool] = now
        return False

    async def handle(self, request):
        """Return the tool result text; never raises for bad input."""
        try:
            call = validate(request, self.catalog)
        except AgentError as error:
            return f"error: {error}"
        if not self.stages:
            return "no renderer"
        stage = self.stages[-1]
        if call["tool"] == "say":
            if stage.pending >= MAX_QUEUED or self._limited("say"):
                return "busy"
            await stage.send(
                {"type": "agent", "kind": "say", "source": call["source"], "text": call["text"]}
            )
            stage.enqueue(call)
            return "queued"
        if self._limited("set_mood"):
            return "busy"
        await stage.send(
            {
                "type": "agent",
                "kind": "mood",
                "source": call["source"],
                "name": call["name"],
                "weight": call["weight"],
            }
        )
        return "ok"


def default_socket_path(environ=None, uid=None):
    environ = os.environ if environ is None else environ
    uid = os.getuid() if uid is None else uid
    runtime = environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return Path(runtime) / "yidhari" / "agent.sock"
    return Path(tempfile.gettempdir()) / f"yidhari-{uid}" / "agent.sock"


def prepare_socket_dir(path):
    """Create the socket's directory (0700, ours, not a symlink); clear a stale socket."""
    path = Path(path)
    if len(os.fsencode(path)) > MAX_SOCKET_PATH:
        raise AgentError(f"Agent socket path is longer than {MAX_SOCKET_PATH} bytes: {path}")
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as error:
        raise AgentError(f"Cannot create agent socket directory {path.parent}: {error}") from None
    info = os.lstat(path.parent)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        raise AgentError(
            f"Agent socket directory {path.parent} is not private "
            "(must be a real directory owned by you with mode 0700)"
        )
    try:
        existing = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(existing.st_mode):
        raise AgentError(f"{path} exists and is not a socket")
    with socket.socket(socket.AF_UNIX) as probe:
        try:
            probe.connect(str(path))
        except OSError:
            path.unlink()  # stale: left by a bridge that did not exit cleanly
            return
    raise AgentError(f"Another bridge is already listening on {path}")


def _peer_uid(writer):
    sock = writer.get_extra_info("socket")
    if sock is None:
        return None
    if not hasattr(socket, "SO_PEERCRED"):
        return os.getuid()  # no peer credentials here; the 0700 directory still applies
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", creds)[1]


async def serve(path, router):
    """Listen on the agent socket; one JSON request and one JSON reply per connection."""
    path = Path(path)
    prepare_socket_dir(path)

    async def client(reader, writer):
        try:
            if _peer_uid(writer) != os.getuid():
                LOG.warning("Refused agent connection from another user")
                return
            try:
                line = await asyncio.wait_for(reader.readline(), 10)
                request = json.loads(line)
            except (ValueError, asyncio.LimitOverrunError, asyncio.TimeoutError):
                result = "error: request must be one JSON line"
            else:
                result = await router.handle(request)
            writer.write(json.dumps({"result": result}).encode() + b"\n")
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()

    previous = os.umask(0o177)
    try:
        server = await asyncio.start_unix_server(client, path, limit=MAX_LINE)
    finally:
        os.umask(previous)
    os.chmod(path, 0o600)
    return server


async def call_bridge(path, request, timeout=10.0):
    """Send one tool call to the bridge; return its result text."""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), timeout)
    except (FileNotFoundError, ConnectionRefusedError):
        return "bridge not running"
    except asyncio.TimeoutError:
        return "bridge not responding"
    except OSError as error:
        return f"error: cannot reach the bridge socket ({error.strerror or error})"
    try:
        writer.write(json.dumps(request, ensure_ascii=False).encode() + b"\n")
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout)
        reply = json.loads(line)
        result = reply.get("result") if isinstance(reply, dict) else None
        return result if isinstance(result, str) else "error: invalid bridge reply"
    except asyncio.TimeoutError:
        return "bridge not responding"
    except (ValueError, ConnectionError):
        return "error: invalid bridge reply"
    finally:
        writer.close()
