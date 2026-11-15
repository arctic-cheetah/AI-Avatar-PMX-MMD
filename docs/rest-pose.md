# Relaxed rest pose (#199)

The PMX loads in a T-pose. `restArms()` in `renderer/main.js` lowers the upper
arms (`左腕`/`右腕`) to hang down, slightly out and forward. Before #199 that was
all it did, so everything below the shoulder stayed in the bind pose: straight
elbows, and straight, flat fingers pointing at the floor. She looked stiff.

`relaxArms()` in `renderer/rest-pose.js` runs at the end of `restArms()` and
relaxes the rest of the arm:

| Part | Change | Default |
| --- | --- | --- |
| Elbow (`ひじ`) | The forearm turns forward, toward her front, about the elbow | 3° |
| Wrist (`手首`) | The hand tips toward the palm | 0° (straight) |
| Fingers (`親指`–`小指` `１–３`) | Each joint curls toward the palm | 15° per joint, scaled per finger |
| Upper arm (`腕`) | The whole arm swings back from the shoulder until the hand hangs in line with the leg | `handForward` 0 (on the line) |

The finger scale is thumb 0.45, index 0.8, middle 0.9, ring 1.0 and pinky
1.1, so the curl grows toward the pinky, like a resting hand. The thumb scale
and the curl itself are shared with the thinking pose's hand
(`curlFingers()` in `renderer/thinking-rig.js`).

### Hands in line with the legs

With the bend alone (candidate C, the user's pick), the hands came forward of
her thighs and she looked like she was about to pick something up. Even the old
straight pose hung the hands a little ahead, because `restArms()` points the
upper arms slightly forward. Measured on the right side: the hip joint (`右足`)
is at z −0.14 and the knee (`右ひざ`) at 0.12, while the wrist was at 0.41 in
the old pose and 0.96 with the bend.

So after the bend, tip and curl, each arm swings about her side-to-side axis
(the mesh's x) through the shoulder joint, by the angle that puts the hand's
centre (halfway between `手首` and `中指１`) on that side's leg line: the
line from `足` to `ひざ`, at the hand's height. `handForward` moves the target
ahead of the line (in model units). The swing is solved exactly in the mesh's
y–z plane and limited to ±20°. It keeps the elbow bend and how far out the arm
hangs. Without the leg bones there is no swing.

## Idle poses

On 15 November 2026 the user asked to keep option C as a named pose and to add
a second one with the hands closer to the thighs in the front view, saying
some clipping is fine because a person's hands rest against their thighs.
Two rest poses can now be picked in **Animation actions · 仕草再生**:

| Button | Pose | Sizes |
| --- | --- | --- |
| **Idle-pose-clean** | The user's pick C, the default | elbow 3°, wrist 0°, curl 15°, hands on the leg line |
| **Idle-pose-natural** | The same, with the arms swung in toward the thighs | as clean, plus `armIn` 4° |

- `armIn` swings each upper arm toward her middle about her front-to-back
  axis (the mesh's z) through the shoulder, before the leg-line swing. So the
  hand still ends up on the leg line, just closer to the thigh. Clean has
  `armIn` 0.
- Clicking a button applies that pose straight away. The thinking rig and
  the arm drift are rebuilt on top of it. The chosen button stays pressed.
  The choice is saved as `yidhari.rest-pose`, and at load she starts in the
  saved pose (clean if none is saved or the value is unknown). Clicking the
  pose already shown does nothing.
- The idle motion (sway, inward and outward drift, forearm roll, finger
  ripple and spread) plays on top of either pose.
- The user picked 4° from a front and three-quarter grid of 0°, 4°, 6°, 8°
  and 10° (right hand centre x −2.98, −2.57, −2.37, −2.16 and −1.96, with
  the hip joint at −1.11). At 6° the hands press against the outer thighs,
  and from 8° they sink into them.
- The pose switch is instant, not eased. Both poses are rest poses, so the
  change is small.


The ticket guessed that her palms faced backward. Measured in the renderer,
they already face her thighs, with the thumb side forward (palm normal about
±0.93 on x toward her middle). So the wrist only tips toward the palm and does
not turn.

## How it composes

- **Rotations in world space.** The elbow turns about the axis between the
  forearm and her front (the mesh's +z), and the wrist about the axis between
  the hand and the palm normal. So the result does not depend on the PMX's
  local bone axes or the twist bones (`腕捩`, `手捩`) in between.
- **Upper arms only swing.** `肩` and the twist bones keep what `restArms()`
  gave them. `腕` only swings back about her side-to-side axis, so how far out
  and down the arms hang does not change.
- **Everything else inherits it.** The thinking rig, arm drift (#193), body
  sway, idle motion and the physics warm-up all capture their rest after
  `restArms()`, so they start from the relaxed pose with no changes. The
  thinking pose blends from it and releases back to it exactly.
- **Missing bones are skipped.** Without finger bones the elbows still bend
  and the wrists stay as they are, because the palm cannot be found. Without
  `足`/`ひざ` the arms are not swung.

## Picking the sizes

On 15 November 2026 the user picked candidate C (elbow 12°, wrist 6°, curl
15°) from B (8°, 4°, 10°), C and D (16°, 8°, 22°), and asked for the hands
to hang in line with the legs rather than in front of them. From the
leg-line grid (old pose, C without the swing, C on the line and C 0.3 ahead),
they then picked 0.3 ahead.

With the idle hand motion running, the hands still looked like they were
carrying something. Measured from the side, the thigh tilts 2–3° forward,
but the forearm tilted 15° and the hand 18°. The user then picked option C
from a third grid (forearm and hand tilt in each label):

| Option | Elbow | Wrist | `handForward` | Forearm tilt | Hand tilt |
| --- | --- | --- | --- | --- | --- |
| A (before) | 12° | 6° | 0.3 | 15° | 18° |
| B | 5° | 3° | 0.15 | 10° | 13° |
| **C (picked)** | 3° | 0° | 0 | 7° | 10° |
| D | 0° | 0° | 0 | 6° | 9° |

Even with no bend, the forearm tilts about 6° forward, because the PMX's
forearm already leans forward of the upper arm in its bind pose. C keeps a
hint of bend so the arm does not look stiff again. The 15° finger curl
stays.

The sizes were picked by eye from labelled front, side and three-quarter
grids of candidates against the old rest pose (see
[Comparison grids](pmx-morph-catalog.md#comparison-grids) for the workflow).
The grids stay in `assets/private/` because the model is private. To redo
them, `globalThis.__yidhariPreview.relax({ elbow, wrist, curl, handForward })` reapplies
the rest pose with other sizes (radians) and rebuilds the thinking rig and
idle bones on top of it. `relax()` with no argument puts the defaults back.

## Code and tests

- `renderer/rest-pose.js`: `RELAXED_REST`, `relaxArms(mesh, sizes)`,
  `REST_POSES` and `bindRestPoseSetting()` for the pose buttons.
- `renderer/thinking-rig.js`: `curlFingers()`, shared with `poseHand()`.
- `renderer/main.js`: `restArms()` calls `relaxArms()`.
- `tests/renderer/rest-pose.test.mjs` uses the synthetic arm rig in
  `tests/renderer/arm-fixture.mjs`, shared with `thinking-rig.test.mjs`.
