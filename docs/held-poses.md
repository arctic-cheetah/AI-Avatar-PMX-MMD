# Held poses from Blender (#49)

The renderer can hold a pose authored in Blender (see
[Posing Yidhari in Blender](blender-poses.md)) and saved as a VPD file. This is
the first slice of #49: static VPD poses. Timed VMD motion comes later.

## Use

1. Save poses as `assets/private/poses/<name>.vpd`, for example with the
   Yidhari Poses add-on (#261). The folder is gitignored; `serve.py` already
   serves it on localhost.
2. In the panel, under **Animation actions ▸ Blender poses · ポーズ**, each
   VPD has a button (`🎞️ wink-v-sign`). A click plays the pose like an action:
   she eases into it over 0.4 s, keeps it for 4 s, then eases out. Clicking the
   playing button stops it early; clicking another pose switches to it.
3. `?pose=<name>` in the page URL holds a pose from page load until its button
   is clicked, for example
   `http://127.0.0.1:8770/renderer/?pose=wink-v-sign`.

The status line under the buttons names bones and morphs in the file that the
model does not have. A file that is missing or is not a VPD shows an error
there, and nothing is held.

## How it works (`renderer/held-pose.js`)

- **Reading.** three.js r170's `MMDParser.parseVpd` rejects any `Morph`
  block. `readVpd()` cuts the `MorphN{…}` blocks out, parses the bones with
  `MMDParser` (with the left-to-right handed conversion `MMDLoader.loadVPD`
  uses), and reads the morph weights itself.
- **Reference.** VPD rotations are measured from the PMX **bind pose**, not
  the lowered-arm rest that `restArms()` makes. `HeldPose` records every bone's
  bind rotation and position when the model loads, before `restArms()`. A
  fully held bone gets `bind ⊗ vpd` (and `bind + translation`), the same
  result as `MMDAnimationHelper.pose()` after `mesh.pose()`, without resetting
  the live model.
- **Ownership.** Only the bones the VPD names are touched. The pose layer runs
  after the thinking pose, gaze, sway, idle motion and arm drift, and before
  physics, so the held bones win and the hair and tails still follow.
- **Release.** Each held bone eases from its *base*: what a layer wrote this
  frame, or, for a bone no layer rewrites (the mouth-corner bones `口左`/`口右`,
  the fingers), where it was before the pose took it. When the weight reaches
  0 the base is put back, so releasing leaves nothing behind. Swapping to
  another pose puts back the bones the new pose does not hold.
- **Blending.** Held bones slerp from what the layers wrote this frame toward
  the target by the pose weight. The weight follows smoothstep over
  `easeSeconds` (0.4 s), driven by elapsed time, so it is the same at any
  frame rate. Releasing halfway reverses from the current weight.
- **Morphs.** The pose's morph weights (for example `ウィンク右` in
  `wink-v-sign`) are raised to `weight × pose weight` after the expression,
  speech and blink layers. They never lower a morph another layer set higher.
- **No IK or grant solving.** The renderer runs no IK or grant solver, and
  poses from the add-on hold the deform bones directly, so none is needed.

## Limits

- Bones a held pose owns no longer follow gaze, sway or idle motion while it
  is held. Wink + V-sign only owns the right arm and fingers, so her head
  tracking, breathing and tails keep moving.
- Held bones take the pose exactly. Contact with the body or face is not
  checked; check new poses in the comparison grids.

## Tests

`node --test tests/renderer/held-pose.test.mjs` covers the reading, the bind
reference under a changed rest, the bone mask, missing names, frame-rate-
independent easing, reversing, release, morphs and swapping poses, on the
synthetic arm rig.
