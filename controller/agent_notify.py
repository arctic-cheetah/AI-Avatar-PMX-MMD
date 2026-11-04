"""Agent-host hook: tell Yidhari when a coding agent stops or needs attention (#27).

Run by Claude Code hooks, which pass a JSON payload on stdin:

  stop          the agent's final message becomes a report, so she speaks even
                if the model forgot to call report. The bridge skips it when the
                agent already reported in the last two minutes.
  notification  the host's notice (for example a permission prompt) is spoken.
                She only says it; approvals stay in the agent host.

Always exits 0 and prints nothing, so it can never block or change the agent.
Setup: docs/agent-voice.md.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

if not __package__:
    # Support `python controller/agent_notify.py` as well as `python -m controller.agent_notify`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from controller.agent import MAX_REPORT, MAX_SAY, call_bridge, default_socket_path

MAX_TRANSCRIPT = 8 * 1024 * 1024  # bytes read from the end of a transcript


def _blocks(entry):
    """Text blocks and whether a tool call is present, for one assistant entry."""
    content = entry.get("message", {}).get("content") if isinstance(entry.get("message"), dict) else None
    if isinstance(content, str):
        return [content], False
    if not isinstance(content, list):
        return [], False
    texts = [
        block["text"]
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ]
    tools = any(isinstance(block, dict) and block.get("type") == "tool_use" for block in content)
    return texts, tools


def last_assistant_text(lines):
    """The agent's final message: trailing assistant text after its last tool call."""
    collected = []
    for line in reversed(list(lines)):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") != "assistant":
            if collected:
                break
            continue
        texts, tools = _blocks(entry)
        if collected and (tools or not texts):
            break
        collected[:0] = [text for text in texts if text.strip()]
    text = "\n".join(collected).strip()
    return text or None


def _read_tail(path):
    try:
        with open(path, "rb") as file:
            file.seek(0, 2)
            size = file.tell()
            file.seek(max(0, size - MAX_TRANSCRIPT))
            return file.read().decode("utf-8", "replace").splitlines()
    except (OSError, TypeError, ValueError):
        return []


def build_request(event, payload, source):
    """The bridge request for a hook payload, or None when there is nothing to say."""
    if event == "stop":
        if payload.get("stop_hook_active"):
            return None
        text = payload.get("last_assistant_message")
        if not isinstance(text, str) or not text.strip():
            text = last_assistant_text(_read_tail(payload.get("transcript_path")))
        if not text:
            return None
        return {"tool": "report", "source": source, "text": text[:MAX_REPORT], "kind": "done",
                "hook": True}
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        message = "Your agent needs your attention."
    return {"tool": "say", "source": source, "mood": "worried", "hook": True,
            "text": message[:MAX_SAY]}


async def run(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("event", choices=["stop", "notification"])
    parser.add_argument("--name", default="Claude Code", help="Label on her chat bubbles.")
    parser.add_argument("--socket", type=Path, default=None, help="Bridge agent socket.")
    args = parser.parse_args(argv)
    try:
        payload = json.loads(sys.stdin.read())
        request = build_request(args.event, payload, args.name) if isinstance(payload, dict) else None
        if request is not None:
            await call_bridge(args.socket or default_socket_path(), request, timeout=5)
    except Exception:
        pass  # a hook must never get in the agent's way
    return 0


def main():
    sys.exit(asyncio.run(run(sys.argv[1:])))


if __name__ == "__main__":
    main()
