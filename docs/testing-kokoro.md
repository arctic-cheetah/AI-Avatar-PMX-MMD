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

## Expressive voice defaults

Everything below that was approved by listening (#29, #84) is **on by default**:
mood prosody (§2b), punctuation cadence (§2c), emphasis (§2d), interjection
contours and word lifts (§2e), and quote voice (§2f). Turn a part off with its `--no-…` flag (for
example `--no-word-lifts`), or all of them with `--plain-voice`, e.g. to A/B
against the plain Kokoro → RVC voice. Emphasis, contours and lifts only act
with `--tts kokoro`.

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
- An ellipsis touching the next word (`Wait...what?!`) always splits the
  sentence there, like `Wait... what?!`; this needs no flag. It costs one extra
  clip (a Kokoro → RVC → align round trip) for such sentences.
- When a tail is padded past the clip's own silence, the last 20 ms of audio
  fade out first, so RVC's residual tail never stops abruptly into digital silence.

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
- Only a **single word** counts: multi-word spans such as the roleplay action
  `*giggles softly*` are not emphasis (they are still read out, as before). A
  one-word action like `*giggles*` cannot be told apart from `*really*`.
- At most three marked words per sentence are used; extra marks are ignored
  rather than failing the sentence. The prompt rule is added only with
  `--tts kokoro`, since Edge never pauses for emphasis.
- The Kokoro worker phonemizes the sentence itself and checks that its words
  line up one-to-one with the text's. Kokoro reports when each phoneme is
  spoken, so the pause is spliced into the space before the word, with 5 ms
  fades so it does not click.
- If the words do not line up (numbers such as `1999` expand to several
  words), the sentence is spoken without the pause; the clip metrics show
  `emphasisPauses`, and `emphasisSkipped` says why none was made (`misaligned`,
  `no-timings`, `first-word` or `not-found`). With `--punctuation-cadence`, a sentence whose dashes
  change the word count (`1–5` → "1 to 5") also skips the pause.
- The chat log still shows the asterisks, as it does for other Markdown.
- Stronger stress or loudness on the word itself is research in #83.

```bash
.venv/bin/python -m controller.audition_kokoro --emphasis \
  --text "I *really* like it." --text "That is *so* good, but who knows?" \
  --output-dir assets/private/speech/kokoro-audition/issue-84-emphasis
```

## 2e. Interjection contours (#84 tier 5a)

Yidhari's actor says "Aww" with a **rise, then a fall**; Kokoro always renders
a straight drop of about 3 semitones, whatever the punctuation or spelling.
With `--interjection-contours` (Kokoro only, off by default), `aw`/`aww`/`awww`,
`ooh`/`oooh` and `ohh` get a smooth pitch bump of `--interjection-bend`
semitones (default 8, range ±12) that peaks 40 % of the way through the word.
After listening (7 Nov 2026) "Aww" needed far more lift. Kokoro already rises
about 4 st inside "Aww, …", so the peak is roughly 4 + bend:

| Bend | Peak | Clearly pitched frames | Verdict |
| ---: | ---: | ---: | --- |
| 4 | +7 st | 33/42 | smooth |
| **8** | **+12 st (one octave)** | 32/42 | smooth (default) |
| 12 | +15 st | 23/42 | rise turns breathy/rough |
| 18 | +21 st | 17/42 | voice breaks up (beyond the RVC model's range) |

Two octaves is therefore not offered; ±12 st is the limit.

**Hold (off by default):** with `--interjection-hold SECONDS` (0–1.2) and
`--interjection-contours`, an `aw`/`aww` word is lengthened by repeating whole
pitch periods from the steady middle of the vowel, with short crossfades,
before RVC re-voices it; the pitch bend then covers the longer word. A first
default of 0.8 s (asked for as 0.6–1 s) sounded like "aw-aw-aw" and slower
than the rest of the speech when listened to, while the corrected vowel alone
already lasts about 0.36–0.39 s, so the default is 0 (Kokoro's own length).
Short holds (≤ 0.45 s) repeat few cycles and stutter least.

How it works, without touching Kokoro's model:

1. The Kokoro worker phonemizes the sentence, checks the words line up (as for
   emphasis) and reports each interjection's span from its per-phoneme
   timings, after any emphasis pauses.
2. The bridge sends those spans to the RVC worker as `bend`s.
3. The RVC worker wraps Applio's `Pipeline.get_f0()`: after Applio builds the
   F0 curve (10 ms frames, offset by its 1 s padding), the bump is multiplied
   in and the coarse pitch is rebuilt with Applio's own formula. RVC then
   sings Yidhari's voice along the bent curve.

**Pronunciation fix (always on with Kokoro):** espeak phonemizes `Aww` as
`ɔːwə` ("aw-wuh", heard as "awah") and `Awww` as `ɔːʊwə`. The Kokoro worker
replaces those with one long vowel, `ɔːɔː` (about 0.25 s, no dip in loudness),
before synthesis. Other spellings an LLM likes (`Awwww!`, `Aaww!`, `aWWW!`, `Awwh`)
are first rewritten to `Aww` (keeping its capital), since espeak turns them into
`ɔːʊˌʊwə`, `ɑːwə` or even spells out the letters. A plain `Aw` (`ɔː`, about
0.15 s) is left alone. This is a
Kokoro front-end issue, so retraining the RVC voice would not change it.

**Word lifts:** with `--word-lifts` (Kokoro only, off by default), two kinds
of word get a smaller rise-fall bump of `--word-lift-bend` semitones (default
4, ±12), since they sounded monotonous against the rest of the sentence:

- terms of endearment used to address someone, i.e. followed by punctuation:
  "Thank you, *sweetheart*!", "Hi *honey*, …", "Oh, my *love*." ("I love it"
  and "honey cake" are left alone);
- the word right before `!`: "We did *it*!".

- the word right before `?` gets a **rise** instead of a rise-fall: Kokoro
  ends questions on a fall ("Is that so?" drops about 8 st), so it gets
  `--question-rise-bend` semitones (default 9, ±12; raised from 8 after listening
  asked for 10–20 Hz more, about one semitone at her ~230 Hz ending) peaking 70 % of the way
  through the word. Measured on RVC, 4 st peaking at the very end only touched
  the last voiced blip, while 8 st at 70 % turned "so" (202 → 152 Hz) into a
  dip and rise (204 → 192 → 207 → 241 Hz). A question's last word rises even if
  it is an endearment ("Are you okay, *honey*?").

Kokoro's last phoneme often absorbs trailing silence ("so?" is voiced for
0.85–1.05 s but its timing runs to 1.425 s), so word spans are trimmed to the
frames within 30 dB of the word's loudest before any bend or hold; otherwise a
question's rise would land in silence.

Interjections keep their own, larger contour. At most four bends are used
per sentence, interjections first. A bend can carry an optional fourth value,
the position of its peak (0.4 = rise-fall, 1.0 = rise to the end).

The wrapper is installed only if `get_f0` still has the signature it was
written for; otherwise the worker logs it and speaks without bends. A plain
`Oh` is left alone, since it often drops on purpose ("Oh no.").

```bash
.venv/bin/python -m controller.audition_kokoro --interjection-contours \
  --mood tender --text "Aww, that is so sweet." --text "Ooh! Nice." \
  --output-dir assets/private/speech/kokoro-audition/issue-84-contours
```

## 2f. Quotations (#84 tier 5b)

Yidhari's actor sets a quotation apart: a slight pause before it and a
slightly lower voice across it. Quote voice (Kokoro only) is on by default after
listening (8 Nov 2026); `--no-quote-voice` or `--plain-voice` turns it off, a `"…"` or `“…”` span gets an
emphasis pause before its first word and one gentle pitch dip of
`--quote-bend` semitones (default −2, ±12) across all of its words, bent into
the F0 curve like the contours in §2e. Unbalanced quotes are ignored.

A different pace for just the quoted words is not included: Kokoro's speed
is one number per sentence, so it would mean splitting the sentence into
separate clips, which risks audible joins.

```bash
.venv/bin/python -m controller.audition_kokoro --quote-voice \
  --text 'She said "I love it" and smiled.' \
  --output-dir assets/private/speech/kokoro-audition/issue-84-quotes
```

## 2g. Dynamic emphasis (#83)

Some words carry meaning in their delivery: a contrastive "**buuut**" said
deeper and drawn out, or a sarcastic "suuure". With `--dynamic-emphasis`
(Kokoro only, off until auditioned; `--plain-voice` turns it off):

- **Drawl (deeper and longer):** a sentence-opening *But / Well / So / Now /
  Okay*; the attitude words *sure, really, right, totally, obviously* when
  the mood is skeptical, suspicious, unimpressed, sad-sceptical, annoyed,
  sulky, pout or smug; and `*word*` marks in those moods. The word keeps
  Kokoro's own phonemes and gets a slightly deeper tone, a `--drawl-bend` dip
  (default −2 st, ±12). `--drawl-hold SECONDS` (0–0.45, default 0) can hold its
  vowel longer, but see below: it is off because it does not sound right yet.
- **Bright emphasis:** a `*word*` mark in any other mood also gets the word
  lift (`--word-lift-bend`), on top of its pause.

**Stress-mark check (#83 scope 3):** on ordinary words, Kokoro's marks change
length, not loudness:

| Word | Phonemes | Length | Loudness |
| --- | --- | ---: | ---: |
| really | `ɹˈiəli` → `ɹˈˈiəli` | 1.33× | −0.6 dB |
| really | `ɹˈiəli` → `ɹˈiːːəli` | 1.22× | −0.4 dB |
| but | `bˌʌt` → `bˈʌt` | 1.50× | +0.5 dB |
| but | `bˌʌt` → `bˈʌːːt` | 2.25× (0.225 s) | ±0 dB |

Lengthening by marks changes the vowel, though: listening heard `bˈʌːːt` as
"boot", and a spectrum comparison agreed. The smoothed spectrum of the held
vowel's middle was compared with a real "but" (`bˌʌt`) and "boot" (`buːt`):

| Variant | Length | Like "but" | Like "boot" |
| --- | ---: | ---: | ---: |
| `bˈʌːːt` | 0.25 s | 0.80 | **0.84** |
| `bˈʌt` | 0.15 s | 0.80 | 0.81 |
| `bˈʌt` + hold 0.30 s | 0.30 s | **0.85** | 0.81 |

Holding Kokoro's own vowel looked better on that measure, but listening still
heard "boot", and one take broke up: the steady part of "but" is only about
20 ms, so reaching 0.3 s repeats it many times, which RVC turns buzzy. So a
natural "buuut" needs Kokoro itself to say the vowel longer, i.e. per-token
speed in the ONNX model (#83 scope 2). Until then a drawl is only the slightly
deeper tone, and loudness stays with the exclamation gain.

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
