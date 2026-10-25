# Body sway (issue #4)

Slow, subtle sine-wave motion of the upper body so Yidhari feels alive
while idle — think of the grok companion's gentle drift.

## Approach

Three independent sine channels, one per bone, each a pure function of the
monotonic animation-clock time:

| Channel | Bone      | Axis | Amplitude | Period |
| ------- | --------- | ---- | --------- | ------ |
| Roll    | `上半身2` | z    | ~1.5°     | ~6 s   |
| Yaw     | `上半身`  | y    | ~1.0°     | ~9 s   |
| Breath  | `グルーブ`| x    | ~0.8°     | ~4 s   |

Periods are co-prime-ish so the combined motion never looks like a rigid
loop. The coprime phasing also keeps the motion clear of the ~3 s
expression loop and the ~2–6 s blink timer.

## Composition rules

- Sway applies **relative rotations each frame**: each swayed bone's base
  quaternion is cached at load time (after `restArms()` drops the arms out
  of the T-pose), and every frame sets
  `bone.quaternion = base * smallSineRotation`.
- This composes with the lowered-arm pose and with any future bone-animation
  layer (shared with #6 eye tracking): sway never overwrites a load-time
  pose, it only multiplies a small delta on top.
- The pure math (`swayAnglesAt`) lives in `renderer/body-sway.js` with no
  DOM or Three.js imports, mirroring `renderer/gaze-tracking.js`, so
  `node --test` covers it.

## Caveats

- Hair and coat have no physics yet: keep amplitudes to a few degrees at
  most or the stiff cloth/hair will betray the motion.
- Rotation order for the composed delta is YXZ (yaw, pitch, roll) so the
  breathing pitch reads naturally against the roll.
- A sway toggle (default ON) mirrors `blinkToggle` for users who prefer a
  perfectly still bust.
