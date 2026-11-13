// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHYSICS_RATE_DEFAULT, PHYSICS_RATE_MAX, PHYSICS_RATE_MIN, PHYSICS_WARMUP_CYCLES, PhysicsLayer, physicsStep,
} from "../../renderer/physics-layer.js";
import { defaultPhysicsGroups } from "../../renderer/physics-groups.js";

/** A fake MMDPhysics build that records every call in one shared log. */
function harness({ fail = false, deferred = false, steps = false } = {}) {
  const log = [];
  const builds = [];
  const pending = [];
  const build = (groups) => {
    const id = builds.length;
    const physics = {
      id,
      groups: [...groups].sort(),
      update: (delta) => log.push(["update", id, delta]),
      reset: () => log.push(["reset", id]),
      warmup: (cycles) => log.push(["warmup", id, cycles]),
      dispose: () => log.push(["dispose", id]),
    };
    if (steps) physics.setStep = ({ unitStep, maxStepNum }) => log.push(["step", id, Math.round(1 / unitStep), maxStepNum]);
    builds.push(physics);
    log.push(["build", id]);
    if (fail) return Promise.reject(new Error("Ammo failed to load"));
    if (!deferred) return Promise.resolve(physics);
    return new Promise((resolve) => pending.push(() => resolve(physics)));
  };
  const restoreBones = () => log.push(["restore"]);
  const layer = new PhysicsLayer({ build, restoreBones });
  const release = async () => {
    pending.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { layer, log, builds, release };
}

test("starts off with the default groups and builds nothing", () => {
  const { layer, log } = harness();
  assert.equal(layer.status, "off");
  assert.deepEqual([...layer.groups].sort(), [...defaultPhysicsGroups()].sort());
  layer.update(1 / 60);
  assert.deepEqual(log, []);
});

test("enabling builds once, then resets and warms up before the first update", async () => {
  const { layer, log, builds } = harness();
  await layer.setEnabled(true);
  assert.equal(layer.status, "on");
  assert.deepEqual(builds[0].groups, [...defaultPhysicsGroups()].sort());
  assert.deepEqual(log, [["build", 0], ["reset", 0], ["warmup", 0, PHYSICS_WARMUP_CYCLES]]);
});

test("update passes delta straight through: no second accumulator", async () => {
  const { layer, log } = harness();
  await layer.setEnabled(true);
  log.length = 0;
  for (const delta of [0.016, 0.1, 0]) layer.update(delta);
  assert.deepEqual(log, [["update", 0, 0.016], ["update", 0, 0.1], ["update", 0, 0]]);
});

test("disabling stops updates and puts the physics bones back at rest", async () => {
  const { layer, log } = harness();
  await layer.setEnabled(true);
  log.length = 0;
  await layer.setEnabled(false);
  layer.update(1 / 60);
  assert.equal(layer.status, "off");
  assert.deepEqual(log, [["restore"]]);
});

test("re-enabling reuses the build but resets and warms up again", async () => {
  const { layer, log } = harness();
  await layer.setEnabled(true);
  await layer.setEnabled(false);
  log.length = 0;
  await layer.setEnabled(true);
  assert.deepEqual(log, [["reset", 0], ["warmup", 0, PHYSICS_WARMUP_CYCLES]]);
});

test("a group change while on restores, disposes and rebuilds with the new set", async () => {
  const { layer, log, builds } = harness();
  await layer.setEnabled(true);
  log.length = 0;
  await layer.setGroup("chest", true);
  assert.ok(builds[1].groups.includes("chest"));
  assert.deepEqual(log, [
    ["restore"], ["dispose", 0], ["build", 1], ["reset", 1], ["warmup", 1, PHYSICS_WARMUP_CYCLES],
  ]);
  log.length = 0;
  layer.update(0.02);
  assert.deepEqual(log, [["update", 1, 0.02]]);
});

test("chest and hips switch independently", async () => {
  const { layer } = harness();
  await layer.setGroup("hips", true);
  assert.ok(layer.groups.has("hips") && !layer.groups.has("chest"));
  await layer.setGroup("chest", true);
  await layer.setGroup("hips", false);
  assert.ok(layer.groups.has("chest") && !layer.groups.has("hips"));
});

test("a group change while off waits for the next enable", async () => {
  const { layer, log, builds } = harness();
  await layer.setGroup("hips", true);
  assert.deepEqual(log, []);
  await layer.setEnabled(true);
  assert.ok(builds[0].groups.includes("hips"));
});

test("a group change while off disposes a stale build, so enable rebuilds", async () => {
  const { layer, log, builds } = harness();
  await layer.setEnabled(true);
  await layer.setEnabled(false);
  log.length = 0;
  await layer.setGroup("chest", true);
  await layer.setEnabled(true);
  assert.equal(builds.length, 2);
  assert.deepEqual(log, [["dispose", 0], ["build", 1], ["reset", 1], ["warmup", 1, PHYSICS_WARMUP_CYCLES]]);
});

test("setting a group to its current value does not rebuild", async () => {
  const { layer, builds } = harness();
  await layer.setEnabled(true);
  await layer.setGroup("hair", true);
  assert.equal(builds.length, 1);
});

test("an unknown group is refused", async () => {
  const { layer } = harness();
  await assert.rejects(layer.setGroup("cape", true), RangeError);
});

test("a failed build reports an error and leaves the rest of the frame alone", async () => {
  const { layer, log } = harness({ fail: true });
  const statuses = [];
  layer.onStatus = (status) => statuses.push(status);
  await layer.setEnabled(true);
  assert.equal(layer.status, "error");
  assert.match(layer.error.message, /Ammo/);
  assert.deepEqual(statuses, ["loading", "error"]);
  log.length = 0;
  layer.update(1 / 60);
  assert.deepEqual(log, []);
});

test("disabling while the build is still loading keeps it idle", async () => {
  const { layer, log, release } = harness({ deferred: true });
  const enabling = layer.setEnabled(true);
  assert.equal(layer.status, "loading");
  await layer.setEnabled(false);
  await release();
  await enabling;
  layer.update(1 / 60);
  assert.equal(layer.status, "off");
  assert.ok(!log.some(([kind]) => kind === "update" || kind === "warmup"));
});

test("when group changes overlap, only the newest build runs and older ones are disposed", async () => {
  const { layer, log, release } = harness({ deferred: true });
  const first = layer.setEnabled(true);
  const second = layer.setGroup("chest", true);
  await release();
  await release();
  await Promise.all([first, second]);
  log.length = 0;
  layer.update(0.01);
  assert.deepEqual(log, [["update", 1, 0.01]]);
  assert.equal(layer.status, "on");
});

test("physicsStep turns a rate into MMDPhysics' unitStep and keeps ~46 ms of catch-up", () => {
  assert.deepEqual([PHYSICS_RATE_MIN, PHYSICS_RATE_MAX, PHYSICS_RATE_DEFAULT], [65, 120, 120]);
  assert.deepEqual(physicsStep(65), { rate: 65, unitStep: 1 / 65, maxStepNum: 3 });
  assert.deepEqual(physicsStep(120), { rate: 120, unitStep: 1 / 120, maxStepNum: 6 });
  assert.equal(physicsStep(90).maxStepNum, 5);
});

test("physicsStep clamps to 65–120 and falls back to the default for nonsense", () => {
  assert.equal(physicsStep(30).rate, 65);
  assert.equal(physicsStep(500).rate, 120);
  for (const bad of [Number.NaN, undefined, "fast"]) assert.equal(physicsStep(bad).rate, PHYSICS_RATE_DEFAULT);
  assert.equal(physicsStep("100").rate, 100);
});

test("a new build gets the step rate before it warms up", async () => {
  const { layer, log } = harness({ steps: true });
  await layer.setEnabled(true);
  assert.deepEqual(log, [["build", 0], ["step", 0, 120, 6], ["reset", 0], ["warmup", 0, PHYSICS_WARMUP_CYCLES]]);
});

test("changing the rate while on applies at once, without a rebuild", async () => {
  const { layer, log, builds } = harness({ steps: true });
  await layer.setEnabled(true);
  log.length = 0;
  layer.setStepRate(65);
  assert.equal(layer.stepRate, 65);
  assert.deepEqual(log, [["step", 0, 65, 3]]);
  assert.equal(builds.length, 1);
});

test("a rate set while off, or before the first build, is used when physics starts", async () => {
  const { layer, log } = harness({ steps: true });
  layer.setStepRate(100);
  assert.deepEqual(log, []);
  await layer.setEnabled(true);
  assert.deepEqual(log.find(([kind]) => kind === "step"), ["step", 0, 100, 5]);
  await layer.setGroup("chest", true);
  assert.deepEqual(log.filter(([kind]) => kind === "step").at(-1), ["step", 1, 100, 5], "rebuilds keep it");
});
