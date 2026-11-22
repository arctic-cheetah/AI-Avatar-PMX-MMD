# Thinking pose arms (#217)

The thinking mood rests her right fist under her chin, with her left hand
cupped under the right elbow. `buildThinkingRig()` in `renderer/thinking-rig.js`
solves both arms once, from the targets in `THINKING_ARM`:

| Target | What it sets | Relative to | Value |
| --- | --- | --- | --- |
| `chin` | The right wrist | The head bone (`頭`) | −0.85, −0.75, 1.8 |
| `elbowBend` | Which way the right elbow bends | The analytic two-segment solver | −0.5, −0.866, 0.8 (30° out, tucked) |
| `fist` | The right hand's finger direction | World space | 0.15, 0.643, −0.766 (tilted 50° back) |
| `fistPalm` | The right palm normal | World space | 0, −0.766, −0.643 |
| `support` | The left wrist | The posed right elbow (`右ひじ`) | 0.5, −0.6, 0.1 |
| `supportBend` | Which way the left elbow bends | The analytic two-segment solver | 1, −0.3, 0.3 (lifted, #221) |

## The clipping

Before #217 the right elbow hung low beside her waist and the left hand cupped
it. On the way up to the chin, the right forearm and glove cut through her bust.
The renderer has no collision, and the rig tests use a synthetic skeleton with
no mesh, so nothing caught it.

Measured on the PMX at full pose weight: 150–330 right forearm and hand
vertices sat behind the front surface of the bust, up to 0.90 model units deep,
depending on the camera-driven gaze and the bust physics.

## The rule the user set

On 16 November 2026 the user set what may touch and what may not:

- The **arm itself (its bone) must not clip** into the bust.
- The **puffy elbow sleeve and the glove may press in a little**, because cloth
  touching the body looks natural.
- The arm should look tucked in, **not like a chicken wing**.
- The fist should sit **at the bottom of the chin**, not cover the face.
- The left hand should **touch or be close to the right elbow**.

## How it was measured

On a `?bridge=off` test page (so the live avatar keeps her voice), with idle
actions, sway and cursor gaze off:

- **Vertices in the bust.** Vertices weighted at least half to a bone named
  `胸` are skinned with `SkinnedMesh.getVertexPosition()` and binned by x and y
  (0.15 units), keeping the back-most and front-most z of each bin. An arm
  vertex counts as inside when it falls in a bin between those two.
- **Sleeve or arm.** The right arm's cloth (material `体`) is split into the
  sleeve (on the upper arm, or in the elbow third of the forearm, 0.6–0.9 out
  from the bone) and the glove (0.2–0.5 out). Skin (`肌`) is always arm.
- **Bone clearance.** Points along the elbow→wrist bone line, with a 0.2 arm
  radius, against the same bins. Positive means in front of the bust.
- **Hand at the chin.** The highest right-hand skin vertex against the lowest
  face vertex near the middle (the bottom of the chin), and the hand's distance
  to that point.
- **Left hand at the elbow.** The left hand's skin against the right elbow's
  sleeve.

`globalThis.__yidhariPreview.thinkingArm({ ... })` rebuilds the pose from rest
with other targets, and `__yidhariPreview.mesh` is the loaded PMX. Calling
`thinkingArm()` with no argument restores `THINKING_ARM`. The measurement
scripts and every grid are in `assets/private/thinking-217/`, which is
gitignored because the model is private.

## How the pose was picked

Each step was a labelled grid (bust camera, front, both three-quarters) that the
user picked from. Clearances are ranges over those views, because the bust
physics moves.

1. **Arm out of the bust (A).** The arms are too short for the forearm to pass
   in front of the bust, so the first fix swung the elbow 75° outward. It was
   clean, but the user found it looked like a chicken wing.
2. **Lower elbow angles.** At 60°–20° the elbow looked natural, but the forearm
   sank back in, up to 0.81 deep at 20°.
3. **Bone rule and a tucked elbow (T2).** Checking the bone, not the glove,
   allowed a tucked elbow (30°, small forward bias) with the bone 0.15–0.24 clear.
4. **Fist up to the chin (C1).** In T2 the fist sat 1.3 from the face. Raising
   it brought it to 0.6, but the upright fist then rose 0.46 above the bottom of
   the chin and covered part of the face.
5. **Tilted fist (D3).** A fist tilted back is shorter, so it fits under the
   chin without dropping the wrist onto the bust. The user then asked for a
   softer wrist and picked **50°, with the fist slightly higher**: the fingers
   rise about 0.2 up the side of the jaw without covering the face, and the
   bone has its best margin.
6. **Left hand at the elbow (L2).** Moving the left wrist close under the right
   elbow puts the hand on the puffy sleeve. L2 was the only spot where no
   left-arm vertex went into the bust from any view.

| Step | Right forearm bone | Right hand top vs bottom of chin | Left hand | Left arm in bust |
| --- | --- | --- | --- | --- |
| Before | inside, 0.90 deep | — | cupped under a low elbow | 0 |
| A | clear | — | at her waist | 0–2 vertices, ≤ 0.14 deep |
| T2 | 0.15–0.24 clear | fist 1.3 from the face | at her waist | 0 |
| C1 | 0.09–0.57 clear | 0.46–0.52 above | at her waist | 0 |
| **Final (50° fist, L2)** | **0.45–0.93 clear** | **0.21–0.26 above (side of the jaw)** | **0.008–0.019 from the elbow sleeve** | **0** |

The final row is the committed default, checked after the commit from the face
camera, the bust camera, the front and both three-quarters
(`grid-final-l2.png`). The original pose's right forearm bone was 0.26–0.35
inside the bust from the same views. Sampled every frame while the final pose
eased in from rest, the right forearm bone stayed at least 0.53 in front of the
bust wherever it was over it, and the left forearm bone never was.

In the final pose the puffy sleeve and glove press into the bust, as agreed.
The upper-arm readings near the armpits sometimes count as inside the bust
bins, because the upper arm passes beside the body there; it is hidden and is
not counted.

## Left elbow lift (#221)

With `supportBend` 1, −1, 0 (L2), the left elbow hung near her waist, 0.99
below the right one. Her left shoulder line looked lower than the right, and
the forearm across her waist looked as if it cut into her bust. On 17 November
2026 the user asked to raise the left arm so her shoulders look balanced. The
#217 rule still holds: the arm bone must not clip, and the cuff and sleeve may
press in a little, because cloth is flexible.

The left wrist target (`support`) did not change, so the left hand still cups
the right elbow. Only the left elbow's bend hint moved, which lifts the elbow
up and out. The candidates were labelled grids from the front, from below and
of the shoulders, on a `?bridge=off` page (`grid-left-higher.png` in
`assets/private/thinking-221/`):

| Option | `supportBend` | Left elbow below the right | Left forearm bone | Cuff vertices in the bust |
| --- | --- | --- | --- | --- |
| L2 (before) | 1, −1, 0 | 0.99 | never over the bust | 0 |
| H1 | 1, −0.4, 0.3 | 0.52 | never over the bust | 3 |
| **Picked** | **1, −0.3, 0.3** | **0.43** | **0.18 in front of it** | **2, ≤ 0.18 deep** |
| H2 | 1, −0.2, 0.3 | 0.33 | 0.26 in front of it | 4 |
| H3 (level) | 1, 0, 0.3 | 0.08 | 0.02 in front of it | 2 |

The user liked H1, then asked for more lift. Of the grid, the user picked
**halfway between H1 and H2**. On the PMX the picked pose keeps the left hand
0.79 from the right elbow, puts no hand vertex in the bust, and passes the
left forearm bone 0.21 below the bottom of the bust. These readings were steady
over 3 s of bust physics. After the commit, the same readings were checked on
the committed default, from the front and from below (`grid-final.png`).

## Tests

`tests/renderer/thinking-rig.test.mjs` uses a bust stand-in in the synthetic
arm rig (`BUST` and `bustDepth()` in `tests/renderer/arm-fixture.mjs`): one
ellipsoid per side, fitted to the measured front of the PMX bust, with centres
at x ±0.7, y 16.7, z 0.6 and radii 1.0, 1.05 and 1.25.

- **Bones out of the bust.** Each forearm bone is sampled from elbow to wrist
  and must stay outside the ellipsoids grown by `ARM_BONE_RADIUS` (0.2). The
  original pose sinks 0.34 (normalised) into them; the final pose stays 0.08
  clear on the right and 0.03 on the left (0.16 before the #221 lift).
- **Left elbow lifted (#221).** The left upper arm swings at least 40° out
  from hanging straight down (48.6°; the right is 58.9°, L2 was 31.8°), and
  the left elbow sits within 0.7 of the right elbow's height (0.43).
- **Left hand at the elbow.** The left wrist sits within 0.9 of the right
  elbow and below it (0.79 in the final pose; 2.15 in A).
- **Fist setting.** The right hand's finger direction follows `fist`.

This is tuned clearance, not mesh collision. A new model, outfit or pose needs
the measurement again.

## Thinking fidget (#218)

Once the pose is in, her hands used to be perfectly still: the arm drift and
the finger ripple fade out by `1 − thinkingPose.weight`. The thinking fidget
adds a small, slow idle on top of the pose instead, from
`renderer/thinking-fidget.js`:

| Part | Channel (screen side) | Bones | Motion | Size (`THINKING_FIDGET`) |
| --- | --- | --- | --- | --- |
| Fist roll | `forearmLeft` | `右手捩` | The right fist rolls under her chin, on two sine waves | ±5°, waves of 5 s and 8 s |
| Fist squeeze | `curl{Thumb…Little}Left` | `右親指`–`右小指` `１–３` | The fist tightens and loosens, on its own two waves | ±4° per joint, waves of 7 s and 11 s |
| Finger tap | `curl{Index…Little}Right` | `左人指`–`左小指` `１–３` | Every 7 s the left fingers lift off the sleeve and come back, little finger first, like drumming on her elbow; the thumb keeps holding | 5° lift, 0.5 s per finger, 0.15 s apart, first tap 2 s in |
| Pinky lift | `curlLittleRight` | `左小指` `１–３` | The left little finger is held open while she thinks, so it lies on the sleeve instead of sinking into it; it taps from there | 18° |

- **It cannot move the arms.** The fidget only uses the forearm twist bone and
  the finger joints, through the axes of the hand drift rig
  (`buildHandDriftRig()`). The twist bone rolls about the elbow→wrist line, so
  the elbows and wrists stay exactly where #217 put them: the forearm bones
  keep their bust clearance, the fist stays under the bottom of her chin and
  the left hand stays at the right elbow. Only the fist and fingers move.
- **Its own clock.** Thinking blocks the idle state, so the arm drift's clock
  and weight cannot drive it. `ThinkingPose` counts its own `clock` while the
  pose has weight, and resets it once the pose has fully released, so each
  thinking spell starts with a still hand. `fidget()` returns the angles
  already scaled by the pose weight, so the fidget eases in and out with the
  arm.
- **One writer.** `applyArmDrift()` in `renderer/main.js` mixes both layers
  with `handAngles(idlePose, fidget, weight)`: each hand channel is
  `(1 − weight) × drift + fidget`. As the hand goes to the chin the drift
  hands over to the fidget, and back as it drops.
- **Previews.** `__yidhariPreview.thinkingFidget({ ... })` overrides the sizes
  (and `clock` holds one moment) for comparison grids. Calling it with no
  argument restores `THINKING_FIDGET` and the running clock.

### How the sizes were picked

On 16–17 November 2026 the user picked from labelled grids and real-speed
clips, on a `?bridge=off` test page with sway, cursor gaze, idle and blinking
off, so only the fidget moved. The fidget was held at one moment with
`thinkingFidget({ clock })`. Grids and clips are in the gitignored
`assets/private/thinking-218/`.

1. **Finger tap (`grid-tap.png`, `clip-tap.mp4`).** Lifts of 5°, 8° and 12°,
   and an 8° press into the sleeve, seen from her right side so the fingers
   on the sleeve face the camera. Pressing in hid the fingertips in the
   sleeve. The user loved **A, a 5° lift**: the fingertips move 0.06–0.08.
2. **Pinky lift (`grid-pinky.png`).** In the #217 pose the left little
   finger's tip sinks into the sleeve, so the user asked to avoid that. Held
   open by 0°, 6°, 12° and 18°: from 12° the whole nail sits on the sleeve.
   The user picked **18°**.
3. **Fist (`grid-fist.png`, `clip-fist.mp4`).** Rolls of 2°, 3° and 5° and
   squeezes of 2° and 4°, then three clips: 3° + 2° on 9–19 s waves, 5° + 4°
   on the same waves, and 5° + 4° on faster 5–11 s waves. The user picked
   **roll 5° and squeeze 4° on the faster waves**.

| Check on the PMX | Still | With the fidget |
| --- | --- | --- |
| Right and left wrists | — | 0.000 moved, in every frame |
| Right forearm bone in front of the bust | 0.818 | 0.818, in every frame |
| Right hand top vs bottom of chin | 0.23 above | 0.20–0.26 above (roll 5°), 0.23 (squeeze 4°) |

After the commit, the defaults were sampled every 0.25 s over 20 s of held
clocks (`final-check.js`, `grid-final.png`): the wrists moved 0.000, the right
forearm bone stayed 0.818 in front of the bust, and the hand top stayed
0.203–0.259 above the bottom of the chin. The held pinky lies on the sleeve
from the side, before and during its tap.

The hand top stays inside the 0.21–0.26 that #217 agreed (the fingers on the
side of the jaw, the face uncovered), give or take 0.01 at the roll's far end.

### Tests

`tests/renderer/thinking-fidget.test.mjs` checks the channels, the sizes and
speed around each finger's held angle, the tap order and rests, the held
pinky, the mix with the drift, the clock, and, on the posed synthetic rig,
that the elbows, wrists and forearm bust clearance never change while the
fingertips move.
