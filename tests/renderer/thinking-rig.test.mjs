import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { THINKING_ARM, buildThinkingRig, elbowForTarget } from "../../renderer/thinking-rig.js";
import { DIGITS, JOINTS, LOWER_LENGTH, UPPER_LENGTH, bustDepth, fixture } from "./arm-fixture.mjs";

const TOLERANCE = 1e-7;

function close(actual, expected, message, tolerance = TOLERANCE) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function vectorClose(actual, expected, message) {
  close(actual.distanceTo(expected), 0, message);
}

function finite(values, message) {
  assert.ok(values.every(Number.isFinite), message);
}

function worldPosition(object) {
  return object.getWorldPosition(new THREE.Vector3());
}

function snapshot(mesh) {
  const state = new Map();
  mesh.traverse((object) => state.set(object, {
    quaternion: object.quaternion.toArray(),
    matrix: object.matrix.toArray(),
    matrixWorld: object.matrixWorld.toArray(),
  }));
  return state;
}

function assertSnapshot(mesh, expected) {
  assert.deepEqual(snapshot(mesh), expected);
}

function applyPose(mesh, entries, weight) {
  for (const { bone, rest, posed } of entries) bone.quaternion.copy(rest).slerp(posed, weight);
  mesh.updateMatrixWorld(true);
}

test("analytic elbow preserves both segment lengths and bends down for reachable targets", () => {
  const shoulder = new THREE.Vector3(-1.32, 17.76, -0.57);
  const hint = new THREE.Vector3(0, -1, 0);
  const targets = [
    shoulder.clone().add(new THREE.Vector3(3.4, 0, 1.2)),
    shoulder.clone().add(new THREE.Vector3(-3.4, 0, -1.2)),
    new THREE.Vector3(-0.35, 18.22, 0.85),
  ];
  for (const wrist of targets) {
    const before = [shoulder.toArray(), wrist.toArray(), hint.toArray()];
    const elbow = elbowForTarget(shoulder, wrist, UPPER_LENGTH, LOWER_LENGTH, hint);
    close(elbow.distanceTo(shoulder), UPPER_LENGTH, "upper arm length");
    close(elbow.distanceTo(wrist), LOWER_LENGTH, "forearm length");
    assert.ok(elbow.y < Math.min(shoulder.y, wrist.y), "elbow should be below shoulder and wrist");
    assert.deepEqual([shoulder.toArray(), wrist.toArray(), hint.toArray()], before, "inputs are not mutated");
  }
});

test("degenerate hints, coincident targets and unreachable targets produce finite elbows", () => {
  const shoulder = new THREE.Vector3(0.4, 17.76, -0.57);
  const cases = [
    { offset: [2, 0, 0], hint: [1, 0, 0] },
    { offset: [0, 0, 2], hint: [0, 0, 1] },
    { offset: [0, 2, 1], hint: [0, 0, 0] },
    { offset: [0, 0, 0], hint: [0, -1, 0] },
    { offset: [0, 0, 0], hint: [0, 0, 0], lengths: [2.96, 2.96] },
    { offset: [0.01, 0, 0], hint: [0, -1, 0] },
    { offset: [30, 12, -8], hint: [0, -1, 0] },
  ];
  for (const { offset, hint, lengths = [UPPER_LENGTH, LOWER_LENGTH] } of cases) {
    const elbow = elbowForTarget(shoulder, shoulder.clone().add(new THREE.Vector3(...offset)),
      ...lengths, new THREE.Vector3(...hint));
    finite(elbow.toArray(), `finite elbow for ${JSON.stringify({ offset, hint, lengths })}`);
    close(elbow.distanceTo(shoulder), lengths[0], "upper segment remains bounded at its length");
  }
});

test("building the cache restores exact rest quaternions, local matrices and world matrices", () => {
  const { mesh, get } = fixture();
  const before = snapshot(mesh);
  const entries = buildThinkingRig(mesh);
  assert.ok(entries.length > 0);
  assert.equal(new Set(entries.map(({ bone }) => bone)).size, entries.length);
  assertSnapshot(mesh, before);
  for (const { bone, rest, posed } of entries) {
    assert.notStrictEqual(rest, bone.quaternion);
    assert.notStrictEqual(posed, bone.quaternion);
    assert.notStrictEqual(rest, posed);
    assert.deepEqual(rest.toArray(), before.get(bone).quaternion);
    finite(posed.toArray(), `${bone.name} has a finite cached rotation`);
    close(posed.length(), 1, `${bone.name} has a unit cached rotation`);
  }
  for (const side of ["右", "左"]) {
    close(worldPosition(get(`${side}腕`)).distanceTo(worldPosition(get(`${side}ひじ`))), UPPER_LENGTH, "fixture upper length");
    close(worldPosition(get(`${side}ひじ`)).distanceTo(worldPosition(get(`${side}手首`))), LOWER_LENGTH, "fixture lower length");
    assert.ok(get(`${side}ひじ`).parent.name.endsWith("腕捩"));
    assert.ok(get(`${side}手首`).parent.name.endsWith("手捩"));
    assert.ok(get(`${side}腕`).parent.quaternion.angleTo(new THREE.Quaternion()) > 0.1);
  }
  applyPose(mesh, entries, 1);
  for (const { bone, rest } of entries) assert.deepEqual(rest.toArray(), before.get(bone).quaternion);
});

test("cached pose reaches the chin and supports the lowered right elbow through rotated twist parents", () => {
  const { mesh, get } = fixture();
  const head = worldPosition(get("頭"));
  const entries = buildThinkingRig(mesh);
  applyPose(mesh, entries, 1);
  vectorClose(worldPosition(get("右手首")), head.clone().add(new THREE.Vector3(...THINKING_ARM.chin)), "chin wrist target");
  const elbow = worldPosition(get("右ひじ"));
  assert.ok(elbow.y < worldPosition(get("右手首")).y, "right elbow hangs below the wrist");
  vectorClose(worldPosition(get("左手首")), elbow.clone().add(new THREE.Vector3(...THINKING_ARM.support)), "support wrist target");
  for (const side of ["右", "左"]) {
    close(worldPosition(get(`${side}腕`)).distanceTo(worldPosition(get(`${side}ひじ`))), UPPER_LENGTH, "posed upper length");
    close(worldPosition(get(`${side}ひじ`)).distanceTo(worldPosition(get(`${side}手首`))), LOWER_LENGTH, "posed lower length");
  }
});

test("posed forearms keep clear of the bust instead of cutting through it (#217)", () => {
  const { mesh, get } = fixture();
  applyPose(mesh, buildThinkingRig(mesh), 1);
  for (const side of ["右", "左"]) {
    const elbow = worldPosition(get(`${side}ひじ`));
    const wrist = worldPosition(get(`${side}手首`));
    for (let step = 0; step <= 20; step++) {
      const point = elbow.clone().lerp(wrist, step / 20);
      const depth = bustDepth(point);
      assert.ok(depth <= 0, `${side} forearm at ${step * 5}% from the elbow sinks ${depth.toFixed(3)} into the bust `
        + `at (${point.toArray().map((value) => value.toFixed(2)).join(", ")})`);
    }
  }
});

test("cached fingers really curl at all three joints instead of discarding the hand pose", () => {
  const { mesh, get } = fixture();
  const entries = buildThinkingRig(mesh);
  applyPose(mesh, entries, 1);
  for (const side of ["右", "左"]) {
    for (const digit of DIGITS) {
      for (const joint of JOINTS) {
        const bone = get(`${side}${digit}${joint}`);
        const entry = entries.find((candidate) => candidate.bone === bone);
        assert.ok(entry, `${bone.name} is cached`);
        assert.ok(entry.rest.angleTo(entry.posed) > 0.15, `${bone.name} must retain its curl, including third joints`);
        const incoming = worldPosition(bone).sub(worldPosition(bone.parent)).normalize();
        const outgoing = worldPosition(bone.children[0]).sub(worldPosition(bone)).normalize();
        assert.ok(incoming.angleTo(outgoing) > 0.15, `${bone.name} must visibly bend its finger segment`);
      }
    }
  }
});

test("missing optional fingers or arm bones are safe and leave the available rest pose intact", () => {
  const variants = [
    { fingers: false },
    ...["右腕", "右ひじ", "右手首", "左腕", "左ひじ", "左手首", "右中指１", "左人指１", "右小指１"]
      .map((missing) => ({ missing })),
  ];
  for (const { fingers = true, missing } of variants) {
    const { mesh } = fixture({ fingers });
    if (missing) mesh.skeleton = new THREE.Skeleton(mesh.skeleton.bones.filter((bone) => bone.name !== missing));
    const before = snapshot(mesh);
    const entries = buildThinkingRig(mesh);
    assertSnapshot(mesh, before);
    applyPose(mesh, entries, 1);
    mesh.traverse((object) => {
      finite(object.quaternion.toArray(), `${missing ?? "no fingers"}: finite quaternion`);
      finite(object.matrixWorld.toArray(), `${missing ?? "no fingers"}: finite world matrix`);
    });
    applyPose(mesh, entries, 0);
    assertSnapshot(mesh, before);
  }
});

test("missing head or skeleton returns an empty cache without changing any transforms", () => {
  for (const skeleton of ["no head", "no skeleton"]) {
    const { mesh } = fixture();
    if (skeleton === "no head") {
      mesh.skeleton = new THREE.Skeleton(mesh.skeleton.bones.filter((bone) => bone.name !== "頭"));
    } else {
      delete mesh.skeleton;
    }
    const before = snapshot(mesh);
    assert.deepEqual(buildThinkingRig(mesh), []);
    assertSnapshot(mesh, before);
  }
});

test("cached interpolation is repeatable and releases exactly to rest without accumulating rotations", () => {
  const { mesh } = fixture();
  const before = snapshot(mesh);
  const entries = buildThinkingRig(mesh);
  for (const weight of [0, 0.25, 0.5, 0.75, 1, 0.5, 0.25, 0.75, 0]) {
    applyPose(mesh, entries, weight);
    for (const { bone, rest, posed } of entries) {
      close(rest.angleTo(bone.quaternion), rest.angleTo(posed) * weight, `${bone.name} interpolation`, 1e-6);
      finite(bone.matrixWorld.toArray(), `${bone.name} interpolated world matrix`);
    }
  }
  assertSnapshot(mesh, before);
  const cached = entries.map(({ rest, posed }) => [rest.toArray(), posed.toArray()]);
  applyPose(mesh, entries, 1);
  applyPose(mesh, entries, 0);
  assertSnapshot(mesh, before);
  assert.deepEqual(entries.map(({ rest, posed }) => [rest.toArray(), posed.toArray()]), cached);
});
