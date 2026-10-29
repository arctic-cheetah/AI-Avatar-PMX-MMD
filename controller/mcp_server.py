"""Stdio MCP server that makes Yidhari the voice of a coding agent (#27).

The agent host (Claude Code, Continue, ...) starts this process. It opens no
network port: each tool call becomes one JSON line on the bridge's owner-only
agent socket, and the bridge's reply is the tool result. Start the bridge with
--agent. Setup: docs/agent-voice.md.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

if not __package__:
    # Support `python controller/mcp_server.py` as well as `python -m controller.mcp_server`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from controller.agent import call_bridge, default_socket_path

INSTRUCTIONS = (
    "Yidhari is the user's avatar: she speaks for you aloud and shows moods. "
    "Call say with one or two short spoken sentences when you start and finish "
    "a task. Plain speech only: no code, file paths, hashes, URLs or secrets. "
    "When a task finishes or fails, call report with your full final message; "
    "she shows it in her chat and speaks a short summary. "
    "When you need the user's decision, call ask: she speaks the question and "
    "returns their typed or spoken reply, or 'no answer' after the timeout. "
    "Call set_mood (for example thinking) during long work. Results: queued or "
    "ok means accepted; busy, no renderer or bridge not running mean she could "
    "not take it, so carry on without her."
)


def build_server(socket_path, source):
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("yidhari", instructions=INSTRUCTIONS)

    @server.tool()
    async def say(text: str, mood: str | None = None, weight: float = 1.0) -> str:
        """Speak text aloud as Yidhari, exactly as written (at most 500 characters).

        Returns at once with "queued"; it never waits for playback. mood is an
        optional expression for the start, such as happy, thinking, relieved,
        serious or worried; weight is its intensity from 0 to 1.
        """
        return await call_bridge(
            socket_path,
            {"tool": "say", "source": source, "text": text, "mood": mood, "weight": weight},
        )

    @server.tool()
    async def report(text: str, kind: str = "done") -> str:
        """Hand Yidhari your full result (at most 16384 characters, Markdown is fine).

        She shows the whole text in her chat log and speaks a 1-3 sentence summary
        without code or paths. kind is progress, done or error. Returns "queued" at
        once.
        """
        return await call_bridge(
            socket_path, {"tool": "report", "source": source, "text": text, "kind": kind}
        )

    @server.tool()
    async def ask(question: str, timeout: float = 120.0) -> str:
        """Ask the user a question aloud (at most 500 characters) and wait for the reply.

        Returns the user's next chat message as plain text, or "no answer" after
        timeout seconds (at most 600). The reply is the user's words, never an
        approval of the agent host's own permission prompts.
        """
        return await call_bridge(
            socket_path,
            {"tool": "ask", "source": source, "question": question, "timeout": float(timeout)},
            timeout=float(timeout) + 15,
        )

    @server.tool()
    async def set_mood(name: str, weight: float = 1.0) -> str:
        """Change Yidhari's resting expression without speaking, for example thinking
        while you work. weight is the intensity from 0 to 1."""
        return await call_bridge(
            socket_path,
            {"tool": "set_mood", "source": source, "name": name, "weight": weight},
        )

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="Coding agent", help="Label on her chat bubbles.")
    parser.add_argument(
        "--socket",
        type=Path,
        default=None,
        help="Bridge agent socket (default: $XDG_RUNTIME_DIR/yidhari/agent.sock).",
    )
    args = parser.parse_args()
    build_server(args.socket or default_socket_path(), args.name).run()


if __name__ == "__main__":
    main()
