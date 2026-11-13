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
| Sleepy mouth | A slow yawn (`あ` 1 + `お` 0.4) during the stretch, a closed mouth while sleepy | Done |
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
  one action at a time, 8–20 s apart (see [Actions](#actions)).
- **stretching:** the last 3.2 s before *Sleepy after*, so sleepy still starts
  on time. If *Sleepy after* is within 3.2 s of *Idle after*, the stretch
  gets only the time in between.
- **sleepy:** reached after *Sleepy after*, counted from the last activity,
  not from the start of idle. She shows `sleepy` at 0.8 (see
  [Sleepy face and yawn](#sleepy-face-and-yawn)), and her blinks come
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
- the mood is `thinking`, unless the mood preview loop is only passing through it;
- an agent `ask` is waiting for an answer;
- a chat reply is streaming;
- a morph audition sweep or held preview is running (developer tools).

The mood preview loop that starts when the page loads does not block idle.
It cycles moods until something stops it, so blocking on it would keep her
awake forever without a bridge. Turning sleepy stops the loop, like any
other mood selection. The loop's own `thinking` step does not block either. Before this fix it
reset the timer every ~150 s, so sleepy (10 min) was never reached without a
bridge. The user found this while trying #151. The rule is the pure
`idleBlocked()` in `renderer/idle-behaviour.js`.

If one of these starts while she is sleepy or waking, the idle state ends at
once and hands her face back. The renderer only restores the resting mood
when her face still shows the mood the idle controller set and no speech is
running, so it never overwrites a mood that speech, thinking or an agent has
just applied.

## Sleepy face and yawn

`sleepy` is half-lidded eyes (`じと目` 1, `下` 0.4) with her mouth closed.
Its `"ease": 3` lets the eyelids droop over about 1.6 s instead of the usual
0.34 s. Waking uses `surprised`'s own (normal) rate, so she still wakes
quickly.

**Actions while asleep.** While she is sleepy, she does one of the ticked
[actions](#actions) every *Sleep action every* minutes (2 by default), counted
from when sleepy began. Her sleepy face stays during each one. Set the
interval to 0 for none: she then only stretches once, before sleepy.

She **yawns during each stretch**: on the way into sleepy, and whenever the stretch-and-yawn action plays:

- **Mouth:** `あ` 1 + `お` 0.4, chosen by the user from rendered comparison
  grids on 11 November 2026.
- **Timing:** opens over 1.4 s, holds 0.6 s, closes over 1.0 s, so about 3 s
  in all. It fits inside the 3.2 s stretch. The curve goes through the
  motion spring, so the largest change in one 60 fps frame is under 0.03.
- **After the yawn:** the mouth is closed again by the time she is sleepy.
  An earlier version held the open mouth for the whole sleepy state, and the
  user's live check found it looked wrong.
- **Lip sync:** `あ` and `お` are speech morphs. Speech blocks idle, so the
  yawn eases shut before visemes take the mouth. The yawn adds on top of
  whatever is already shown, capped at 1.
- **Grids:** candidates (`あ`, `お`, `え`, mixes), the pick at several
  strengths, the yawn through its curve, and mid-speech captures are kept in
  `assets/private/71/` (private model).

## Actions

Pure logic in `renderer/idle-motion.js` (`IdleMotion`). Each action follows an
authored curve (`bump`: smoothstep in, hold, smoothstep out), and the output
goes through a critically damped spring (rate 8, about 0.6 s to settle). So
when she is interrupted mid-action, the pose eases back instead of snapping.

**One set of actions for idle and sleep** (#149). Since 12 November 2026, at
the user's request, every action can play both while she is awake and idle
(one every 8–20 s) and while she is asleep (one per *Sleep action every*
interval). They come from one weighted registry, `ACTIONS`. Each entry has a
`weight` (its chance), `create(random)` for its random parameters and length,
and `apply(motion, target)` for its pose. To add an action, add an entry
(keeping the weights summing to 1), an `ACTION_LABELS` entry and a test. The
panel picks it up by itself.

| Action | Chance | Length | What moves | Size |
| --- | --- | --- | --- | --- |
| `glance` | 10 % | 2.2–3.2 s | Eyes, head following at 45 %, drift to one side and back, eased in and out over 0.9 s | 0.45–0.75 of the gaze range sideways, ±0.15 up/down |
| `tilt-left` | 10 % | 2–3.5 s | `頭` rolls toward the left of the screen | 5° |
| `tilt-right` | 10 % | 2–3.5 s | `頭` rolls toward the right of the screen | 5° |
| `shrug-left` | 5 % | 2.4–3.0 s | The shoulder on the left of the screen (`右肩`) lifts, then drops | 12° |
| `shrug-right` | 5 % | 2.4–3.0 s | The shoulder on the right of the screen (`左肩`) | 12° |
| `shrug-both` | 5 % | 2.4–3.0 s | Both `肩` together | 12° |
| `sigh` | 15 % | 1.1 s in, 1.7 s out | Chest (`上半身2` pitch) and both `肩` lift, then fall | 2° chest, 2.5° shoulders |
| `stretch-yawn` | 30 % | 3.2 s | Back arches (`上半身`), head tips back (`首`/`頭`), shoulders lift, and she yawns | 5° back, 7° head, 6° shoulders, yawn 1 |
| `nod` | 10 % | 3.2 s | A dozing nod: `首`/`頭` dip forward slowly, then lift | 6° |

- **Shrug size:** shrugs were 6° at first, but that hid behind the always-on
  body sway. The user picked 12° from a 6/12/18/24° comparison. To keep every
  60 fps frame under 0.25°, a 12° shrug lasts 2.4–3.0 s with 1.2 s ramps
  (0.23° per frame at most).
- **Chances:** glances 10 % and stretch-and-yawn 30 % are the user's picks
  (12 November 2026). An equal 1-in-9 mix was not used. When every action had equal
  chances, the user found the shrugs too common, so shrugs stay at 5 % each.
- **Choosing actions:** the panel's **Actions · 仕草** group has a checkbox
  for each one, all ticked by default. Only ticked actions play, awake or
  asleep, and they keep their relative chances. For example, with only
  glance, tilt-left and sigh ticked, the chances are 10 : 10 : 15 out of 35.
  With nothing ticked she stays still. The choice is saved as
  `yidhari.actions`.
- **Slower glances:** a glance used to jump to its target at the gaze
  spring's speed (about 0.3 s), which the user found too fast. Now its weight
  eases in and out (`bump`, 0.9 s ramps), and the gaze blends from the
  cursor, or the centre, toward the glance by that weight.
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
- Nothing plays on its own while she is active, sleepy or waking, so the blocking rules
  above cover motions too.
- The first motion waits a full gap after idle begins, and each new idle
  period starts a new gap.

### Playing an action on demand (#164)

The **Animation actions · 仕草再生** section has one button per action. The
buttons are built from `ACTION_LABELS`, so a new action gets a button with no
HTML change. Each button plays its action once through the same springs, so it
eases in, eases out and settles back to rest.

- **Same button again** stops it, easing back. **Another button** switches to
  that action, blending from the current pose.
- **No waking:** a button is not activity. Only chat, voice and the bridge
  wake her, as before. While she is sleepy the action plays and she stays
  asleep.
- **Gated:** the buttons are disabled, and a playing action stops, until the
  model has loaded, while *Idle behaviours* is off, while idle is blocked
  (speech, thinking, an open ask, a streaming reply or a morph preview),
  while a pose is held for a preview, during the stretch into sleepy, and
  while she wakes. The status line under the buttons says which.
- A manual action takes the place of the idle or sleep action for its
  length. Idle auto play then waits a fresh gap.
- The **Actions** ticks above choose what idle and sleep may pick
  automatically. They do not limit the buttons, and the buttons never change
  them.

## Settings

In **Independent channels**:

| Control | Default | Range | Saved as |
| --- | --- | --- | --- |
| **Idle behaviours · 待機動作** | on | on / off | `yidhari.idle-enabled` (`0` = off) |
| **Idle after (s)** | 60 | 5 s to 1 h | `yidhari.idle-timing` (JSON, seconds) |
| **Sleepy after (min)** | 10 | 5 s to 24 h, never before *Idle after* | `yidhari.idle-timing` |
| **Sleep action every (min)** | 2 | 0 (none) or 10 s to 1 h | `yidhari.idle-timing` (`sleepActionEvery`) |

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
