# Running the text-expression bridge

**Recovery note:** these commands describe the previously implemented bridge.
The renderer client is restored, but the current Python bridge is the original
scaffold and does not support these flags until it is restored separately.

From the project root, run the renderer (using your Python environment):

```bash
python3 renderer/serve.py
```

After restoring the backend and its `websockets`/`httpx` dependencies:

```bash
.venv/bin/python controller/bridge.py --mode demo
```

Open http://127.0.0.1:8770/renderer/ (not localhost), wait for the model and
**Connected · ready**, then click **Start response**. Expected sequence:

```text
[soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]
```

The transcript must omit tags, moods must change in order, and neutral clears
the mood. Preview controls become inert during the response; authoring overrides
are cleared. No speech is generated yet.

Stop demo mode before starting the historical LLM mode:

```bash
.venv/bin/python controller/bridge.py --mode llm --prompt "Say good morning, then think about what we could work on."
```

Defaults: llama-server at http://127.0.0.1:8080, bridge port 8765. Optional flags
were `--llama-url` and `--model`. Each click made a fresh single-turn request using
the CLI prompt. The adapter streamed `/v1/chat/completions` content deltas and
ignored separately supplied reasoning deltas. The last mood persisted until a
neutral event; errors/disconnects reset it. The user confirmed live LLM response
before deletion; this has not been revalidated after recovery.

Square brackets are reserved controls, including unknown blocks: general
Markdown/coding output needs a distinct protocol. See the
[architecture](./architecture-v2.md) for the preserved parser contract.
