# Architecture v2 — PMX companion

Target host: user-reported ASUS ProArt PX13, Ryzen AI MAX+ 395, 128 GB unified memory, Ubuntu 24.04.

This supersedes the VRM/Live2D sketch in [architecture.md](./architecture.md).
Reconstructed from the conversation after repository loss on 2026-10-17;
see [Restoration status](./restoration-status.md) for current recovery limits.

## Goal

A quiet companion, not a dancer. The face combines blink, semantic moods, and
accurate sound-by-sound lip sync. Small canned hand poses are planned. The body
stays mostly stationary; no dance VMD or locomotion is required. Existing arm
lowering is a local pose adjustment. Hair/coat/tail physics remain future work.

Speech uses timed phonemes mapped to calibrated visemes, including consonant
closures and silence. Five vowel shapes or a loudness-driven mouth alone are not
the finished target. TTS determines audible pronunciation; animation follows it.

## Loop

```text
User text -> llama-server (Qwen, Vulkan, 127.0.0.1:8080)
                    |
             streaming text + mood tags
                    v
             controller/bridge.py
                    |
                    +-- Text preview: clean text + expression events
                    |
                    +-- Planned speech:
                        TTS (local, or Applio online TTS workflow)
                          -> Applio RVC conversion (voice model)
                          -> final audio + exact transcript
                          -> phoneme alignment -> timed visemes + segment mood
                    |
             WebSocket 127.0.0.1:8765
                    v
             renderer/bridge-client.js -> renderer/main.js
                    |
             expression controller / planned audio-clock facial compositor
                    v
             PMX morph weights -> screen / OBS
```

Applio replaces the earlier VCClient candidate for voice conversion. The user was
downloading Applio 3.6.6; its installed CLI, AMD/Linux backend and latency have not
been verified. Conversion can be bypassed for baseline comparisons. Keep Applio
as a sibling installation with its own Python environment and voice models;
configure an explicit path when integrating it. Do not mix its dependencies into
the avatar environment.

Applio's [TTS documentation](https://docs.applio.org/getting-started/tts/) describes
Edge TTS followed by optional RVC conversion. Edge TTS sends text to an online
service. For fully local generation, use local TTS (Piper remains a candidate)
then Applio conversion. Initial integration uses a saved final WAV, not live
virtual-device routing. Applio is not assumed to provide phoneme timings.

The renderer runs separately from inference. This prevents blocking animation
with inference work, but does not eliminate contention for shared hardware.

## Model and runtime

Load `yidhari-mmd/伊德海莉.pmx` without moving or renaming the model pack: texture
paths are relative. Keep the pack gitignored; its readme forbids redistribution.
Do not load `武器.pmx`. The pack contains no dance motion, and none is needed.

The [PMX catalog](./pmx-morph-catalog.md) inventories 56 vertex morphs. Blink uses
`まばたき`; winks use `ウィンク` and `ウィンク右`. The
[shared JSON catalog](../renderer/expressions.json) holds 46 semantic presets,
including `neutral` with an empty morph map. Presets are interpreted visually,
not inferred reliably from duplicated English metadata labels.

Preview buttons and bridge callbacks call the same expression controller. One
mood is active at a time, with easing to another mood or neutral. The controller
resolves required morphs and disables unavailable presets. Loop intensity is
retained across presets; the intensity slider can rescale the active mood or
loop without stopping it. The test bench provides manual sliders, a sweep,
candidate storage, and JSON export; these are authoring tools, not LLM controls.

Every frame resets morph influences, then applies blink, winks, mood and manual
audition contributions. Known overlap: `super-angry` uses the blink morph, and
multiple moods use speech-related mouth shapes. A proper compositor is still
needed before speech; existing channel independence is not a guarantee of
non-conflicting geometry.

Hand poses (`rest`, `loose`, `lift`, `thinking`) are planned using wrist/finger
bones, eased over about 300 ms. Webcam tracking and full-body locomotion are out
of scope.

## Current state and historical verification

| Piece                                           | State after this restoration                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| JSON catalog, expression controller, test bench | Restored in the renderer                                                                                                 |
| Browser WebSocket client and transcript         | Restored; waits for backend                                                                                              |
| Python bridge and llama-server adapter          | Restored: catalog parser, Origin-restricted WebSocket, SSE adapter, local environment and regression tests |
| Live LLM test                                   | Post-repair backend test passed: qwen3.8-27b streamed soft-smile, thinking, neutral and tag-free text via WebSocket                 |
| Applio, TTS, alignment, lip sync                | Planned, not implemented                                                                                                 |

## LLM mood pipeline and events

The LLM gets only allowed semantic names and descriptions, never PMX names or
weights. The bridge reads the same UTF-8 JSON via a path relative to its source.
Example target output:

```text
[soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]
```

The restored backend sends:

```json
{"type":"start"}
{"type":"expression","name":"soft-smile","weight":0.6}
{"type":"say","text":"Good morning."}
{"type":"end"}
```

`error` carries a text message. Each run begins neutral; successful completion
keeps the last mood unless a neutral tag was emitted. Generation errors reset neutral. The browser preserves the last mood on disconnect. The renderer writes transcript text with `textContent`, limits retained
text to 50,000 characters, reconnects without automatically repeating a run,
and clears manual overrides/stops the loop on start. Authoring controls are
inert while receiving a response.

The streaming parser must retain split tags such as `[soft-` + `smile:0.6]`.
Case-sensitive catalog names are allowlisted; decimal intensity defaults to 1,
finite values clamp to 0–1. Brackets are reserved controls: unknown, malformed,
oversized (over 128 characters), and unfinished blocks are dropped. Text outside
tags preserves whitespace. Consequently general Markdown links, bracketed
citations and code indexing require a different structured-control protocol.

The restored llama-server adapter posts streamed `/v1/chat/completions` requests,
uses content deltas rather than reasoning deltas, and generates its system
prompt from the catalog. The CLI prompt represents a fresh single-turn request,
not persistent chat history. Text preview changes expression on arrival; final
speech must change it at audio playback start.

## Speech and expression synchronisation

This is the next milestone, not implemented functionality. Multiple phonemes
can share a viseme. Do not assign mouth shapes from spelling or equal-duration
syllables, and do not ask the LLM to invent timestamps.

1. Produce a short fixed sentence with the selected TTS/Applio voice. Save source
   audio, final converted WAV, exact transcript, duration and generation time.
2. Prefer verified synthesis phone/viseme timestamps if trustworthy. Otherwise
   align the final audio and transcript using a local phone-level forced aligner.
   Word timestamps alone are insufficient; an aligner has not been selected.
3. If conversion changes timing, re-align converted audio or use a measured,
   validated time mapping. Constant offset correction is valid only when
   durations are preserved.
4. Buffer final audio and its complete timing track per segment before playback.
   Prepare subsequent segments asynchronously with a bounded queue.
5. Schedule mood and visemes on the browser audio clock. Each speech segment
   needs utterance ID, segment ID, audio reference, duration, expression, and
   ordered audio-relative viseme intervals. Validate finite times, bounds and
   weights; interpolate locally each frame rather than send per-frame messages.
6. Cancel audio and queued tracks together on interruption. Pause/resume follows
   the audio position, not wall time. Release speech mouth influence afterwards.
   Report alignment failures and any explicitly labelled degraded animation.

Initial candidate shapes: `aa` → `あ`, `ih` → `い`, `uu` → `う`, `eh` → `え`,
`oh` → `お`. These require auditioning. Add closed lips for /m b p/, lip/teeth
contact for /f v/, rounding, and silence/rest to a separate speech-shape catalog.
Document unsupported articulation or create local corrective morphs subject to
the asset licence. Extra compute does not repair missing geometry.

Use smooth transitions with neighbouring-sound influence (coarticulation), but
preserve short closures. Mood easing should not simply be reused for rapid
speech shapes. Speech owns articulation; attenuate conflicting mood mouth
contributions with per-shape rules while preserving compatible brows and eyes.
A blanket 50% mood-mouth reduction does not prove closures work. Restore the
resting mood mouth smoothly after speech.

The [Montreal Forced Aligner guide](https://montreal-forced-aligner.readthedocs.io/en/v3.4.0/user_guide/index.html)
is a reference for audio/transcript alignment, not a selection or performance claim.

## Validation and hardware

The Ryzen AI MAX+ 395 / 128 GB UMA configuration is a capable candidate for this
workload; the project has not benchmarked this host. ASUS documents the
[2026 PX13 configuration](https://press.asus.com/news/press-releases/asus-proart-px13/).
Morph updates are modest; TTS, alignment, conversion and concurrent LLM inference
determine practical latency. Start with CPU-capable speech workers and bounded
concurrency. Verify each Linux backend; NPU acceleration is optional, not assumed.
UMA is one pool shared by weights, KV cache, speech models, rendering and the OS.
Bandwidth, GPU/CPU contention and sustained laptop thermals all matter.

Proposed acceptance targets, not measured results:

- Use recordings covering vowels, closures, diphthongs, pauses, fast speech and
  project names. Check audible pronunciation separately from alignment/animation.
- Aim for representative visible landmarks within 50 ms of annotated audio,
  allowing deliberate anticipation. Inspect start/end drift using captures and
  playback logs.
- Replay the same sentence in neutral, soft-smile, sad and angry. Confirm closures,
  silence and readable eye/brow expression.
- Measure time to first audio, total audio-preparation real-time factor, tokens/s,
  frame-time percentiles, peak memory and thermals under the actual LLM workload.
- Target smooth 60 fps with a configurable 30 fps fallback. After initial buffering,
  aim for preparation faster than playback with no underruns. Set a latency budget
  after benchmarking. Volume-only mouth movement is not acceptance of lip sync.

## Security

Treat LLM and WebSocket data as untrusted. Allowlist events/expressions, validate
finite weights, and never evaluate message content. Bind the bridge to
127.0.0.1:8765 and accept only `Origin: http://127.0.0.1:8770`; reject absent and
other Origins. This is browser-origin protection, not authentication against
other local processes. Do not expose arbitrary file paths or commands to tags.

## Build order

1. Preserve the local PMX pack outside git. Keep the renderer working.
2. Python bridge restored with regression tests. Run the fixed demo and live LLM text checks using [the bridge guide](./running-the-bridge.md). Live backend verification after recovery passed against qwen3.8-27b; visual renderer verification is separate.
3. Next visual milestone: one saved Applio-voiced sentence with accurate lip sync
   and a matching expression. Calibrate in neutral, then test a few moods.
4. Automate the verified Applio workflow in its own environment and feed live LLM
   segments through the proven speech path.
5. Finish bounded queues, cancellation, pause/resume, compositor, optional
   conversion comparisons and concurrent-load checks. Additional gestures follow.

The current preview and future experience differ: text arrives immediately now;
the final experience schedules facial expressions and articulation together.

### TTS and voice-model decision notes — 2026-10-17

- **User-reported experience:** previous university IT demonstrations used Applio's UI for both live speech-to-target-voice conversion after model training and text-to-target-voice generation. The user also reports using sampled Yidhari voice audio with Applio. An NVIDIA RTX 4090 was used in the earlier demos; these results are not benchmarks of the current AMD laptop.
- **Model role:** treat the existing Applio-trained voice as an RVC conversion model until its files and configuration are inspected. A successful TTS workflow in the UI does not establish that the voice checkpoint itself accepts text: source TTS and voice conversion are separate stages. ONNX (`.onnx`) and PyTorch (`.pth`) describe file formats, not whether a model performs synthesis or conversion. Matching architecture, configuration, and supporting assets are still required.
- **Preferred experiment:** lightweight local TTS → existing Applio/RVC voice model → final-audio alignment → synchronised playback. Reuse the trained voice if compatible; retraining is not the next milestone. A direct TTS model for the desired voice could remove conversion, but no such model has been identified here.
- **Local versus online:** favour a fully local path for offline operation and keeping dialogue on the machine, subject to voice quality and measured latency. Keep Edge TTS as a comparison or fallback, not an assumed requirement. Local synthesis avoids network delay but consumes shared compute; online synthesis offloads that stage but still requires local conversion and alignment in this design. Neither route is assumed faster without measurement.
- **Hardware/runtime:** the MAX+ 395 with 128 GB UMA is a suitable candidate for pretrained speech inference, but capacity does not establish speed or application compatibility. Start by benchmarking a CPU-capable TTS runtime; test AMD GPU acceleration only with a compatible installed backend. Working llama.cpp Vulkan inference does not prove Applio/PyTorch acceleration works. Record actual devices used and do not assume NPU support.
- **Comparison:** use the same short transcript, target voice, and output settings for local and online source TTS. Compare source pronunciation, converted voice quality, time to first playable audio, total preparation time relative to audio duration, and LLM throughput with the pipeline running. Include alignment in end-to-end timing, distinguish cold model loading from warm inference, and aim for preparation faster than playback after initial buffering.
- **Current status:** the user is still setting up Applio 3.6.6. Its installed backend, model assets, automation interface, and performance remain unverified. Resume with one saved source recording, converted WAV, and exact transcript once setup is ready; then implement the combined speech-and-expression demo. No installation or runtime changes are implied by these notes.
