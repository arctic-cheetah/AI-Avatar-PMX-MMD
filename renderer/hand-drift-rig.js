// Hand drift rig (natural hands, #199): the bones and axes the idle arm drift
// uses below the elbow. Each entry turns one bone about an axis in its own
// frame, found once from the rest pose, so the PMX's local bone axes do not
// matter: the forearm rolls about itself on the twist bone (手捩), the wrist
// tips the hand toward the palm, and each finger joint curls toward the palm
// like the rest curl in rest-pose.js. See docs/idle-behaviours.md#arm-drift-193.

import * as THREE from "three";
import { handFrame } from "./thinking-rig.js";
import { RELAXED_REST } from "./rest-pose.js";

/** Her right arm is on the left of the screen, as with the shrugs. */
const SIDES = Object.freeze([["右", "Left"], ["左", "Right"]]);
const FINGER = /^(?:右|左)(親指|人指|中指|薬指|小指)[１２３]$/;

const at = (object) => object.getWorldPosition(new THREE.Vector3());

/** A world direction in `bone`'s own frame, as a unit axis. */
function localAxis(bone, world) {
  return world.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
}

/**
 * @typedef {{ bone: THREE.Bone, axis: THREE.Vector3, channel: string, scale: number }} HandDriftEntry
 * Turn `bone` by `scale` × the pose's `channel` angle about `axis`, in its own frame.
 */

/**
 * Find the forearm, wrist and finger axes from the current (rest) pose.
 * Missing bones are skipped: without finger bones there is no palm, so only the forearm rolls.
 * @param {THREE.Object3D & { skeleton?: THREE.Skeleton }} mesh
 * @returns {HandDriftEntry[]}
 */
export function buildHandDriftRig(mesh) {
  const get = (name) => mesh.skeleton?.getBoneByName(name);
  if (!mesh.skeleton) return [];
  mesh.updateMatrixWorld(true);
  const entries = [];
  for (const [side, screen] of SIDES) {
    const twist = get(`${side}手捩`);
    const wrist = get(`${side}手首`);
    if (twist && wrist) {
      entries.push({ bone: twist, axis: localAxis(twist, at(wrist).sub(at(twist))), channel: `forearm${screen}`, scale: 1 });
    }
    const frame = wrist && handFrame(mesh, side);
    if (!frame) continue;
    // Turning `a` about a × b moves it toward b: the hand and each finger toward the palm.
    entries.push({
      bone: wrist,
      axis: localAxis(wrist, new THREE.Vector3().crossVectors(frame.finger, frame.palm)),
      channel: `wrist${screen}`,
      scale: 1,
    });
    for (const bone of mesh.skeleton.bones) {
      const match = FINGER.exec(bone.name);
      if (!match || !bone.name.startsWith(side)) continue;
      const child = bone.children.find((entry) => entry.isBone) ?? bone.children[0];
      const along = child ? at(child).sub(at(bone)) : at(bone).sub(at(bone.parent));
      const axis = new THREE.Vector3().crossVectors(along.normalize(), frame.palm);
      if (axis.lengthSq() < 1e-12) continue;
      entries.push({ bone, axis: localAxis(bone, axis), channel: `curl${screen}`, scale: RELAXED_REST.digits[match[1]] ?? 1 });
    }
  }
  return entries;
}
