// The hand under her chin while she yawns (#270): the user's Blender pose
// (YAWN_POSE), held by the idle motion's yawnHand weight, with the fingers
// bent a little. Without that file, one arm reaches to just below the chin,
// solved once like the thinking chin rest. See docs/idle-behaviours.md#sleepy-face-and-yawn.
import * as THREE from "three";
import { THUMB_CURL, armPoseBones, curlFingers, handFrame, poseArm, poseHand } from "./thinking-rig.js";

/** The user's Blender pose for the yawn, in assets/poses/ (#270). */
export const YAWN_POSE = "yawn-v1";

/** Radians each finger joint bends toward the palm in the authored yawn pose; the thumb bends THUMB_CURL of it. */
export const YAWN_FINGER_BEND = 0.25;

const FINGER_JOINT = /^(?:右|左)(?:親指|人指|中指|薬指|小指)[０１２３]$/;

/**
 * Bend the authored pose's fingers a little toward each palm. The pose is
 * put on the rig only to measure the palms, then everything is put back.
 * @param {THREE.Object3D} mesh
 * @param {Map<THREE.Bone, THREE.Quaternion>} bind Each bone's PMX bind rotation (VPD rotations are measured from it).
 * @param {{ bones: { name: string, translation: number[], quaternion: number[] }[], morphs: object[] }} vpd From readVpd.
 * @param {number} [bend] Radians per finger joint.
 * @returns {typeof vpd} A new pose: the same bones, finger joints bent, every finger joint listed.
 */
export function bendYawnFingers(mesh, bind, vpd, bend = YAWN_FINGER_BEND) {
  const bones = mesh.skeleton?.bones ?? [];
  const saved = bones.map((bone) => bone.quaternion.clone());
  const byName = new Map(vpd.bones.map((entry) => [entry.name, entry]));
  try {
    for (const bone of bones) {
      const entry = byName.get(bone.name);
      bone.quaternion.copy(bind.get(bone) ?? bone.quaternion);
      if (entry) bone.quaternion.multiply(new THREE.Quaternion().fromArray(entry.quaternion).normalize());
    }
    mesh.updateMatrixWorld(true);
    for (const side of ["右", "左"]) {
      const frame = handFrame(mesh, side);
      if (frame) curlFingers(mesh, side, frame.palm, (digit) => (digit === "親指" ? bend * THUMB_CURL : bend));
    }
    const fingers = bones.filter((bone) => FINGER_JOINT.test(bone.name) && bind.has(bone)).map((bone) => ({
      name: bone.name,
      translation: byName.get(bone.name)?.translation ?? [0, 0, 0],
      quaternion: bind.get(bone).clone().invert().multiply(bone.quaternion).toArray(),
    }));
    const kept = vpd.bones.filter((entry) => !FINGER_JOINT.test(entry.name));
    return { ...vpd, bones: [...kept, ...fingers] };
  } finally {
    bones.forEach((bone, index) => bone.quaternion.copy(saved[index]));
    mesh.updateMatrixWorld(true);
  }
}

/**
 * Arm targets for the yawn, for her right hand; the left mirrors them.
 * - side: which hand yawns.
 * - chin: wrist target from the head bone. The wrist sits forward of the
 *   chin, so the open hand lies across her throat just under it.
 * - elbowBend: which way the elbow bends.
 * - finger, palm: the hand's finger direction and palm normal, in world
 *   space: open fingers across toward her other side, palm toward her throat.
 * - curl: radians per finger joint; 0 keeps the fingers open and straight
 *   (the user, 27 November 2026), unlike the thinking fist (0.8).
 * Picked from comparison grids on the PMX (27 November 2026): lower than the first pick (y -0.5), which
 * covered her mouth before the stretch had tipped her head back.
 */
export const YAWN_ARM = Object.freeze({
  side: "右",
  chin: Object.freeze([-0.8, -0.8, 2.3]),
  // Further out than the thinking elbow, so the forearm keeps clear of the bust.
  elbowBend: Object.freeze([-0.8, -0.6, 0.5]),
  finger: Object.freeze([1, 0.3, -0.2]),
  palm: Object.freeze([0, -0.3, -1]),
  curl: 0,
});

const mirrored = (vector) => Object.freeze([-vector[0], vector[1], vector[2]]);

/**
 * Build the yawn pose, retaining exact rest rotations for release. Its
 * entries cover the same bones in the same order as buildThinkingRig, so
 * blendArmLayers can mix the two bone by bone.
 * @param {THREE.Object3D} mesh
 * @param {Partial<typeof YAWN_ARM>} [arm] Overrides, for previews and grids.
 * @returns {{ bone: THREE.Bone, rest: THREE.Quaternion, posed: THREE.Quaternion }[]}
 */
export function buildYawnRig(mesh, arm = {}) {
  const side = arm.side ?? YAWN_ARM.side;
  const defaults = side === YAWN_ARM.side ? YAWN_ARM : {
    ...YAWN_ARM,
    ...Object.fromEntries(["chin", "elbowBend", "finger", "palm"].map((key) => [key, mirrored(YAWN_ARM[key])])),
  };
  const { chin, elbowBend, finger, palm, curl } = { ...defaults, ...arm };
  const head = mesh.skeleton?.getBoneByName("頭");
  if (!head) return [];
  const entries = armPoseBones(mesh).map((bone) => ({ bone, rest: bone.quaternion.clone(), posed: bone.quaternion.clone() }));
  try {
    mesh.updateMatrixWorld(true);
    const wrist = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...chin));
    if (poseArm(mesh, side, wrist, new THREE.Vector3(...elbowBend))) {
      poseHand(mesh, side, new THREE.Vector3(...finger), new THREE.Vector3(...palm), curl);
    }
    for (const entry of entries) entry.posed.copy(entry.bone.quaternion);
    return entries;
  } finally {
    for (const entry of entries) entry.bone.quaternion.copy(entry.rest);
    mesh.updateMatrixWorld(true);
  }
}

const unit = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * How the arm layers share her arms this frame. The thinking pose wins; the
 * yawn takes what it leaves; the arm drift fades by both, so it never pushes
 * a raised hand into her face; the head follows the gaze less while a hand
 * is up (headGazeScale).
 * @param {number} thinking Thinking pose weight, 0-1.
 * @param {number} yawnHand The idle motion's yawnHand weight, 0-1.
 * @returns {{ thinking: number, yawn: number, drift: number, headGaze: number }}
 */
export function armLayerWeights(thinking, yawnHand) {
  const t = unit(thinking);
  const yawn = unit(yawnHand) * (1 - t);
  return { thinking: t, yawn, drift: (1 - t) * (1 - unit(yawnHand)), headGaze: Math.max(t, yawn) };
}

/**
 * Write the thinking and yawn poses onto their bones from rest; nothing accumulates.
 * @param {{ bone: THREE.Bone, rest: THREE.Quaternion, posed: THREE.Quaternion }[]} thinking
 * @param {{ posed: THREE.Quaternion }[]} yawn Same bones in the same order, or empty.
 * @param {{ thinking: number, yawn: number }} weights From armLayerWeights.
 * @returns {void}
 */
export function blendArmLayers(thinking, yawn, weights) {
  thinking.forEach(({ bone, rest, posed }, index) => {
    bone.quaternion.copy(rest).slerp(posed, weights.thinking);
    if (yawn[index] && weights.yawn > 0) bone.quaternion.slerp(yawn[index].posed, weights.yawn);
  });
}
