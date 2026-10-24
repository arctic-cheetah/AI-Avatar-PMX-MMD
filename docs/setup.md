# 🛠️ Setup: Applio with ROCm or CUDA

How to install the [Applio](https://github.com/IAHispano/Applio) voice-conversion
engine so the bridge can run RVC on **your GPU** instead of falling back to CPU —
for both **AMD ROCm** and **NVIDIA CUDA** machines. 🌸

> **Which path should I pick?**
> - 🟢 **AMD Radeon** (e.g. Ryzen AI MAX+ 395 / Radeon 8060S, `gfx1151`) → **Path A: ROCm**
> - 🟢 **NVIDIA GeForce/RTX** → **Path B: CUDA** (upstream Applio already targets this)
> - ⚪ **No supported GPU** → Applio still works on CPU; just slower. Use either path and let PyTorch fall back, or skip to [Connect it to the avatar](#-connect-it-to-the-avatar).

The bridge never mixes environments: each Applio install keeps **its own `.venv`**,
and the bridge picks one with `--applio-dir`. Your voice model (`.pth` + `.index`)
is shared by copying or pointing `--pth`/`--index` at it — it is not tied to a GPU vendor.

---

## 0. Common prerequisites (both paths) 🧰

| Requirement | Check |
|---|---|
| Ubuntu 22.04/24.04 (or similar Linux) | `lsb_release -d` |
| Python 3.12 | `python3 --version` |
| `ffmpeg` on PATH | `ffmpeg -version` |
| `git`, ~20 GB free disk per Applio install | `df -h .` |
| The Yidhari voice model | `logs/Yidhari-zzz/Yidhari-zzz_75e_21450s.pth` + `Yidhari-zzz.index` in your Applio `logs/` |

Clone Applio once per path (keep the two installs separate):

```bash
cd ~/Code
git clone https://github.com/IAHispano/Applio.git Applio        # CUDA / CPU install
git clone https://github.com/IAHispano/Applio.git Applio-rocm   # ROCm install (Path A only)
```

Copy your voice model into each install you plan to use:

```bash
# from wherever your trained model currently lives:
cp -r logs/Yidhari-zzz ~/Code/Applio/logs/        # if not already there
cp -r logs/Yidhari-zzz ~/Code/Applio-rocm/logs/   # ROCm path
```

---

## Path A — AMD ROCm (Radeon 8060S / gfx1151) ❤️

Verified on 2026-10-23 on the Ryzen AI MAX+ 395 host (see
[`docs/architecture-v2.md`](./architecture-v2.md) and `~/Code/Applio-rocm/README-ROCM.md`).

### A1. Driver & permissions check 🔍

```bash
rocminfo | grep -A2 gfx1151          # the GPU agent should appear
ls -l /dev/kfd /dev/dri/renderD*     # device nodes should exist
id | grep -o render || echo "⚠️ add yourself: sudo usermod -aG render,video $USER (then re-login)"
```

No `rocminfo`? Install the amdgpu driver / ROCm userspace for your distro first
(AMD's [ROCm installation guide](https://rocm.docs.amd.com/projects/install-on-linux/en/latest/)).
The PyTorch wheel below bundles its **own** ROCm userspace, so it talks to your
kernel driver via `/dev/kfd` — you do *not* need to match a system ROCm version.

### A2. Create the venv and install ROCm PyTorch 🎯

> ⚠️ Do **not** run Applio's `run-install.sh` in this install — on Linux it pulls
> the CUDA (`cu128`) wheel index and you end up back on CPU. Install PyTorch from
> the ROCm index **first**:

```bash
cd ~/Code/Applio-rocm
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip wheel
.venv/bin/python -m pip install torch==2.11.0 torchaudio==2.11.0 \
  --index-url https://download.pytorch.org/whl/rocm7.2
```

### A3. Install Applio's remaining requirements

Install everything except a second PyTorch. The file below is the upstream
`requirements-engine.txt` with the CUDA-only Windows packages removed and the
ROCm index kept as an extra index so `torch` is never re-resolved from PyPI:

```bash
cat > requirements-rocm.txt <<'EOF'
--extra-index-url https://download.pytorch.org/whl/rocm7.2
click==8.1.8
numpy==2.4.6
requests==2.34.2
tqdm==4.68.4
faiss-cpu==1.14.3
librosa==0.11.0
scipy==1.18.0
soundfile==0.14.0
stftpitchshift==2.0
soxr==1.1.0
torchcrepe==0.0.24
torchfcpe==0.0.4
einops==0.8.2
transformers==5.13.1
matplotlib==3.11.0
tensorboard==2.21.0
onnx==1.23.1
onnxruntime>=1.17.0
edge-tts==7.2.8
beautifulsoup4==4.15.0
sounddevice==0.5.5
webrtcvad-wheels==2.0.14
psutil==7.2.2
uvicorn>=0.30.0
fastapi>=0.110.0
websockets>=13.0
gradio==6.20.0
pypresence==4.6.2
EOF
.venv/bin/python -m pip install -r requirements-rocm.txt
```

> ⚠️ Afterwards, never `pip install torch` from plain PyPI inside this venv — it
> would overwrite the ROCm build with a CUDA/CPU one.

### A4. Verify the GPU is really used ✅

Save as `check_gpu.py` in `~/Code/Applio-rocm` and run it:

```python
import torch
print(f"torch        : {torch.__version__}")
print(f"hip          : {torch.version.hip}")
print(f"available    : {torch.cuda.is_available()}")
if not torch.cuda.is_available():
    raise SystemExit("FAIL: ROCm device not visible — check /dev/kfd permissions and the torch build.")
props = torch.cuda.get_device_properties(0)
print(f"device 0     : {torch.cuda.get_device_name(0)}  arch={props.gcnArchName}")
x = torch.randn(1024, 1024, device="cuda")
print(f"matmul smoke : ok (sum={(x @ x).sum().item():.1f})")
print("PASS: ROCm GPU is usable by PyTorch 🎉")
```

```bash
.venv/bin/python check_gpu.py
# Expected on the 395 host:
# torch 2.11.0+rocm7.2 · available True · Radeon 8060S Graphics · gfx1151 · PASS
```

Applio itself needs **no code change**: its config selects `cuda:0` whenever
`torch.cuda.is_available()` is true, and ROCm PyTorch satisfies that API. 🎉

### A5. (Optional) Benchmark before you commit 📊

From `~/Code/Applio-rocm`, time one conversion of a real speech WAV with your
model and compare against the CPU install. On the verified host: 14.84 s of
speech took **1.58 s (GPU)** vs **3.34 s (CPU)**; per-sentence live conversions
land around `rvcSeconds 0.6–2.0`. Also listen to the output — same quality is
required, not just speed. 🎧

---

## Path B — NVIDIA CUDA (GeForce/RTX) 💚

This is upstream Applio's primary path, so it is the easy one. 🙂

### B1. Driver check 🔍

```bash
nvidia-smi   # should list your GPU and driver version
```

If the command is missing, install the current NVIDIA driver for your distro
first (Ubuntu: `sudo ubuntu-drivers autoinstall`, then reboot).

### B2. Run Applio's installer 🛠️

```bash
cd ~/Code/Applio
chmod +x run-install.sh run-applio.sh
./run-install.sh
```

What it does (Linux): creates `.venv` (Python 3.12, via `uv`), installs
`ffmpeg` support, then installs `requirements.txt` with the
`https://download.pytorch.org/whl/cu128` index — i.e. CUDA 12.8 PyTorch builds
(currently pinned at `torch==2.11.0` in `requirements-engine.txt`).

### B3. Verify the GPU is really used ✅

```bash
.venv/bin/python - <<'PY'
import torch
print(torch.__version__, torch.version.cuda, torch.cuda.is_available())
print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU fallback ⚠️")
PY
```

Expect `True` and your GPU name. If you prefer a manual install instead of the
script, the equivalent is:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install torch==2.11.0 torchaudio==2.11.0 \
  --index-url https://download.pytorch.org/whl/cu128
.venv/bin/python -m pip install -r requirements.txt
```

> ℹ️ PyTorch wheels bundle the CUDA runtime, so a matching system CUDA toolkit
> install is **not** required — only a current NVIDIA driver.

### B4. (Optional) Try the Applio UI 🎛️

```bash
./run-applio.sh   # or: .venv/bin/python app.py
```

---

## 🎙️ Connect it to the avatar

From the avatar repo, point the bridge at the install you just built:

```bash
cd ~/Code/avatar-yidhari

# Kokoro (local, default voice source) + ROCm RVC:
.venv/bin/python -m controller.bridge --mode llm --speech \
  --tts kokoro --kokoro-voice af_heart --kokoro-speed 1.0 --kokoro-threads 2 \
  --applio-dir ../Applio-rocm

# Kokoro + NVIDIA CUDA RVC (same default Applio folder):
.venv/bin/python -m controller.bridge --mode llm --speech \
  --tts kokoro --kokoro-voice af_heart --kokoro-speed 1.0 --kokoro-threads 2 \
  --applio-dir ../Applio

# CPU fallback: omit --applio-dir and optionally cap CPU threads:
#   ... --rvc-threads 4
```

Notes:

- The default `.pth`/`.index` follow `--applio-dir`
  (`logs/Yidhari-zzz/Yidhari-zzz_75e_21450s.pth` + `Yidhari-zzz.index`);
  `--pth` / `--index` override individually.
- `--rvc-threads` is a CPU-torch setting; the GPU paths ignore it.
- Watch for `Applio worker ready: load …s, warm-up …s` at bridge startup and
  per-sentence `rvcSeconds` in the log — that's your end-to-end proof. 📈

---

## 🩹 Troubleshooting

| Symptom | Path | Fix |
|---|---|---|
| `torch.cuda.is_available()` is `False` | ROCm | Check `rocminfo` sees `gfx1151`, `/dev/kfd` exists, and you're in the `render` group; re-login after `usermod`. Last resort: `HSA_OVERRIDE_GFX_VERSION=11.5.1` (misreports arch — try without first). |
| Same, after running `run-install.sh` in Applio-rocm | ROCm | The installer pulled the CUDA index. Rebuild the venv following Path A exactly (PyTorch from the ROCm index **first**). |
| `torch …+cu128` inside Applio-rocm | ROCm | A plain-PyPI install overwrote ROCm. Reinstall with `--index-url https://download.pytorch.org/whl/rocm7.2`. |
| `torch.cuda.is_available()` is `False` | CUDA | Update the NVIDIA driver (`nvidia-smi` must work outside Python first). |
| Bridge stops at startup with "Applio file not found" | both | The chosen `--applio-dir` lacks `.venv/bin/python`, the `.pth`, or the `.index` — check the path in the error and copy the model in (§0). |
| First conversion is very slow, later ones fast | both | Normal: model load + kernel warm-up. The bridge warms the worker once at startup; don't judge by clip #1. |
| RVC runs but the LLM slows down | ROCm | On UMA APUs the iGPU is shared with `llama-server` (Vulkan). Measure tokens/s with/without speech (#15) before tuning. |

## 🔗 Related

- [`README.md`](../README.md) — quick start (Kokoro is the documented default voice source)
- [`docs/running-the-bridge.md`](./running-the-bridge.md) — bridge guide & troubleshooting
- [`docs/testing-kokoro.md`](./testing-kokoro.md) — Kokoro setup, auditions, measurements
- [`docs/architecture-v2.md`](./architecture-v2.md) — "Kokoro source TTS and ROCm RVC — 2026-10-23"
- Upstream: [Applio docs](https://docs.applio.org/getting-started/installation/) · [PyTorch get started](https://pytorch.org/get-started/locally/)
