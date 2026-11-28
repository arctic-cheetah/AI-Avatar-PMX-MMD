# Speech buffering · 準備 (junbi)

Issue #278. On a slower CPU (for example a Ryzen 7 5825U laptop), one sentence
can take longer to make (TTS → RVC → trim → Rhubarb) than the clip before it
takes to play. With the usual streaming, Yidhari then stops partway through a
reply and waits for the next clip. Speech buffering changes **when** the bridge
sends ready clips to the renderer. It does not change how clips are made.

## Modes

| Mode | When clips are sent | First sound | Gaps |
|---|---|---|---|
| `stream` (default) | Each clip as soon as it is ready, in order | Fastest | Possible on slow CPUs |
| `full` | Nothing until every sentence of the reply is ready, then all of them in order | Slowest | None |
| `adaptive` | Once the reply's text is complete and the audio already made covers the estimated time to make the rest | In between | None, if the estimate holds |

- **Adaptive estimate.** The bridge measures how long the reply has taken so
  far per character made. It multiplies that by the characters still to make,
  and starts when the ready audio is at least 1.2 × that time
  (`ADAPTIVE_MARGIN`). Until the first clip has been measured, it waits as
  `full` does.
- **Streamed chat replies.** `adaptive` and `full` wait until the LLM has
  finished the reply text, because before that the rest of the reply is
  unknown. For `say` and `report` the text is complete from the start.
- **Thinking face.** When the first ready clip is held, she shows the
  `thinking` mood, so the silence looks intentional. Each clip's own mood
  replaces it when the clip plays.
- **Maximum hold.** After `--speech-max-hold` seconds (default 20) from the
  start of the reply, the held clips are sent anyway and the rest of the reply
  streams. A long reply never leaves her silent indefinitely.
- **Cancel.** A new chat, an interrupting chat reply, or a disconnect during a
  hold drops every held clip, and the worker drops the run's queued sentences,
  as with streaming.
- **Once playing.** After the held clips are sent, the rest of the reply
  streams as usual.
- **Replay.** Clips are added to the turn's replay manifest when they are sent,
  so per-bubble replay plays the clips that were spoken.

## Choosing a mode

- **Panel.** Chat panel → **Speech buffering · 準備**: *Bridge default*,
  *Stream*, *Wait for full reply* or *Adaptive*. The choice is saved in this
  browser (`localStorage`, key `yidhari.speech-buffering`) and sent to the
  bridge whenever the page connects. The change applies from the next reply.
  The note under the menu shows the mode the bridge is using.
- **Launch flag.** `--speech-buffering {stream,full,adaptive}` sets the bridge
  default, which *Bridge default* in the panel goes back to.

```bash
.venv/bin/python controller/bridge.py --mode llm --speech --tts kokoro \
  --speech-buffering adaptive --speech-max-hold 20
```

The setting is shared by chat replies, the greeting and agent speech, because
they all use the same bridge speech worker.

## Protocol

Renderer → bridge:

```json
{"type": "settings", "speechBuffering": "full"}
```

- `speechBuffering` is one of `stream`, `full` or `adaptive`, or `null` to go
  back to the launch flag's mode. Any other value is dropped with a warning and
  gets no reply.
- The bridge answers with the mode now in use:
  `{"type": "settings", "speechBuffering": "<mode>"}`.

## Measurements

To be recorded on the 5825U: time to first audio and the number of gaps for
each mode on the same replies.
