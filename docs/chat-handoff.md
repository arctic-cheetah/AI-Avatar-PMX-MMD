# Chat handoff — continue here

This note is the portable copy of the conversation that created this project.
The live VS Code chat file was also refreshed into the `avatar-yidhari` workspace storage.

Session id: `dbea3010-a4aa-4d90-bdff-5dcc3318b8c3`
Title: Virtual avatar request
Source workspace: `/home/parrot/Code/my_code_pc`
Destination workspace: `/home/parrot/Code/avatar-yidhari`

If the Chat view in this window does not show the refreshed history, reload the window, then open the session titled **Virtual avatar request**.

## What we decided

1. Yidhari is the local companion for this project.
2. Hardware is an AMD Ryzen AI MAX+ 395 (Strix Halo).
3. Memory bus is 256-bit soldered LPDDR5X-8000.
4. Theoretical peak bandwidth is 256 GB/s. Sustained is closer to 220–230 GB/s.
5. Unified memory is shared by the CPU, RDNA 3.5 iGPU, and XDNA 2 NPU.
6. A VTuber-style avatar is feasible on Ubuntu 24.04.
7. The real limit is iGPU compute contention, not memory bandwidth.
8. Start with a 2D / 2.5D avatar (browser Live2D or VRM), not a heavy 3D scene.
9. Keep the renderer in its own process so animation does not stall LLM decode.
10. Project lives at `/home/parrot/Code/avatar-yidhari`, outside `my_code_pc`.

## Current scaffold

- `README.md`
- `docs/architecture.md`
- `controller/bridge.py` — parses `[blink]`, `[happy]`, `[thinking]`, `[tilt]`, `[idle]`
- `renderer/` — empty
- `requirements.txt` — `websockets`, `httpx`

## Suggested next step

Wire `controller/bridge.py` to `llama-server` on `127.0.0.1:8080`, then add a browser renderer that subscribes to avatar events.
