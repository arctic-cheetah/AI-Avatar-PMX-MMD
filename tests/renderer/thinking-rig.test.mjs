import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildThinkingRig, elbowForTarget } from "../../renderer/thinking-rig.js";

const UPPER_LENGTH = 2.96;
const LOWER_LENGTH = 2.71;
const TOLERANCE = 1e-7;
const DIGITS = ["親指", "人指", "中指", "薬指", "小指"];
const JOINTS = ["１", "２", "３"];

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

function fixture({ fingers = true } = {}) {
  const mesh = new THREE.Object3D();
  mesh.rotation.set(0.12, -0.19, 0.08);
  const bones = [];
  function atWorld(parent, name, position, rotation = new THREE.Euler()) {
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    parent.updateWorldMatrix(true, false);
    bone.position.copy(parent.worldToLocal(position.clone()));
    bone.quaternion.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
      .multiply(new THREE.Quaternion().setFromEuler(rotation));
    bones.push(bone);
    mesh.updateMatrixWorld(true);
    return bone;
  }
  const torso = atWorld(mesh, "上半身", new THREE.Vector3(0, 15.4, -0.55),
    new THREE.Euler(-0.09, 0.16, -0.11));
  atWorld(torso, "頭", new THREE.Vector3(0, 19.27, -0.55));
  for (const [side, sign] of [["右", -1], ["左", 1]]) {
    const shoulderPosition = new THREE.Vector3(sign * 1.32, 17.76, -0.57);
    const upperDirection = new THREE.Vector3(sign * 0.22, -0.94, 0.26).normalize();
    const lowerDirection = new THREE.Vector3(sign * 0.12, -0.98, 0.14).normalize();
    const elbowPosition = shoulderPosition.clone().addScaledVector(upperDirection, UPPER_LENGTH);
    const wristPosition = elbowPosition.clone().addScaledVector(lowerDirection, LOWER_LENGTH);
    const shoulder = atWorld(torso, `${side}肩`, shoulderPosition,
      new THREE.Euler(0.13, sign * 0.21, sign * -0.17));
    const arm = atWorld(shoulder, `${side}腕`, shoulderPosition,
      new THREE.Euler(-0.14, sign * 0.18, sign * 0.24));
    const upperTwist = atWorld(arm, `${side}腕捩`, shoulderPosition.clone().lerp(elbowPosition, 0.45),
      new THREE.Euler(0.11, sign * -0.16, sign * 0.09));
    const elbow = atWorld(upperTwist, `${side}ひじ`, elbowPosition,
      new THREE.Euler(0.08, sign * 0.15, sign * -0.12));
    const lowerTwist = atWorld(elbow, `${side}手捩`, elbowPosition.clone().lerp(wristPosition, 0.55),
      new THREE.Euler(-0.1, sign * 0.13, sign * 0.19));
    const wrist = atWorld(lowerTwist, `${side}手首`, wristPosition);
    const handRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), lowerDirection);
    wrist.quaternion.copy(lowerTwist.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(handRotation);
    if (!fingers) continue;
    for (const [digitIndex, digit] of DIGITS.entries()) {
      let parent = wrist;
      if (digit === "親指") {
        parent = new THREE.Bone();
        parent.name = `${side}${digit}０`;
        parent.position.set(sign * 0.42, 0.2, 0.06);
        wrist.add(parent);
        bones.push(parent);
      }
      for (const [jointIndex, joint] of JOINTS.entries()) {
        const bone = new THREE.Bone();
        bone.name = `${side}${digit}${joint}`;
        if (jointIndex === 0) {
          bone.position.set(sign * (digitIndex - 2) * 0.2, 0.5 + (digitIndex === 2 ? 0.1 : 0), 0);
        } else {
          bone.position.set(0, jointIndex === 1 ? 0.32 : 0.24, 0);
        }
        bone.rotation.set(0.025, 0, sign * 0.015);
        parent.add(bone);
        bones.push(bone);
        parent = bone;
      }
      const tip = new THREE.Object3D();
      tip.name = `${side}${digit}先`;
      tip.position.set(0, 0.18, 0);
      parent.add(tip);
    }
  }
  mesh.skeleton = new THREE.Skeleton(bones);
  mesh.updateMatrixWorld(true);
  return { mesh, get: (name) => mesh.skeleton.getBoneByName(name) };
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
  vectorClose(worldPosition(get("右手首")), head.clone().add(new THREE.Vector3(-0.35, -1.5, 2.05)), "chin wrist target");
  const elbow = worldPosition(get("右ひじ"));
  assert.ok(elbow.y < worldPosition(get("右手首")).y, "right elbow hangs below the wrist");
  vectorClose(worldPosition(get("左手首")), elbow.clone().add(new THREE.Vector3(0.45, -0.3, 0.85)), "support wrist target");
  for (const side of ["右", "左"]) {
    close(worldPosition(get(`${side}腕`)).distanceTo(worldPosition(get(`${side}ひじ`))), UPPER_LENGTH, "posed upper length");
    close(worldPosition(get(`${side}ひじ`)).distanceTo(worldPosition(get(`${side}手首`))), LOWER_LENGTH, "posed lower length");
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
