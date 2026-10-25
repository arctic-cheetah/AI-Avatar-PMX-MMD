# External and cloud LLMs

The bridge can talk to any **OpenAI-compatible** chat server, not only a local
`llama-server`. That covers local Ollama, LM Studio, vLLM and llama.cpp, and —
with an API key — cloud or proxied endpoints such as OpenAI, OpenRouter, and an
EasyProxy / CLIProxyAPI proxy. The renderer never changes and never sees a key:
the bridge alone holds the credential, calls upstream, and streams mood tags
and text to the browser exactly as it does for a local model.

> ⚠️ **Privacy:** with a non-loopback (`localhost` / `127.0.0.1` / `::1`) URL,
> your prompts and conversation history leave this machine and go to that
> provider, under that provider's retention and billing rules. Speech, STT and
> the model files stay local; only the chat text crosses the wire. The startup
> line names the upstream host, model and whether a key is sent, so the
> destination is always explicit — check it before sending anything private.

## Quick start

Local servers need no key. A cloud or proxy endpoint needs a model name and a
key from an environment variable:

```bash
export OPENAI_API_KEY='sk-…'          # never paste the key into a command line
.venv/bin/python controller/bridge.py --mode llm \
  --llama-url https://your-proxy.example/v1 \
  --model your-model-name \
  --context-tokens 65536
```

`--llama-url` keeps its historic name for backwards compatibility; it is the
base URL of any OpenAI-compatible server, not only llama.cpp. Start the
renderer as usual and chat from the page — history, mood tags, speech and
**New chat** behave identically. See
[running-the-bridge.md](running-the-bridge.md) for the local flow this extends.

## URL forms

All of these address the same endpoint; the bridge normalises the base URL
instead of blindly appending `/v1/chat/completions`:

| `--llama-url` | Request sent to |
| --- | --- |
| `http://127.0.0.1:8080` | `http://127.0.0.1:8080/v1/chat/completions` |
| `http://127.0.0.1:11434/v1` (Ollama) | `http://127.0.0.1:11434/v1/chat/completions` |
| `https://proxy.example/v1` | `https://proxy.example/v1/chat/completions` |
| `https://proxy.example/v1/chat/completions` | used unchanged |

A base URL with a path prefix keeps it, so a proxy mounted under
`https://host/prefix/v1` works too. Trailing slashes are ignored.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--llama-url` | `http://127.0.0.1:8080` | OpenAI-compatible base URL or full `…/chat/completions` endpoint |
| `--model` | none | Model name/id the server routes on; **required for non-loopback URLs** |
| `--api-key-env` | `OPENAI_API_KEY` | Name of the environment variable holding the API key |
| `--llm-header` | none | Extra HTTP header `Name: Value`; repeatable |
| `--allow-no-key` | off | Allow a non-loopback URL with no API key (keyless proxies only) |
| `--context-tokens` | see below | Model context window in tokens (at least 65536) |

### API key

- The key is read **in the bridge only**, from the variable named by
  `--api-key-env` (default `OPENAI_API_KEY`), and sent as
  `Authorization: Bearer <key>`. Only the variable *name* is ever a CLI
  argument, so the secret never appears in `ps`, shell history, the browser,
  or this repo.
- Point `--api-key-env` at a provider-specific variable to keep several keys
  apart, e.g. `--api-key-env OPENROUTER_API_KEY`.
- An empty variable counts as missing. For a non-loopback URL the bridge
  refuses to start when the named variable is missing, unless
  `--allow-no-key` is given — use that only for proxies that genuinely need no
  credential. Loopback URLs never require a key, but send one when the
  variable is set (LM Studio / proxies on localhost may want it).
- Keys are never logged. Upstream error messages are truncated before logging,
  and the generic “Generation failed” notice shown in the page carries no
  credential or provider detail.

### Extra headers

Some providers want routing or attribution headers in addition to (or instead
of) the bearer key:

```bash
.venv/bin/python controller/bridge.py --mode llm \
  --llama-url https://openrouter.ai/api/v1 --model vendor/model-name \
  --context-tokens 65536 \
  --llm-header "HTTP-Referer: http://127.0.0.1:8770" \
  --llm-header "X-Title: avatar-yidhari"
```

Headers are validated at startup: a header needs a `Name: Value` shape, and
`Authorization` must come from `--api-key-env`, never from `--llm-header`.
Header values are not logged.

### Context window

For loopback servers the window is still read from llama-server `/props`, with
`--context-tokens` as override. A non-loopback server is **not** probed at
`/props` (it may not exist, and may be metered): pass `--context-tokens` for
the model you chose, or the bridge assumes 65536 tokens and warns at startup.
History trimming, overflow retry and **New chat** are unchanged; see
[conversation-history.md](conversation-history.md). Providers that reject an
oversized request with a `context_length_exceeded`-style 400 are treated as a
context overflow, same as llama-server's `exceed_context_size`.

## Reasoning and the thinking face

While a model reasons, the bridge holds the `thinking` mood and never forwards
reasoning text to the page. Providers name the streaming field differently, so
both spellings are honoured:

- `delta.reasoning_content` — llama.cpp, DeepSeek-style and many proxies
- `delta.reasoning` — OpenRouter and several OpenAI-compatible proxies

Reasoning sent inside ordinary `content` (for example `<think>…</think>` from a
model whose server does not split it out) is still shown as text, as before;
the bridge does not strip markup it did not produce.

## Provider notes

| Provider | `--llama-url` | `--model` | Key |
| --- | --- | --- | --- |
| llama.cpp (local) | `http://127.0.0.1:8080` | optional | none |
| Ollama (local) | `http://127.0.0.1:11434/v1` | e.g. `llama3.1` | none |
| LM Studio (local) | `http://127.0.0.1:1234/v1` | loaded model id | none, unless the server sets one |
| EasyProxy / CLIProxyAPI | your proxy base, e.g. `https://proxy.example/v1` | model the proxy routes | `--api-key-env` variable for the proxy key, or `--allow-no-key` if it takes none |
| OpenAI | `https://api.openai.com/v1` | e.g. `gpt-…` | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | e.g. `vendor/model` | `--api-key-env OPENROUTER_API_KEY`; optional headers above |

Notes and limits:

- Smaller or heavily aligned models follow the mood-tag instructions less
  reliably. The parser already drops unknown or malformed tags, so this costs
  expression quality, never a crash.
- Only the OpenAI-style streaming chat API (`stream: true`,
  `data: …` / `data: [DONE]`) is supported. Anthropic's native Messages API is
  out of scope until it is fronted by an OpenAI-compatible proxy.
- Provider-specific request extras (seed, reasoning-effort toggles, vendor
  extensions) are not passed through; if a proxy needs them as *headers*, use
  `--llm-header`.
- Outgoing requests ignore system proxy environment variables
  (`trust_env=False`), as before; reach the endpoint directly or through a
  proxy URL you name explicitly.
- Per-sentence speech still starts only when the first content arrives, so a
  long cloud “thinking” phase keeps the thinking face, then speech pipelines
  as usual.

## Troubleshooting

- **Bridge refuses to start, “requires --model”:** name the upstream model;
  most cloud and proxy routers cannot pick one for you.
- **Bridge refuses to start, “API key environment variable … is not set”:**
  `export` it in the bridge terminal, rename it with `--api-key-env`, or —
  only for a keyless proxy — add `--allow-no-key`.
- **401 / 403 in the bridge terminal:** wrong or expired key, or the model
  name is not enabled for that key. The page only shows the generic failure.
- **Stream ends without `[DONE]`, or a non-SSE error page:** the URL is
  probably not an OpenAI-compatible chat endpoint; check the `/v1` suffix
  table above.
