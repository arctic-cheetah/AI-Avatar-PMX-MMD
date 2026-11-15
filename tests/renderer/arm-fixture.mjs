// Shared synthetic PMX arm rig for renderer tests: torso, head, shoulders,
// arms with twist bones, elbows, wrists and three-joint fingers, under a
// rotated mesh so world/local mix-ups show up. Used by thinking-rig and
// rest-pose tests.
import * as THREE from "three";

export const UPPER_LENGTH = 2.96;
export const LOWER_LENGTH = 2.71;
export const DIGITS = ["親指", "人指", "中指", "薬指", "小指"];
export const JOINTS = ["１", "２", "３"];

/**
 * Build the rig.
 * @param {{ fingers?: boolean, legs?: boolean }} [options] fingers: false leaves the hands without
 *   finger bones; legs: false leaves out the hips and legs.
 * @returns {{ mesh: THREE.Object3D, get: (name: string) => THREE.Bone | undefined }}
 */
export function fixture({ fingers = true, legs = true } = {}) {
  const mesh = new THREE.Object3D();
  mesh.rotation.set(0.12, -0.19, 0.08);
  const bones = [];
  function atWorld(parent, name, position, rotation = new THREE.Euler()) {
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    parent.updateWorldMatrix(true, false);
    bone.position.copy(parent.worldToLocal(position.clone()));
    bone.quaternion.copy(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
      .multiply(new THREE.Quaternion().setFromEuler(rotation));
    bones.push(bone);
    mesh.updateMatrixWorld(true);
    return bone;
  }
  const torso = atWorld(mesh, "上半身", new THREE.Vector3(0, 15.4, -0.55),
    new THREE.Euler(-0.09, 0.16, -0.11));
  atWorld(torso, "頭", new THREE.Vector3(0, 19.27, -0.55));
  if (legs) {
    const hips = atWorld(mesh, "下半身", new THREE.Vector3(0, 13.3, -0.5), new THREE.Euler(0.05, -0.08, 0.04));
    for (const [side, sign] of [["右", -1], ["左", 1]]) {
      const thigh = atWorld(hips, `${side}足`, new THREE.Vector3(sign * 1.05, 12.6, -0.6), new THREE.Euler(-0.06, 0, sign * 0.05));
      atWorld(thigh, `${side}ひざ`, new THREE.Vector3(sign * 1.2, 7.4, -0.25));
    }
  }
  for (const [side, sign] of [["右", -1], ["左", 1]]) {
    const shoulderPosition = new THREE.Vector3(sign * 1.32, 17.76, -0.57);
    const upperDirection = new THREE.Vector3(sign * 0.22, -0.94, 0.26).normalize();
    const lowerDirection = new THREE.Vector3(sign * 0.12, -0.98, 0.14).normalize();
    const elbowPosition = shoulderPosition.clone().addScaledVector(upperDirection, UPPER_LENGTH);
    const wristPosition = elbowPosition.clone().addScaledVector(lowerDirection, LOWER_LENGTH);
    const shoulder = atWorld(torso, `${side}肩`, shoulderPosition,
      new THREE.Euler(0.13, sign * 0.21, sign * -0.17));
    const arm = atWorld(shoulder, `${side}腕`, shoulderPosition,
      new THREE.Euler(-0.14, sign * 0.18, sign * 0.24));
    const upperTwist = atWorld(arm, `${side}腕捩`, shoulderPosition.clone().lerp(elbowPosition, 0.45),
      new THREE.Euler(0.11, sign * -0.16, sign * 0.09));
    const elbow = atWorld(upperTwist, `${side}ひじ`, elbowPosition,
      new THREE.Euler(0.08, sign * 0.15, sign * -0.12));
    const lowerTwist = atWorld(elbow, `${side}手捩`, elbowPosition.clone().lerp(wristPosition, 0.55),
      new THREE.Euler(-0.1, sign * 0.13, sign * 0.19));
    const wrist = atWorld(lowerTwist, `${side}手首`, wristPosition);
    const handRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), lowerDirection);
    wrist.quaternion.copy(lowerTwist.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(handRotation);
    if (!fingers) continue;
    for (const [digitIndex, digit] of DIGITS.entries()) {
      let parent = wrist;
      if (digit === "親指") {
        parent = new THREE.Bone();
        parent.name = `${side}${digit}０`;
        parent.position.set(sign * 0.42, 0.2, 0.06);
        wrist.add(parent);
        bones.push(parent);
      }
      for (const [jointIndex, joint] of JOINTS.entries()) {
        const bone = new THREE.Bone();
        bone.name = `${side}${digit}${joint}`;
        if (jointIndex === 0) {
          bone.position.set(sign * (digitIndex - 2) * 0.2, 0.5 + (digitIndex === 2 ? 0.1 : 0), 0);
        } else {
          bone.position.set(0, jointIndex === 1 ? 0.32 : 0.24, 0);
        }
        bone.rotation.set(0.025, 0, sign * 0.015);
        parent.add(bone);
        bones.push(bone);
        parent = bone;
      }
      const tip = new THREE.Object3D();
      tip.name = `${side}${digit}先`;
      tip.position.set(0, 0.18, 0);
      parent.add(tip);
    }
  }
  mesh.skeleton = new THREE.Skeleton(bones);
  mesh.updateMatrixWorld(true);
  return { mesh, get: (name) => mesh.skeleton.getBoneByName(name) };
}

/**
 * A stand-in for her bust in the fixture's world space (#217): one ellipsoid
 * per side, fitted to the front of the PMX's 胸-weighted vertices (x ±1.5,
 * y 16.0–17.8, front surface up to z 1.88). The fixture has no mesh, so this
 * is what the thinking-pose arms must keep clear of.
 */
export const BUST = Object.freeze([-0.7, 0.7].map((x) => Object.freeze({
  center: new THREE.Vector3(x, 16.7, 0.6),
  radii: new THREE.Vector3(1.0, 1.05, 1.25),
})));

/** About the radius of her forearm and glove, in model units. */
export const FOREARM_RADIUS = 0.3;

/**
 * How far a limb of the given radius at this point sinks into the bust.
 * @param {THREE.Vector3} point World position on the limb's axis.
 * @param {number} [radius] Limb radius.
 * @returns {number} Positive inside (0 to 1, normalised), zero or negative when clear.
 */
export function bustDepth(point, radius = FOREARM_RADIUS) {
  return Math.max(...BUST.map(({ center, radii }) => {
    const offset = point.clone().sub(center);
    const reach = radii.clone().addScalar(radius);
    return 1 - Math.hypot(offset.x / reach.x, offset.y / reach.y, offset.z / reach.z);
  }));
}
