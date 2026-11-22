/**
 * Per-frame Goo shader inputs (#252, docs/goo-shader.md). The Blender nodes
 * `faceLogic`, `[Light Facing Forward]` and `Face Facing Forward` only depend on
 * the light, the head and the camera, so they run here once per frame, in
 * Blender's world space (Z up, the face looking along −Y), and reach the GLSL
 * as uniforms.
 */
import * as THREE from "three";

/** three.js (x, y, z) is Blender (x, −z, y). */
export const threeToBlender = ([x, y, z]) => [x, -z, y];
/** Blender (x, y, z) is three.js (x, z, −y). */
export const blenderToThree = ([x, y, z]) => [x, z, -y];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => {
  const length = Math.hypot(...v);
  return length > 0 ? v.map((c) => c / length) : [0, 0, 0];
};
const flat = (v) => [v[0], v[1], 0];
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Rotate a vector by a Blender XYZ Euler (X first, then Y, then Z), like Vector Rotate in EULER_XYZ mode. */
export function rotateEulerXYZ([rx, ry, rz], v) {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, "ZYX"));
  return new THREE.Vector3(...v).applyMatrix4(m).toArray();
}

/** The `light dir` before flattening: +Z rotated by the Main Light's Euler. */
export const lightDirection = (euler) => normalize(rotateEulerXYZ(euler, [0, 0, 1]));

/** An XYZ Euler (X, 0, Z) whose light direction is `direction` (Blender space). */
export function eulerForDirection(direction) {
  const [x, y, z] = normalize(direction);
  const tilt = Math.acos(Math.min(1, Math.max(-1, z)));
  const yaw = Math.hypot(x, y) < 1e-9 ? 0 : Math.atan2(x, -y);
  return [tilt, 0, yaw];
}

const DEG = Math.PI / 180;

/**
 * The light's Euler for the chosen light controls (#254).
 * @param {{ mode: "fixed" | "camera", yaw: number, pitch: number }} light Degrees.
 * @param {{ baseEuler: number[], cameraBack?: number[] }} scene Blender space.
 * @returns {number[]}
 */
export function lightEulerFor({ mode, yaw, pitch }, { baseEuler, cameraBack }) {
  if (mode === "camera" && cameraBack) return eulerForDirection(cameraBack);
  return [baseEuler[0] - pitch * DEG, baseEuler[1], baseEuler[2] + yaw * DEG];
}

/** `faceLogic`'s exponent: pow(2 − (0.5 + 0.75), 3). */
const RANGE_POWER = (2 - (0.5 + 0.75)) ** 3;

/**
 * The face and light terms for one frame, all in Blender world space.
 * @param {{ light: number[], lightEuler: number[], headForward: number[], headUp: number[],
 *   cameraForward: number[], cameraBack: number[] }} input
 * @returns {{ shadowRange: number, mirrorU: boolean, facingDot: number, facingForward: number,
 *   lightFacingPow: number, edgeLight: number }}
 */
export function faceTerms({ light, lightEuler, headForward, headUp, cameraForward, cameraBack }) {
  const lightXY = normalize(flat(normalize(light)));
  const forwardXY = flat(normalize(headForward));
  const rightXY = flat(normalize(cross(headForward, headUp)));
  // Lightmap Direction Logic: (dot·0.5 + 0.5) <= 0.5 keeps the UV, otherwise u is mirrored.
  const mirrorU = dot(lightXY, rightXY) * 0.5 + 0.5 > 0.5;
  // Face Shadow Range.
  const shadowRange = Math.min((dot(lightXY, forwardXY) + 1) / 2, 0.999) ** RANGE_POWER;
  // Face Facing Forward: the unnormalised head forward against the camera's view direction.
  const facingDot = dot(headForward, cameraForward);
  const facingForward = clamp01((facingDot * 1.15) ** 25);
  // [Light Facing Forward]: the camera's back vector turned by the light rotation; its Z.
  const z = rotateEulerXYZ(lightEuler, cameraBack)[2];
  const towards = clamp01(0.5 - z);
  return { shadowRange, mirrorU, facingDot, facingForward, lightFacingPow: clamp01(towards ** 10), edgeLight: 1 - towards };
}

/**
 * Head Controller vectors for the current pose: the rest vectors (Blender
 * space) turned by how far the head bone has rotated from its bind pose.
 * @param {{ bindQuaternion: THREE.Quaternion, currentQuaternion: THREE.Quaternion,
 *   restForward: number[], restUp: number[] }} input Quaternions in three.js mesh space.
 * @returns {{ forward: number[], up: number[] }} Blender space.
 */
export function headVectors({ bindQuaternion, currentQuaternion, restForward, restUp }) {
  const delta = currentQuaternion.clone().multiply(bindQuaternion.clone().invert());
  const turn = (v) => threeToBlender(new THREE.Vector3(...blenderToThree(v)).applyQuaternion(delta).toArray());
  return { forward: turn(restForward), up: turn(restUp) };
}

/** Read a baked ramp LUT (evenly spaced samples over 0–1) with linear steps. */
export function sampleRamp(samples, x) {
  const last = samples.length - 1;
  const t = Math.min(1, Math.max(0, x)) * last;
  const i = Math.min(last - 1, Math.floor(t));
  return samples[i] + (samples[i + 1] - samples[i]) * (t - i);
}

/**
 * Build the per-frame update for a loaded PMX mesh: returns a function that
 * takes the camera and gives the values for `setFrame()` of the Goo materials.
 * @param {{ mesh: THREE.SkinnedMesh, scene: { light: { eulerXYZ: number[] },
 *   head: { bone: string, forward: number[], up: number[] } } }} input
 * @returns {(camera: THREE.Camera, light?: { mode: "fixed" | "camera", yaw: number, pitch: number }) => object}
 * @throws {Error} When the mesh has no head bone.
 */
export function createFrameUpdater({ mesh, scene }) {
  const bones = mesh.skeleton?.bones ?? [];
  const index = bones.findIndex((bone) => bone.name === scene.head.bone);
  if (index < 0) throw new Error(`the PMX has no ${scene.head.bone} bone`);
  const bindQuaternion = new THREE.Quaternion();
  const scratch = new THREE.Vector3();
  new THREE.Matrix4().copy(mesh.skeleton.boneInverses[index]).invert().decompose(scratch, bindQuaternion, new THREE.Vector3());
  const baseEuler = scene.light.eulerXYZ;
  const local = new THREE.Matrix4();
  const currentQuaternion = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const lightThree = new THREE.Vector3();
  return (camera, lightControls = { mode: "fixed", yaw: 0, pitch: 0 }) => {
    local.copy(mesh.matrixWorld).invert().multiply(bones[index].matrixWorld);
    local.decompose(scratch, currentQuaternion, new THREE.Vector3());
    const head = headVectors({ bindQuaternion, currentQuaternion, restForward: scene.head.forward, restUp: scene.head.up });
    const cameraForward = threeToBlender(camera.getWorldDirection(forward).toArray());
    const cameraBack = cameraForward.map((c) => -c);
    const lightEuler = lightEulerFor(lightControls, { baseEuler, cameraBack });
    const light = lightDirection(lightEuler);
    const terms = faceTerms({ light, lightEuler, headForward: head.forward, headUp: head.up, cameraForward, cameraBack });
    const lightView = lightThree.set(...blenderToThree(light)).transformDirection(camera.matrixWorldInverse).toArray();
    return { lightView, ...terms };
  };
}
