// Shoulder lift (#236): the shrugs, the stretch and the sighs roll 肩, whose
// pivot sits by the neck. The arm hangs from it, so the roll alone would swing
// the hand in or out by about a unit at 12°. counterShoulder() turns 腕 back by
// the shoulder's rotation, so the arm keeps hanging the way it did and the hand
// only rises with the shoulder joint. See docs/idle-behaviours.md.

import * as THREE from "three";

/**
 * Per shoulder bone: its arm, the shrug channel named by screen side (her
 * right shoulder is on the left of the screen, #149), and the roll sign that
 * lifts the shoulder tip (checked on the model, #236).
 */
export const SHOULDER_LIFT = Object.freeze({
  "右肩": Object.freeze({ arm: "右腕", channel: "shoulderLeft", sign: -1 }),
  "左肩": Object.freeze({ arm: "左腕", channel: "shoulderRight", sign: 1 }),
});

const between = new THREE.Quaternion();
const counter = new THREE.Quaternion();

/**
 * Undo a shoulder's rotation on its arm, after `delta` was multiplied onto
 * `shoulder`'s local rotation this frame. Bones between them (肩C) are
 * accounted for, so the arm's world rotation is what it would be without the
 * delta. The counter is premultiplied, in the arm's parent frame, so drift
 * already on the arm is kept.
 * @param {THREE.Bone} shoulder The 肩 bone.
 * @param {THREE.Bone} arm Its 腕 descendant.
 * @param {THREE.Quaternion} delta The local rotation multiplied onto the shoulder.
 * @returns {void}
 */
export function counterShoulder(shoulder, arm, delta) {
  if (delta.x === 0 && delta.y === 0 && delta.z === 0) return;
  // between = the local rotations from the shoulder's child down to the arm's parent.
  between.identity();
  for (let bone = arm.parent; bone && bone !== shoulder; bone = bone.parent) between.premultiply(bone.quaternion);
  // arm' = between⁻¹ · delta⁻¹ · between · arm
  counter.copy(between).invert().multiply(delta.clone().invert()).multiply(between);
  arm.quaternion.premultiply(counter);
}
