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

- **Adaptive estimate.** The bridge measures synthesis throughput: the time
  between one clip finishing and the next, divided by the next clip's
  characters. It counts only clips that were already queued when the one
  before them finished, so time spent waiting for the LLM is left out. The
  first clip of each reply is skipped, because it includes warm-up. Samples
  feed a moving average (`SynthesisRate`) kept on the speech worker, so later
  replies start with a warm estimate. Adaptive starts when the ready audio is
  at least 1.2 × (characters still to make × seconds per character)
  (`ADAPTIVE_MARGIN`). Until the average has `MIN_RATE_SAMPLES` (2) samples,
  it waits as `full` does.
  - Throughput is measured rather than divided by the number of sentences in
    flight, because RVC converts one clip at a time. Only the TTS step
    overlaps.
- **Streamed chat replies.** `adaptive` and `full` wait until the LLM has
  finished the reply text, because before that the rest of the reply is
  unknown. For `say` and `report` the text is complete from the start.
- **Thinking face.** When the first ready clip is held, she shows the
  `thinking` mood, so the silence looks intentional. Each clip's own mood
  replaces it when the clip plays.
- **Maximum hold.** After `--speech-max-hold` seconds (default 20) from the
  **first held clip**, the held clips are sent anyway and the rest of the reply
  streams. A long reply never leaves her silent indefinitely after audio is
  ready. Time spent waiting for the LLM's first sentence does not count, so a
  slow model does not quietly turn `full` into `stream`.
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
  browser (`localStorage`, key `yidhari.speech-buffering`). When the page
  connects, a stored choice is sent to the bridge. With no stored choice, the
  page only asks which mode is in use, so it never resets another page's
  choice. The change applies from the next reply. The note under the menu
  shows the mode the bridge is using.
- **One mode for the bridge.** There is one voice, so the mode is shared by
  every open page and by agent speech, and the last change wins. Every
  connected page is told about a change, so each page's note stays correct.
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
- After a change, the bridge sends the mode now in use to **every** connected
  page: `{"type": "settings", "speechBuffering": "<mode>"}`.
- `{"type": "settings"}` with no `speechBuffering` key is a query. It changes
  nothing, and only the asking page gets the answer.

## Measurements

To be recorded on the 5825U: time to first audio and the number of gaps for
each mode on the same replies.
