import * as THREE from "three";

const EPSILON = 1e-6;

/** Place an elbow on the intersection of the upper/lower-arm reach spheres. */
export function elbowForTarget(shoulder, wrist, upperLength, lowerLength, bendHint) {
  const direction = wrist.clone().sub(shoulder);
  const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(upperLength - lowerLength) + EPSILON,
    upperLength + lowerLength - EPSILON);
  if (direction.lengthSq() < EPSILON ** 2) direction.set(0, 0, 1);
  else direction.normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const bend = bendHint.clone().addScaledVector(direction, -bendHint.dot(direction));
  if (bend.lengthSq() < EPSILON ** 2) {
    bend.set(Math.abs(direction.x) < 0.9 ? 1 : 0, Math.abs(direction.x) < 0.9 ? 0 : 1, 0);
    bend.addScaledVector(direction, -bend.dot(direction));
  }
  bend.normalize();
  return shoulder.clone().addScaledVector(direction, along).addScaledVector(bend, height);
}

function pointBone(bone, endpoint, target) {
  bone.updateWorldMatrix(true, true);
  const origin = bone.getWorldPosition(new THREE.Vector3());
  const from = endpoint.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const to = target.clone().sub(origin).normalize();
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const delta = new THREE.Quaternion().setFromUnitVectors(from, to);
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(parent.multiply(delta).multiply(world));
  bone.updateWorldMatrix(false, true);
}

/**
 * Point one arm's upper arm and forearm so its wrist reaches a world target.
 * @param {THREE.Object3D} mesh
 * @param {"右"|"左"} side
 * @param {THREE.Vector3} target World wrist target.
 * @param {THREE.Vector3} bendHint Which way the elbow bends.
 * @returns {{ elbow: THREE.Bone, wrist: THREE.Bone } | null} null when a bone is missing.
 */
export function poseArm(mesh, side, target, bendHint) {
  const get = (suffix) => mesh.skeleton.getBoneByName(side + suffix);
  const arm = get("腕"), elbow = get("ひじ"), wrist = get("手首");
  if (!arm || !elbow || !wrist) return null;
  mesh.updateMatrixWorld(true);
  const shoulderPosition = arm.getWorldPosition(new THREE.Vector3());
  const elbowPosition = elbow.getWorldPosition(new THREE.Vector3());
  const wristPosition = wrist.getWorldPosition(new THREE.Vector3());
  const solved = elbowForTarget(shoulderPosition, target, shoulderPosition.distanceTo(elbowPosition),
    elbowPosition.distanceTo(wristPosition), bendHint);
  pointBone(arm, elbow, solved);
  pointBone(elbow, wrist, target);
  return { elbow, wrist };
}

/**
 * The hand's world frame: the wrist-to-middle-finger direction and the palm
 * normal (pointing out of the palm on both sides).
 * @returns {{ finger: THREE.Vector3, palm: THREE.Vector3 } | null} null when a bone is missing.
 */
export function handFrame(mesh, side) {
  const get = (suffix) => mesh.skeleton?.getBoneByName(side + suffix);
  const wrist = get("手首"), middle = get("中指１"), index = get("人指１"), little = get("小指１");
  if (!wrist || !middle || !index || !little) return null;
  wrist.updateWorldMatrix(true, true);
  const origin = wrist.getWorldPosition(new THREE.Vector3());
  const finger = middle.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const across = index.getWorldPosition(new THREE.Vector3()).sub(little.getWorldPosition(new THREE.Vector3())).normalize();
  const palm = new THREE.Vector3().crossVectors(across, finger).normalize();
  if (side === "左") palm.negate();
  return { finger, palm };
}

/**
 * Curl every finger joint of one hand toward a palm normal, by an angle per finger.
 * Axes are captured before any joint bends, so each joint curls relative to the palm.
 * @param {THREE.Object3D} mesh
 * @param {"右"|"左"} side
 * @param {THREE.Vector3} palmWorld Palm normal in world space.
 * @param {(digit: string) => number} angleFor Radians per joint for 親指, 人指, 中指, 薬指 or 小指.
 * @returns {void}
 */
export function curlFingers(mesh, side, palmWorld, angleFor) {
  const pattern = new RegExp(`^${side}(親指|人指|中指|薬指|小指)[１２３]$`);
  const curls = (mesh.skeleton?.bones ?? []).filter((bone) => pattern.test(bone.name)).map((bone) => {
    bone.updateWorldMatrix(true, false);
    const child = bone.children.find((entry) => entry.isBone);
    const localDirection = (child?.position ?? bone.position).clone().normalize();
    const palmLocal = palmWorld.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert());
    return { bone, angle: angleFor(pattern.exec(bone.name)[1]), axis: new THREE.Vector3().crossVectors(localDirection, palmLocal).normalize() };
  });
  for (const { bone, axis, angle } of curls) {
    if (angle) bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
  }
}

/** The thumb curls this much of the other fingers' angle. */
export const THUMB_CURL = 0.45;

/**
 * Turn one hand so its fingers point along `forward` with the palm facing
 * `normal` (world space), then curl the fingers by `curlAmount` radians.
 * @returns {void}
 */
export function poseHand(mesh, side, forward, normal, curlAmount) {
  const wrist = mesh.skeleton.getBoneByName(`${side}手首`);
  const frame = handFrame(mesh, side);
  if (!frame) return;
  const { finger, palm } = frame;
  const basis = (y, z) => {
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    z = new THREE.Vector3().crossVectors(x, y).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  };
  const rotation = basis(forward.clone().normalize(), normal.clone().normalize())
    .multiply(basis(finger, palm).invert());
  const world = wrist.getWorldQuaternion(new THREE.Quaternion());
  wrist.quaternion.copy(wrist.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation).multiply(world));
  wrist.updateWorldMatrix(false, true);
  curlFingers(mesh, side, normal.clone().normalize(), (digit) => (digit === "親指" ? curlAmount * THUMB_CURL : curlAmount));
  wrist.updateWorldMatrix(false, true);
}

/**
 * Arm targets for the chin-rest pose, in model units relative to a bone.
 * - chin: right wrist target, from the head bone.
 * - elbowBend: which way the right elbow bends.
 * - support: left wrist target, from the posed right elbow.
 * - supportBend: which way the left elbow bends.
 * - fist: the right hand's finger direction, in world space.
 * - fistPalm: the right palm normal, in world space.
 * Picked with the user from comparison grids; see docs/thinking-pose.md (#217).
 */
export const THINKING_ARM = Object.freeze({
  // The fist sits under the right side of the chin, so it props the chin up without covering the face.
  chin: Object.freeze([-0.85, -0.75, 1.8]),
  // 30° out from straight down with a little forward bias: tucked in, with the forearm bone clear of the bust.
  elbowBend: Object.freeze([-0.5, -0.866, 0.8]),
  // The left hand cups the right elbow from below, against the puffy sleeve.
  support: Object.freeze([0.5, -0.6, 0.1]),
  // The left elbow lifts up and out, so her shoulders look balanced; only the cuff presses in (#221).
  supportBend: Object.freeze([1, -0.3, 0.3]),
  // Fingers tilted 50° back, so the fist is short enough to fit under the chin.
  fist: Object.freeze([0.15, 0.643, -0.766]),
  fistPalm: Object.freeze([0, -0.766, -0.643]),
});

/** Both arms' bones a cached arm pose rewrites: arm, elbow, wrist and finger joints. */
const ARM_POSE_BONE = /^(?:右|左)(?:腕$|ひじ$|手首$|(?:親指|人指|中指|薬指|小指)[０１２３]$)/;

/**
 * The bones a cached arm pose owns, in skeleton order, so two poses line up bone by bone.
 * @param {THREE.Object3D} mesh
 * @returns {THREE.Bone[]}
 */
export function armPoseBones(mesh) {
  return (mesh.skeleton?.bones ?? []).filter((bone) => ARM_POSE_BONE.test(bone.name));
}

/**
 * Build a chin-rest pose, retaining exact rest rotations for release.
 * @param {THREE.Object3D} mesh
 * @param {Partial<typeof THINKING_ARM>} [arm] Overrides for the arm targets, for previews.
 */
export function buildThinkingRig(mesh, arm = {}) {
  const { chin, elbowBend, support, supportBend, fist, fistPalm } = { ...THINKING_ARM, ...arm };
  const head = mesh.skeleton?.getBoneByName("頭");
  if (!head) return [];
  const entries = armPoseBones(mesh).map((bone) => ({ bone, rest: bone.quaternion.clone(), posed: bone.quaternion.clone() }));
  try {
    mesh.updateMatrixWorld(true);
    // Leave space in front of the jaw and outfit for the curled fingers and gloves.
    const chinWrist = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...chin));
    const right = poseArm(mesh, "右", chinWrist, new THREE.Vector3(...elbowBend));
    if (right) {
      poseHand(mesh, "右", new THREE.Vector3(...fist), new THREE.Vector3(...fistPalm), 0.8);
      const supportWrist = right.elbow.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...support));
      const left = poseArm(mesh, "左", supportWrist, new THREE.Vector3(...supportBend));
      if (left) poseHand(mesh, "左", new THREE.Vector3(-1, 0.1, 0), new THREE.Vector3(0, 1, -0.2), 0.45);
    }
    for (const entry of entries) entry.posed.copy(entry.bone.quaternion);
    return entries;
  } finally {
    for (const entry of entries) entry.bone.quaternion.copy(entry.rest);
    mesh.updateMatrixWorld(true);
  }
}
