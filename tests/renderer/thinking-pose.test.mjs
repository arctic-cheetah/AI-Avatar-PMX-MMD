import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkingPose } from "../../renderer/thinking-pose.js";

test("thinking pose eases in and completely releases", () => {
  const pose = new ThinkingPose();
  assert.equal(pose.update(1), 0);
  pose.setActive(true);
  const lifted = pose.update(0.1);
  assert.ok(lifted > 0 && lifted < 1);
  assert.ok(pose.update(0.1) > lifted);
  pose.setActive(false);
  for (let i = 0; i < 30; i += 1) pose.update(0.1);
  assert.equal(pose.weight, 0);
});

test("negative frame deltas cannot reverse or grow the pose", () => {
  const pose = new ThinkingPose();
  pose.setActive(true);
  assert.equal(pose.update(-1), 0);
});
