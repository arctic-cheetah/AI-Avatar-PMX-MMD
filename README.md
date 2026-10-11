# avatar-yidhari

A local virtual avatar for **Yidhari**, running beside a local LLM on Ubuntu 24.04 / AMD Ryzen AI MAX+ 395 (Strix Halo).

This is a companion project, kept outside `my_code_pc` so it does not compete for workspace space.

## Goal

Give Yidhari a VTuber-style body:

1. Local LLM (`llama-server`) streams text and optional action tags.
2. A small Python controller turns those tags into avatar events.
3. A browser renderer loads the local PMX, blinks, and later plays lip sync.

## Hardware notes

- Chip: AMD Ryzen AI MAX+ 395 (Strix Halo)
- Memory: soldered LPDDR5X-8000, 256-bit bus
- Peak bandwidth: 256 GB/s theoretical
- Unified memory shared by CPU, RDNA 3.5 iGPU, and XDNA 2 NPU
- Constraint to watch: iGPU compute contention, not memory bandwidth

## Layout

```text
avatar-yidhari/
  README.md
  requirements.txt
  controller/          # LLM bridge + action tags
  renderer/            # browser PMX viewer
  docs/                # architecture notes
```

## Status

The first renderer page loads `yidhari-mmd/伊德海莉.pmx` and blinks. The model pack stays local and is gitignored.

```bash
python3 renderer/serve.py
```

Then open `http://127.0.0.1:8770/renderer/`. Do not open the HTML file directly. The PMX is served from the workspace root.
