// The hand under her chin while she yawns (#270): one arm reaches to just
// below the chin, solved once like the thinking chin rest and blended by the
// idle motion's yawnHand weight. See docs/idle-behaviours.md#sleepy-face-and-yawn.
import * as THREE from "three";
import { armPoseBones, poseArm, poseHand } from "./thinking-rig.js";

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
