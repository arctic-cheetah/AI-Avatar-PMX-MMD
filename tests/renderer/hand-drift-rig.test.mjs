// Run with: node --test tests/renderer/*.test.mjs
// Hand drift rig (#199 follow-up): the bones and axes that animate her
// forearms, wrists and fingers while idle. Each entry turns one bone about an
// axis in its own frame, found from the rest pose: the forearm rolls about
// itself, the wrist tips the hand toward the palm and each finger joint curls
// toward the palm.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildHandDriftRig } from "../../renderer/hand-drift-rig.js";
import { RELAXED_REST, relaxArms } from "../../renderer/rest-pose.js";
import { DIGITS, JOINTS, fixture } from "./arm-fixture.mjs";

const SIDES = [["右", "Left"], ["左", "Right"]];
const at = (object) => object.getWorldPosition(new THREE.Vector3());

/** Every object's local quaternion, by object. */
function snapshot(mesh) {
  const state = new Map();
  mesh.traverse((object) => state.set(object, object.quaternion.toArray()));
  return state;
}

/** The palm normal in world space, as handFrame() in thinking-rig.js defines it. */
function palmNormal(get, side) {
  const wrist = at(get(`${side}手首`));
  const finger = at(get(`${side}中指１`)).sub(wrist).normalize();
  const across = at(get(`${side}人指１`)).sub(at(get(`${side}小指１`))).normalize();
  const palm = new THREE.Vector3().crossVectors(across, finger).normalize();
  return side === "左" ? palm.negate() : palm;
}

/** Turn one rig entry by `angle` on top of the bone's current rotation. */
function turn(mesh, entry, angle) {
  entry.bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(entry.axis, angle));
  mesh.updateMatrixWorld(true);
}

function relaxed() {
  const rig = fixture();
  relaxArms(rig.mesh);
  return rig;
}

test("the rig has a forearm, a wrist and fifteen finger joints per side, by screen side", () => {
  const { mesh } = relaxed();
  const entries = buildHandDriftRig(mesh);
  for (const [side, screen] of SIDES) {
    const mine = entries.filter((entry) => entry.bone.name.startsWith(side));
    assert.deepEqual(mine.filter((e) => e.channel === `forearm${screen}`).map((e) => e.bone.name), [`${side}手捩`]);
    assert.deepEqual(mine.filter((e) => e.channel === `wrist${screen}`).map((e) => e.bone.name), [`${side}手首`]);
    assert.equal(mine.filter((e) => e.channel === `curl${screen}`).length, DIGITS.length * JOINTS.length);
  }
  for (const entry of entries) {
    assert.ok(Math.abs(entry.axis.length() - 1) < 1e-9, `${entry.bone.name} has a unit axis`);
  }
});

test("building the rig leaves the skeleton exactly as it was", () => {
  const { mesh } = relaxed();
  const before = snapshot(mesh);
  buildHandDriftRig(mesh);
  assert.deepEqual(snapshot(mesh), before);
});

test("the forearm rolls about itself: the wrist stays put and the hand turns", () => {
  for (const [side] of SIDES) {
    const { mesh, get } = relaxed();
    const entry = buildHandDriftRig(mesh).find((e) => e.bone.name === `${side}手捩`);
    const wrist = at(get(`${side}手首`));
    const finger = at(get(`${side}人指１`));
    turn(mesh, entry, 0.2);
    assert.ok(at(get(`${side}手首`)).distanceTo(wrist) < 1e-9, `${side} wrist stays on the forearm's line`);
    assert.ok(at(get(`${side}人指１`)).distanceTo(finger) > 0.01, `${side} hand turns`);
  }
});

test("a positive wrist angle tips the hand toward the palm", () => {
  for (const [side] of SIDES) {
    const { mesh, get } = relaxed();
    const entry = buildHandDriftRig(mesh).find((e) => e.bone.name === `${side}手首`);
    const palm = palmNormal(get, side);
    const middle = at(get(`${side}中指１`));
    turn(mesh, entry, 0.1);
    assert.ok(at(get(`${side}中指１`)).sub(middle).dot(palm) > 0, `${side} hand tips toward the palm`);
  }
});

test("a positive curl angle curls every finger toward the palm, scaled like the rest curl", () => {
  for (const [side] of SIDES) {
    const { mesh, get } = relaxed();
    const entries = buildHandDriftRig(mesh).filter((e) => e.channel.startsWith("curl") && e.bone.name.startsWith(side));
    const palm = palmNormal(get, side);
    const tips = Object.fromEntries(DIGITS.map((digit) => [digit, at(mesh.getObjectByName(`${side}${digit}先`))]));
    for (const entry of entries) {
      const digit = DIGITS.find((name) => entry.bone.name.includes(name));
      assert.equal(entry.scale, RELAXED_REST.digits[digit], `${entry.bone.name} scale`);
      turn(mesh, entry, 0.1);
    }
    for (const digit of DIGITS) {
      const moved = at(mesh.getObjectByName(`${side}${digit}先`)).sub(tips[digit]);
      assert.ok(moved.dot(palm) > 0, `${side}${digit} tip curls toward the palm`);
    }
  }
});

test("missing bones are skipped without errors", () => {
  const { mesh } = fixture({ fingers: false, legs: false });
  const entries = buildHandDriftRig(mesh);
  assert.ok(entries.every((e) => !e.channel.startsWith("curl") && !e.channel.startsWith("wrist")),
    "no palm without fingers, so no wrist or curl entries");
  assert.ok(entries.some((e) => e.channel.startsWith("forearm")), "the forearm still rolls");
  assert.deepEqual(buildHandDriftRig(new THREE.Object3D()), []);
});
