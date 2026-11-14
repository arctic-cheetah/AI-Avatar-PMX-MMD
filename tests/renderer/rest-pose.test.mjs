// Run with: node --test tests/renderer/*.test.mjs
// Relaxed rest pose (#199): after restArms() lowers the upper arms, the elbows
// bend a little forward, the wrists tip toward the palm and the fingers curl
// softly, so she does not stand with straight arms and flat hands.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RELAXED_REST, relaxArms } from "../../renderer/rest-pose.js";
import { buildThinkingRig } from "../../renderer/thinking-rig.js";
import { DIGITS, JOINTS, LOWER_LENGTH, UPPER_LENGTH, fixture } from "./arm-fixture.mjs";

const DEG = Math.PI / 180;
const SIDES = ["右", "左"];

const at = (bone) => bone.getWorldPosition(new THREE.Vector3());
const close = (actual, expected, message, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);

/** Every object's local quaternion, by object. */
function snapshot(mesh) {
  const state = new Map();
  mesh.traverse((object) => state.set(object, object.quaternion.toArray()));
  return state;
}

/** A direction between two bones in the mesh's own frame (+z is her front). */
function localDirection(mesh, from, to) {
  return mesh.worldToLocal(at(to)).sub(mesh.worldToLocal(at(from))).normalize();
}

/** The palm normal in world space, as poseHand() in thinking-rig.js defines it. */
function palmNormal(get, side) {
  const wrist = at(get(`${side}手首`));
  const finger = at(get(`${side}中指１`)).sub(wrist).normalize();
  const across = at(get(`${side}人指１`)).sub(at(get(`${side}小指１`))).normalize();
  const palm = new THREE.Vector3().crossVectors(across, finger).normalize();
  return side === "左" ? palm.negate() : palm;
}

test("the relaxed sizes stay gentle", () => {
  assert.ok(RELAXED_REST.elbow >= 5 * DEG && RELAXED_REST.elbow <= 20 * DEG, "elbow 5-20°");
  assert.ok(RELAXED_REST.wrist >= 0 && RELAXED_REST.wrist <= 10 * DEG, "wrist up to 10°");
  assert.ok(RELAXED_REST.curl > 0 && RELAXED_REST.curl <= 25 * DEG, "curl up to 25° per joint");
  const scale = RELAXED_REST.digits;
  assert.ok(scale["親指"] < scale["人指"], "the thumb curls least");
  assert.ok(scale["人指"] <= scale["中指"] && scale["中指"] <= scale["薬指"] && scale["薬指"] <= scale["小指"],
    "more curl toward the pinky");
});

test("the upper arms, shoulders and twist bones are left as restArms() set them", () => {
  const { mesh, get } = fixture();
  const before = snapshot(mesh);
  relaxArms(mesh);
  for (const side of SIDES) {
    for (const name of ["肩", "腕", "腕捩"]) {
      assert.deepEqual(get(side + name).quaternion.toArray(), before.get(get(side + name)), side + name);
    }
  }
});

test("the elbows bend the forearms forward by the elbow angle, keeping their lengths", () => {
  const { mesh, get } = fixture();
  const before = Object.fromEntries(SIDES.map((side) => [side, localDirection(mesh, get(`${side}ひじ`), get(`${side}手首`))]));
  const elbows = Object.fromEntries(SIDES.map((side) => [side, at(get(`${side}ひじ`))]));
  relaxArms(mesh);
  for (const side of SIDES) {
    const after = localDirection(mesh, get(`${side}ひじ`), get(`${side}手首`));
    close(after.angleTo(before[side]), RELAXED_REST.elbow, `${side} forearm turns by the elbow angle`);
    assert.ok(after.z > before[side].z, `${side} forearm comes forward`);
    close(at(get(`${side}ひじ`)).distanceTo(elbows[side]), 0, `${side} elbow stays put`);
    close(at(get(`${side}腕`)).distanceTo(at(get(`${side}ひじ`))), UPPER_LENGTH, `${side} upper length`);
    close(at(get(`${side}ひじ`)).distanceTo(at(get(`${side}手首`))), LOWER_LENGTH, `${side} forearm length`);
  }
});

test("the wrists tip the hands toward the palm by the wrist angle", () => {
  const straight = fixture();
  relaxArms(straight.mesh, { ...RELAXED_REST, wrist: 0, curl: 0 });
  const relaxed = fixture();
  relaxArms(relaxed.mesh, { ...RELAXED_REST, curl: 0 });
  for (const side of SIDES) {
    const hand = (rig) => at(rig.get(`${side}中指１`)).sub(at(rig.get(`${side}手首`))).normalize();
    const from = hand(straight);
    const to = hand(relaxed);
    close(to.angleTo(from), RELAXED_REST.wrist, `${side} hand tips by the wrist angle`);
    assert.ok(to.clone().sub(from).dot(palmNormal(straight.get, side)) > 0, `${side} hand tips toward the palm`);
  }
});

test("the fingers curl toward the palm at all three joints, more toward the pinky", () => {
  const { mesh, get } = fixture();
  const before = snapshot(mesh);
  const tips = new Map();
  mesh.traverse((object) => { if (object.name.endsWith("先")) tips.set(object.name, at(object)); });
  relaxArms(mesh, { ...RELAXED_REST, elbow: 0, wrist: 0 });
  for (const side of SIDES) {
    const palm = palmNormal(get, side);
    for (const digit of DIGITS) {
      for (const joint of JOINTS) {
        const bone = get(side + digit + joint);
        const turned = bone.quaternion.angleTo(new THREE.Quaternion().fromArray(before.get(bone)));
        close(turned, RELAXED_REST.curl * RELAXED_REST.digits[digit], `${side}${digit}${joint} curl`);
      }
      const tip = mesh.getObjectByName(`${side}${digit}先`);
      assert.ok(at(tip).sub(tips.get(tip.name)).dot(palm) > 0, `${side}${digit} tip moves toward the palm`);
    }
  }
});

test("hands without finger bones still relax the elbows and leave the wrists alone", () => {
  const { mesh, get } = fixture({ fingers: false });
  const before = snapshot(mesh);
  assert.doesNotThrow(() => relaxArms(mesh));
  for (const side of SIDES) {
    assert.ok(get(`${side}ひじ`).quaternion.angleTo(new THREE.Quaternion().fromArray(before.get(get(`${side}ひじ`)))) > 0,
      `${side} elbow bends`);
    assert.deepEqual(get(`${side}手首`).quaternion.toArray(), before.get(get(`${side}手首`)), `${side} wrist unchanged`);
  }
});

test("zero sizes leave the skeleton exactly as it was", () => {
  const { mesh } = fixture();
  const before = snapshot(mesh);
  relaxArms(mesh, { ...RELAXED_REST, elbow: 0, wrist: 0, curl: 0 });
  assert.deepEqual(snapshot(mesh), before);
});

test("a mesh without arm bones is left alone", () => {
  const empty = new THREE.Object3D();
  assert.doesNotThrow(() => relaxArms(empty));
  empty.skeleton = new THREE.Skeleton([]);
  assert.doesNotThrow(() => relaxArms(empty));
});

test("the thinking pose still reaches the chin from the relaxed rest and releases back to it", () => {
  const { mesh, get } = fixture();
  relaxArms(mesh);
  const relaxed = snapshot(mesh);
  const head = at(get("頭"));
  const entries = buildThinkingRig(mesh);
  for (const { bone, rest } of entries) assert.deepEqual(rest.toArray(), relaxed.get(bone), `${bone.name} rest`);
  for (const { bone, posed } of entries) bone.quaternion.copy(posed);
  mesh.updateMatrixWorld(true);
  close(at(get("右手首")).distanceTo(head.clone().add(new THREE.Vector3(-0.35, -1.5, 2.05))), 0, "chin wrist target", 1e-5);
  for (const { bone, rest } of entries) bone.quaternion.copy(rest);
  assert.deepEqual(snapshot(mesh), relaxed);
});
