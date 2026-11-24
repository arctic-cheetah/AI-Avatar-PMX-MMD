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
   she eases into it over 1 s, keeps it for 4 s, then eases out over 1 s. Clicking the
   playing button stops it early; clicking another pose switches to it.
3. `?pose=<name>` in the page URL holds a pose from page load until its button
   is clicked, for example
   `http://127.0.0.1:8770/renderer/?pose=wink-v-sign`.

The status line under the buttons names bones and morphs in the file that the
model does not have. A file that is missing or is not a VPD shows an error
there, and nothing is held.

## As idle actions

Each pose also gets a tick under **Actions · 仕草** (`🎞️ wink-v-sign`). While
she idles or sleeps, a ticked pose can be picked at random like any other
action, with the chance of a share-1 action such as the glance. It plays for
4 s, the same as its button. Pose ticks are on by default for new poses and
are saved per browser (`yidhari.poseActions`), apart from the built-in
actions. `IdleMotion.setExternalActions()` registers them; IdleMotion only
decides when, and main.js plays the pose through `HeldPose`.

## Uploading a pose from the page

Under the pose buttons, **Upload VPD** sends a `.vpd` file to `serve.py`, which
saves it as `assets/private/poses/<name>.vpd` and adds its button and tick.
The name defaults to the file name. If a pose of that name exists, the page
asks before replacing it, which is how to update a pose after editing it in
Blender.

`POST /poses/<name>` (`controller/pose_store.py`):

- is accepted only from the renderer page itself (the `Origin` header must
  be the server's own), so other web pages cannot write files;
- takes names of 1–64 letters, digits, `_` or `-` (Japanese included), so a
  name cannot leave the folder;
- takes `application/octet-stream` up to 1 MB that starts with
  `Vocaloid Pose Data file`;
- answers 409 when the pose exists, unless `?overwrite=1`, and writes
  through a temporary file so a failed upload leaves the old pose intact.

`serve.py --poses-dir` points it at another folder (the tests use one).

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
- **Blending.** Held bones slerp from their base toward the target by the
  pose weight. The weight comes from `PoseEase` in `smoothing.js`, shared
  with the thinking pose. From rest it follows smootherstep
  (6p⁵ − 15p⁴ + 10p³) over the ease time, so it starts and lands with no
  speed and no jolt. Turned back midway, it plans a quintic from its current
  speed, so it keeps moving a moment and curves round instead of snapping
  back. Each transition is computed from elapsed time, so it is the same at
  any frame rate. The first version used 0.4 s smoothstep, which the user
  found too quick.
- **Ease time.** The **Pose ease (s)** slider under the pose buttons sets the
  ease time from 0.3 to 3 s (default 1 s), for the Blender poses and the
  thinking pose together, and is saved per browser (`yidhari.poseEase`). A
  new time applies from the next transition. An idle pick of a pose lasts
  4 s plus two ease times.
- **Morphs.** The pose's morph weights (for example `ウィンク右` in
  `wink-v-sign`) are raised to `weight × pose weight` after the expression,
  speech and blink layers. They never lower a morph another layer set higher.
- **Every morph ≤ 1.** The last morph pass first runs `clampMorphs()` in
  `facial-layers.js`: every morph ends within 0 to 1, however many layers
  added to it (pose, mood, speech, audition sliders). Sums across different
  morphs are left alone, because most do not overlap: `上左` + `上右` lift
  different brows. Capping whole panels instead was measured and rejected:
  it would have changed 23 of the 50 tuned mood presets.
- **Eye budget.** Then `capEyeClosure()` in
  `facial-layers.js`, keeps each eye's closing morphs at or under 1 in total
  (left: `笑い`, `まばたき`, `ウィンク`, `ウィンク２`; right: `笑い`, `まばたき`,
  `ウィンク右`, `ウィンク２右`). An eye over budget has its closers scaled down by
  the same factor. So `wink-v-sign` (`ウィンク右` 1) during `happy` (`笑い` 1)
  shows each at 0.5: the right eye closes once instead of the lid clipping
  through, and the left eye keeps half the smile. None of the 50 mood presets
  exceeds the budget on its own, so moods alone are unchanged.
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
