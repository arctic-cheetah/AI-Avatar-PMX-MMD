# Optional native Kokoro worker (#62)

## Runtime contract

The normal bridge gains an optional native PyTorch ROCm worker. CPU ONNX
remains the default. The native path must use the CustomSTFT implementation
accepted in the investigation and ATen operators (`cudnn.enabled=False` in
the isolated worker), without changing the live bridge or Applio process.

| Flag | Default | Contract |
|---|---|---|
| `--kokoro-device cpu|gpu|auto` | `cpu` | CPU skips GPU probing; GPU must initialise and warm successfully; auto may visibly fall back |
| `--kokoro-backend auto|onnx|native` | `auto` | CPU auto selects ONNX; GPU auto selects native ROCm; explicit backend is preserved |
| `--kokoro-python PATH` | matching runtime | Override the worker interpreter; otherwise `.venv-kokoro` for ONNX or `.venv-kokoro-rocm` for native |

- `cpu + auto/onnx`: CPU ONNX, without importing PyTorch.
- `gpu + auto/native`: native ROCm GPU; missing dependencies, bad/missing model
  assets, unavailable GPU or failed warm-up stop startup with a reason.
- `gpu + onnx`: invalid: no production ONNX GPU provider is supported here.
- `auto + auto`: attempt native GPU if its environment is present; otherwise
  use ONNX CPU. Native startup/warm-up failure also falls back to ONNX CPU.
- `auto + native`: attempt native GPU, then native CPU, retaining the explicitly
  selected backend. Missing native dependencies/assets remain an error if the
  native CPU attempt also cannot start.
- `auto + onnx`: CPU ONNX with a visible explanation that this backend is CPU-only.
- Interpreter overrides are honoured and validated; an invalid explicit path
  is not silently replaced. Kokoro and RVC selections are independent.

Both workers keep the existing sentence protocol, cancellation, restart,
voice blending, per-token speed, word spans and expressive features. Native
session metadata supplies durations/vocabulary directly; it must not load
the entire CPU ONNX graph just to run native inference. Native inference
must not access the network. Local native config/weights are hash-checked.

Readiness reports requested/effective device/backend, provider or torch build,
GPU/arch when relevant, model identity, load/warm-up times and fallback reason.
The bridge prints Kokoro readiness separately from RVC readiness. Structured
startup errors identify Kokoro. No worker is ready until warm-up succeeds.

## Independent setup

`python3 -m controller.setup_kokoro_rocm` creates `.venv-kokoro-rocm` and installs
the pinned ROCm PyTorch wheel plus native/wrapper requirements there. It downloads
the recorded native revision and source assets with SHA-256 verification and
atomic replacement. It must not change `.venv-kokoro`, Applio's environment,
system drivers or shell startup files. No `.pth` overlay or scratch path is
required by the supported integration.

CPU fallback requires the existing local ONNX source model and voice pack.
Native GPU uses the same voice pack, tokenizer and timing/postprocessing wrapper.
Setup verifies both and derives the separate per-token ONNX copy for fallback;
it does not patch the downloaded original. Linux Python 3.12 is required by
this tested installer. The PyTorch wheel is about 6.2 GB; allow at least 20 GB
for the environment plus download/cache space. Existing ROCm device access
must already work; setup does not install system drivers or change groups.

```bash
python3 -m controller.setup_kokoro_rocm
.venv/bin/python -m controller.bridge --mode llm --agent --speech --tts kokoro \
  --kokoro-device gpu --kokoro-backend native \
  --applio-dir ../Applio-rocm --rvc-device gpu
```

Use `--rvc-device cpu` to keep RVC on CPU while Kokoro uses GPU. To audition
the source without starting another bridge or claiming the live renderer:

```bash
.venv-kokoro-rocm/bin/python -m controller.kokoro_worker \
  --device gpu --backend native --text "Good morning, sweetheart." \
  --output assets/private/speech/62/native-worker.wav
```

An explicit GPU request fails if GPU initialisation or warm-up fails. With
`auto + auto`, the native environment includes ONNX CPU dependencies so it can
fall back within the same worker. Without that environment, auto uses the
existing CPU environment and reports why native could not load. An explicitly
chosen interpreter must contain the dependencies for the requested policy.
`--assets-only` verifies/downloads assets without installing an environment;
`--asset-cache DIR` can reuse native assets after checking their hashes.

## Test and delivery gates

Before implementation, run tests red for flags/interpreter selection, runtime
policy, explicit GPU rejection, visible auto fallback including warm-up failure,
native decoder settings, local asset integrity and structured worker failures.
Then implement the smallest path and re-run relevant regression checks.

Hardware validation uses private worker logs and output clips, not the live
agent socket/renderer. Exercise CPU/GPU readiness, representative synthesis,
cancel/close/restart and a real native-to-RVC request. Keep raw evidence and
listening verdicts private. Source-voice listening approval from the spike does
not imply full post-RVC quality acceptance or controlled multitasking coverage.

UI/persistence, load-aware switching, other GPU vendors and a full workload
benchmark remain outside this increment. This branch builds on draft #133.

## Validation recorded on 9 November 2026

On the Radeon 890M (`gfx1150`), the independent `.venv-kokoro-rocm` installed
successfully with PyTorch `2.11.0+rocm7.2`, HIP `7.2.26015`, Kokoro `0.9.4`,
kokoro-onnx `0.6.1` and ORT `1.31.1`. `pip check` passed. Its only site-packages
directory belongs to that environment; no package overlay or scratch path is
used. The recorded native weights/config and original CPU assets passed their
hash checks. The existing CPU environment was not upgraded.

- **Red → green:** the first 16 contract tests failed for missing flags/modules
  and worker naming before implementation. Additional regression tests reproduced
  a sentence failure labelled Applio instead of Kokoro and a native session not
  closed after an invalid voice. Both now pass after their fixes.
- **Native regression suite:** 43 Kokoro tests passed in the independent runtime:
  `.venv-kokoro-rocm/bin/python -m unittest discover -s tests -p 'test_kokoro*.py'`.
- **Repository suite:** 454 tests ran, with 12 skips, one failure and 20 errors.
  The failing test names exactly match the unchanged-master baseline: 20 fake
  worker tests require the absent default `../Applio` working directory; the
  summariser test expects the old three-sentence instruction. This increment
  adds no failing test names; the full suite is not green on this checkout.
- **CPU default:** real synthesis used ONNX CPU and did not import `torch`.
- **Native parity:** six real comparisons (three lengths, scalar and per-token
  speed) matched ONNX CPU durations and sample counts. Native construction and
  speech succeeded while ONNX session creation and the model's HF download
  function were patched to raise, verifying local metadata/assets suffice.
- **Lifecycle:** real GPU requests preserved emphasis, spans, holds and per-token
  stretching. Cancellation dropped a queued sentence, preserved the next run,
  and did not create the cancelled output. Killing the child was followed by a
  successful request in a new process. Closing released the worker.
- **Device failure:** with GPU visibility disabled only for test children,
  required GPU startup failed with a Kokoro-labelled error; `auto + auto`
  reported ONNX CPU plus the failure reason and produced a fallback clip.
- **Combined pipeline:** GPU Kokoro → GPU Applio succeeded with emphasis, one
  stretched drawl and one endearment lift. One returning request produced
  2.840 s of source in 0.802 s of TTS and took 3.180 s of RVC. These are smoke
  timings under ambient desktop load, not a benchmark or an end-to-end latency
  promise.

Private evidence and audition clips are under
`assets/private/speech/62/native-integration/`, including `report.json`,
`parity.json`, `features-source.wav`, `paired-source.wav` and `paired-rvc.wav`.
No new post-RVC listening verdict is claimed. The earlier source-voice approval
applies to the corrected decoder in the spike; release quality and controlled
Docker/LLM contention still need separate evaluation.

## Listening follow-up: “mean it” (10 November 2026)

The user reports that “mean it” in the combined audition sounds truncated and
asks for clearer pronunciation of “mean”. This reopens the listening gate; the
functional checks above do not establish pronunciation quality.

Before changing runtime defaults, compare identical CPU/GPU source settings,
print the actual phonemes and durations, and isolate source synthesis from RVC
and expressive processing. Try a small number of local timing candidates using
the existing per-token mechanism, retaining the original spelling and phonemes
unless the phonemizer is demonstrably wrong. Save both source and converted
clips under `assets/private/speech/62/mean-it/`. Acceptance requires the user's
ears: a complete “mean it” without a new syllable, exaggerated drawl or damaged
word boundary. Do not promote a word-specific pronunciation override based only
on one audition.

The probe found the same phonemes on CPU and GPU:
`bˌʌt swˈiːthɑːɹt, aɪ ɹˈiəli mˈiːn ɪt!`. “Mean” is correctly represented
as `mˈiːn`; both backends predict `[1, 2, 1, 1, 1]` frames for those five
tokens (150 ms total). CPU/GPU token IDs and duration vectors match in the
expressive baseline. This supports short model delivery as a hypothesis;
it does not establish that RVC contributes no further degradation. The original
paired audition did not run the avatar's later trimming step.

Two smaller local candidates retain the existing 0.125 s drawl target on “But”,
the pause before “mean”, and the original RVC pitch bends. They add per-token
stretch only to word index 4 (“mean”); “it” remains unchanged:

| Audition | Extra stretch request | Measured source span of “mean” |
|---|---|---|
| Baseline | none on “mean” | 150 ms |
| B, gentler | `[4, 0.050]` | 275 ms |
| C, longer | `[4, 0.075]` | 350 ms |

These requests are **per-sound duration targets**, not milliseconds added to
the whole word. Verify the actual predictions: the earlier diagnostic 0.125 s
request yielded 5/6/7 frames on the vowel/length/nasal tokens because speeds
are derived from rounded durations. It exceeded the five-frame listening
limit and was not selected for the comparison. B/C stay within that limit.
Slowing the whole sentence to 0.92 left “mean” at 150 ms in this example,
so it was not selected either. No pronunciation spelling override or runtime
default has been changed; the candidates still need the user's listening verdict.

All five RVC controls (CPU expressive baseline, GPU plain, GPU expressive
baseline, B and C) converted successfully using one GPU worker. B/C differ from
the GPU baseline only at the three “mean” duration tokens selected by the
existing stretch helper; all other predicted token durations, including “it”,
match. The source and converted comparison files are finite, nonempty mono
audio at 24 kHz and 40 kHz respectively. B/C are `gpu-mean50-{source,rvc}.wav`
and `gpu-mean75-{source,rvc}.wav`; `candidates.json` and `rvc-report.json`
retain the inputs, durations, word spans, bend settings and conversion results.
The live bridge was not restarted. These are reversible auditions, so no new
runtime code or implementation-mirroring tests were added for this follow-up.

### Onset defect and acceptance criteria (10 November 2026)

The user rejected both stretched candidates: the start of “mean” still sounds
clipped, with an abrupt volume reset. Inspecting a single captured take before
and after emphasis insertion confirms a real processing defect: `pause_points`
uses the midpoint of a space token without checking the waveform. In this take,
the cut at 1.930 s sits in continuous voiced audio, about 4 dB below the loudest
short RMS window. Inserting 120 ms of zeros there, with fades, breaks the
connected “really → mean” transition. This affects the shared CPU/GPU worker.
The 150 ms duration observation did not explain that transition defect.

The correction must require a quiet window inside the space token before
inserting a pause. Keep at least 5 ms of quiet audio on either side of the cut
for the existing fades; use a conservative level (40 dB below peak amplitude).
If no such window exists, skip that pause, preserve all original speech samples
and report `emphasisSkipped: no-safe-gap` when no requested pause is safe.
Calculate word-span shifts from inserted pauses only. Preserve safe pauses,
first/missing-word handling and non-emphasis synthesis. No spelling change,
extra word stretch or volume boost is part of this correction.

Add tests red for voiced spaces, a safe quiet region away from the nominal
midpoint, insufficient quiet duration, and safe/unsafe mixed requests and
word-span reporting. Then implement and check real same-take CPU/GPU and RVC
comparisons. The audible outcome still requires a new listening verdict.

Implemented and checked: seven onset regression tests reproduced the unsafe
splice/missing waveform-aware selection before implementation. The 23 focused
onset/emphasis/span tests now pass, as do all 43 Kokoro tests in the independent
native environment. The full suite ran 461 tests (12 skips); its one failure and
20 errors have exactly the same names as the unchanged-master baseline.

Real CPU and GPU corrected clips both report `emphasisPauses: 0` and
`emphasisSkipped: no-safe-gap` for this phrase. Each corrected PCM file is
sample-for-sample equal to its own untouched take before emphasis insertion.
Matched old/fixed GPU sources and a corrected CPU-source control all converted
through the same GPU RVC worker successfully. See private
`assets/private/speech/62/mean-onset/`: `fix-report.json`, `rvc-report.json`,
`gpu-old-rvc.wav`, `gpu-fixed-rvc.wav`, `cpu-fixed-rvc.wav`, and the waveform
comparison `onset-comparison.png`. No extra stretch was applied to “mean”.

Quiet-gap preservation is covered by synthetic waveform tests; the additional
real connected-speech controls also skipped unsafe pauses. This deliberately
allows fewer emphasis pauses where the model does not leave silence. The
correction is local and uncommitted; the running avatar bridge was not restarted.
Listening verdict, 10 November 2026: the user accepted the corrected GPU → RVC
“mean it” audition: **“it sounds perfect!”** This closes the listening gate for
that matched onset-fix example. The longer stretched candidates were rejected;
the accepted change preserves the connected speech instead of adding stretch.
This is not blanket approval of longer text, every emphasis transition or
controlled Docker/LLM contention. Final code review and checkpoint commits/PR
remain next; the live bridge still needs a restart to load the correction.

## Live bridge listening feedback (10 November 2026)

The user's first restarted bridge log selected ROCm GPU for RVC and ONNX CPU
for Kokoro. Its command contained `--rvc-device gpu` but no Kokoro device flag;
the CPU readiness line was correct. The user described that live voice as
virtually indistinguishable from the earlier CPU voice. This is a successful
CPU-default regression check, not evidence of GPU Kokoro in that log.

After adding the Kokoro GPU selection, the user separately reported testing
Kokoro on GPU and described the result as **“shockingly good”**. Together with
the accepted matched GPU → RVC onset-fix audition, this supplies positive live
GPU listening feedback. No new timing or resource measurement is inferred from
that verdict. The README now provides a complete both-GPU launch command and
the two readiness prefixes to check.

The requested delivery stops at focused commits and an open PR for guard
review, stacked on #133/#132. No merge is authorized at this checkpoint.
Keep #62 open for its check tool, controlled workload measurements and UI/
persistence scope. The pasted LLM summary connection failure is separate from
TTS device selection and is outside this PR.
