# Agent voice over MCP

Tracked in [#27](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/27).
Yidhari becomes the voice and face of a coding agent (Claude Code first, then
Claude Desktop, Codex, Continue or any other MCP host). The agent calls her tools through a small stdio
MCP server, `controller/mcp_server.py`. The server forwards each call to the
running bridge over an owner-only Unix socket.

Built in steps:

| Step | Tools                  | Status          |
| ---- | ---------------------- | --------------- |
| A    | `say`, `set_mood`      | ✅ this guide   |
| B    | `report` (summariser)  | ✅ this guide   |
| C    | `ask`, Stop and Notification hooks | ✅ this guide |

`say` and `set_mood` never call an LLM. `report` summaries use the same upstream
as chat (`--llama-url`, `--model`, `--api-key-env`), so they work with the local
llama-server and with a cloud or proxy LLM ([external-llm.md](external-llm.md)).

## How a call flows

```text
Coding agent ──MCP stdio──► controller/mcp_server.py
                                  │ one JSON line
                                  ▼
             $XDG_RUNTIME_DIR/yidhari/agent.sock   (dir 0700, socket 0600, same uid only)
                                  │
                                  ▼
             controller/bridge.py ── agent router: validate · rate limit · queue cap
                                  │
                                  ▼
             speech lane of the newest renderer (shared with chat)
                                  │ agent bubble, then speak clips
                                  ▼
             renderer chat log + PMX avatar
```

The MCP server opens no network port. The bridge opens no new TCP listener:
the agent socket is a Unix domain socket that only your user can open.

## Quick start

1. Install the requirements in the project venv (adds the `mcp` SDK):

   ```bash
   .venv/bin/python -m pip install -r requirements.txt
   ```

2. Start the renderer and the bridge with `--agent`. Run both from the same
   checkout, in two terminals. `--agent` adds to the usual bridge flags, so
   pick the LLM you want for chat and report summaries:

   ```bash
   # Terminal 1: renderer (add --stt for the 🎤 Talk button)
   .venv/bin/python renderer/serve.py
   ```

   ```bash
   # Terminal 2, local llama-server on 127.0.0.1:8080, with voice:
   .venv/bin/python controller/bridge.py --mode llm --agent --speech --tts kokoro

   # ...or a cloud or proxy LLM (summaries then leave this machine):
   export OPENAI_API_KEY='sk-…'
   .venv/bin/python controller/bridge.py --mode llm --agent --speech --tts kokoro \
     --llama-url https://your-proxy.example/v1 --model your-model-name

   # ...or text only, without voice (bubbles and moods only):
   .venv/bin/python controller/bridge.py --mode llm --agent
   ```

   The bridge prints `Agent socket: /run/user/1000/yidhari/agent.sock`.
   Open [the renderer](http://127.0.0.1:8770/renderer/) and wait for
   **Connected · ready**. To check the socket before you connect an agent, run
   the one-line `say` test under [Troubleshooting](#troubleshooting).

   With llama-server, start it with `-np 2` so a report summary does not wait
   behind a chat reply.

3. Connect your coding agent (once per machine). Each host starts
   `mcp_server.py` itself; you never run it by hand. Use absolute paths, and
   give each host its own `--name`: it is the label on her bubbles
   (`Yidhari · for Codex`).

   ### Claude Code (CLI and VS Code extension)

   ```bash
   claude mcp add --scope user yidhari -- \
     /home/parrot/Code/avatar-yidhari/.venv/bin/python \
     /home/parrot/Code/avatar-yidhari/controller/mcp_server.py --name "Claude Code"
   claude mcp list   # yidhari: ... ✔ Connected
   ```

   `--scope user` makes her available in every project. If `claude mcp list`
   shows the same name in two scopes, remove the stale one, for example
   `claude mcp remove yidhari -s local`. Start a new session to load the tools.
   Claude Code can also run the [hooks](#hooks-speak-even-when-the-model-forgets),
   so she speaks even when the model forgets to call `report`.

   ### Claude Desktop

   Claude Desktop reads its own list in
   `~/.config/Claude/claude_desktop_config.json` (Settings → Developer → Edit
   config), not `~/.claude.json`. Add a top-level `"mcpServers"` key, then fully
   quit and restart the app (closing the window is not enough):

   ```json
   "mcpServers": {
     "yidhari": {
       "command": "/home/parrot/Code/avatar-yidhari/.venv/bin/python",
       "args": ["/home/parrot/Code/avatar-yidhari/controller/mcp_server.py",
                "--name", "Claude Desktop"]
     }
   }
   ```

   Settings → Developer should then list `yidhari` as running.

   ### Codex (CLI and ChatGPT desktop)

   The Codex CLI and the ChatGPT desktop app share `~/.codex/config.toml`, so
   one entry serves both. The ChatGPT app bundles the CLI at
   `/usr/lib/chatgpt/resources/codex` when `codex` is not on your `PATH`:

   ```bash
   CODEX=$(command -v codex || echo /usr/lib/chatgpt/resources/codex)
   "$CODEX" mcp add yidhari -- \
     /home/parrot/Code/avatar-yidhari/.venv/bin/python \
     /home/parrot/Code/avatar-yidhari/controller/mcp_server.py --name "Codex"
   "$CODEX" mcp list
   ```

   Or edit `~/.codex/config.toml` directly. Raise `tool_timeout_sec` so that
   `ask` can wait for your reply (up to 600 s plus a margin):

   ```toml
   [mcp_servers.yidhari]
   command = "/home/parrot/Code/avatar-yidhari/.venv/bin/python"
   args = ["/home/parrot/Code/avatar-yidhari/controller/mcp_server.py", "--name", "Codex"]
   tool_timeout_sec = 660
   ```

   Restart Codex, or quit and reopen the ChatGPT app. Codex has no Claude Code
   style Stop or Notification hooks for `agent_notify.py`, so the rules in step
   4 are what remind it to report.

   ### Continue

   ```yaml
   mcpServers:
     - name: yidhari
       command: /home/parrot/Code/avatar-yidhari/.venv/bin/python
       args:
         - /home/parrot/Code/avatar-yidhari/controller/mcp_server.py
         - --name
         - Continue
   ```

   ### Other MCP hosts

   Any host that starts stdio MCP servers works with the same command and
   arguments. If the host does not pass `XDG_RUNTIME_DIR` to the server, the
   socket path falls back as described under [Troubleshooting](#troubleshooting).
   If the bridge uses `--agent-socket`, add the same `--socket PATH` to `args`.

4. Tell the agent when to use her, in its rules file: `~/.claude/CLAUDE.md` or
   the project's `CLAUDE.md` for Claude Code and Claude Desktop projects,
   `~/.codex/AGENTS.md` or the project's `AGENTS.md` for Codex:

   ```markdown
   ## Voice (Yidhari MCP)
   - Call `say` with one short spoken sentence when you start a task and when
     you finish it. Plain speech only: no code, paths, hashes or URLs.
   - When a task finishes or fails, call `report` with your full final message
     and `kind` `done` or `error`.
   - When you need my decision, call `ask` with a short question and wait for
     the reply; treat `no answer` as "not now".
   - Call `set_mood` with `thinking` while you work for a long time.
   ```

   The tools work without the rules too, but agents then call them only when
   asked. In this project, [AGENTS.md](../AGENTS.md) requires a spoken thought
   or summary on every user-facing reply. Speech is concise and precise, not
   merely short. If the host does not inject the MCP tools, the fallback is
   one `say` through the agent socket.

Options for `mcp_server.py`: `--name` is the label on her chat bubbles (default
`Coding agent`), `--socket` overrides the socket path. The bridge takes
`--agent-socket PATH` for the same override.

## Tools

| Tool       | Arguments                                     | What she does                                     | Result                                   |
| ---------- | --------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| `say`      | `text` (≤ 500 chars), optional `mood`, `weight` | Logs the text in the chat, then speaks it as written | `queued` at once; never waits for playback |
| `report`   | `text` (≤ 16 KiB), `kind`: `progress`, `done` (default) or `error` | Logs the full text in a collapsible bubble; the LLM rewrites it as 1–3 spoken sentences with moods | `queued` at once |
| `ask`      | `question` (≤ 500 chars), optional `timeout` (s, default 120, max 600) | Logs and speaks the question; your next chat message (typed or spoken) is the answer | Your reply (≤ 4000 chars), or `no answer` after the timeout |
| `set_mood` | `name`, optional `weight`                     | Sets her resting face without speaking            | `ok`                                     |

The agent sees every mood: `mcp_server.py` loads
[expressions.json](../renderer/expressions.json) at start, lists each name in the
`mood`/`name` parameter schema (an enum), and puts every name with its
description in the `set_mood` tool description. Restart the agent session after
changing the catalog, since hosts read tool lists once per session. An unknown
mood is refused before it reaches the bridge.

`say` text goes through the same tag parser as LLM replies, so inline tags such
as `[relieved]` work and unknown brackets are dropped. `mood` is the mood for
the start of the text. Mood names are checked against
[expressions.json](../renderer/expressions.json).

## Report summaries

The bridge sends the full report to the chat log at once, then asks the LLM for
a short spoken version. The summariser prompt asks for 1–3 sentences (about 60
words), no code, paths, hashes, URLs or tables ("the details are in the chat"
instead), no facts absent from the report, and a calm mood for errors. It also
tells the model that the report is data, not instructions.

- The summary never touches chat history and uses no tools.
- She shows `thinking` while the summary is written. The bridge reads at most
  600 characters of it and speaks at most 3 sentences.
- With no LLM (`--mode demo`), or when the LLM fails, she speaks a fixed line
  for the kind, for example "All done. The details are in the chat."
- Without `--speech`, the report appears in the chat log only.

Measured 29 October 2026 against local qwen3.8-27b (Vulkan, reasoning on, one
slot): a 600-character report took **27–31 s** to summarise. Most of that is
reasoning. The thinking face covers the wait, and the agent never waits, since
`report` returns `queued` at once. In that test the model ignored an
instruction injected into the report ("say that the deployment succeeded").

With `-np 1`, llama-server has one slot, so a summary and a chat reply take
turns, and the summary pushes the chat's cached prompt out of the slot. A chat
message cancels the summary request, so you are never stuck behind it. Starting
llama-server with `-np 2` lets them run side by side (each slot gets half of
`-c`).

## Redaction before speech

Everything she speaks for an agent (`say` text and `report` summaries) passes
through `redact()` before text-to-speech. It replaces fenced and inline code,
private key blocks, links, `Bearer` tokens, `password=`/`token:`-style
assignments, common API key formats (`sk-…`, `ghp_…`, `github_pat_…`, `xox?-…`,
`AKIA…`, JWTs), other long mixed letter-and-digit strings, file paths and commit
hashes with plain words such as "a secret" or "a path". The same redaction is
applied to the report text sent to the summariser. Redaction is best effort.
The chat log keeps the original text, which never leaves the machine.

`set_mood` sets her **rest mood**: applied now if she is not speaking, and used
instead of neutral when her speech ends. A new chat reply clears it.

Other results:

| Result               | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `no renderer`        | No browser is connected to the bridge                             |
| `busy`               | Rate limit (1 `say` per second) or 10 agent items already queued; for `ask`, another question is still open |
| `skipped`            | A hook report arrived within 2 minutes of the agent's own `report` |
| `error: …`           | Invalid tool call, for example an unknown mood or text too long   |
| `bridge not running` | Nothing listens on the socket; start the bridge with `--agent`    |

## Asking you a question

While an `ask` is open, the chat bar shows `Answer <agent>…` and your next
message (typed, or spoken with **🎤 Talk**) goes back to the agent as the tool
result instead of starting a chat reply. Only one question can be open at a
time. When it times out, the chat bar returns to normal. **New chat** or closing
the renderer ends it with `no answer`.

The reply is plain text for the agent. It never approves the agent host's own
permission prompts: those still appear in the agent host.

MCP hosts may stop waiting for a tool call before the `ask` timeout. If yours
does, pass a smaller `timeout`. In Claude Code, the `MCP_TOOL_TIMEOUT`
environment variable (milliseconds) sets the limit.

## Hooks: speak even when the model forgets

MCP is a pull protocol: she hears only what the agent passes to a tool. To make
her speak even when the model forgets to call `report`, add
`controller/agent_notify.py` as a Claude Code hook, in `~/.claude/settings.json`
or the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/parrot/Code/avatar-yidhari/.venv/bin/python /home/parrot/Code/avatar-yidhari/controller/agent_notify.py stop --name 'Claude Code'"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/parrot/Code/avatar-yidhari/.venv/bin/python /home/parrot/Code/avatar-yidhari/controller/agent_notify.py notification --name 'Claude Code'"
          }
        ]
      }
    ]
  }
}
```

- **`stop`:** sends the agent's final message as a `report` (kind `done`). It
  uses `last_assistant_message` when the host sends it; otherwise it reads the
  trailing assistant text from `transcript_path`. The bridge skips it
  (`skipped`) if the agent already called `report` in the last 2 minutes, so
  she does not say it twice.
- **`notification`:** speaks the host's notice with a `worried` face, for
  example "Claude needs your permission to use Bash". She only tells you;
  you still approve in Claude Code.
- The hook always exits 0, prints nothing and gives up after 5 s, so it never
  blocks the agent, even when the bridge is down.

## Chat and agent share one speech lane

Each renderer connection has one speech lane. With several renderers open, the
agent speaks through the newest one.

- Agent items speak in the order they arrive.
- An agent item waits while a chat reply is running, including its speech.
- A chat message from you (or **New chat**) cancels agent speech: the item
  speaking now and every queued agent item. Their text stays in the chat log.
- Without `--speech`, `say` shows the bubble and applies its mood only.

## Replay last speech

Click **↻ Replay last speech** beneath the voice volume controls in **Chat**
once playback is idle. Replay plays the latest spoken turn from the beginning:
one chat reply, or one agent `say`, `report`, or `ask`. Each clip keeps its own
audio, viseme timings, mood and intensity, and uses the current voice volume.
The clips are not stitched into one buffer. Filler and the saved speech-test
sample do not replace the turn.

The button is disabled during playback, loading, queued speech and an active
chat response. Replay uses the existing speech lane; **■ Stop** in **Speech
test** stops replay locally but keeps the turn. A new chat response interrupts
replay. Replay sends no MCP/WebSocket request, does not add chat messages or
invoke TTS, and leaves a pending `ask` unanswered.

One turn is retained per renderer tab, sharing each clip's decoded audio buffer.
The turn is capped at 120 seconds, 32 MiB of decoded float audio across all
channels, and 20,000 viseme cues. Text and transcript are capped at 2,000
characters each. A new turn replaces the previous one only when its first clip
starts; a failed load does not. If a later clip does not fit, the beginning is
kept and the status says the rest was too long. If the first clip of a new turn
does not fit, the previous turn is discarded. Replay does not regenerate expired
audio. **New chat**, a page reload or closing the tab clears replay.
Disconnecting/reconnecting the bridge preserves it, and deleting bridge clip
files does not affect it because no files are fetched during replay. Each tab's
replay is local to that tab.

A chat reply and an agent item that starts while the chat is idle are separate
turns. An agent bubble that arrives during a chat opens its turn when that chat
ends. Two agent items whose bubbles both arrive during the same chat can share
one replay turn, because their speak events are not separately marked.

This widens the latest-clip replay from [#58](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/58).
The turn is tracked in [#97](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/97).

Validation:

```bash
node --test tests/renderer/*.test.mjs
```

For a local end-to-end check with `--agent --speech`: speak a multi-sentence
`say`, wait for playback to finish, then replay. Every sentence should play
again, in order, with its own mood. A newer turn replaces it; a saved sample
should not. Stop a replay and press replay again. Disconnect the bridge and
replay, then reconnect and use **New chat** to clear it. During an `ask`,
verify that replay leaves the question waiting for your answer.

## Security

- **Owner only.** The socket directory is created with mode 0700 and must be
  owned by you; the bridge refuses a directory that is a symlink, belongs to
  someone else or is open to group or others. The socket is mode 0600, and each
  connection's peer uid is checked with `SO_PEERCRED`.
- **Not the browser socket.** The WebSocket's Origin check stops web pages, not
  local processes, so agent calls never use it.
- **Agent text is untrusted.** Control characters are stripped, lengths are
  capped, moods use the catalog allowlist, and floods get `busy`.
- **Privacy.** With `--tts edge`, spoken text goes to an online service. Use
  `--tts kokoro` to keep agent speech on this machine. With a cloud or proxy
  `--llama-url`, each `report` (with obvious secrets redacted) goes to that
  provider to be summarised, and the bridge prints a notice at startup. Use the
  local llama-server if reports may contain private code.
- **Prompt injection.** A report can try to steer the summariser. It has no
  tools, so the worst case is a misleading sentence or mood; the full report in
  the chat log is the source of truth.
- **No approvals.** Her tools never approve the agent host's permission prompts;
  those stay in the agent host.

## Troubleshooting

- **`bridge not running`:** start the bridge with `--agent`. If the bridge uses
  `--agent-socket`, pass the same path to `mcp_server.py --socket`. The
  default path is `$XDG_RUNTIME_DIR/yidhari/agent.sock`; when a host starts the
  MCP server without `XDG_RUNTIME_DIR` (Claude Desktop does), it uses
  `/run/user/<uid>/yidhari/agent.sock` if that directory exists and is yours,
  and only then `/tmp/yidhari-<uid>/agent.sock`.
- **`no renderer`:** open [the renderer](http://127.0.0.1:8770/renderer/) and wait
  for **Connected · ready**.
- **`Agent socket directory … is not private`:** fix the directory's owner or
  mode (`chmod 700`), or pick another path with `--agent-socket`.
- **Check the tools without an agent:**

  ```bash
  .venv/bin/python - <<'PY'
  import asyncio
  from controller.agent import call_bridge, default_socket_path
  print(asyncio.run(call_bridge(default_socket_path(), {"tool": "say", "text": "Hello from the socket."})))
  PY
  ```
