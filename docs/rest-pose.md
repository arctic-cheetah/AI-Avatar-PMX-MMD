# Relaxed rest pose (#199)

The PMX loads in a T-pose. `restArms()` in `renderer/main.js` lowers the upper
arms (`左腕`/`右腕`) to hang down, slightly out and forward. Before #199 that was
all it did, so everything below the shoulder stayed in the bind pose: straight
elbows, and straight, flat fingers pointing at the floor. She looked stiff.

`relaxArms()` in `renderer/rest-pose.js` runs at the end of `restArms()` and
relaxes the rest of the arm:

| Part | Change | Default |
| --- | --- | --- |
| Elbow (`ひじ`) | The forearm turns forward, toward her front, about the elbow | 12° |
| Wrist (`手首`) | The hand tips toward the palm | 6° |
| Fingers (`親指`–`小指` `１–３`) | Each joint curls toward the palm | 15° per joint, scaled per finger |
| Upper arm (`腕`) | The whole arm swings back from the shoulder until the hand hangs in line with the leg | `handForward` 0 |

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

## What was measured first

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
to hang in line with the legs rather than in front of them.

The sizes were picked by eye from labelled front, side and three-quarter
grids of candidates against the old rest pose (see
[Comparison grids](pmx-morph-catalog.md#comparison-grids) for the workflow).
The grids stay in `assets/private/` because the model is private. To redo
them, `globalThis.__yidhariPreview.relax({ elbow, wrist, curl, handForward })` reapplies
the rest pose with other sizes (radians) and rebuilds the thinking rig and
idle bones on top of it. `relax()` with no argument puts the defaults back.

## Code and tests

- `renderer/rest-pose.js`: `RELAXED_REST` and `relaxArms(mesh, sizes)`.
- `renderer/thinking-rig.js`: `curlFingers()`, shared with `poseHand()`.
- `renderer/main.js`: `restArms()` calls `relaxArms()`.
- `tests/renderer/rest-pose.test.mjs` uses the synthetic arm rig in
  `tests/renderer/arm-fixture.mjs`, shared with `thinking-rig.test.mjs`.
