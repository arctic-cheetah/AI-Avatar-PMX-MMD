# 🎤 Voice input (speech-to-text)

Talk to Yidhari instead of typing. Click **🎤 Talk** on the chat bar, speak, and
click **■ Stop**. Your words are transcribed **on this machine** and sent down
the same path as typed chat. Tracked in
[#25](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/25).

```text
🎤 Talk  →  browser MediaRecorder (webm/opus, echo cancellation on)
         →  POST /stt  on http://127.0.0.1:8770   (the renderer's own server)
         →  renderer/serve.py --stt  ──JSON line──►  controller/stt_worker.py
                                                     (.venv-stt, faster-whisper, CPU int8)
         ←  {"text": "…"}   only the transcript comes back
         →  your chat bubble  →  {"type":"start","prompt":"…"}  →  bridge  →  llama-server
```

- **Local by default.** Whisper runs on the CPU in an isolated `.venv-stt`.
  Models load offline from `models/whisper/` (`HF_HUB_OFFLINE=1` at runtime).
- **No audio on the WebSocket.** Audio goes only to `serve.py` over one
  same-origin POST. The bridge receives the transcript as an ordinary `prompt`.
- **Nothing is kept.** Each recording is written to a `0600` temp file under
  `assets/private/stt/` (gitignored) for the worker, then deleted after the reply.

## 🛠️ Setup (once)

```bash
python3 -m controller.setup_stt                         # .venv-stt + base.en (~140 MB)
python3 -m controller.setup_stt --models base.en small.en   # optionally also small.en (~465 MB)
```

This installs `requirements-stt.txt` (`faster-whisper==1.2.1`, `av==15.1.0`).
It downloads the Systran CTranslate2 Whisper models at pinned Hugging Face
revisions, listed in `MODELS` in [controller/stt_worker.py](../controller/stt_worker.py).

> ⚠️ `av` is pinned on purpose: faster-whisper 1.2.1 calls
> `av.open(metadata_errors=…)`, which PyAV 16+ removed. With newer PyAV, every
> transcription fails with `TypeError: open() got an unexpected keyword argument`.

## 🚀 Use it

```bash
.venv/bin/python renderer/serve.py --stt     # wait for "STT worker ready: base.en on CPU…"
.venv/bin/python controller/bridge.py --mode llm --speech --tts kokoro --applio-dir ../Applio-rocm
```

Open <http://127.0.0.1:8770/renderer/> and allow the microphone when the browser
asks. `http://127.0.0.1` counts as a secure context, so `getUserMedia` works
without HTTPS.

| Option | Default | Meaning |
| --- | --- | --- |
| `--stt` | off | Start the Whisper worker and enable `POST /stt` |
| `--stt-model` | `base.en` | `base.en` (fast) or `small.en` (more robust, ~2.5× slower) |
| `--stt-threads` | `4` | CPU threads for CTranslate2 |

How it behaves:

- **Mic disabled while she is busy.** It turns on again when her reply ends, so
  two generations never overlap. Proper barge-in waits for #14.
- **Hands-free send.** A non-empty transcript is sent straight away. If the bridge
  became busy meanwhile, the text goes into the chat box instead, so press **Send** later.
- **Ignored:** clips under 0.4 s, silence (Silero VAD), transcripts with no
  letters or digits, and stock Whisper hallucinations such as "Thanks for watching!".
- **30 s limit.** Recording stops by itself after 30 seconds.
- Every state is shown as **text** in the status line, not only as colour.

## 📊 Why CPU, and why `base.en` — measured 2026-10-24

Ryzen AI MAX+ 395, faster-whisper 1.2.1, int8, greedy decode, VAD on, Kokoro
clips encoded as 32 kbit/s Opus (what the browser sends). Warm model:

| Model · threads | 2.5 s utterance, idle | 2.5 s, LLM decoding | 14.8 s clip, idle | 14.8 s, LLM decoding |
| --- | ---: | ---: | ---: | ---: |
| `base.en` · 4 | 0.21 s | **0.45 s** | 2.9 s | 6.2 s |
| `base.en` · 8 | 0.15 s | — | 2.4 s | — |
| `small.en` · 4 | 0.49 s | 1.24 s | 7.4 s | 15.7 s (RTF > 1) |
| `small.en` · 8 | 0.42 s | — | 7.0 s | — |

- Both models transcribed every test clip correctly and returned nothing for 3 s of silence.
- **Headless Chrome end to end** (fake mic → MediaRecorder → `/stt`): 266 ms
  from **Stop** to transcript.
- **Under LLM load, transcription is 2–3× slower.** That comes from the shared
  memory pool, which an iGPU backend would contend for too. Meanwhile the iGPU
  already runs the LLM (Vulkan) and RVC (ROCm), and short push-to-talk clips
  gain little from a GPU (compare RVC's 0.47 s vs 0.52 s on a 2.5 s clip).
- **Memory:** the warm `base.en` worker measured 254 MB resident. It uses no CPU
  while the mic is down.
- **If a GPU is ever needed,** try whisper.cpp with Vulkan, the backend llama.cpp
  already uses reliably here, rather than a third ROCm PyTorch stack.

## 🛡️ Security notes

- `POST /stt` requires an exact `Origin: http://127.0.0.1:8770` (the served
  origin). Other websites and DNS-rebinding hosts get `403` and never reach the
  worker. A cross-site page cannot send an `audio/*` body without a CORS
  preflight, which this server never approves.
- Only `audio/webm`, `audio/ogg`, `audio/mp4` and `audio/wav` are accepted, up to 2 MiB.
- Decoder errors and file paths stay in the server log. The browser gets a
  generic message.
- Transcripts are not logged. The worker log is `assets/private/stt/stt-worker.log`.

## 🧯 Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Voice input is off; start serve.py with --stt" | Restart the renderer server with `--stt` |
| "Microphone permission denied" | Allow the mic from the address-bar icon and reload; typing still works |
| "Speech-to-text is unavailable" | See `assets/private/stt/stt-worker.log`. Run `python3 -m controller.setup_stt` if the model is missing |
| `serve.py --stt` exits with "failed to start" | Same log. Usually `.venv-stt` or the model is missing |
| 🎤 Talk stays disabled | The bridge is disconnected or busy. Wait for **Connected · ready** |
| Transcribes her own voice | Use headphones, or wait until she finishes. The browser's echo cancellation helps but isn't perfect |

Check the worker without the browser:

```bash
.venv-stt/bin/python -m controller.stt_worker --audio path/to/clip.webm
```
