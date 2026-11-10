# Idle behaviours (issue #71)

When no chat or message comes through the bridge for a while, Yidhari drifts
from active to idle, and after a long quiet she turns sleepy, with slower
blinks. The next chat, voice input or bridge message wakes her with a brief
surprised look, then a happy one, before she settles back into her resting
mood.

#71 lands in parts:

| Part | What it adds | Status |
| --- | --- | --- |
| Idle-state timer | States, sleepy face and blinks, wake-up, blocking, settings | Done |
| Idle motions | Side glances, head tilts, a visual sigh, a stretch before sleepy | Done |
| Sleepy mouth | An open, yawn-like mouth on the `sleepy` face that eases in slowly | Done |
| Sigh and yawn clips | Short synthesised clips, cached like the thinking filler | Planned |

Authored VMD/VPD idle motion is a separate ticket, #140.

## States

```
active ──(idle after, 60 s)──▶ idle ──(sleepy after − 3.2 s)──▶ stretching ──(sleepy after, 10 min)──▶ sleepy
   ▲                              │ glance · tilt · sigh            │                                     │
   └──────── activity ◀───────────┴─────────────────────────────────┘           activity ──▶ waking ─────┘
                                                                       surprised 0.6 s → happy 1.6 s → rest
```

- **active:** the timer counts seconds since the last activity.
- **idle:** reached after *Idle after*. Her face does not change. She plays
  one small motion at a time, 8–20 s apart (see [Idle motions](#idle-motions)).
- **stretching:** the last 3.2 s before *Sleepy after*, so sleepy still starts
  on time. If *Sleepy after* is within 3.2 s of *Idle after*, the stretch
  gets only the time in between.
- **sleepy:** reached after *Sleepy after*, counted from the last activity,
  not from the start of idle. She shows `sleepy` at 0.8 (see
  [Sleepy face](#sleepy-face)), and her blinks come
  twice as far apart and close and open 2.5 times as slowly.
- **waking:** only from sleepy. `surprised` at 0.6 for 0.6 s, then `happy` at
  0.8 for 1.6 s, then her resting mood: the last agent mood, or neutral.
  The existing expression springs ease each step (#54).

Activity during a short idle or the stretch simply returns her to active. A startle after
a minute of quiet would feel jumpy, so the surprised → happy wake-up is kept
for the long, sleepy idle.

## What counts as activity

Only conversation with her counts:

- Sending a chat message, including an answer to an agent `ask`. It counts
  as soon as it is sent, before the bridge replies. An empty message does not
  count.
- Any event from the bridge (`controller/bridge.py`): a chat reply starting,
  a speech clip, an agent `say`, `report`, `ask` or `set_mood`.
- Voice input changing state (recording, transcribing).

The mouse, keyboard, wheel and cursor gaze do not count. Moving the mouse
neither keeps her awake nor wakes her, and her eyes still follow the cursor
while she is awake. This was the user's choice on 11 November 2026: she gets
sleepy when nobody talks to her, not when nobody touches the page.

## When idle behaviours never play

The timer is frozen at zero, and no idle state is entered, while:

- speech is playing, loading or queued;
- the mood is `thinking`;
- an agent `ask` is waiting for an answer;
- a chat reply is streaming;
- a morph audition sweep or held preview is running (developer tools).

The mood preview loop that starts when the page loads does not block idle.
It cycles moods until something stops it, so blocking on it would keep her
awake forever without a bridge. Turning sleepy stops the loop, like any
other mood selection.

If one of these starts while she is sleepy or waking, the idle state ends at
once and hands her face back. The renderer only restores the resting mood
when her face still shows the mood the idle controller set and no speech is
running, so it never overwrites a mood that speech, thinking or an agent has
just applied.

## Sleepy face

`sleepy` is half-lidded eyes (`じと目` 1, `下` 0.4) with an open, drowsy mouth:
`あ` 1 + `お` 0.4, chosen by the user from rendered comparison grids on
11 November 2026. At the idle weight of 0.8 that is `あ` 0.8 + `お` 0.32.

- **A slow, yawn-like ease.** The preset sets `"ease": 3`, so the whole face
  drifts in over about 1.6 s on a critically damped spring, instead of the
  usual 0.34 s. The largest change in one 60 fps frame is under 0.03, and the
  curve is the same at 15 and 60 fps. Waking uses `surprised`'s own (normal)
  rate, so she still wakes up quickly.
- **Lip sync.** `あ` and `お` are speech morphs. While she speaks, speech holds
  them, so visemes replace the open mouth rather than stacking on it, and
  the open mouth comes back when she stops.
- **Grids.** Candidates (`あ`, `お`, `え`, mixes at 0.15–0.35), the user's pick
  at 0.25 / 0.5 / 0.7 / 0.8 / 1, and mid-speech captures are kept in
  `assets/private/71/` (private model).

## Idle motions

Pure logic in `renderer/idle-motion.js` (`IdleMotion`). Each motion follows an
authored curve (`bump`: smoothstep in, hold, smoothstep out), and the output
goes through a critically damped spring (rate 8, about 0.6 s to settle). So
when she leaves idle mid-motion, the pose eases back instead of snapping.

| Motion | Chance | Length | What moves | Size |
| --- | --- | --- | --- | --- |
| Glance | 40 % | 1.2–2.2 s | Eyes, head following at 45 %, to one side | 0.45–0.75 of the gaze range sideways, ±0.15 up/down |
| Head tilt | 30 % | 2–3.5 s | `頭` roll to one side | 5° |
| Sigh | 30 % | 1.1 s in, 1.7 s out | Chest (`上半身2` pitch) and both `肩` lift, then fall | 2° chest, 2.5° shoulders |
| Stretch | Before sleepy | 3.2 s | Back arches (`上半身` pitch), head tips back (`首`/`頭`), shoulders lift | 5° back, 7° head, 6° shoulders |

- The glance is a gaze source. For its 1–2 s it outranks the cursor, which
  may still be moving because the mouse is not activity, but a face tracked
  by the camera still wins. When the glance ends, gaze returns to the cursor or the centre,
  using the gaze spring from #54.
- The tilt, sigh and stretch are small rotations multiplied on top of the
  rest pose: the tilt on the head after gaze, the rest on the sway layer. They
  never replace another layer's pose.
- Bone signs were checked on the model with exaggerated angles (15–20°):
  negative pitch tips the spine and head back, and a shrug is `左肩` negative
  and `右肩` positive roll.
- For previews and comparison grids, `globalThis.__yidhariIdlePose = { tilt, chest,
  shoulders, back, headPitch, glance }` holds a pose (radians, normalised
  glance) until it is set back to `null`.
- Nothing plays while she is active, sleepy or waking, so the blocking rules
  above cover motions too.
- The first motion waits a full gap after idle begins, and each new idle
  period starts a new gap.

## Settings

In **Independent channels**:

| Control | Default | Range | Saved as |
| --- | --- | --- | --- |
| **Idle behaviours · 待機動作** | on | on / off | `yidhari.idle-enabled` (`0` = off) |
| **Idle after (s)** | 60 | 5 s to 1 h | `yidhari.idle-timing` (JSON, seconds) |
| **Sleepy after (min)** | 10 | 5 s to 24 h, never before *Idle after* | `yidhari.idle-timing` |

A status line under the controls shows the current idle state. Settings are
saved in this browser only. If storage is blocked, changes last for the
session. Out-of-range input is clamped and written back to the field.
Unreadable input keeps the last value. Switching the feature off while she is
sleepy wakes her quietly, straight to her resting mood.

To try the states quickly, set *Idle after* to 5 and *Sleepy after* to 0.2
(12 s).

## Timing

The timer uses the real time between frames, without the 0.25 s frame cap
used for easing. A hidden tab pauses the frame loop, so after a long time
away she is already sleepy on the first frame back, until a chat or bridge
message wakes her.

## Code

- `renderer/idle-behaviour.js`: the pure `IdleController` (no DOM or
  Three.js), `normaliseIdleTiming`, and `bindIdleSettings` for the panel
  controls. It emits actions (`mood`, `rest`) rather than touching the
  expression controller itself.
- `renderer/idle-motion.js`: the pure `IdleMotion` that turns the idle state
  into a glance target and small bone angles each frame.
- `renderer/gaze-tracking.js`: `setIdle(target)`, the idle glance source.
- `renderer/bridge-client.js`: `onActivity` for every bridge event and
  voice-input state change, and `onAskChange(open)` when an agent ask opens
  or closes.
- `renderer/main.js`: feeds activity and blocking into the controller each
  frame, applies its moods, and scales the idle blink.
- Tests: `tests/renderer/idle-behaviour.test.mjs`,
  `tests/renderer/idle-motion.test.mjs`, and the #71 cases in
  `tests/renderer/bridge-client.test.mjs` and
  `tests/renderer/gaze-tracking.test.mjs`.
