# Thinking pose arms (#217)

The thinking mood rests her right fist under her chin. `buildThinkingRig()` in
`renderer/thinking-rig.js` solves both arms once, from four targets in
`THINKING_ARM`:

| Target | What it sets | Relative to |
| --- | --- | --- |
| `chin` | The right wrist | The head bone (`頭`) |
| `elbowBend` | Which way the right elbow bends | The analytic two-segment solver |
| `support` | The left wrist | The posed right elbow (`右ひじ`) |
| `supportBend` | Which way the left elbow bends | The analytic two-segment solver |

## The clipping

Before #217 the right elbow hung low beside her waist and the left hand cupped
it. On the way up to the chin, the right forearm and glove cut through her bust.
The renderer has no collision, and the rig tests use a synthetic skeleton with
no mesh, so nothing caught it.

Measured on the PMX at full pose weight: 150–290 right forearm and hand
vertices sat behind the front surface of the bust, up to 0.87 model units deep.
The count moves a little with the bust physics.

The arms are too short for the forearm to pass in front of the bust. The
shoulder is at z −0.6 and the front of the bust reaches z 1.88, so an elbow far
enough forward is out of the upper arm's reach (2.96). The forearm has to pass
beside and above the bust instead, so the right elbow swings outward. Once the
elbow is that high, a left hand cupping it has to cross the bust too. So the left
forearm now folds across her waist under the bust, with the hand by her right
side.

## How it was measured

On a `?bridge=off` test page, the clearance check:

1. takes vertices weighted at least half to a bone named `胸` (bust) or to a
   forearm, wrist or finger bone (`ひじ`, `手捩`, `手首`, fingers) on each side;
2. skins them with `SkinnedMesh.getVertexPosition()`;
3. bins the bust vertices by x and y (0.15 units) and keeps the front-most z of
   each bin;
4. counts the arm vertices that fall in a bust bin but sit behind its front.

`globalThis.__yidhariPreview.thinkingArm({ chin, elbowBend, support,
supportBend })` rebuilds the pose from rest with other targets, and
`__yidhariPreview.mesh` is the loaded PMX. Calling `thinkingArm()` with no
argument restores `THINKING_ARM`.

## Picking the targets

The elbow-bend hint was swept around the whole circle the elbow can reach,
with the wrist at its old place and 0.25 further forward. The right forearm
clears once the elbow swings 60–90° outward from straight down. A random search
of the left targets with the right elbow raised found nothing that clears while
the left hand is near the elbow. Folding the left forearm under the bust does
clear.

Grids (front and three-quarter, the old pose against the candidates) are in
`assets/private/thinking-217/`, which is gitignored because the model is
private.

| Option | `chin` | `elbowBend` | `support` | `supportBend` | Right in bust | Left in bust |
| --- | --- | --- | --- | --- | --- | --- |
| Before | −0.35, −1.5, 2.05 | −0.35, −1, 0.85 | 0.45, −0.3, 0.85 | 0.7, −1, 0.2 | 150–290 vertices, 0.87 deep | 0 |
| **A (picked)** | −0.35, −1.5, 2.3 | −0.97, −0.26, 0.8 (75° out) | 1.4, −1.6, 0.3 | 1, −1, 0 | 0 | 0–2 vertices, ≤ 0.14 deep |
| B | as A | as A | 1.6, −1.7, 0.1 | 1, −1, 0 | 0 | 0–2 vertices |
| C | as A | 90° out | 1.4, −1.6, 0.3 | 1, −1, 0 | 0 | about 55 vertices, 0.49 deep |

- The wrist moves 0.25 forward so the forearm clears the top of the bust with a
  lower elbow. The fist still sits under the chin, and the 35 % head gaze range
  from `THINKING_POSE.headGaze` is unchanged.
- B differs from A only in the left hand, which sits a little lower and closer
  to her middle.

## Test

`tests/renderer/thinking-rig.test.mjs` checks both posed forearms against a
bust stand-in in the synthetic arm rig (`BUST` and `bustDepth()` in
`tests/renderer/arm-fixture.mjs`). The stand-in is one ellipsoid per side,
fitted to the measured front of the PMX bust: centres at x ±0.7, y 16.7,
z 0.6, with radii 1.0, 1.05 and 1.25. Each forearm axis is sampled from elbow
to wrist and must stay outside the ellipsoids grown by a 0.3 forearm radius.
The old pose sinks 0.38 (normalised) into them, and A stays 0.04 clear.

This is tuned clearance, not mesh collision. A new model, outfit or pose needs
the measurement again.
