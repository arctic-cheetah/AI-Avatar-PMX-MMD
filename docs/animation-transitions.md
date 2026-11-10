# Animation transitions (issue #54)

How the renderer keeps mood, pose, gaze, sway and speech changes smooth,
including when a new change interrupts one still in progress. Items 1–6 of
[#54](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/54) are here.
Body-motion blending with VPD/VMD (item 7) belongs to #49 and #50.

## What was rough

Measured with the synthetic trace (see [Checking it](#checking-it)) before
this change:

| Transition | Problem | Cause |
| --- | --- | --- |
| Neutral → mood → neutral, mood → mood | A morph jumped to full speed on the first frame: 15 % of its range in one 60 fps frame | First-order exponential ease (`1 - exp(-rate·dt)`) has its highest speed at the start |
| Rapid interrupted moods, gaze recentre, thinking pose leave | Direction reversed in a single frame | An exponential ease has no velocity to carry over, so a new target restarts it at full speed |
| Sway toggled off or on | Torso snapped up to 1.5° in one frame | The toggle switched the sine angles straight to zero |
| Idle blink during `furious` | The mood's half-closed `まばたき` 0.3 vanished | The blink overwrote the shared morph instead of combining with it |
| Speaking during `yelling`, `shocked`, `gasp`, `scared`, `grin`, `excited` | Visemes stacked on top of an already open mood mouth | `□`, `ワ` and `ワ２` are not speech morphs, so speech never took them over |
| Head gaze during the thinking gesture | The head could turn away from the hand under the chin | The hand pose is solved once against the resting head |

Easing was already time based, so the speeds above were the same at
60, 30 and 15 fps. Only the 0.1 s frame cap slowed real-time easing, below 10 fps.

## Timing per channel

All rates live in `TIMING` in [smoothing.js](../renderer/smoothing.js), in
units of 1/s (so a time constant τ is `1 / rate`).

| Channel | Ease | Rate | Roughly settled (95 %) |
| --- | --- | --- | --- |
| Mood morphs | Critically damped spring | 14 | 0.34 s |
| Thinking pose | Critically damped spring | 10 | 0.47 s |
| Gaze (eyes, head follows) | Critically damped spring | 15 | 0.32 s |
| Winks | Critically damped spring | 16 | 0.30 s |
| Sway fade on toggle | Critically damped spring | 4 | 1.2 s |
| Speech shapes | Exponential | 35 | 86 ms |
| Lip closures (A) | Exponential | 80 | 38 ms |
| Speech ↔ mood mouth handoff | Exponential | 18 | 0.17 s |
| Idle blink | Authored ramps | 70 ms close, 50 ms hold, 110 ms open | — |
| Sleepy blink (#71) | Authored ramps, ×2.5 slower | 175 ms close, 125 ms hold, 275 ms open, twice as far apart | — |
| Idle moods: sleepy, wake-up (#71) | Mood springs above | Same as mood morphs | 0.34 s per step |
| Idle tilt, sigh, stretch (#71) | Authored curve, then critically damped spring | 8 | 0.6 s |
| Idle glance (#71) | Gaze spring above | 15 | 0.32 s |

A critically damped spring starts and stops gently, never overshoots when
starting from rest, and carries its velocity into a new target. That last
property is what makes interruptions continuous: a mood changed half-way
slows and turns instead of reversing in one frame. Speech keeps the faster
exponential eases on purpose, because a slow mouth loses lip-sync and
intelligibility.

The spring uses the exact closed-form step, so a 15 fps frame lands on the
same curve as four 60 fps frames. The frame delta is capped at
`MAX_FRAME_DELTA` (0.25 s), so wall-time easing holds down to 4 fps. Any
longer pause, such as a hidden tab, resumes as a 0.25 s step rather than a jump.

## Blending from the displayed state

Every controller keeps its displayed value and velocity, and each change only
moves the target. Nothing resets through a default pose:

- Mood changes retarget the springs of the morphs already showing. A morph
  that is leaving decelerates and fades from wherever it is.
- The thinking pose slerps rest → posed by its spring weight, so leaving
  half-way returns from the half-raised arm.
- Turning sway off fades its gain to zero, and turning it back on fades the
  sine back in from the current phase.

## Layer priority

Each frame clears every morph, then writes channels in this order:

1. **Mood:** the expression controller writes its springs.
2. **Speech:** blends speech-owned morphs (`あ`, `い`, `う`, `え`, `お`) from the
   mood's value toward the current viseme, and scales open-mouth mood shapes
   (`□`, `ワ`, `ワ２`) by `1 − envelope`. Between words and after the clip, the
   envelope returns them to the mood. Mouth corners such as `口角上げ` and
   `口角下げ` stay, so the emotion still shows while talking.
3. **Winks:** spring-eased `ウィンク` and `ウィンク右`.
4. **Blink:** combines with the mood's own `まばたき` as
   `1 − (1 − mood) · (1 − blink · (1 − closure))`. The closure is the
   strongest eye-closing morph already on the face (`笑い`, `ウィンク`,
   `ウィンク右`; the table is `EYE_CLOSURE` in
   [facial-layers.js](../renderer/facial-layers.js)). A closed-eye smile or
   a wink therefore does not blink on top of itself, and a partial closure blinks
   only the rest of the way.
5. **Audition:** manual sliders add on top for previews.

Bones do not share writers: the thinking pose owns the arms and fingers, gaze
owns `左目`, `右目`, `首` and `頭`, and sway owns `上半身`, `上半身2` and
`グルーブ`. While the chin rests on the hand, the head and neck follow gaze at
`THINKING_POSE.headGaze` (35 %) of their usual range. The eyes keep their full
range.

## Checking it

```bash
node tests/renderer/transition-trace.mjs
```

The trace prints, per scenario, frame rate and channel: the largest
single-frame step, peak speed, and the largest frame-to-frame change in speed.
The scenarios follow the issue's reproduction list: neutral → mood → neutral,
mood → mood, rapid interrupted moods, the thinking pose entered, interrupted
and re-entered, gaze jumps, sway stopped at its peak, and thinking → speaking → idle.
It uses a synthetic face, so its numbers are safe to paste.

```bash
node --test tests/renderer/*.test.mjs
```

[transitions.test.mjs](../tests/renderer/transitions.test.mjs) runs the same
scenarios at 60, 30 and 15 fps. It asserts:

- no eased channel moves more than 0.1 of its range in one 60 fps frame
- speed never changes by more than 6 ranges/s between frames, interruptions included
- weights stay in 0–1
- values at the same wall time agree across frame rates
- sway never moves faster than 6°/s when toggled
- speech yields the open mood mouth and hands it back

## Limitations

- **Visual review on the real model is still needed.** The checks prove
  continuity on synthetic fixtures. Record side-by-side clips locally to judge
  feel on the private PMX, and keep them out of the repository.
- **The blink is an authored ramp.** At about 4 fps or lower a whole
  230 ms blink can fall between two frames.
- **Mouth and eye-closure tables are by name.** They match Yidhari's PMX
  (see [pmx-morph-catalog.md](./pmx-morph-catalog.md)). Another model with
  different morph names needs its own entries.
- **The partial closure model is linear.** How `笑い` and `まばたき` really
  combine depends on the model geometry. Check the overlap by eye if a smile
  looks over- or under-closed.
- **Authored motion is out of scope.** VPD/VMD pose and motion blending
  is tracked in #49 and #50.
