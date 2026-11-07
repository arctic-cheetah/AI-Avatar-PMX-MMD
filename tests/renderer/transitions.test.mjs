// Automated smoothness checks for issue #54, on synthetic fixtures only.
// Run with: node --test tests/renderer/transitions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_RATES, SCENARIOS, measure, runScenario, valueAt } from "./transition-fixtures.mjs";

/** No eased channel may move more than this much of its range in one 60 fps frame. */
const MAX_STEP_AT_60 = 0.1;
/**
 * Largest allowed frame-to-frame change in speed, in ranges per second.
 * Exponential easing jumps from rest to full speed (about 7–10 here), and
 * reverses instantly when interrupted; a second-order ease stays below this.
 */
const MAX_VELOCITY_JUMP = 6;
/** Sway may fade in and out, but never faster than this many degrees per second. */
const MAX_SWAY_SPEED = 6;

const scenario = (name) => SCENARIOS.find((entry) => entry.name === name);
const EASED = [
  ["neutral → mood → neutral", ["smile"]],
  ["mood → different mood", ["smile", "brow", "frown"]],
  ["rapid interrupted moods", ["smile", "brow", "frown", "glare"]],
  ["thinking pose enter, interrupted leave, re-enter", ["pose"]],
  ["gaze target jump and recentre", ["gaze"]],
  ["thinking → speaking → idle", ["squint", "glare", "pose"]],
];

for (const [name, channels] of EASED) {
  test(`${name}: no abrupt per-frame jump at 60 fps`, () => {
    const metrics = measure(runScenario(scenario(name), 60));
    for (const channel of channels) {
      assert.ok(metrics[channel].maxStep <= MAX_STEP_AT_60,
        `${channel} moved ${metrics[channel].maxStep.toFixed(3)} in one frame`);
    }
  });

  test(`${name}: speed stays continuous, including interruptions`, () => {
    for (const fps of FRAME_RATES) {
      const metrics = measure(runScenario(scenario(name), fps));
      for (const channel of channels) {
        assert.ok(metrics[channel].maxVelocityJump <= MAX_VELOCITY_JUMP,
          `${channel} at ${fps} fps changed speed by ${metrics[channel].maxVelocityJump.toFixed(2)}/s in one frame`);
      }
    }
  });

  test(`${name}: weights stay in range`, () => {
    for (const fps of FRAME_RATES) {
      const metrics = measure(runScenario(scenario(name), fps));
      for (const channel of channels) {
        assert.ok(metrics[channel].min >= -1e-9 && metrics[channel].max <= 1 + 1e-9, `${channel} at ${fps} fps`);
      }
    }
  });
}

test("transitions follow wall time, not frame count", () => {
  for (const [name, channels] of EASED) {
    const fast = runScenario(scenario(name), 60);
    for (const fps of [30, 15]) {
      const slow = runScenario(scenario(name), fps);
      for (const time of [0.4, 0.8, 1.2, 1.6]) {
        for (const channel of channels) {
          const gap = Math.abs(valueAt(fast, channel, time) - valueAt(slow, channel, time));
          assert.ok(gap < 0.02, `${name} ${channel} differs by ${gap.toFixed(3)} at ${time}s (${fps} fps)`);
        }
      }
    }
  }
});

test("stopping or restarting sway fades instead of snapping to rest", () => {
  for (const fps of FRAME_RATES) {
    const metrics = measure(runScenario(scenario("sway stop at peak, then restart"), fps));
    for (const channel of ["roll", "yaw", "breath"]) {
      assert.ok(metrics[channel].peakVelocity <= MAX_SWAY_SPEED,
        `${channel} at ${fps} fps moved ${metrics[channel].peakVelocity.toFixed(1)}°/s`);
    }
  }
});

test("a stopped sway still settles at rest", () => {
  const run = runScenario(scenario("sway stop at peak, then restart"), 60);
  for (const channel of ["roll", "yaw", "breath"]) {
    assert.ok(Math.abs(valueAt(run, channel, 3.9)) < 0.01, `${channel} rests before the restart`);
  }
});

test("speech articulation yields mood mouth shapes, then hands them back", () => {
  for (const fps of FRAME_RATES) {
    const run = runScenario(scenario("thinking → speaking → idle"), fps);
    // Speech starts at 0.6 s; the open-jaw cue holds from 0.7 s to 1.0 s.
    assert.ok(valueAt(run, "a", 0.93) > 0.8, `jaw opens for the cue at ${fps} fps`);
    assert.ok(valueAt(run, "shout", 0.93) < 0.1, `mood mouth yields while articulating at ${fps} fps`);
    // Clip ends at 1.6 s and the mood holds until 2.2 s.
    assert.ok(valueAt(run, "shout", 2.13) > 0.95, `mood mouth returns after speech at ${fps} fps`);
    assert.ok(valueAt(run, "a", 2.13) < 0.01, `speech morphs release at ${fps} fps`);
    assert.ok(valueAt(run, "glare", 0.93) > 0.75, `non-mouth mood morphs stay during speech at ${fps} fps`);
  }
});

test("speech handoff stays quick but has no single-frame pop at 60 fps", () => {
  const metrics = measure(runScenario(scenario("thinking → speaking → idle"), 60));
  assert.ok(metrics.shout.maxStep <= 0.3, `shout moved ${metrics.shout.maxStep.toFixed(3)} in one frame`);
});
