# Running the text-expression bridge

The recovered Python scaffold has been replaced with the streaming bridge.
The project-local `.venv` and dependencies have been recreated. Python 3.10+ is
required. For a fresh environment:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Run the renderer from the project root if it is not already running:

```bash
.venv/bin/python renderer/serve.py
```

In a separate terminal, test the deterministic demo:

```bash
.venv/bin/python controller/bridge.py --mode demo
```

Open [http://127.0.0.1:8770/renderer/](http://127.0.0.1:8770/renderer/) (not localhost), wait for the model and
**Connected · ready**, then click **Start response**. Expected sequence:

```text
[soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]
```

The transcript omits tags, moods change in order, and neutral clears the mood.
Preview controls become inert during a response; authoring overrides are cleared.
No speech is generated yet.

## Local LLM

Stop demo mode with Ctrl+C before starting LLM mode. Keep llama-server running:

```bash
.venv/bin/python controller/bridge.py --mode llm --prompt "Reply exactly: [soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]"
```

Click **Start response** after reconnection. Default llama-server address is
[http://127.0.0.1:8080](http://127.0.0.1:8080); optional `--llama-url` selects its base URL and `--model`
supplies its model alias. Bridge port defaults to 8765. Each click is a fresh
single-turn request using the CLI prompt; it does not attach to another chat UI.
The adapter reads `/v1/chat/completions` SSE content deltas and ignores separately
supplied reasoning deltas. Thinking may delay visible output. A missing `[DONE]`
terminator or upstream failure is reported as an error, not successful completion.

Each run begins neutral. Successful completion keeps the last mood unless a
neutral tag was emitted; generation errors reset it. The recovered browser client
preserves the last mood on disconnect, avoiding repeated resets during reconnects.
An active generation is cancelled when its browser disconnects. Duplicate starts
while busy are ignored. No automatic generation occurs on reconnect.

## Troubleshooting and tests

- **Disconnected:** start the bridge; use the exact renderer Origin above.
- **Address already in use:** stop the previous bridge in its terminal first.
- **Generation failed:** read the bridge terminal; check that this responds:

```bash
curl http://127.0.0.1:8080/v1/models
```

Run regression tests:

```bash
.venv/bin/python -m unittest discover -s tests -v
```

Tests cover split tags, malformed/unknown controls, bounded buffering, intensity
clamping, prompt generation, real local WebSocket transport and Origin rejection,
repeat runs, simulated SSE, truncated streams, and upstream-error handling.
Live verification after repair passed against qwen3.8-27b on 127.0.0.1:8080:
the real model streamed through the parser and WebSocket, producing soft-smile
0.6, thinking 0.5, neutral, and tag-free greeting text. This verifies backend
connectivity; a fresh visual check in the renderer remains separate.

Square brackets are reserved controls: unknown/malformed/oversized/unfinished
blocks are dropped. Text outside tags preserves whitespace. General Markdown
links, bracketed citations, and code indexing need a separate structured protocol.
No PMX names or weights are sent to the LLM. Origin restrictions are browser
protection, not authentication against other local processes.
