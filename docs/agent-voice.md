# Agent voice over MCP

Tracked in [#27](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/27).
Yidhari becomes the voice and face of a coding agent (Claude Code first, then
Continue or VS Code agent mode). The agent calls her tools through a small stdio
MCP server, `controller/mcp_server.py`. The server forwards each call to the
running bridge over an owner-only Unix socket.

Built in steps:

| Step | Tools                  | Status          |
| ---- | ---------------------- | --------------- |
| A    | `say`, `set_mood`      | ✅ this guide   |
| B    | `report` (summariser)  | planned         |
| C    | `ask`, Stop hook       | planned         |

`say` and `set_mood` never call an LLM, so they work the same with the local
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

2. Start the renderer and the bridge with `--agent`. Every other bridge flag
   still works: local or cloud LLM, `--speech`, `--tts kokoro`.

   ```bash
   .venv/bin/python renderer/serve.py
   .venv/bin/python controller/bridge.py --mode llm --agent --speech --tts kokoro
   ```

   The bridge prints `Agent socket: /run/user/1000/yidhari/agent.sock`.
   Open the renderer and wait for **Connected · ready**.

3. Register the MCP server with Claude Code (once per machine):

   ```bash
   claude mcp add yidhari -- \
     /home/parrot/Code/avatar-yidhari/.venv/bin/python \
     /home/parrot/Code/avatar-yidhari/controller/mcp_server.py --name "Claude Code"
   ```

   Continue uses the same command in its `mcpServers` config:

   ```yaml
   mcpServers:
     - name: yidhari
       command: /home/parrot/Code/avatar-yidhari/.venv/bin/python
       args:
         - /home/parrot/Code/avatar-yidhari/controller/mcp_server.py
         - --name
         - Continue
   ```

4. Tell the agent when to use her, in its rules file (for example `CLAUDE.md`):

   ```markdown
   ## Voice (Yidhari MCP)
   - Call `say` with one short spoken sentence when you start a task and when
     you finish it. Plain speech only: no code, paths, hashes or URLs.
   - Call `set_mood` with `thinking` while you work for a long time.
   ```

Options for `mcp_server.py`: `--name` is the label on her chat bubbles (default
`Coding agent`), `--socket` overrides the socket path. The bridge takes
`--agent-socket PATH` for the same override.

## Tools

| Tool       | Arguments                                     | What she does                                     | Result                                   |
| ---------- | --------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| `say`      | `text` (≤ 500 chars), optional `mood`, `weight` | Logs the text in the chat, then speaks it as written | `queued` at once; never waits for playback |
| `set_mood` | `name`, optional `weight`                     | Sets her resting face without speaking            | `ok`                                     |

`say` text goes through the same tag parser as LLM replies, so inline tags such
as `[relieved]` work and unknown brackets are dropped. `mood` is the mood for
the start of the text. Mood names are checked against
[expressions.json](../renderer/expressions.json).

`set_mood` sets her **rest mood**: applied now if she is not speaking, and used
instead of neutral when her speech ends. A new chat reply clears it.

Other results:

| Result               | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `no renderer`        | No browser is connected to the bridge                             |
| `busy`               | Rate limit (1 `say` per second) or 10 agent items already queued  |
| `error: …`           | Invalid tool call, for example an unknown mood or text too long   |
| `bridge not running` | Nothing listens on the socket; start the bridge with `--agent`    |

## Chat and agent share one speech lane

Each renderer connection has one speech lane. With several renderers open, the
agent speaks through the newest one.

- Agent items speak in the order they arrive.
- An agent item waits while a chat reply is running, including its speech.
- A chat message from you (or **New chat**) cancels agent speech: the item
  speaking now and every queued agent item. Their text stays in the chat log.
- Without `--speech`, `say` shows the bubble and applies its mood only.

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
  `--tts kokoro` to keep agent speech on this machine, and keep code, paths and
  secrets out of `say` text.
- **No approvals.** Her tools never approve the agent host's permission prompts;
  those stay in the agent host.

## Troubleshooting

- **`bridge not running`:** start the bridge with `--agent`. If the bridge uses
  `--agent-socket`, pass the same path to `mcp_server.py --socket`.
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
