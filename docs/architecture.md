# Architecture

Target host: Ubuntu 24.04, AMD Ryzen AI MAX+ 395.

```text
You (text / voice)
        |
        v
llama-server  (Qwen, Vulkan, 127.0.0.1:8080)
        |
        | streaming tokens + action tags
        v
controller/bridge.py
        |
        +-- TTS audio (later, Piper)
        |
        v
renderer (browser VRM or Live2D)
        |
        v
screen / OBS
```

## Why this shape

- LLM decode is memory-bandwidth bound and already fits the 256 GB/s bus.
- A 2D / 2.5D avatar is compute-light on the RDNA 3.5 iGPU.
- Keep the renderer in its own process so animation frames do not stall token decode.

## First milestone

- Controller connects to `llama-server`.
- Parses simple tags such as `[blink]`, `[happy]`, `[tilt]`.
- Forwards events over a local WebSocket the renderer can subscribe to.
