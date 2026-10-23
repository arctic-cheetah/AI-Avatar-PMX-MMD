# Testing Kokoro locally

Experimental branch: `ticket-21-kokoro-local-tts`.

Kokoro runs on CPU in `.venv-kokoro`, separately from the bridge and Applio
environments. Models stay in the gitignored `models/kokoro/` directory. The
avatar can use Kokoro → the existing Yidhari RVC model → trim → Rhubarb →
synchronised playback. Edge remains the default unless `--tts kokoro` is passed.
Kokoro mode never falls back to Edge or sends speech text to an online TTS service.

## Install or reproduce

From the repository root, using Python 3.11–3.13 (tested with 3.12):

```bash
python3 -m controller.setup_kokoro
```

Setup installs the CPU runtime and downloads roughly 354 MB of model/voice
assets, checking their SHA256 hashes against the upstream release metadata.
It needs internet during setup. Synthesis uses those local assets afterwards.
The package provides its eSpeak phonemizer runtime. Existing Applio, ffmpeg,
Rhubarb and the avatar's `.venv` are needed for the converted/avatar tests.

Upstream: [Kokoro model](https://huggingface.co/hexgrad/Kokoro-82M),
[ONNX runtime wrapper](https://github.com/thewh1teagle/kokoro-onnx).
Kokoro weights are Apache-2.0; the wrapper is MIT licensed.

## 1. Hear Kokoro without RVC or the LLM

```bash
.venv-kokoro/bin/python -m controller.kokoro_worker \
  --text "Good evening! I am ready to keep you company." \
  --voice af_heart --speed 1.0 --threads 2
```

Open `assets/private/speech/kokoro-test.wav` in an audio player. This is Kokoro's
own voice, before conversion to Yidhari. The command prints model load time,
synthesis time, audio duration and real-time factor (RTF; below 1 is faster than
playback). This standalone command reloads the model each time; the avatar
keeps it loaded and warms it once.

List available English voices:

```bash
.venv-kokoro/bin/python -m controller.kokoro_worker --list-voices
```

This deployment supports American (`a…`) and British (`b…`) English voices.
Try `af_heart`, `af_bella` or `af_sarah`. Speed is 0.5–2.0; 1.0 is the baseline.
It is independent of Edge's existing −15% rate setting.

## 2. Hear Kokoro converted to Yidhari

```bash
.venv/bin/python -m controller.audition_kokoro \
  --voice af_heart --threads 2 --rvc-threads 4
```

This produces two WAV files, transcripts, final-audio viseme tracks and
`results.json` in `assets/private/speech/kokoro-audition/`. Repeat `--text` to
audition custom sentences. `--output-dir` selects a different results directory.
The JSON report points to each WAV and records per-stage timings. These clips
survive ordinary avatar runs; the separate `live/` directory is cleared by those
runs. Listen for word endings, pronunciation, breath artifacts and voice identity.

## 3. Test on the avatar

Run these commands in separate terminals:

```bash
.venv/bin/python renderer/serve.py
```

```bash
.venv/bin/python -m controller.bridge --mode demo --speech \
  --tts kokoro --kokoro-threads 2 --rvc-threads 4
```

Open [http://127.0.0.1:8770/renderer/](http://127.0.0.1:8770/renderer/) and click **Start default response**.
Demo mode speaks the fixed demo text; chat input does not invoke an LLM in this
mode. Use this to check audio, lip sync and expression changes first.
The renderer still loads its existing Three.js CDN resources; local speech
does not make the entire renderer offline-capable.

To test alongside your LLM, stop the demo bridge with Ctrl+C, start your usual
llama-server, then run:

```bash
.venv/bin/python -m controller.bridge --mode llm --speech \
  --tts kokoro --kokoro-voice af_heart --kokoro-speed 1.0 \
  --kokoro-threads 2 --rvc-threads 4
```

The default LLM endpoint is `http://127.0.0.1:8080`; use `--llama-url` for a
different endpoint. Chat normally after the bridge reconnects. LLM reasoning
remains enabled. To compare Edge, stop this bridge and rerun it with `--tts edge`.
Only one bridge should listen on port 8765 at a time. Ctrl+C stops each service
and the bridge closes both speech workers. No background system service is installed.

## Initial measurements — 22 October 2026

Host: Ryzen AI MAX+ 395, 16 cores/32 threads, approximately 128 GB RAM.
Kokoro 0.6.1, ONNX Runtime 1.31.0, float32 v1.0 model, CPU, `af_heart`, speed 1.0,
2 Kokoro threads; RVC used 4 threads and the existing `75e_21450s` checkpoint.

| Test                      | Kokoro synthesis | Audio duration | Other stages                                         |
| ------------------------- | ---------------- | -------------- | ---------------------------------------------------- |
| Standalone greeting       | 0.946 s          | 5.645 s source | Model load 0.605 s; RTF 0.168                        |
| First converted sentence  | 0.450 s          | 2.510 s final  | RVC 1.83 s; align 0.567 s; total preparation 2.963 s |
| Second converted sentence | 0.450 s          | 2.440 s final  | RVC 1.36 s; align 0.512 s; total preparation 2.355 s |

These are individual smoke-test measurements, without a concurrent LLM workload,
not a benchmark or a guarantee of gap-free playback. The first converted clip
still takes longer to prepare than its playback duration. Pipeline overlap can
help later clips, but must be measured. RVC startup was 1.32 s plus 4.19 s warm-up;
Kokoro startup was 0.541 s plus 0.300 s warm-up, paid once per worker lifetime.

Kokoro sources were 24 kHz mono PCM WAV. Source/final untrimmed durations differed
by about 15–20 ms in these two tests. Final audio was trimmed and aligned;
visual lip-sync quality and preservation of soft endings need your listening check.

## Concurrency, limits and troubleshooting

- One Kokoro synthesis runs at a time, overlapping the serial RVC worker. The
  bridge keeps its existing three-segment in-flight limit and ordered playback.
- Cancelled runs skip queued synthesis. An active inference may finish before
  shutdown or cancellation takes effect. Interactive stop/pause remains the
  existing separate roadmap work.
- Kokoro has its own CPU thread limit; try 2 versus 4 while comparing LLM
  tokens/second, first-audio delay and playback gaps. RVC has a separate limit.
- The existing source-based trim threshold was designed around Edge. Check
  quiet consonants before treating the Kokoro output as production-ready.
- Worker diagnostics: `assets/private/speech/kokoro-worker.log` and
  `assets/private/speech/applio-worker.log`. Bridge output contains stage timings.
- Missing models/environment: rerun setup. An unknown voice or missing source
  produces an error; it does not trigger an online fallback.
- No retraining, Piper comparison or LLM-load tuning is included in this test
  branch. RVC itself can run on the AMD GPU via `--applio-dir ../Applio-rocm`
  (verified 2026-10-23; see [the bridge guide](./running-the-bridge.md) and
  `docs/architecture-v2.md`). Prosody work (intonation, cadence, inflection)
  is tracked in #29.

Validation commands:

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/renderer/
```
