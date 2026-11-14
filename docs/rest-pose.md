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

The finger scale is thumb 0.45, index 0.8, middle 0.9, ring 1.0 and pinky
1.1, so the curl grows toward the pinky, like a resting hand. The thumb scale
and the curl itself are shared with the thinking pose's hand
(`curlFingers()` in `renderer/thinking-rig.js`).

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
- **Upper arms untouched.** `腕`, `肩` and the twist bones keep what
  `restArms()` gave them. How far the arms lower is out of scope.
- **Everything else inherits it.** The thinking rig, arm drift (#193), body
  sway, idle motion and the physics warm-up all capture their rest after
  `restArms()`, so they start from the relaxed pose with no changes. The
  thinking pose blends from it and releases back to it exactly.
- **Missing bones are skipped.** Without finger bones the elbows still bend
  and the wrists stay as they are, because the palm cannot be found.

## Picking the sizes

The sizes were picked by eye from labelled front, side and three-quarter
grids of candidates against the old rest pose (see
[Comparison grids](pmx-morph-catalog.md#comparison-grids) for the workflow).
The grids stay in `assets/private/` because the model is private. To redo
them, `globalThis.__yidhariPreview.relax({ elbow, wrist, curl })` reapplies
the rest pose with other sizes (radians) and rebuilds the thinking rig and
idle bones on top of it. `relax()` with no argument puts the defaults back.

## Code and tests

- `renderer/rest-pose.js`: `RELAXED_REST` and `relaxArms(mesh, sizes)`.
- `renderer/thinking-rig.js`: `curlFingers()`, shared with `poseHand()`.
- `renderer/main.js`: `restArms()` calls `relaxArms()`.
- `tests/renderer/rest-pose.test.mjs` uses the synthetic arm rig in
  `tests/renderer/arm-fixture.mjs`, shared with `thinking-rig.test.mjs`.
