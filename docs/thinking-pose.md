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
| `supportBend` | Which way the left elbow bends | The analytic two-segment solver | 1, −1, 0 |

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
| **Final (50° fist, L2)** | **0.46–0.91 clear** | **0.20–0.22 above (side of the jaw)** | **0.007–0.012 from the elbow sleeve** | **0** |

In the final pose the puffy sleeve and glove press into the bust, as agreed.
The upper-arm readings near the armpits sometimes count as inside the bust
bins, because the upper arm passes beside the body there; it is hidden and is
not counted.

## Tests

`tests/renderer/thinking-rig.test.mjs` uses a bust stand-in in the synthetic
arm rig (`BUST` and `bustDepth()` in `tests/renderer/arm-fixture.mjs`): one
ellipsoid per side, fitted to the measured front of the PMX bust, with centres
at x ±0.7, y 16.7, z 0.6 and radii 1.0, 1.05 and 1.25.

- **Bones out of the bust.** Each forearm bone is sampled from elbow to wrist
  and must stay outside the ellipsoids grown by `ARM_BONE_RADIUS` (0.2). The
  original pose sinks 0.34 (normalised) into them; the final pose stays 0.08
  clear on the right and 0.16 on the left.
- **Left hand at the elbow.** The left wrist sits within 0.9 of the right
  elbow and below it (0.79 in the final pose; 2.15 in A).
- **Fist setting.** The right hand's finger direction follows `fist`.

This is tuned clearance, not mesh collision. A new model, outfit or pose needs
the measurement again.
