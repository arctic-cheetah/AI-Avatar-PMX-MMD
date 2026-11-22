// Run with: node --test tests/renderer/*.test.mjs
// Shoulder lift (#236): the shrugs, the stretch and the sighs roll 肩. The arm
// hangs from it, so the roll must lift the shoulder tip, and 腕 must turn back
// so the arm keeps hanging the way it did instead of swinging into the hips.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SHOULDER_LIFT, counterShoulder } from "../../renderer/shoulder-lift.js";

const DEG = Math.PI / 180;

/**
 * A PMX-like shoulder rig: identity rest orientations as in the PMX, the
 * shoulder pivot by the neck, a 肩C cancel bone between 肩 and 腕, and an arm
 * hanging down by the hip. World positions measured on the private model.
 * @returns {{ root: THREE.Object3D, get: (name: string) => THREE.Bone }}
 */
function rig() {
  const root = new THREE.Object3D();
  const bones = {};
  const add = (parent, name, world) => {
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    parent.updateWorldMatrix(true, false);
    bone.position.copy(parent.worldToLocal(world.clone()));
    root.updateMatrixWorld(true);
    bones[name] = bone;
    return bone;
  };
  const chest = add(root, "上半身2", new THREE.Vector3(0, 16.5, -0.6));
  for (const [side, sign] of [["右", -1], ["左", 1]]) {
    const shoulderP = add(chest, `${side}肩P`, new THREE.Vector3(sign * 0.21, 18.04, -0.65));
    const shoulder = add(shoulderP, `${side}肩`, new THREE.Vector3(sign * 0.21, 18.04, -0.65));
    const cancel = add(shoulder, `${side}肩C`, new THREE.Vector3(sign * 1.29, 17.78, -0.61));
    const arm = add(cancel, `${side}腕`, new THREE.Vector3(sign * 1.29, 17.78, -0.61));
    const elbow = add(arm, `${side}ひじ`, new THREE.Vector3(sign * 2.1, 15.0, -0.4));
    add(elbow, `${side}手首`, new THREE.Vector3(sign * 2.86, 12.35, -0.18));
  }
  // A little arm drift on the upper arm, so the counter is checked on top of a non-rest pose.
  bones["右腕"].quaternion.setFromEuler(new THREE.Euler(0.03, 0.02, -0.04));
  root.updateMatrixWorld(true);
  return { root, get: (name) => bones[name] };
}

const at = (bone) => bone.getWorldPosition(new THREE.Vector3());

/** Roll a shoulder as renderer/main.js applyIdleMotion() does: a local roll, multiplied on. */
function roll(bone, angle) {
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, angle, "YXZ"));
  bone.quaternion.multiply(delta);
  return delta;
}

test("each shoulder maps to its own arm and the shrug channel named by screen side", () => {
  assert.deepEqual(Object.keys(SHOULDER_LIFT).sort(), ["右肩", "左肩"]);
  assert.equal(SHOULDER_LIFT["右肩"].arm, "右腕");
  assert.equal(SHOULDER_LIFT["左肩"].arm, "左腕");
  // Her right shoulder is on the left of the screen, as with the shrugs (#149).
  assert.equal(SHOULDER_LIFT["右肩"].channel, "shoulderLeft");
  assert.equal(SHOULDER_LIFT["左肩"].channel, "shoulderRight");
});

test("a positive lift raises the shoulder tip on both sides", () => {
  for (const [name, { sign }] of Object.entries(SHOULDER_LIFT)) {
    const { root, get } = rig();
    const side = name[0];
    const before = at(get(`${side}腕`));
    roll(get(name), sign * 12 * DEG);
    root.updateMatrixWorld(true);
    const after = at(get(`${side}腕`));
    assert.ok(after.y > before.y + 0.1, `${name}: the tip rises (${before.y.toFixed(3)} → ${after.y.toFixed(3)})`);
  }
});

test("the counter keeps the arm hanging as it did, so the hand only rises with the shoulder", () => {
  for (const [name, { sign, arm }] of Object.entries(SHOULDER_LIFT)) {
    for (const angle of [2.5, 6, 12]) {
      const { root, get } = rig();
      const side = name[0];
      const wrist = get(`${side}手首`);
      const restArm = get(arm).getWorldQuaternion(new THREE.Quaternion());
      const restWrist = at(wrist);
      const restJoint = at(get(arm));
      const delta = roll(get(name), sign * angle * DEG);
      counterShoulder(get(name), get(arm), delta);
      root.updateMatrixWorld(true);
      const turned = get(arm).getWorldQuaternion(new THREE.Quaternion()).angleTo(restArm);
      assert.ok(turned < 1e-6, `${name} ${angle}°: the upper arm keeps its world direction (${turned})`);
      // The hand moves exactly as far as the shoulder joint does: up, and never into the body.
      const moved = at(wrist).sub(restWrist);
      const jointMoved = at(get(arm)).sub(restJoint);
      assert.ok(moved.distanceTo(jointMoved) < 1e-6, `${name} ${angle}°: the hand follows the joint`);
      assert.ok(moved.y > 0, `${name} ${angle}°: the hand lifts with the shoulder`);
      assert.ok(Math.abs(at(wrist).x) >= Math.abs(restWrist.x) - 0.05, `${name} ${angle}°: the hand keeps clear of the hips`);
    }
  }
});

test("without the counter, a 12° lift swings the hand far off its line (the #236 bug)", () => {
  const { root, get } = rig();
  const wrist = get("右手首");
  const rest = at(wrist);
  roll(get("右肩"), -SHOULDER_LIFT["右肩"].sign * 12 * DEG);
  root.updateMatrixWorld(true);
  assert.ok(Math.abs(at(wrist).x) < Math.abs(rest.x) - 0.5, "the old roll swung the hand into the hips");
});

test("no lift leaves the arm exactly as it was", () => {
  const { get } = rig();
  const arm = get("右腕");
  const before = arm.quaternion.clone();
  counterShoulder(get("右肩"), arm, new THREE.Quaternion());
  assert.ok(arm.quaternion.angleTo(before) === 0, "an identity delta changes nothing");
});
