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
  --voice af_heart:0.7,af_bella:0.3 --speed 1.0 --threads 2
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
  --voice af_heart:0.7,af_bella:0.3 --threads 2 --rvc-threads 4
```

This produces two WAV files, transcripts, final-audio viseme tracks and
`results.json` in `assets/private/speech/kokoro-audition/`. Repeat `--text` to
audition custom sentences. `--output-dir` selects a different results directory.
The JSON report points to each WAV and records per-stage timings. These clips
survive ordinary avatar runs; the separate `live/` directory is cleared by those
runs. Listen for word endings, pronunciation, breath artifacts and voice identity.

## 2a. Cadence and voice-style blending (#29)

Kokoro receives **one sentence per request**, and the trimmer then cuts each
clip to the speech plus a short tail. So two different knobs shape cadence:

| Knob | Where it acts | Default | Range |
| --- | --- | ---: | ---: |
| `--clause-pause` (bridge: `--kokoro-clause-pause`) | Kokoro, inside a sentence: pause at commas, semicolons, dashes | 0.25 s | 0–0.5 s |
| `--sentence-tail` | Trim, after a full sentence: the gap before the next clip | 0.4 s | 0–0.8 s |
| `--fragment-tail` | Trim, after a fragment split by a mood tag: keeps it flowing | 0.1 s | 0–0.8 s |

Kokoro's own `sentence_pause` is deliberately not exposed: with one sentence
per request it would only add silence that the trimmer removes. The tails
apply to Edge clips as well. Long tails keep any soft RVC breath that follows
the speech, so listen for it; past the source's own silence (about 0.5 s for
Kokoro) the tail is padded with digital silence (#84).

`--voice` also accepts a weighted blend of up to four voices with the same
accent (all `a…` or all `b…`), for example `af_heart:0.7,af_bella:0.3`.
Weights must be positive and are normalised to sum to 1. The style vectors
are mixed once when the worker starts, so a blend costs nothing per sentence.

Audition several settings with the same sentences, for example:

```bash
for pause in 0.05 0.1 0.25; do
  .venv/bin/python -m controller.audition_kokoro \
    --voice af_heart:0.7,af_bella:0.3 --clause-pause "$pause" --sentence-tail 0.25 \
    --text "Well, I checked the logs, and the alert was a false positive." \
    --text "Shall we tune the rule together?" \
    --output-dir "assets/private/speech/kokoro-audition/pause-$pause"
done
```

Compare `ttsSeconds` and `rvcSeconds` in each `results.json` with the
measurements below; these settings only change parameters, so latency should
stay the same.

**Chosen defaults — 7 November 2026.** After listening to Kokoro → RVC clips,
the user picked `af_heart:0.7,af_bella:0.3`, clause pause 0.25 s, sentence
tail 0.4 s and fragment tail 0.1 s as the most natural.
Measured on the same two sentences: `ttsSeconds`
0.690 / 0.354 and `rvcSeconds` 2.15 / 1.15 (CPU RVC), versus 0.653 / 0.335 and
2.34 / 1.19 for the old `af_heart` defaults — no latency cost. Pass
`--kokoro-voice af_heart --kokoro-clause-pause 0.1 --sentence-tail 0.25` to
return to the previous sound. The sentence tail also applies to Edge clips. Mood-driven prosody (per-sentence speed and pitch) follows in a
separate PR.

## 2b. Mood-driven prosody (#29 tier 2)

With `--mood-prosody` (off by default until auditioned), each sentence's mood
tag also nudges the voice. Moods are grouped; the group's change is scaled by
the tag's weight (0–1) and clamped so back-to-back clips do not sound stitched.

| Group | Moods | Kokoro speed | Clause pause | RVC pitch |
| --- | --- | ---: | ---: | ---: |
| Energetic | excited, joyful, happy, grin, cocky, smug, mischievous, hopeful | ×1.05 | ×0.7 | +1 |
| Reflective | thinking, skeptical, confused, suspicious, serious, worried, nervous, troubled | ×0.95 | ×1.4 | 0 |
| Low | sad, sad-v2, sad-sceptical, sleepy, disappointed, cry, sulky | ×0.92 | ×1.4 | −1 |
| Unchanged | every other mood (neutral, soft-smile, tender, angry, surprised, …) | ×1 | ×1 | 0 |

- Speed and clause pause multiply `--kokoro-speed` and `--kokoro-clause-pause`;
  pitch is added to the RVC model's configured pitch, in semitones.
- Hard limits: speed ±8 %, pitch ±2 semitones, and the workers' own ranges
  (speed 0.5–2.0, clause pause 0–0.5 s). Pitch rounds to whole semitones, so
  a light tag such as `[excited:0.4]` changes only speed and pauses.
- Each worker validates the per-sentence fields again; a request without them
  behaves exactly as before.
- With Edge, only the RVC pitch shift applies (Edge's rate stays global).
- Intense moods (angry, scared, shocked, …) stay unchanged until auditioned.

Audition moods directly; `--mood` takes `name` or `name:weight` and repeats:

```bash
.venv/bin/python -m controller.audition_kokoro --mood-prosody \
  --mood soft-smile --mood excited --mood thinking --mood sad \
  --text "Well, I checked the logs, and the alert was a false positive." \
  --output-dir assets/private/speech/kokoro-audition/issue-29-moods
```

Each `results.json` entry records the mood, weight and applied prosody. On the
avatar, add `--mood-prosody` to the bridge command and listen especially at
mood changes in the middle of a sentence, where two clips meet.

## 2c. Punctuation-driven cadence (#84)

Based on listening to Yidhari's English voice actor: she lingers on ellipses,
an exclamation rises with happy moods and falls with negative ones, and dashes
read as a breath, and an exclamation is louder. `--punctuation-cadence` (off by default until auditioned)
turns on all of the following:

| Rule | What happens | Default |
| --- | --- | --- |
| Gap by ending | Trim tail chosen by the clip's last mark: `…`/`...` `--ellipsis-tail`, `!` (incl. `?!`) `--exclaim-tail`, `?` `--question-tail`, `.` `--sentence-tail` | 0.6 / 0.3 / 0.4 / 0.4 s |
| Ellipsis pace | A sentence ending in `…` is spoken ×0.96 | on |
| Exclamation volume | A clip ending in `!` (incl. `?!`) is made louder by `--exclaim-gain` dB (0–6). A soft limiter (≈3 ms look-ahead, 50 ms release) then holds brief peaks at −1 dBFS, so the boost is not lost to the little headroom RVC clips have. An earlier extra ±1 semitone on `!` was too strong when listened to (7 Nov 2026) and was removed; mood pitch still applies | +3 dB |
| Dashes | `—`, `–` and spaced ` - ` become a comma, so Kokoro's clause pause applies; `1–5` becomes "1 to 5" and hyphenated words are kept. A dash at the end of a clip (`So it goes —`) stays as a comma, and a clip ending in `,` `;` `:` keeps a tail equal to `--kokoro-clause-pause` | on |

- Tails range 0–0.8 s. Kokoro leaves about 0.5 s of silence after speech,
  so a longer tail is padded with digital silence instead of being capped.
- Punctuation prosody stacks with `--mood-prosody` (speed multiplies, pitch
  and gain add) inside the same clamps: speed ±8 %, pitch ±2 semitones,
  gain 0–6 dB. The gain is applied to the final WAV after trimming, so lip
  sync is aligned on the louder audio.
- An ellipsis touching the next word (`Wait...what?!`) now always splits the
  sentence there, like `Wait... what?!`; this needs no flag.

```bash
.venv/bin/python -m controller.audition_kokoro --mood-prosody --punctuation-cadence \
  --mood excited --mood sad --mood thinking \
  --text "Yay — we did it!" --text "Hmm… I am not sure." --text "Really?" \
  --output-dir assets/private/speech/kokoro-audition/issue-84
```

## 2d. Emphasis (#84 tier 4)

Yidhari's actor leaves a slight pause **before** a stressed word. With
`--emphasis` (Kokoro only, off by default), the LLM is told it may wrap one
word per sentence in single asterisks, like `*really*`, and the voice adds a
short pause before it (`--emphasis-pause`, default 0.12 s, 0–0.3).

- The asterisks are never spoken; `**bold**` and `a * b` are not emphasis.
- The Kokoro worker phonemizes the sentence itself and checks that its words
  line up one-to-one with the text's. Kokoro reports when each phoneme is
  spoken, so the pause is spliced into the space before the word, with 5 ms
  fades so it does not click.
- If the words do not line up (numbers such as `1999` expand to several
  words), the sentence is spoken without the pause; the clip metrics show
  `emphasisPauses`. With `--punctuation-cadence`, a sentence whose dashes
  change the word count (`1–5` → "1 to 5") also skips the pause.
- The chat log still shows the asterisks, as it does for other Markdown.
- Stronger stress or loudness on the word itself is research in #83.

```bash
.venv/bin/python -m controller.audition_kokoro --emphasis \
  --text "I *really* like it." --text "That is *so* good, but who knows?" \
  --output-dir assets/private/speech/kokoro-audition/issue-84-emphasis
```

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
  --tts kokoro --kokoro-voice af_heart:0.7,af_bella:0.3 --kokoro-speed 1.0 \
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
  is tracked in #29; cadence controls and voice blending are in section 2a.

Validation commands:

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/renderer/
```
