// Relaxed rest pose (#199). restArms() in main.js lowers the upper arms out of
// the T-pose; relaxArms() then bends the elbows a little forward, tips the
// hands toward the palm and curls the fingers softly, then swings each arm
// back from the shoulder until the hand hangs in line with the leg (the user:
// bent forearms alone looked like picking something up). Every turn is about a
// world-space axis, so the PMX's local bone axes and twist bones do not
// matter. See docs/rest-pose.md.

import * as THREE from "three";
import { THUMB_CURL, curlFingers, handFrame } from "./thinking-rig.js";

const DEG = Math.PI / 180;

/**
 * Default sizes in radians, the user's pick (option C, 15 Nov 2026): a hint of
 * elbow bend, a straight wrist and the hands on the leg line, because a 12°
 * bend, 6° tip and 0.3 lead looked like carrying something. `digits` scales the
 * curl per finger, more toward the pinky. `handForward` is how far (model units)
 * each hand hangs ahead of its leg line; null leaves the arms unswung.
 */
export const RELAXED_REST = Object.freeze({
  elbow: 3 * DEG,
  wrist: 0,
  curl: 15 * DEG,
  digits: Object.freeze({ "親指": THUMB_CURL, "人指": 0.8, "中指": 0.9, "薬指": 1, "小指": 1.1 }),
  handForward: 0,
});

/** The most the arms swing to meet the legs, so an odd rig never flails. */
const SWING_LIMIT = 20 * DEG;

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
 * Swing one arm about her side-to-side axis (the mesh's x) through the
 * shoulder joint until the hand's centre is `ahead` of the hip-to-knee line,
 * at the hand's height. Solved in the mesh's y-z plane; a few passes settle
 * the hand's height, which moves with the swing.
 */
function swingToLeg(mesh, side, ahead) {
  const get = (name) => mesh.skeleton?.getBoneByName(side + name);
  const arm = get("腕"), wrist = get("手首"), middle = get("中指１"), hip = get("足"), knee = get("ひざ");
  if (!arm || !wrist || !middle || !hip || !knee) return;
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
  const local = (bone) => mesh.worldToLocal(at(bone));
  let swung = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    mesh.updateMatrixWorld(true);
    const shoulder = local(arm);
    const hand = local(wrist).lerp(local(middle), 0.5);
    const top = local(hip);
    const bottom = local(knee);
    if (Math.abs(bottom.y - top.y) < 1e-6) return;
    const target = top.z + ((hand.y - top.y) / (bottom.y - top.y)) * (bottom.z - top.z) + ahead;
    if (Math.abs(hand.z - target) < 1e-9) return;
    const y = hand.y - shoulder.y;
    const z = hand.z - shoulder.z;
    const reach = Math.hypot(y, z);
    const depth = target - shoulder.z;
    if (reach < 1e-6 || Math.abs(depth) > reach) return;
    // Turning (y, z) by φ about x gives z' = reach · sin(α + φ), α = atan2(z, y).
    // The hand hangs below the shoulder, so take the branch on that side.
    let angle = Math.PI - Math.asin(depth / reach) - Math.atan2(z, y);
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    angle = THREE.MathUtils.clamp(angle, -SWING_LIMIT - swung, SWING_LIMIT - swung);
    if (angle === 0) return;
    turnWorld(arm, across, angle);
    swung += angle;
  }
}

/**
 * Relax both arms. Run once, right after the upper arms are lowered.
 * Missing bones are skipped: without finger bones the wrist stays as it is,
 * and without leg bones the arm is not swung.
 * @param {THREE.Object3D & { skeleton?: THREE.Skeleton }} mesh The loaded PMX mesh.
 * @param {Partial<typeof RELAXED_REST>} [sizes] Radians; missing entries use RELAXED_REST.
 * @returns {void}
 */
export function relaxArms(mesh, sizes = RELAXED_REST) {
  const { elbow, wrist, curl, digits, handForward } = { ...RELAXED_REST, ...sizes };
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
    if (handForward !== null && handForward !== undefined) swingToLeg(mesh, side, handForward);
  }
  mesh.updateMatrixWorld(true);
}
