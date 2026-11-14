// Relaxed rest pose (#199). restArms() in main.js lowers the upper arms out of
// the T-pose; relaxArms() then bends the elbows a little forward, tips the
// hands toward the palm and curls the fingers softly. Every turn is about a
// world-space axis, so the PMX's local bone axes and twist bones do not
// matter. See docs/rest-pose.md.

import * as THREE from "three";
import { THUMB_CURL, curlFingers, handFrame } from "./thinking-rig.js";

const DEG = Math.PI / 180;

/** Default sizes in radians; `digits` scales the curl per finger, more toward the pinky. */
export const RELAXED_REST = Object.freeze({
  elbow: 12 * DEG,
  wrist: 6 * DEG,
  curl: 15 * DEG,
  digits: Object.freeze({ "親指": THUMB_CURL, "人指": 0.8, "中指": 0.9, "薬指": 1, "小指": 1.1 }),
});

/** Turn a bone about a world axis through its own origin. */
function turnWorld(bone, axis, angle) {
  bone.updateWorldMatrix(true, false);
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(parent.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).multiply(world));
  bone.updateWorldMatrix(false, true);
}

/** Turn `bone` so `direction` moves toward `toward` by `angle`; nothing if they are parallel. */
function turnToward(bone, direction, toward, angle) {
  const axis = new THREE.Vector3().crossVectors(direction, toward);
  if (axis.lengthSq() < 1e-12) return;
  turnWorld(bone, axis.normalize(), angle);
}

const at = (bone) => bone.getWorldPosition(new THREE.Vector3());

/**
 * Relax both arms below the shoulder. Run once, right after the upper arms are lowered.
 * Missing bones are skipped: without finger bones the wrist stays as it is.
 * @param {THREE.Object3D & { skeleton?: THREE.Skeleton }} mesh The loaded PMX mesh.
 * @param {Partial<typeof RELAXED_REST>} [sizes] Radians; missing entries use RELAXED_REST.
 * @returns {void}
 */
export function relaxArms(mesh, sizes = RELAXED_REST) {
  const { elbow, wrist, curl, digits } = { ...RELAXED_REST, ...sizes };
  const get = (name) => mesh.skeleton?.getBoneByName(name);
  mesh.updateMatrixWorld(true);
  // Her front is the mesh's +z.
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
  for (const side of ["右", "左"]) {
    const elbowBone = get(`${side}ひじ`);
    const wristBone = get(`${side}手首`);
    if (!elbowBone || !wristBone) continue;
    if (elbow) turnToward(elbowBone, at(wristBone).sub(at(elbowBone)).normalize(), front, elbow);
    if (wrist) {
      const frame = handFrame(mesh, side);
      if (frame) turnToward(wristBone, frame.finger, frame.palm, wrist);
    }
    if (curl) {
      const frame = handFrame(mesh, side);
      if (frame) curlFingers(mesh, side, frame.palm, (digit) => curl * (digits[digit] ?? 1));
      wristBone.updateWorldMatrix(false, true);
    }
  }
  mesh.updateMatrixWorld(true);
}
