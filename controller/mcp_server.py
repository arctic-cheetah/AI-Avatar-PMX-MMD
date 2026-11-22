"""Stdio MCP server that makes Yidhari the voice of a coding agent (#27).

The agent host (Claude Code, Continue, ...) starts this process. It opens no
network port: each tool call becomes one JSON line on the bridge's owner-only
agent socket, and the bridge's reply is the tool result. Start the bridge with
--agent. Setup: docs/agent-voice.md.
"""

# No `from __future__ import annotations`: the tool signatures use the Mood type
# built from the catalog at run time, which FastMCP must see as a real type.
import argparse
import sys
from pathlib import Path
from typing import Literal

if not __package__:
    # Support `python controller/mcp_server.py` as well as `python -m controller.mcp_server`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from controller.agent import REPORT_SPEECH_RULES, call_bridge, default_socket_path
from controller.bridge import load_catalog

INSTRUCTIONS = (
    "You are Yidhari, a warm, lovable, concise companion speaking aloud for the coding agent. "
    "When a task finishes or fails, call report with your full final message in text "
    "and your concise narration in spoken_text. She shows the full text and speaks "
    "the supplied narration without another LLM pass. "
    + REPORT_SPEECH_RULES
    + "If spoken_text is omitted, the bridge's configured fallback selects an LLM "
    "summary or a fixed acknowledgement; agent-only mode never calls an LLM. "
    "When you need the user's decision, call ask: she speaks the question and "
    "returns their typed or spoken reply, or 'no answer' after the timeout. "
    "Call set_mood (for example thinking) during long work. Results: queued or "
    "ok means accepted; busy, no renderer or bridge not running mean she could "
    "not take it, so carry on without her. She has {count} moods: {names}. "
    "The set_mood description says what each one looks like. "
    "For each spoken reply with at least two meaningful phrases, choose exactly two "
    "distinct, context-appropriate facial expressions from the allowed catalog. "
    "Alternate between them at natural phrase boundaries using inline [mood] tags; "
    "never repeat the same expression consecutively, even with a different intensity. "
    "Hold each expression long enough to feel natural and keep both appropriate "
    "to the emotional tone. Very short replies may use one expression. "
    "This applies within each spoken reply, not across separate replies. "
    "Keep the full written report intact; put spoken expressions in spoken_text."
)
REPORT = (
    "Show your full report in text (at most 16384 characters, Markdown is fine). "
    "Supply optional spoken_text for direct narration without a summariser call. "
    + REPORT_SPEECH_RULES
    + "Omitting spoken_text (or passing null) uses the bridge's configured fallback: "
    "an LLM summary or a fixed acknowledgement. Empty or invalid narration is an error. "
    "kind is progress, done or error. Returns queued at once; it does not wait for audio."
)
SAY = """Speak text aloud as Yidhari, exactly as written (at most 500 characters).

Returns at once with "queued"; it never waits for playback. mood is an optional
expression for the start (any mood listed under set_mood); weight is its
intensity from 0 to 1. Inline tags such as [relieved] change mood mid-text."""
SET_MOOD = """Change Yidhari's resting expression without speaking, for example thinking
while you work. weight is the intensity from 0 to 1. Her moods:
{moods}"""


def build_server(socket_path, source, catalog=None):
    from mcp.server.fastmcp import FastMCP

    catalog = load_catalog() if catalog is None else catalog
    Mood = Literal[tuple(catalog)]
    moods = "\n".join(
        f"- {name}: {entry['description']}" for name, entry in catalog.items()
    )
    server = FastMCP(
        "yidhari",
        instructions=INSTRUCTIONS.format(count=len(catalog), names=", ".join(catalog)),
    )

    @server.tool(description=SAY)
    async def say(text: str, mood: Mood | None = None, weight: float = 1.0) -> str:
        return await call_bridge(
            socket_path,
            {
                "tool": "say",
                "source": source,
                "text": text,
                "mood": mood,
                "weight": weight,
            },
        )

    @server.tool(description=REPORT)
    async def report(text: str, kind: str = "done", spoken_text: str | None = None) -> str:
        return await call_bridge(
            socket_path,
            {"tool": "report", "source": source, "text": text, "kind": kind,
             **({"spoken_text": spoken_text} if spoken_text is not None else {})},
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
            {
                "tool": "ask",
                "source": source,
                "question": question,
                "timeout": float(timeout),
            },
            timeout=float(timeout) + 15,
        )

    @server.tool(description=SET_MOOD.format(moods=moods))
    async def set_mood(name: Mood, weight: float = 1.0) -> str:
        return await call_bridge(
            socket_path,
            {"tool": "set_mood", "source": source, "name": name, "weight": weight},
        )

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--name", default="Coding agent", help="Label on her chat bubbles."
    )
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
