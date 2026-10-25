// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEG, SWAY, maxSwayAmplitude, swayAnglesAt } from "../../renderer/body-sway.js";

test("sway starts at rest so the pose eases in", () => {
  assert.deepEqual(swayAnglesAt(0), { roll: 0, yaw: 0, breath: 0 });
});

test("invalid clocks hold the rest pose", () => {
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.deepEqual(swayAnglesAt(now), { roll: 0, yaw: 0, breath: 0 });
  }
});

test("each channel repeats at its own period", () => {
  for (const [name, { period }] of Object.entries(SWAY)) {
    const first = swayAnglesAt(1.37)[name];
    assert.ok(Math.abs(swayAnglesAt(1.37 + period)[name] - first) < 1e-12, name);
  }
});

test("channels stay within their subtle amplitude bounds", () => {
  for (let now = 0; now < 120; now += 0.05) {
    const angles = swayAnglesAt(now);
    for (const [name, { amplitude }] of Object.entries(SWAY)) {
      assert.ok(Math.abs(angles[name]) <= amplitude + 1e-12, `${name} at ${now}s`);
    }
  }
  assert.ok(maxSwayAmplitude() <= 2 * DEG, "no channel exceeds two degrees");
});

test("channels reach near full amplitude over a long idle", () => {
  for (const [name, { amplitude }] of Object.entries(SWAY)) {
    let peak = 0;
    for (let now = 0; now < 120; now += 0.05) {
      peak = Math.max(peak, Math.abs(swayAnglesAt(now)[name]));
    }
    assert.ok(peak > amplitude * 0.99, `${name} moves visibly`);
  }
});

test("sway is smooth between frames", () => {
  for (let now = 0; now < 30; now += 1 / 60) {
    for (const name of ["roll", "yaw", "breath"]) {
      const step = Math.abs(swayAnglesAt(now + 1 / 60)[name] - swayAnglesAt(now)[name]);
      assert.ok(step < 0.05 * DEG, `${name} has no visible jump`);
    }
  }
});
