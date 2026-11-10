# Kokoro GPU compatibility investigation (#62)

## Scope and acceptance

Investigate MIGraphX ONNX and native PyTorch ROCm on the Ryzen AI 9 HX PRO
370 / Radeon 890M (`gfx1150`). The primary objective is freeing CPU capacity
for concurrent work while preserving the existing voice and timing contract.
This branch starts from the RVC checkpoint (`c0a67aa`, PR #132).

The first deliverable is a go/no-go report per candidate, with reproducible
commands, exact failures, repeated short/medium/long probes, CPU time and wall
time, GPU execution evidence, and clips for listening. A provider listing or
PyTorch smoke test alone does not establish Kokoro compatibility. Listening
acceptance is recorded per clip; source-voice approval does not establish
post-RVC listening acceptance.

Preserve `.venv-kokoro`, `../Applio-rocm/.venv`, original models and the live
bridge. Put experimental environments/models/caches in `/tmp/kokoro-gpu-62`;
put private results and clips in `assets/private/speech/62/`. Do not install
system drivers or change the normal bridge's provider selection. Read-only
reuse of existing package directories is permitted for the native probe, but
must be recorded and must not be described as a standalone deployment.

## Investigation sequence

1. Record model inputs/outputs, dtypes, shapes, graph speed consumers and
   random operations before changing anything. Derive the per-token copy in
   scratch if missing; never patch the original.
2. Prepare identical phonemes, token IDs and voice blend (`af_heart:0.7` +
   `af_bella:0.3`) so tokenizer changes cannot masquerade as backend drift.
3. For MIGraphX, probe different sequence lengths and return to prior shapes;
   record session creation, compilation/recompilation, actual GPU partitions,
   warm runs and exact errors. Test scalar and per-token speed.
4. For native PyTorch, read its exact signature, compare predicted durations
   and sample lengths against CPU ONNX, then probe a per-token speed vector.
   Synchronise GPU work when timing it and establish actual GPU execution.
5. Reuse the existing Kokoro wrapper/worker where possible to exercise voice
   blends, word spans, clause pauses, emphasis, holds/drawls and timings used
   by RVC bends. Record any adapter gaps explicitly.
6. Save source clips and representative post-RVC clips, numerical timing
   checks and separate listening verdicts. Report CPU seconds per audio second
   and wall-time distributions; ambient desktop load is not a controlled
   multitasking benchmark.

Synthetic adapter/measurement tests must fail for the intended missing
behaviour before implementation; keep hardware tests opt-in. Scope excludes
product device flags, UI/persistence, automatic switching, reduced precision,
other GPUs and claims of full feature parity without evidence.

## Sources

- [AMD ONNX Runtime setup](https://rocm.docs.amd.com/projects/ai-ecosystem/en/latest/inference/onnxruntime.html)
- [MIGraphX provider](https://onnxruntime.ai/docs/execution-providers/MIGraphX-ExecutionProvider.html)
- [Native Kokoro model](https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py)
- [Issue scope decisions](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/62#issuecomment-6738174153)

## Results

Measured 9 November 2026 on Ubuntu 24.04.5, kernel `6.17.0-1033-oem`,
Radeon 890M / `gfx1150`. No architecture override or system driver change.
The normal bridge, CPU environment and Applio environment were not switched
or upgraded. The original ONNX model still hashes to
`beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a`.

### Decision

| Candidate | Result | Decision |
|---|---|---|
| MIGraphX 2.18 / ROCm 10.1, ORT 1.29 plugin | A tiny MatMul executes on GPU, but Kokoro reports invalid graph fusion and executes entirely on CPU | **No-go for this tested combination**; isolate/fix the Kokoro partitioning problem before integration |
| Native Kokoro 0.9.4, torch 2.11.0+rocm7.2, default MIOpen | LSTM kernel compilation fails on missing rocRAND headers; supplying matching rocRAND headers exposes missing HIP headers next | **No-go as installed**; no GPU Kokoro inference completed through this MIOpen path |
| Same native model using PyTorch native GPU operators, default TorchSTFT | Real HIP launches and raw duration parity, but the user rejects both native GPU and native CPU clips for voice quality/premature emphasized-word endings | **No-go for promotion**; duration parity alone does not establish voice quality |
| Native model using ATen GPU operators and the ONNX-style CustomSTFT | GPU synthesis, raw duration/sample parity, expressive timings and user source-voice listening all pass on the tested clips | **Go for optional native-backend integration**, with controlled workload, longer-text and post-RVC listening checks still required before broader support |

This is a compatibility investigation, not a production backend selector.
No general support claim is made for other models, runtimes or hardware.

### Model and environment evidence

The reference graph is opset 17 with `input_ids` int64 `[1, n]`, `style`
float32 `[1, 256]`, scalar speed float32 `[1]`, waveform float32 and duration
int64 outputs. `speed` feeds one `Div`. The scratch per-token copy changes
only its declared speed length. `RandomUniformLike` and `RandomNormalLike`
are present, so waveform equality is not used as a parity criterion.

Native weights came from `hexgrad/Kokoro-82M` revision
`f3ff3571791e39611d31c381e3a41a3af07b4987`:

- `kokoro-v1_0.pth`: `496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4`
- `config.json`: `5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f`

The native scratch environment installs Kokoro/misaki dependencies locally
and reuses existing CPU Kokoro and Applio package directories through a `.pth`
file. In particular it uses transformers 5.13.1 and ORT 1.31.1. This avoids
reinstalling the 16 GB Applio runtime, but is **not a standalone deployment**.
Package manifests are retained with the private results. A product setup
would need its own pinned, independent environment.

### Initial native GPU core inference measurements (rejected audio configuration)

Input phonemes, token IDs, style tensors and speed were held equal. Three
lengths (27 / 54 / 243 phoneme tokens, plus model padding) were run in order
three times. The table gives medians of the **two returning-shape runs**,
excluding the first visit to each shape. CPU seconds count process CPU time;
100% CPU means one logical CPU, not the whole 24-thread machine.

| Raw audio length | ONNX CPU wall | Native GPU wall | ONNX CPU seconds | Native GPU CPU seconds |
|---|---:|---:|---:|---:|
| 2.075 s | 0.578 s | 0.660 s | 1.044 | 1.091 |
| 3.325 s | 0.956 s | 0.854 s | 1.728 | 1.361 |
| 14.600 s | 4.365 s | 2.709 s | 7.952 | 4.791 |

The long case used about **40% less process CPU time** in this small sample;
the short case used about 5% more. This supports investigating CPU headroom
for longer speech, not promising a universal latency or CPU reduction.
Ambient desktop work and some other scratch probes overlapped; no controlled
Docker/LLM workload or statistical significance claim is made. These are
**core inference** measurements, excluding tokenisation, pauses, alignment,
RVC and playback.

Timed setup after common probe imports took 0.80 s for ONNX CPU and
5.54 s for native GPU; first short inference took 0.77 s versus 3.41 s.
These are not complete bridge spool-up measurements or cache-flushed starts.

### Numerical and expressive checks

- All nine native GPU core runs matched the CPU ONNX oracle's token durations
  and sample counts exactly for the tested inputs. Native CPU probes matched
  those same three lengths as well.
- A per-token speed vector changing the middle token to 0.5 matched the
  patched ONNX output durations exactly. The normal worker's capped drawl
  path also stretched the requested word successfully.
- The existing worker and ONNX wrapper were reused with a scratch session
  adapter, preserving the voice blend and text/token handling. Word spans
  for words 0, 2 and 5 were present, ordered and within their audio bounds.
- Emphasis inserted one 0.12 s pause. Drawl lengthened the clip by 0.10 s.
  A real vowel-hold probe lengthened the first word by approximately 0.198 s
  and shifted later word spans. Five instrumented feature inference calls
  matched their ONNX oracle durations and sample counts exactly.
- The profiler recorded **16,288 HIP kernel-launch calls**, including
  `hipLaunchKernel`, `hipExtModuleLaunchKernel` and `hipModuleLaunchKernel`;
  model outputs remained CUDA/HIP tensors until copied back. Device-kernel
  timeline events were not available in this profiler build: the report's
  `gpuKernelEvents: 0` must not be confused with the captured launch evidence.
- Both representative source clips subsequently converted successfully in
  the same ROCm RVC worker, supplying each source's own word-5 span for a
  two-semitone bend request. This validates request/conversion plumbing, not
  an independently measured pitch-contour or listening verdict.

**Remaining timing difference:** raw medium audio is 3.325 s for both
backends with pause insertion disabled. With sentence/clause pauses set to
0.25 s, ONNX remains 3.325 s while native becomes 3.565 s. The unchanged
wrapper measures quiet waveform frames before topping up gaps; its
waveform-dependent pause insertion adds 0.24 s for the native waveform.
Later word spans shift accordingly. This is isolated from token-duration
prediction, but full pause/voice equivalence is **not accepted yet**.

Feature runs with `--verify-features` include extra CPU oracle inference;
their `ttsSeconds` values are diagnostic, not fair GPU performance numbers.
Use the core-run table for the preliminary performance comparison.

### Listening feedback and decoder diagnosis

The user rejected the default native GPU emphasis clip as worse quality,
then also rejected the same native route on CPU: some emphasized words
appear to end prematurely. Both verdicts are retained in private
`listening.json`. The native CPU/GPU raw medium waveforms have normalized
correlation approximately 0.997 in this sample; this supports investigating
their shared implementation rather than attributing the defect to GPU math.
Correlation is descriptive and is not a listening acceptance criterion.

Graph inspection found `kmodel.decoder.generator.stft.weight_forward_real`,
`weight_forward_imag`, `weight_backward_real` and `weight_backward_imag`
initializers in the reference ONNX model. The native model defaults to
`TorchSTFT`; its `disable_complex=True` option instead selects `CustomSTFT`,
the convolution-based export implementation. The probe now exposes that
choice explicitly as `--native-custom-stft`.

With CustomSTFT on native CPU, all four tested feature clip lengths and word
spans match the reference again, including 3.325 s plain, 3.445 s emphasis,
3.425 s drawl and approximately 3.523 s hold. Pause comparison is 3.325 s
with both zero and 0.25 s pause settings, matching ONNX. The emphasis waveform
correlation with ONNX is approximately 0.997 for this sample. These results
isolate a decoder-implementation difference and eliminate the measured
0.24 s pause drift. Numerical results alone did not establish that the user's
audible complaint was resolved; a new listening comparison followed.

The matching **GPU** configuration then passed all nine raw duration/sample
comparisons and per-token speed. Its plain/emphasis/drawl/hold clip lengths
and word spans match the CPU reference. The trace records 16,289 HIP launch
calls. The user accepted the revised GPU emphasis source clip as **similar to
the original CPU voice**. This positive verdict applies to that tested source
clip; post-RVC listening and broader text coverage remain separate checks.

### Matching-STFT GPU measurements (source clip accepted)

Same corpus, voice blend, token/style inputs and two returning-shape samples
per length as above. These are core inference numbers under ambient load.

| Raw audio length | ONNX CPU wall | Native GPU wall | ONNX CPU seconds | Native GPU CPU seconds | Less process CPU time |
|---|---:|---:|---:|---:|---:|
| 2.075 s | 0.578 s | 0.401 s | 1.044 | 0.644 | 38% |
| 3.325 s | 0.956 s | 0.576 s | 1.728 | 0.906 | 48% |
| 14.600 s | 4.365 s | 2.042 s | 7.952 | 3.631 | 54% |

The largest case converted approximately 2.1 times as fast in this sample,
with roughly half the process CPU work. This is a promising match for the
CPU-headroom objective, not a controlled Docker/LLM contention result or a
claim about complete speech latency. Timed setup after common imports took
8.41 s and the first short inference 1.60 s for this configuration.

### MIGraphX failure isolation

The official pip combination installed entirely under scratch:
`rocm[libraries,device-gfx1150]==10.1.0`,
`migraphx==2.18.0+rocm10.1.0`, `migraphx-libs` at the same version,
`onnxruntime-ep-migraphx==1.0.0+rocm10.1.0`, and ORT 1.29.0.

Two separate issues were observed:

1. Registering the plugin and specifying its name in `providers=[...]`
   silently produces a CPU-only session. Explicit
   `SessionOptions.add_provider_for_devices` avoids this known
   [upstream selection issue](https://github.com/microsoft/onnxruntime/issues/33556).
   The adapter tests ensure that missing plugin devices are rejected.
2. With explicit device attachment, Kokoro emits:

   ```text
   OrtEp::GetCapability() for MIGraphXExecutionProvider set nodes that cannot
   be fused together ... an unsupported node in any path between two of the
   supported nodes.
   ```

   The resulting profile contains 45,057 CPU node events and **no MIGraphX
   node execution**. The same runtime executes a small MatMul on MIGraphX,
   isolating the observed failure to Kokoro graph support/partitioning rather
   than proving that the GPU runtime is unavailable. The CPU-fallback timings
   are not reported as GPU performance. Compilation/recompilation/cache costs
   for actual GPU Kokoro therefore remain unmeasured.

### Native MIOpen failure isolation

The first native GPU attempt fails compiling `MIOpenDropoutHIP.cpp`:

```text
fatal error: 'rocrand/rocrand_xorwow.h' file not found
RuntimeError: miopenStatusUnknownError
```

Supplying rocRAND headers from tag `rocm-7.2.0` (commit
`13c332b687d173643024b0d8bba5e3e11e57a16b`) via
`HIPRTC_COMPILE_OPTIONS_APPEND=-I/tmp/kokoro-gpu-62/rocRAND/library/include`
advances compilation to a missing `hip/hip_runtime.h`. This confirms a
compiler-header dependency chain; no system installation was attempted.
The successful native experiment explicitly bypasses MIOpen with
`torch.backends.cudnn.enabled=False` in its own process. It still executes
PyTorch GPU operators; this is not CPU fallback or a change to Applio.

### Reproduction on this prepared scratch environment

To rebuild the native scratch environment on this checkout with the recorded
working CPU/Applio environments available:

```bash
python3 -m venv /tmp/kokoro-gpu-62/native
python3 - <<'PY'
from pathlib import Path
root = Path.cwd()
site = Path('/tmp/kokoro-gpu-62/native/lib/python3.12/site-packages')
(site / '00-existing-readonly.pth').write_text(
    str(root / '.venv-kokoro/lib/python3.12/site-packages') + '\n' +
    str(root.parent / 'Applio-rocm/.venv/lib/python3.12/site-packages') + '\n')
PY
/tmp/kokoro-gpu-62/native/bin/python -m pip install \
  --cache-dir /tmp/kokoro-gpu-62/pip-cache kokoro==0.9.4
PYTHONPATH=. /tmp/kokoro-gpu-62/native/bin/python - <<'PY'
import hashlib
from pathlib import Path
from controller.setup_kokoro import ASSETS, make_per_token_model
source = Path('models/kokoro/kokoro-v1.0.onnx')
assert hashlib.sha256(source.read_bytes()).hexdigest() == ASSETS[source.name]
make_per_token_model(source, Path('/tmp/kokoro-gpu-62/kokoro-pertoken.onnx'))
PY
```

Use the retained package manifests to recover the tested transitive versions.
The probe pins the native weight/config revision recorded above. This recipe
deliberately depends on the existing working package directories; independent
packaging remains future work.

Run from the repository root. `sg render` is needed only while the desktop
session has stale group membership. `HF_HOME` points at the recorded native
weights; no text is sent to an online TTS service.

```bash
# CPU reference (uses the scratch per-token model).
PYTHONPATH=. /tmp/kokoro-gpu-62/native/bin/python \
  tools/kokoro_gpu_spike.py --backend onnx

# Native GPU using ATen operators, with ROCm PyTorch 2.11.0.
sg render -c 'HF_HOME=/tmp/kokoro-gpu-62/hf PYTHONPATH=. \
  XDG_CACHE_HOME=/tmp/kokoro-gpu-62/cache-native \
  /tmp/kokoro-gpu-62/native/bin/python tools/kokoro_gpu_spike.py \
  --backend native --native-aten --native-custom-stft \
  --output assets/private/speech/62/native-custom-stft'

# Targeted feature diagnostics; requires that the preceding run saved NPZ inputs.
sg render -c 'HF_HOME=/tmp/kokoro-gpu-62/hf PYTHONPATH=. \
  /tmp/kokoro-gpu-62/native/bin/python tools/kokoro_gpu_spike.py \
  --backend native --native-aten --native-custom-stft --features-only --verify-features \
  --output assets/private/speech/62/native-custom-stft'

# Adapter contract tests (NumPy/PyTorch available only in the scratch env).
PYTHONPATH=. /tmp/kokoro-gpu-62/native/bin/python -m unittest discover \
  -s tests -p 'test_kokoro_gpu_spike.py'
```

These commands assume the separately prepared scratch dependencies/model
copy. They are not an installation command or a supported bridge GPU flag.
The experiment source is `tools/kokoro_gpu_spike.py`. Its CLI uses the
existing wrappers for the probes and writes private JSON/NPZ/WAV reports.

For the failed MIGraphX candidate, use a **separate** venv and the three
official AMD wheel indexes; do not mix its ROCm 10.1 libraries with the native
PyTorch 7.2 process:

```bash
python3 -m venv /tmp/kokoro-gpu-62/migraphx
/tmp/kokoro-gpu-62/migraphx/bin/python -m pip install \
  --cache-dir /tmp/kokoro-gpu-62/pip-cache \
  --extra-index-url https://stable.repo.amd.com/rocm/whl-next/ \
  --extra-index-url https://stable.repo.amd.com/rocm/migraphx/whl-next/ \
  --extra-index-url https://stable.repo.amd.com/rocm/onnxruntime/whl-next/ \
  'rocm[libraries,device-gfx1150]==10.1.0' \
  'migraphx==2.18.0+rocm10.1.0' 'migraphx-libs==2.18.0+rocm10.1.0' \
  'onnxruntime-ep-migraphx==1.0.0+rocm10.1.0'
python3 - <<'PY'
from pathlib import Path
site = Path('/tmp/kokoro-gpu-62/migraphx/lib/python3.12/site-packages')
(site / '00-existing-readonly.pth').write_text(
    str(Path.cwd() / '.venv-kokoro/lib/python3.12/site-packages') + '\n')
PY
sg render -c 'PYTHONPATH=. XDG_CACHE_HOME=/tmp/kokoro-gpu-62/cache-migraphx \
  ORT_MIGRAPHX_CACHE_PATH=/tmp/kokoro-gpu-62/migraphx-cache \
  /tmp/kokoro-gpu-62/migraphx/bin/python tools/kokoro_gpu_spike.py \
  --backend migraphx --output assets/private/speech/62/migraphx-device'
```

### Validation and retained artifacts

- Docs were written before adapter tests and implementation.
- Red: adapter test import failed for the missing investigation module.
  Green: six synthetic PyTorch contract tests passed.
- Red: provider selection tests failed for missing `attach_migraphx`.
  Green: **all eight probe tests passed** in the scratch environment.
- The normal project environment passes the two provider tests and explicitly
  skips the six PyTorch tests without installing new runtime dependencies.
- The original ONNX SHA-256 is unchanged. `git diff --check` passes.
- Private artifacts under `assets/private/speech/62/` include raw reports,
  package manifests, model identities, profiles, source clips and post-RVC
  clips. The post-RVC reproduction helper is retained there too.
- The initial native CPU/GPU clips failed listening. The revised matching-STFT
  GPU source clip was accepted by the user as similar to the reference.
  The subsequent post-RVC feedback was provisional,
  rather than an explicit approval of equivalence; post-RVC acceptance remains
  open. The normal bridge still uses CPU
  Kokoro; neither the bridge nor renderer production paths changed.

Next integration decisions: retain CustomSTFT for voice/timing compatibility,
listen to the converted pairs and implement an optional native GPU backend
with explicit device/environment controls. The MIGraphX graph-partitioning
reproduction can be reported upstream separately. Product controls and
controlled multitasking validation remain later stages of #62.
