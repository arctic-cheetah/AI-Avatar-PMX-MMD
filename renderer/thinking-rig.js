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

function poseArm(mesh, side, target, bendHint) {
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

function poseHand(mesh, side, forward, normal, curlAmount) {
  const get = (suffix) => mesh.skeleton.getBoneByName(side + suffix);
  const wrist = get("手首"), middle = get("中指１"), index = get("人指１"), little = get("小指１");
  if (!wrist || !middle || !index || !little) return;
  wrist.updateWorldMatrix(true, true);
  const origin = wrist.getWorldPosition(new THREE.Vector3());
  const finger = middle.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const across = index.getWorldPosition(new THREE.Vector3()).sub(little.getWorldPosition(new THREE.Vector3())).normalize();
  const palm = new THREE.Vector3().crossVectors(across, finger).normalize();
  if (side === "左") palm.negate();
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
  const palmWorld = normal.clone().normalize();
  // Capture axes before bending parents so each joint curls relative to the palm.
  const curls = mesh.skeleton.bones.filter((bone) =>
    new RegExp(`^${side}(?:親指|人指|中指|薬指|小指)[１２３]$`).test(bone.name)).map((bone) => {
    const child = bone.children.find((entry) => entry.isBone);
    const localDirection = (child?.position ?? bone.position).clone().normalize();
    const palmLocal = palmWorld.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert());
    return { bone, axis: new THREE.Vector3().crossVectors(localDirection, palmLocal).normalize() };
  });
  for (const { bone, axis } of curls) {
    const amount = bone.name.includes("親指") ? curlAmount * 0.45 : curlAmount;
    bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, amount));
  }
  wrist.updateWorldMatrix(false, true);
}

/** Build a supported chin-rest pose, retaining exact rest rotations for release. */
export function buildThinkingRig(mesh) {
  const head = mesh.skeleton?.getBoneByName("頭");
  if (!head) return [];
  const entries = mesh.skeleton.bones.filter((bone) => /^(?:右|左)(?:腕$|ひじ$|手首$|(?:親指|人指|中指|薬指|小指)[０１２３]$)/.test(bone.name))
    .map((bone) => ({ bone, rest: bone.quaternion.clone(), posed: bone.quaternion.clone() }));
  try {
    mesh.updateMatrixWorld(true);
    // Leave space in front of the jaw and outfit for the curled fingers and gloves.
    const chinWrist = head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(-0.35, -1.5, 2.05));
    const right = poseArm(mesh, "右", chinWrist, new THREE.Vector3(-0.35, -1, 0.85));
    if (right) {
      poseHand(mesh, "右", new THREE.Vector3(0.15, 1, -0.1), new THREE.Vector3(0, 0, -1), 0.8);
      const support = right.elbow.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0.45, -0.3, 0.85));
      const left = poseArm(mesh, "左", support, new THREE.Vector3(0.7, -1, 0.2));
      if (left) poseHand(mesh, "左", new THREE.Vector3(-1, 0.1, 0), new THREE.Vector3(0, 1, -0.2), 0.45);
    }
    for (const entry of entries) entry.posed.copy(entry.bone.quaternion);
    return entries;
  } finally {
    for (const entry of entries) entry.bone.quaternion.copy(entry.rest);
    mesh.updateMatrixWorld(true);
  }
}
