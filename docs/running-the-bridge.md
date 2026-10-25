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
supplies its model alias. Bridge port defaults to 8765. Each click sends the CLI
prompt as the next turn of the current conversation; it does not attach to
another chat UI. The context window comes from llama-server's `/props`; use
`--context-tokens N` (at least 65536) to set it yourself. History, trimming and
**New chat** are described in [conversation-history.md](conversation-history.md).
The adapter reads `/v1/chat/completions` SSE content deltas and ignores separately
supplied reasoning deltas. Thinking may delay visible output. A missing `[DONE]`
terminator or upstream failure is reported as an error, not successful completion.

Each run begins neutral. In text-only mode, successful completion keeps the last
mood unless a neutral tag was emitted; generation errors reset it. With
`--speech`, the face eases back to neutral about 0.6 s after the last clip of a
finished response stops playing, and a response that produced no clips clears
the thinking face when it ends. The saved-sample test keeps its chosen mood. The recovered browser client
preserves the last mood on disconnect, avoiding repeated resets during reconnects.
An active generation is cancelled when its browser disconnects. Duplicate starts
while busy are ignored. No automatic generation occurs on reconnect.

## External (cloud / proxy) LLM

The same bridge accepts any OpenAI-compatible base URL — a cloud API or a
proxy such as EasyProxy / CLIProxyAPI — with a model name and an API key taken
from an environment variable (bridge only):

```bash
export OPENAI_API_KEY='sk-…'
.venv/bin/python controller/bridge.py --mode llm \
  --llama-url https://your-proxy.example/v1 --model your-model-name \
  --context-tokens 65536
```

`--llama-url` may be the bare host, a `…/v1` base, or the full
`…/v1/chat/completions` endpoint. Non-loopback URLs require `--model` and a
key (`--api-key-env` names the variable, default `OPENAI_API_KEY`;
`--allow-no-key` only for keyless proxies), are never probed at `/props`, and
send your chat text off this machine. Provider examples, extra headers
(`--llm-header`), the `reasoning` / `reasoning_content` spelling difference,
and 401/stream troubleshooting are in [external-llm.md](external-llm.md).

## Speech and lip sync

For the experimental CPU Kokoro source, standalone WAV audition and local
Kokoro → RVC mode, see [Testing Kokoro locally](./testing-kokoro.md).

Add `--speech` to either mode to voice each sentence with Applio (Edge TTS → RVC)
and lip-sync it with Rhubarb. Needs internet (Edge TTS), `rhubarb` and `ffmpeg` on
PATH, and Applio installed next to this repository (`../Applio`, with its own
`.venv`):

```bash
.venv/bin/python controller/bridge.py --mode llm --speech --prompt "Greet me warmly in two short sentences."
```

`--applio-dir` selects which Applio installation to launch (default
`../Applio`); the Yidhari `.pth` and `.index` defaults follow the selected
installation, and `--pth` / `--index` override them individually. For ROCm GPU
conversion on the Radeon 8060S, point it at the separate ROCm workspace:

```bash
.venv/bin/python -m controller.bridge --mode llm --speech --tts kokoro \
  --kokoro-voice af_heart --kokoro-speed 1.0 --kokoro-threads 2 \
  --applio-dir ../Applio-rocm
```

ROCm RVC ignores `--rvc-threads` (a CPU-only torch setting), so omit it there.
On 23 October 2026 this passed an isolated demo-mode check on port 8766:
worker ready in 2.17 s (load) + 4.89 s (warm-up); the two demo sentences
spoke in 1.64 s / 3.59 s with `rvcSeconds` 0.84 / 0.62. `--rvc-threads` was
omitted; the host's llama-server was idle, so this verifies wiring and GPU
conversion, not TTFS under concurrent LLM load. See
`~/Code/Applio-rocm/README-ROCM.md` for setup and benchmarks.

On startup the bridge launches a persistent Applio worker
(`controller/applio_worker.py`, run with Applio's own Python) that loads the voice
model once and warms up (about 4 s) before accepting connections. It stops if
Applio's Python, the voice model or the index is missing, or if the worker fails
to start; Applio's own output goes to `assets/private/speech/applio-worker.log`.
`--pth /path/to/model.pth` selects another voice model; the other Applio settings
live in `ApplioSettings` in `controller/speech.py`. Each sentence is logged with
its Edge, RVC and alignment times and its length before and after trimming.
The worker requests Edge audio for up to two sentences ahead while RVC converts
one at a time, and the bridge keeps up to three sentences in flight, so later
sentences are usually ready well before they are needed. Each clip is trimmed
to 0.05 s before and 0.25 s after the speech, which also removes breaths RVC
adds at the end. While the LLM is reasoning, Yidhari shows the `thinking` mood. Clips are written to
`assets/private/speech/live/` and replaced on the next run. The renderer plays
them in order and applies each mood when its clip starts.

## Voice input

Start the renderer server with `--stt` (after `python3 -m controller.setup_stt`) to enable the
**🎤 Talk** button. The bridge needs no flag: spoken prompts arrive as ordinary
`{"type":"start","prompt":…}` messages. See [voice-input.md](voice-input.md).

## Troubleshooting and tests

- **Disconnected:** start the bridge; use the exact renderer Origin above.
- **Address already in use:** stop the previous bridge in its terminal first.
- **Generation failed:** read the bridge terminal; check that this responds:

```bash
curl http://127.0.0.1:8080/v1/models
```

For a cloud/proxy endpoint, check the same path under its base URL with your
key, e.g. `curl -H "Authorization: Bearer $OPENAI_API_KEY" https://your-proxy.example/v1/models`; a 401 means the key is wrong or the model is not enabled for it.

Run regression tests:

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/renderer/
```

Tests cover split tags, malformed/unknown controls, bounded buffering, intensity
clamping, prompt generation, real local WebSocket transport and Origin rejection,
repeat runs, simulated SSE, truncated streams, and upstream-error handling.
Speech tests cover sentence splitting, the worker protocol, trimming, Edge/RVC
pipelining and ordered sending; `tests/renderer/` checks when the face relaxes
after speech (Node's built-in test runner, no packages needed).
Live verification after repair passed against qwen3.8-27b on 127.0.0.1:8080:
the real model streamed through the parser and WebSocket, producing soft-smile
0.6, thinking 0.5, neutral, and tag-free greeting text. This verifies backend
connectivity; a fresh visual check in the renderer remains separate.

Square brackets are reserved controls: unknown/malformed/oversized/unfinished
blocks are dropped. Text outside tags preserves whitespace. General Markdown
links, bracketed citations, and code indexing need a separate structured protocol.
No PMX names or weights are sent to the LLM. Origin restrictions are browser
protection, not authentication against other local processes.
