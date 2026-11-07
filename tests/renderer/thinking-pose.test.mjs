import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_POSE, ThinkingPose, headGazeScale } from "../../renderer/thinking-pose.js";

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

test("head gaze follows less while the chin rests on the hand", () => {
  assert.equal(headGazeScale(0), 1);
  assert.equal(headGazeScale(1), THINKING_POSE.headGaze);
  assert.ok(THINKING_POSE.headGaze > 0 && THINKING_POSE.headGaze < 1);
  assert.ok(headGazeScale(0.5) < 1 && headGazeScale(0.5) > THINKING_POSE.headGaze);
  assert.equal(headGazeScale(2), THINKING_POSE.headGaze, "weights above 1 are clamped");
  assert.equal(headGazeScale(-1), 1, "weights below 0 are clamped");
});

test("an interrupted release keeps moving smoothly instead of reversing at once", () => {
  const pose = new ThinkingPose();
  pose.setActive(true);
  for (let i = 0; i < 9; i += 1) pose.update(1 / 60);
  const rising = pose.weight;
  pose.setActive(false);
  assert.ok(pose.update(1 / 60) > rising, "the arm decelerates before it turns back");
});
