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
| Yawn hand | One hand rises to just below her chin while she yawns (#270) | Done |
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

**Hand under her chin (#270).** As she yawns, one hand rises to just below
her chin and lowers again as her mouth closes:

- **Timing:** the `yawnHand` channel rises over 0.9 s, so the hand is up
  before her mouth is widest at 1.4 s. It holds through the 0.6 s hold and
  lowers over the 1.0 s close, so it is down by the end of the 3.2 s
  stretch. The curve goes through the motion spring (rate 8). Only the yawn
  drives it: the sneeze's small open mouth (#149) leaves the hand down.
- **Pose:** `renderer/yawn-rig.js` solves the arm with the thinking chin
  rest's two-bone solver (`renderer/thinking-rig.js`) and caches it once.
  `YAWN_ARM` holds the wrist target, from the head bone. It sits lower than
  the thinking fist, so the hand stays under her chin with a little gap
  instead of propping it. The fingers stay open and straight (the user asked
  to uncurl them), unlike that fist, and lie across her throat toward her
  other side. Her right hand yawns by default, and the other arm stays where
  it is. A first, higher pick covered her mouth before the stretch had tipped
  her head back, so the target is lower.
- **Sharing the arms:** the thinking pose wins. The yawn gets
  `yawnHand × (1 − thinking)`. The arm drift (#193) fades by both weights,
  so it never pushes a raised hand into her face. The head follows the gaze
  less while the hand is up, as it does for the chin rest, so her chin
  stays over the hand. A held pose (#49) still wins over both.
- **Interruptions:** speech, thinking and an open `ask` end the yawn, and
  the spring lowers the hand smoothly. Idle behaviours off means no yawn and
  no hand.
- **Grids:** placement candidates, curled vs open fingers, weights and a
  played stretch-and-yawn are kept in
  `assets/private/270/` (private model).

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
| `glance` | 4.5 % | 2.2–3.2 s | Eyes, head following at 45 %, drift to one side and back, eased in and out over 0.9 s | 0.45–0.75 of the gaze range sideways, ±0.15 up/down |
| `tilt-left` | 4.5 % | 2–3.5 s | `頭` rolls toward the left of the screen | 5° |
| `tilt-right` | 4.5 % | 2–3.5 s | `頭` rolls toward the right of the screen | 5° |
| `shrug-left` | 2.2 % | 2.4–3.0 s | The shoulder on the left of the screen (`右肩`) lifts, then drops | 12° |
| `shrug-right` | 2.2 % | 2.4–3.0 s | The shoulder on the right of the screen (`左肩`) | 12° |
| `shrug-both` | 2.2 % | 2.4–3.0 s | Both `肩` together | 12° |
| `sigh` | **15 % (fixed)** | 1.1 s in, 1.7 s out | Chest (`上半身2` pitch) and both `肩` lift, then fall; the mouth parts a little breathing in and opens with `お` breathing out | 2° chest, 2.5° shoulders, `お` 0.15 in, 0.35 out |
| `stretch-yawn` | 13.4 % | 3.2 s | Back arches (`上半身`), head tips back (`首`/`頭`), shoulders lift, and she yawns with a hand under her chin (#270) | 5° back, 7° head, 6° shoulders, yawn 1, hand 1 |
| `nod` | 4.5 % | 3.2 s | A dozing nod: `首`/`頭` dip forward slowly, then lift | 6° |
| `sneeze` | 2.2 % | 2.2 s | A light sneeze: breathe in with the head tipped back, the chest rising and the mouth a little open (0.9 s), then a quick forward snap with the eyes squeezed shut (`まばたき`) and the mouth closed, then rest | 4° back, 5° forward, 1.5° chest, mouth 0.3 |
| `wink-left` | 2.2 % | 1.4 s | A playful wink: the eye on the left of the screen closes in a happy arc (`ウィンク右`), the mouth corners lift a little (`口角上げ` 0.5), and the head tilts toward it | 3° tilt |
| `wink-right` | 2.2 % | 1.4 s | The same with the eye on the right of the screen (`ウィンク`) | 3° tilt |
| `look-around` | 4.5 % | 5 s | The eyes, head following, drift left, pause, drift right, pause, then back to the middle | 0.6 of the gaze range each way |
| `shiver` | 2.2 % | 1.4 s | A little "brr": a 6 Hz tremble of the upper body and shoulders that fades in and out | 0.6° |
| `hiccup` | 2.2 % | 1.0 s | A quick jolt: chest and shoulders hop, the head tips back a touch, and the eyes widen (`びっくり`), then she settles | 1.5° chest, 3° shoulders, eyes 0.6 |
| `nodding-off` | 4.5 % | 4.6 s | The head droops slowly with heavy eyes, then jerks up with wide eyes and settles | 6° down, 3° up, eyes 0.5 |
| `humming-bob` | 4.5 % | 4 s | A gentle head bob to a 1.6 Hz beat with a slower 0.8 Hz sway and a soft smile, as if humming along | 1.2° bob, 1° sway, smile 0.35 |
| `contented-smile` | 4.5 % | 3 s | A soft, contented smile (`smile`) eases in, holds about 2 s, eases out, with the head tipped 1° forward | smile 1 |
| `eyebrow-raise` | 2.2 % | 1.6 s | A curious "oh?": both brows up with slightly wider eyes (`browRaise`) and a small head tilt | brows 1, 2° tilt |
| `deep-breath` | 4.5 % | 4.8 s | A slower, fuller sigh: 2 s in, a short hold, 2.4 s out, with the head back a touch, the mouth parting a little breathing in and opening with `お` breathing out, and the eyes relaxing on the way out | 2° chest, 4° shoulders, 1.5° head, `お` 0.15 in, 0.35 out |
| `sniffle` | 2.2 % | 1.4 s | Two quick little sniffs: the head tips up 1.5° each time, the chest lifts and the eyes narrow a little | 1.5° head, 0.8° chest, eyes 0.25 |
| `neck-roll` | 2.2 % | 5 s | One slow, even circle of the head (back, side, forward, side): it starts a quarter turn in, so all four extremes come at full size inside the 0.6 s ease. About ±3.3° each way on the head bone (the user asked for ±3–4°, 14 November 2026) | 5.5° pitch (head and neck), 4° tilt |
| `weight-shift` | 4.5 % | 4.5–5.5 s | The upper body leans to a random side (`lean` on `上半身`; positive leans toward the left of the screen, like `tilt`, checked on the model) and holds, the head tilting back half as much to stay level, then returns | 3° lean, 1.5° head |
| `shy-look-away` | 2.2 % | 3.5 s | Eyes and head drop down and to a random side, the head dips, with a shy giggle (`shy`), then back | gaze 0.5 sideways, 0.45 down, 3° head |

- **Shrug size:** shrugs were 6° at first, but that hid behind the always-on
  body sway. The user picked 12° from a 6/12/18/24° comparison. To keep every
  60 fps frame under 0.25°, a 12° shrug lasts 2.4–3.0 s with 1.2 s ramps
  (0.23° per frame at most).
- **Chances:** the sigh is fixed at 15 % (the user, 14 November 2026), and
  new actions never take from it. Every other action has a relative share
  (`share` in `ACTIONS`), and together they fill the other 85 %:
  - a glance, each tilt and the nod count 1;
  - stretch-and-yawn counts 3;
  - each shrug and the sneeze count ½;
  - the part 1 actions (14 November 2026): look-around and nodding off count 1, each wink, the shiver and the hiccup count ½.
  - the part 2 actions: humming bob, contented smile and deep breath count 1, the eyebrow raise ½.
  - the part 3 actions: weight shift counts 1; sniffle, neck roll and shy look-away count ½.

  As new actions arrive, every chance except the sigh's shrinks. Stretch-and-yawn is now 13.4 %, down from the user's earlier 30 %. The user chose to leave it shared (14 November 2026).

  This keeps the user's earlier picks in proportion: glance 10 % to
  stretch-and-yawn 30 %, with shrugs rare. Equal chances were tried and
  reverted, because shrugs came up too often. A new action only needs a
  share; everything except the sigh rebalances by itself.
- **Choosing actions:** the panel's **Actions · 仕草** section (its own
  collapsible section since 14 November 2026, next to **Animation actions**)
  has a checkbox for each one, all ticked by default. Only ticked actions play, awake or
  asleep, and they keep their relative chances. For example, with only
  glance, tilt-left and sigh ticked, they keep their 9.4 : 9.4 : 15 proportions.
  With nothing ticked she stays still. The choice is saved as
  `yidhari.actions`.
- **Face channels** (`FACE_MORPHS`): actions write a 0–1 weight per channel,
  and the renderer adds its morphs on top of the mood:
  - `yawn` → `あ`/`お`;
  - `squint` → `まばたき`;
  - `winkLeft` → `ウィンク右`, `winkRight` → `ウィンク` (named by screen side, checked in a grid);
  - `mouthLift` → `口角上げ`;
  - `surprise` → `びっくり`;
  - `smile` → `笑い` 0.5 + `にこり` 0.6 + `口角上げ` 0.6 (soft smiling eyes, the user's pick B);
  - `browRaise` → `上` 0.8 + `びっくり` 0.3 (curious, the user's pick G);
  - `shy` → `笑い` 0.35 + `困る` 0.4 (a shy giggle, the user's pick C; the model has no blush morph);
  - `exhale` → `お` (the breathing mouth of the sigh and the deep breath; the user's idea).

  Face channels ease with a quicker spring (rate 30) than the bones (rate 8).
- **Quick actions:** the sneeze, shiver, hiccup, nodding off and sniffle are flagged `quick`.
  They may move up to 0.6° per 60 fps frame; every other action stays under
  0.25°. The shiver is a fast wave that the bone springs would smooth away. So
  only its size goes through a spring, and the wave (`shiverWave`) is added on
  top, rolling `上半身2` and both shoulders.
- **Light sneeze** (#149, 14 November 2026): keyframed with eased
  segments (`IDLE_MOTION.sneeze`) and then the usual springs. The snap is
  meant to be quick, so it may move up to 0.6° per 60 fps frame, where the
  calm actions stay under 0.25°. Its eye closure drives `まばたき` through
  a new `squint` channel, and its mouth reuses the yawn's `あ`/`お` channel at
  0.3. Its share is ½, like a shrug, and it never takes from the sigh.
  Like every action, it has a checkbox in **Actions** and a button in
  **Animation actions**.
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
  negative pitch tips the spine and head back.
- **Shoulder lift (#236).** A shrug is `右肩` negative and `左肩` positive
  roll (`SHOULDER_LIFT` in `renderer/shoulder-lift.js`). Before #236 the
  signs were the other way round. The pivot of `肩` sits by the neck, so that
  roll *dropped* the shoulder tip by 0.2 and swung the hanging arm inward.
  At 12° the wrist moved 1.2 inward (x −2.72 to −1.54), and the hand sank
  into the hip. The stretch (6°), the sighs and the hiccup used the same
  sign. Now a lift raises the tip, and `counterShoulder()` turns that side's
  `腕` back by the same rotation, through `肩C`. The arm keeps its world
  direction, so the hand rises with the shoulder joint and never swings in
  or out. The counter runs at the end of `applyArmDrift()`, on top of the
  drift and the thinking pose, so all three keep working. It is exactly zero
  when the shoulders are at rest. The shiver's tremble keeps its signs: it
  is symmetric, and the counter cancels its arm swing too.
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

### Arm drift (#193)

Once `restArms()` lowers her arms, nothing else moved them while idle, so
they hung still at her sides. Arm drift is a slow, always-on idle channel,
not an action: it never takes a pick from `ACTIONS`, and the actions play on
top of it.

| Channel (screen side) | Bone | Motion | Size |
| --- | --- | --- | --- |
| `armSwayLeft/Right` | `右腕` / `左腕` | Swings forward and back, in the shoulder's frame | ±2.5° |
| `armOutLeft/Right` | `右腕` / `左腕` | Sways away from the body and back in past rest, less far in than out | −1.5° (in) to 2° (out) |
| `elbowLeft/Right` | `右ひじ` / `左ひじ` | Bends a little, never past straight | 0–4° |
| `forearmLeft/Right` | `右手捩` / `左手捩` | Rolls softly about the forearm, on the twist bone | ±4° |
| `wristLeft/Right` | `右手首` / `左手首` | Tips toward and away from the palm, following the elbow 1.2 s later | ±3° |
| `curl{Thumb,Index,Middle,Ring,Little}Left/Right` | `親指`–`小指` `１–３` | Each finger's joints loosen and curl around the rest curl, scaled like it (thumb 0.45 to pinky 1.1), rippling from the index to the little finger | ±3° per joint |
| `spreadLeft/Right` | `人指`–`小指` `１` | The fingers fan apart and close: index and little finger fully, middle and ring by 0.35 | ±2.5° |

**Natural hands** (#199 follow-up). The user asked for the lower arms and
hands to move naturally, not just the upper arms. Three things make a still
hand look alive:
- The forearm roll uses the twist bone `手捩`, not the wrist. Twisting at
  the wrist pinches the skin there, while the twist bone spreads it along
  the forearm.
- The wrist does not have its own wave. It replays the elbow's wave 1.2 s
  later (`wristLag`), so the hand trails the forearm like a loose hand would.
  The elbow only bends one way, so its 0–4° is mapped to the wrist's ±3°.
- The fingers curl and loosen on their own slow waves (13–29 s), which do not
  follow the elbow, so the hand never freezes in one shape.
- **Finger sway** (the user, 15 Nov 2026: "make the finger sway a little").
  Each finger replays the index finger's curl 0.35 s after the finger before
  it (`rippleLag`), so a curl runs across the hand like a wave. The thumb
  curls with the index finger. The fingers also fan apart and close on a
  separate wave (11–23 s, `spread`), about the palm normal at their base
  joints.
- **Inward sway** (the same request). The arms used to sway only outward, so
  they could never press into the body. Now they also sway in past rest, by
  at most 1.5° (`in`) against 2° out. With the hands resting on the leg
  line (the relaxed rest's option C, see [rest-pose.md](rest-pose.md)),
  1.5° in brings each wrist 0.14 closer to the body (x −2.81 to −2.67).
  Front, side and three-quarter grids show no clipping into the thighs at
  1.5° in, nor at a 2× margin (3°). The same check passed earlier with the
  hands 0.3 ahead.

The axes come from `buildHandDriftRig()` in `renderer/hand-drift-rig.js`,
found once from the rest pose: the forearm's own direction for the roll, the
axis between the hand and the palm for the wrist, and, for each finger
joint, the axis between the joint and the palm, as the rest curl uses. So
they work whatever the PMX's local bone axes are. Without finger bones there
is no palm, so only the forearm rolls.

- **Slow and never on a loop.** Each channel adds two sine waves with
  periods of 11–47 s (up to 53 s on the right) that do not divide evenly.
  The right of the screen runs 13 % slower and on its own phases, so the two arms are never mirrored or
  in step. One frame moves each angle by less than 0.02°.
- **Eased with the idle state.** `IdleMotion.update()` returns the drift's
  weight as `armDrift` and the twenty-two angles, already scaled by it. A spring
  (rate 2, about 2 s) takes the weight to 1 while idle or stretching, 0.6
  while sleepy or waking, and 0 while active. Blocking (speech, thinking, an
  open ask, a streaming reply or a morph preview) makes her active, so the
  arms settle back. The spring snaps to exactly 0 once settled, so many
  cycles leave nothing behind.
- **The thinking pose owns the arms.** `applyArmDrift()` runs after
  `applyThinkingPose()`, which rewrites these bones from the lowered rest
  every frame. The drift multiplies on top, scaled by
  `1 − thinkingPose.weight`, so it fades as the hand goes to the chin and
  comes back as it drops. If the thinking rig failed to build, the drift
  keeps its own copy of the rest pose. Later hand poses (#177, #150) must
  follow the same rule. While she thinks, the **thinking fidget** (#218)
  takes over the forearm twist and finger channels instead: a roll and
  squeeze of the right fist under her chin, a finger tap on her elbow every
  7 s and the left little finger held open, out of the sleeve,
  on the thinking pose's own clock. See
  [thinking-pose.md](thinking-pose.md#thinking-fidget-218).
- **Shoulders stay with their owners.** The shrugs and the sigh (#149) keep
  `左肩`/`右肩`. The drift only uses `腕`, `ひじ` and `手首`. The shoulder
  counter (#236) is then multiplied onto `腕` in its parent's frame, so the
  drift still sways the arm relative to the body. The shoulder's lift only
  carries the arm up.
- **Physics runs after it**, so sleeves, hair and tails react to the arms.
- **Off switch:** the **Arm drift** tick at the end of the **Actions** list
  turns it off. It eases out rather than stopping. It is saved as
  `yidhari.arm-drift` (`0` = off) and is on by default. It does not affect
  the action picks.
- For previews and grids, `__yidhariIdlePose` can hold the twenty-two arm angles
  with `armDrift: 1`.

## Tentacle wave (#182)

While she is idle or stretching, a slow wave travels along her four tails;
while sleepy it is half as big. It eases in over about 1.5 s and eases out
when she becomes active, including when speech or other blocks stop idle.
While she thinks, the tails keep the full wave at 0.8 of its pace instead of
going still (#225) — unless an ask is open or a morph preview is running,
which always settles them (`tentacleBlocks()`, PR #227). The
**Tentacle wave · 触手** toggle (`yidhari.tentacles`, on by default) eases it
out. The **Wave size** slider under it sets the size from 0 to 2 (default
0.4, saved as `yidhari.tentacles.size`). The tails also perk up on surprise,
lift when she's happy, droop while sleepy or sad, and sway gently while she
speaks. Four **Tentacle** buttons in Animation actions play the wave, perk,
droop and sway on demand. How it sits on top of physics is in
[physics.md](physics.md#tentacle-wave-182).

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
  into a glance target and small bone angles each frame, including the arm
  drift (`armDriftAngles`, `bindArmDriftSetting`).
- `renderer/tentacle-motion.js`: the pure `TentacleWave` that turns the idle
  state into a travelling wave along the tails (#182).
- `renderer/gaze-tracking.js`: `setIdle(target)`, the idle glance source.
- `renderer/bridge-client.js`: `onActivity` for every bridge event and
  voice-input state change, and `onAskChange(open)` when an agent ask opens
  or closes.
- `renderer/main.js`: feeds activity and blocking into the controller each
  frame, applies its moods, and scales the idle blink.
- Tests: `tests/renderer/idle-behaviour.test.mjs`,
  `tests/renderer/idle-motion.test.mjs`, `tests/renderer/arm-drift.test.mjs`, and the #71 cases in
  `tests/renderer/bridge-client.test.mjs` and
  `tests/renderer/gaze-tracking.test.mjs`.
