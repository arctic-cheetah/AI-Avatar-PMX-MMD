// Run with: node --test tests/renderer/*.test.mjs
// Relaxed rest pose (#199): after restArms() lowers the upper arms, the elbows
// bend a little forward, the wrists tip toward the palm and the fingers curl
// softly, so she does not stand with straight arms and flat hands. The arms
// then swing back from the shoulder until the hands hang in line with the legs
// (the user: bent forearms alone looked like picking something up).
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

/** Where a hand hangs: halfway between the wrist and the middle finger's base, in the mesh's frame. */
function handCentre(mesh, get, side) {
  return mesh.worldToLocal(at(get(`${side}手首`)).lerp(at(get(`${side}中指１`)), 0.5));
}

/** The leg line's depth (mesh-frame z) at a height: between the hip joint and the knee. */
function legDepth(mesh, get, side, y) {
  const hip = mesh.worldToLocal(at(get(`${side}足`)));
  const knee = mesh.worldToLocal(at(get(`${side}ひざ`)));
  return hip.z + ((y - hip.y) / (knee.y - hip.y)) * (knee.z - hip.z);
}

/** The angle the elbow is bent: between the upper arm and the forearm. */
function elbowBend(mesh, get, side) {
  return localDirection(mesh, get(`${side}腕`), get(`${side}ひじ`))
    .angleTo(localDirection(mesh, get(`${side}ひじ`), get(`${side}手首`)));
}

/** Sizes that leave the upper arms' swing alone, to test one part at a time. */
const NO_SWING = { handForward: null };

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
  assert.ok(Math.abs(RELAXED_REST.handForward) <= 0.5, "hands near the leg line");
  const scale = RELAXED_REST.digits;
  assert.ok(scale["親指"] < scale["人指"], "the thumb curls least");
  assert.ok(scale["人指"] <= scale["中指"] && scale["中指"] <= scale["薬指"] && scale["薬指"] <= scale["小指"],
    "more curl toward the pinky");
});

test("the shoulders and twist bones are left as restArms() set them", () => {
  const { mesh, get } = fixture();
  const before = snapshot(mesh);
  const shoulders = Object.fromEntries(SIDES.map((side) => [side, at(get(`${side}腕`))]));
  relaxArms(mesh);
  for (const side of SIDES) {
    for (const name of ["肩", "腕捩"]) {
      assert.deepEqual(get(side + name).quaternion.toArray(), before.get(get(side + name)), side + name);
    }
    close(at(get(`${side}腕`)).distanceTo(shoulders[side]), 0, `${side} shoulder joint stays put`);
  }
});

test("the elbows turn the forearms forward by the elbow angle, keeping the arm lengths", () => {
  const { mesh, get } = fixture();
  const forearms = Object.fromEntries(SIDES.map((side) => [side, localDirection(mesh, get(`${side}ひじ`), get(`${side}手首`))]));
  relaxArms(mesh, { ...RELAXED_REST, ...NO_SWING });
  for (const side of SIDES) {
    const after = localDirection(mesh, get(`${side}ひじ`), get(`${side}手首`));
    close(after.angleTo(forearms[side]), RELAXED_REST.elbow, `${side} forearm turns by the elbow angle`);
    assert.ok(after.z > forearms[side].z, `${side} forearm comes forward`);
  }
  relaxArms(mesh);
  for (const side of SIDES) {
    close(at(get(`${side}腕`)).distanceTo(at(get(`${side}ひじ`))), UPPER_LENGTH, `${side} upper length`);
    close(at(get(`${side}ひじ`)).distanceTo(at(get(`${side}手首`))), LOWER_LENGTH, `${side} forearm length`);
  }
});

test("the arms swing back from the shoulder until the hands hang in line with the legs", () => {
  for (const handForward of [RELAXED_REST.handForward, 0.3]) {
    const unswung = fixture();
    relaxArms(unswung.mesh, { ...RELAXED_REST, ...NO_SWING });
    const bends = Object.fromEntries(SIDES.map((side) => [side, elbowBend(unswung.mesh, unswung.get, side)]));
    const { mesh, get } = fixture();
    const sideways = Object.fromEntries(SIDES.map((side) => [side, localDirection(mesh, get(`${side}腕`), get(`${side}ひじ`)).x]));
    relaxArms(mesh, { ...RELAXED_REST, handForward });
    for (const side of SIDES) {
      const hand = handCentre(mesh, get, side);
      close(hand.z, legDepth(mesh, get, side, hand.y) + handForward, `${side} hand ${handForward} ahead of the leg line`);
      // A swing about her side-to-side axis: the arm keeps how far out it hangs.
      close(localDirection(mesh, get(`${side}腕`), get(`${side}ひじ`)).x, sideways[side], `${side} arm keeps its sideways hang`);
      close(elbowBend(mesh, get, side), bends[side], `${side} elbow bend kept through the swing`);
    }
  }
});

test("without leg bones the arms are not swung", () => {
  const { mesh, get } = fixture({ legs: false });
  const before = snapshot(mesh);
  relaxArms(mesh);
  for (const side of SIDES) {
    assert.deepEqual(get(`${side}腕`).quaternion.toArray(), before.get(get(`${side}腕`)), `${side}腕 unchanged`);
  }
});

test("the wrists tip the hands toward the palm by the wrist angle", () => {
  const straight = fixture();
  relaxArms(straight.mesh, { ...RELAXED_REST, ...NO_SWING, wrist: 0, curl: 0 });
  const relaxed = fixture();
  relaxArms(relaxed.mesh, { ...RELAXED_REST, ...NO_SWING, curl: 0 });
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
  relaxArms(mesh, { ...RELAXED_REST, ...NO_SWING, elbow: 0, wrist: 0 });
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
  const { mesh, get } = fixture({ fingers: false, legs: false });
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
  relaxArms(mesh, { ...RELAXED_REST, ...NO_SWING, elbow: 0, wrist: 0, curl: 0 });
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
