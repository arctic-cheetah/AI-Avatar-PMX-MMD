# Animation actions while speaking (#269)

Yidhari can play **Animation actions · 仕草再生** while she speaks: a head
tilt, a shrug, a wink, a tentacle perk, or a Blender pose. They are timed with
her words the same way inline `[mood]` tags are. A coding agent writes them
in `say` and `report` narration, or plays one without speech with
`play_action`. The chat LLM can use them too when the bridge starts with
`--chat-actions`.

```text
[happy] Ooh, a new ticket! [@tilt-left] [mischievous] Shall we make it a big one?
```

## Tags

| Tag | Plays | Example |
| --- | --- | --- |
| `[@name]` | A built-in action from [actions.json](../renderer/actions.json) | `[@shrug-both]` |
| `[@pose:name]` | A Blender pose, `assets/poses/<name>.vpd` | `[@pose:elated-fist]` |

- **Where it starts.** An action tag closes the current fragment, like a mood
  tag, so the action starts with the words after it. The bridge attaches it to
  the next spoken sentence or fragment, and the renderer plays it when that
  clip starts playing.
- **One per fragment.** A second action tag before the same words is dropped.
  An action tag with no words after it is dropped too, because no clip would
  start it.
- **At most eight per reply** (`MAX_ACTIONS` in `controller/actions.py`; the
  user raised it from three on 27 Nov 2026), so she does not flail. Later tags are dropped.
- **Never spoken.** Every `[@…]` tag is removed from the speech text, valid or
  not. Unknown names and actions that are not speech-safe are dropped with a
  warning in the bridge log.
- **Text-only bridge.** Without speech, the bridge sends each action as soon
  as its tag is parsed.

## Shared action catalog

[renderer/actions.json](../renderer/actions.json) is read by both sides:
`controller/actions.py` in Python and `renderer/speech-actions.js` in the
browser. Each entry has:

| Field | Meaning |
| --- | --- |
| `label` | The panel button label (`ACTION_LABELS` and `TENTACLE_ACTIONS` match it; a test checks) |
| `description` | When the action fits. The MCP tool lists it for the agent |
| `speech` | Whether it may play while she speaks |
| `layer` | `body` (default, an `IdleMotion` action) or `tentacle` |
| `target` | For `tentacle`: the `TENTACLE_ACTIONS` key it plays |

**Speech-safe** actions move the head, eyes, brows, shoulders or tails:
glance, the tilts, the shrugs, the winks, eyebrow raise, look around, weight
shift, shy look-away, tentacle perk and tentacle droop.

**Idle and sleep only** actions move the mouth or breath, or read as sleepy,
so they would fight lip sync: sigh, stretch and yawn, the dozing nod,
nodding off, sneeze, hiccup, sniffle, shiver, deep breath, humming bob,
contented smile and neck roll. The long tentacle wave and the tentacle sway
are not speech-safe either, because speech already sways the tails.
`play_action` can still play these, since she is not speaking then.

To add an action: add it to `ACTIONS` in `renderer/idle-motion.js` and to
`actions.json`, then run the tests.

## Poses as actions

Poses are made by the user and can change while the bridge runs, so they have
their own rules.

### Namespace

Poses always use the `pose:` prefix, in tags (`[@pose:name]`) and in
`play_action` (`pose:name`). A pose can never shadow a built-in action or a
mood, even one called `glance` or `happy`: `[@glance]` is the built-in glance
and `[@pose:glance]` is the pose.

### One name rule

`controller/pose_store.py` `NAME` is the only definition of a pose name:
1–64 letters (Japanese included), digits, `_` or `-`. Uploads, the bridge's
tag parser and the `play_action` check all use it, so every name you can
upload can be tagged, and every name a tag accepts can be uploaded.

- **Unicode NFC.** Names are normalised to NFC on upload and on every lookup,
  so `ポ` typed as one character or as `ホ` plus a combining `U+309A` mark is
  the same pose.
- **Case.** An upload whose name differs from an existing pose only by case,
  such as `wink` next to `Wink`, is refused with 409. The same name with the
  same case still overwrites with `?overwrite=1`.
- **Look-alikes.** Full-width punctuation such as `－` or `＿` is not a word
  character, so it is refused, not folded into `-` or `_`.
- **Control characters** are refused by the rule, so a pose name cannot break
  a log line or the tool text.

### Re-reading the poses folder

The renderer is the one that plays poses, and it reads them from its own
`serve.py`, so the bridge never needs the poses folder:

- After an upload, including an overwrite, the page lists the folder again
  (as before), so the new pose can be tagged in the next reply.
- When a speech or agent action names a pose the page does not know, it
  lists the folder again before giving up. A pose added by `git pull` or saved
  by the Blender add-on (#261) therefore plays without a reload.
- A pose that was removed or renamed is dropped, and the Animation actions
  status line says so. Nothing is spoken.
- Only finished `.vpd` files are listed: the `.upload-*` temporary files that
  `pose_store` writes through start with a dot and are skipped.

`mcp_server.py` lists the poses folder once at start for the `play_action`
description (`--poses-dir`, default `assets/poses`). It never checks a name
against that list, so a pose added later can still be played; restart the
agent session to see it in the description.

### Pose settings (`<name>.json`)

An optional sidecar next to the VPD, committed with it so it travels with
`git pull`:

```json
{
  "label": "Elated fists",
  "description": "Both fists up in delight, for a big win.",
  "speech": false,
  "speechHold": 2
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `label`, `description` | none | Shown to the agent in the `play_action` description |
| `speech` | `true` | Whether the pose may play while she speaks. A big two-arm pose can opt out |
| `speechHold` | `2` s | How long she holds it while speaking (clamped to 0.5–4 s). Buttons and idle picks keep the 4 s hold |

A missing or unreadable sidecar gives the defaults.

## In the renderer

- **When.** `playNextSpeech()` plays a clip's action when the clip starts,
  after its mood.
- **Replays repeat it** (the user asked for this on 27 Nov 2026). **Replay
  last speech** keeps each clip's action with its audio, and a bubble's
  replay reads it from the turn's `turn.json`, where `record_clip()` saves it
  next to the mood. A replayed action goes through the same gate, and an
  invalid one in a manifest is dropped while its clip still plays.
- **Gate** (`speechActionBlocked()`): speech does not block a speech action,
  unlike the panel buttons. It is blocked before the model loads, with
  **Gestures while speaking** off, while a pose is held for a preview, during
  a morph preview, while stretching into sleepy and while waking.
- **Not stopped by speech.** The bridge events that end a button's action
  (activity) do not end a speech action, and the per-frame gate that stops a
  blocked button action lets a speech action finish.
- **Layering.** Body actions play through `IdleMotion` on top of the speech
  body sway, so they ease in and out through the same springs. A button or
  the next speech action switches, as before.
- **Poses while speaking** play for their `speechHold`. `HeldPose.quietMouth`
  leaves the mouth panel to the mood and lip sync while she speaks, and the
  pose keeps its bones, eyes and brows. A speech pose never replaces a pose
  you started from a button or `?pose=`, like an idle pick.
- **Toggle.** **Gestures while speaking** under Animation actions is on by
  default and saved per browser (`yidhari.speechActions`). With it off, tags
  are still removed from speech and nothing plays.
- **Status.** The Animation actions status line names the last speech or
  agent action, or why it did not play.

## Agent tool

`play_action(name)` plays one action without speech. `name` is a catalog
action or `pose:<name>`. Any catalog action is allowed here, speech-safe or
not. It returns `ok`, or `busy` within 0.5 s of the last call. An unknown name
is refused before it reaches the renderer. See
[Agent voice over MCP](./agent-voice.md#tools).

## Chat LLM

`--chat-actions` adds the speech-safe actions and the `[@pose:name]` form to
the chat system prompt. Without it the chat LLM is not told about actions,
but any `[@…]` tag it writes is still parsed, and never spoken.

## Tests

- `tests/test_speech_actions.py`: the catalog, tags and their splits across
  stream chunks, the cap, segments, speak events, `play_action`, the pose-name
  round trip, NFC, case clashes, the pose list and sidecars, and the MCP tool.
- `tests/renderer/speech-actions.test.mjs`: catalog parity with `IdleMotion`
  and the tentacle actions, action references, the gate, the toggle and the
  bridge-client checks.
- `tests/renderer/held-pose.test.mjs`: `quietMouth`.
- Replays: `tests/test_replay_store.py` (the action in `turn.json`),
  `tests/renderer/speech-replay.test.mjs` and `turn-replay.test.mjs`.
