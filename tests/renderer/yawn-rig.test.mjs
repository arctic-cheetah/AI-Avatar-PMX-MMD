// Run with: node --test tests/renderer/*.test.mjs
// The hand under her chin while she yawns (#270): a cached arm pose, solved
// like the thinking chin rest, and how it shares the arms with that pose.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { THINKING_ARM, buildThinkingRig } from "../../renderer/thinking-rig.js";
import { YAWN_ARM, armLayerWeights, blendArmLayers, buildYawnRig } from "../../renderer/yawn-rig.js";
import { bustDepth, fixture } from "./arm-fixture.mjs";

const worldPosition = (object) => object.getWorldPosition(new THREE.Vector3());

function snapshot(mesh) {
  const state = new Map();
  mesh.traverse((object) => state.set(object, [object.quaternion.toArray(), object.matrixWorld.toArray()]));
  return state;
}

function applyPose(mesh, entries, weight) {
  for (const { bone, rest, posed } of entries) bone.quaternion.copy(rest).slerp(posed, weight);
  mesh.updateMatrixWorld(true);
}

test("building the yawn pose leaves the rig exactly at rest and caches the thinking rig's bones in order", () => {
  const { mesh } = fixture();
  const before = snapshot(mesh);
  const entries = buildYawnRig(mesh);
  assert.deepEqual(snapshot(mesh), before);
  assert.ok(entries.length > 0);
  assert.deepEqual(entries.map(({ bone }) => bone), buildThinkingRig(mesh).map(({ bone }) => bone),
    "same bones, same order, so the two poses blend bone by bone");
  for (const { bone, rest, posed } of entries) {
    assert.deepEqual(rest.toArray(), before.get(bone)[0]);
    assert.ok(posed.toArray().every(Number.isFinite), `${bone.name} finite`);
    assert.ok(Math.abs(posed.length() - 1) < 1e-9, `${bone.name} unit`);
  }
});

test("the yawning hand sits just below her chin, lower than the thinking chin rest", () => {
  const { mesh, get } = fixture();
  const head = worldPosition(get("頭"));
  applyPose(mesh, buildYawnRig(mesh), 1);
  const side = YAWN_ARM.side;
  const wrist = worldPosition(get(`${side}手首`));
  assert.ok(wrist.distanceTo(head.clone().add(new THREE.Vector3(...YAWN_ARM.chin))) < 1e-6, "reaches its target");
  assert.ok(wrist.y < head.y + THINKING_ARM.chin[1], "below where the thinking fist props the chin");
  assert.ok(wrist.y > head.y - 2.2, "still up at her chin, not at her chest");
  assert.ok(wrist.z > head.z + 1, "in front of her face, not inside it");
  assert.ok(worldPosition(get(`${side}ひじ`)).y < wrist.y, "the elbow hangs below the hand");
});

test("only the yawning arm moves; the other stays at rest", () => {
  const { mesh } = fixture();
  const other = YAWN_ARM.side === "右" ? "左" : "右";
  for (const { bone, rest, posed } of buildYawnRig(mesh)) {
    if (bone.name.startsWith(other)) assert.ok(rest.angleTo(posed) < 1e-9, `${bone.name} stays put`);
  }
  for (const side of ["右", "左"]) {
    const moved = buildYawnRig(mesh, { side }).filter(({ rest, posed }) => rest.angleTo(posed) > 1e-6);
    assert.ok(moved.length > 0 && moved.every(({ bone }) => bone.name.startsWith(side)), `side ${side}`);
  }
});

test("the yawning forearm keeps clear of the bust (#217)", () => {
  for (const side of ["右", "左"]) {
    const { mesh, get } = fixture();
    applyPose(mesh, buildYawnRig(mesh, side === "左" ? { side, chin: [-YAWN_ARM.chin[0], ...YAWN_ARM.chin.slice(1)] } : {}), 1);
    const elbow = worldPosition(get(`${side}ひじ`));
    const wrist = worldPosition(get(`${side}手首`));
    for (let step = 0; step <= 20; step += 1) {
      const depth = bustDepth(elbow.clone().lerp(wrist, step / 20));
      assert.ok(depth <= 0, `${side} forearm at ${step * 5}% sinks ${depth.toFixed(3)} into the bust`);
    }
  }
});

test("the yawning hand's fingers curl loosely, less than the thinking fist", () => {
  const { mesh } = fixture();
  const yawn = buildYawnRig(mesh);
  const think = buildThinkingRig(mesh);
  const tip = `${YAWN_ARM.side}人指３`;
  const angle = (entries) => {
    const { rest, posed } = entries.find(({ bone }) => bone.name === tip);
    return rest.angleTo(posed);
  };
  assert.ok(angle(yawn) > 0.1, "curled a little");
  assert.ok(angle(yawn) < angle(think), "looser than the fist");
});

test("missing bones are safe and a missing head gives no pose", () => {
  for (const missing of ["右腕", "右ひじ", "右手首", "右中指１"]) {
    const { mesh } = fixture();
    mesh.skeleton = new THREE.Skeleton(mesh.skeleton.bones.filter((bone) => bone.name !== missing));
    const before = snapshot(mesh);
    const entries = buildYawnRig(mesh);
    assert.deepEqual(snapshot(mesh), before, missing);
    applyPose(mesh, entries, 1);
    mesh.traverse((object) => assert.ok(object.matrixWorld.toArray().every(Number.isFinite), missing));
  }
  const { mesh } = fixture();
  mesh.skeleton = new THREE.Skeleton(mesh.skeleton.bones.filter((bone) => bone.name !== "頭"));
  assert.deepEqual(buildYawnRig(mesh), []);
});

test("the thinking pose wins the arms; the yawn, drift and head gaze share what is left", () => {
  assert.deepEqual(armLayerWeights(0, 0), { thinking: 0, yawn: 0, drift: 1, headGaze: 0 });
  assert.deepEqual(armLayerWeights(0, 1), { thinking: 0, yawn: 1, drift: 0, headGaze: 1 });
  assert.deepEqual(armLayerWeights(1, 1), { thinking: 1, yawn: 0, drift: 0, headGaze: 1 });
  const half = armLayerWeights(0.5, 0.5);
  assert.equal(half.yawn, 0.25);
  assert.equal(half.drift, 0.25);
  assert.equal(half.headGaze, 0.5);
  for (const bad of [Number.NaN, -1, 2, undefined]) {
    const weights = armLayerWeights(bad, bad);
    assert.ok(Object.values(weights).every((value) => value >= 0 && value <= 1), `clamped for ${bad}`);
  }
});

test("blending the layers releases exactly to rest and reaches each pose at full weight", () => {
  const { mesh } = fixture();
  const before = snapshot(mesh);
  const thinking = buildThinkingRig(mesh);
  const yawn = buildYawnRig(mesh);
  for (const [t, y] of [[0, 1], [1, 0], [0.4, 0.7], [0, 0]]) {
    blendArmLayers(thinking, yawn, armLayerWeights(t, y));
    mesh.updateMatrixWorld(true);
    if (t === 0 && y === 1) yawn.forEach(({ bone, posed }) => assert.ok(bone.quaternion.angleTo(posed) < 1e-6, bone.name));
    if (t === 1) thinking.forEach(({ bone, posed }) => assert.ok(bone.quaternion.angleTo(posed) < 1e-6, bone.name));
  }
  assert.deepEqual(snapshot(mesh), before, "no rotation left behind");
  blendArmLayers(thinking, [], armLayerWeights(0.3, 1));
  thinking.forEach(({ bone, rest, posed }) => assert.ok(Math.abs(bone.quaternion.angleTo(rest) - 0.3 * rest.angleTo(posed)) < 1e-6,
    "without a yawn rig the thinking pose blends as before"));
});
