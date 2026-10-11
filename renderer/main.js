// Yidhari's browser body.
//
// serve.py must be running. Open http://127.0.0.1:8770/renderer/
// Do not open this file directly: the PMX and textures are served from
// the workspace root, next to this folder.
//
// What this file owns:
//   1. Load yidhari-mmd/伊德海莉.pmx.
//   2. Frame a bust portrait.
//   3. Drop the arms out of the PMX T-pose.
//   4. Blink on a timer and preview the happy face morph.
//
// What it does not own yet:
//   LLM mood tags, hand poses, lip sync, WebSocket, hair/coat physics.
//
// Extension points:
//   restArms()  — add elbow, wrist, or finger rotations here.
//   updateBlink — copy this pattern for other morph weights.
//   animate()   — keep per-frame work here, not in the loader callback.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MMDLoader } from "three/addons/loaders/MMDLoader.js";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";
import { EXPRESSION_CATALOG } from "./expression-catalog.js";
import { ExpressionController } from "./expression-controller.js";

// Served by renderer/serve.py from the workspace root. Do not rename the PMX.
const MODEL_URL = "/yidhari-mmd/伊德海莉.pmx";
const BLINK_MORPH = "まばたき";

const statusEl = document.querySelector("#status");
const canvas = document.querySelector("#view");
const happyButton = document.querySelector("#happy-button");

// Scene, camera, and lights. The portrait camera is replaced once the
// model loads; the initial position only matters before that.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141018);

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
camera.position.set(0, 12, 500);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

// MMD toon outlines. This is separate from the WebGL renderer.
const outline = new OutlineEffect(renderer);

scene.add(new THREE.AmbientLight(0xffffff, 2.2));
const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
key.position.set(4, 10, 8);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9eb6ff, 0.7);
fill.position.set(-6, 4, -2);
scene.add(fill);

// Unit circle, scaled to the model after load.
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64),
  new THREE.MeshStandardMaterial({
    color: 0x221c28,
    roughness: 0.95,
    metalness: 0,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 11, 0);
controls.enableDamping = true;
controls.minDistance = 3;
controls.maxDistance = 80;

/** @type {THREE.SkinnedMesh | null} */
let mesh = null;
let blinkIndex = -1;
/** @type {ExpressionController | null} */
let expressions = null;
let previousFrame = performance.now();
/** @type {{ start: number, close: number, hold: number, open: number } | null} */
let blink = null;

/**
 * Show a short loading or readiness message below the canvas.
 * @param {string} text Message to display.
 * @returns {void}
 */
function setStatus(text) {
  statusEl.textContent = text;
}

/**
 * Match the camera and both renderers to the browser viewport.
 * OutlineEffect maintains its own size, separate from WebGLRenderer.
 * @returns {void}
 */
function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  outline.setSize(width, height);
}

/**
 * Find a named PMX bone and return its current world-space position.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @param {string} name Bone name in the PMX rig.
 * @returns {THREE.Vector3 | null} Bone position, or null if absent.
 */
function boneWorld(object, name) {
  const bone = object.skeleton?.getBoneByName(name);
  if (!bone) {
    return null;
  }
  bone.updateWorldMatrix(true, false);
  return bone.getWorldPosition(new THREE.Vector3());
}

/**
 * Plant the PMX on y=0 and frame a bust portrait around its head.
 * The camera distance of 13 PMX units includes the face and shoulders.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @returns {void}
 */
function frameModel(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.position.y -= box.min.y;
  object.updateMatrixWorld(true);

  const head = boneWorld(object, "頭");
  const lookAt = head
    ? new THREE.Vector3(head.x, head.y, head.z)
    : new THREE.Vector3(0, 15.0, 0);
  controls.target.copy(lookAt);
  camera.position.set(lookAt.x, lookAt.y, lookAt.z + 13);
  camera.near = 0.05;
  camera.far = 400;
  camera.updateProjectionMatrix();
  controls.minDistance = 3;
  controls.maxDistance = 80;
  controls.update();
  floor.scale.setScalar(Math.max(18, (head ? head.y : 22) * 0.9));
}

const parentDown = new THREE.Vector3();
const parentQuat = new THREE.Quaternion();

/**
 * Rotate a bone so its first child points along a world-space direction.
 * Used to lower the arms without playing a VMD animation.
 * @param {THREE.Bone} bone Bone to rotate.
 * @param {THREE.Vector3} worldTarget Desired direction in world space.
 * @returns {void}
 */
function hangBone(bone, worldTarget) {
  const child = bone.children[0];
  if (!child) {
    return;
  }
  bone.parent?.updateWorldMatrix(true, false);
  parentDown.copy(worldTarget).normalize();
  if (bone.parent) {
    bone.parent.getWorldQuaternion(parentQuat).invert();
    parentDown.applyQuaternion(parentQuat);
  }
  bone.quaternion.setFromUnitVectors(child.position.clone().normalize(), parentDown);
}

/**
 * Lower both upper arms from the T-pose while leaving elbows and fingers bound.
 * The target directions point mostly down, slightly outward and forward.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @returns {void}
 */
function restArms(object) {
  object.updateMatrixWorld(true);
  const left = object.skeleton?.getBoneByName("左腕");
  const right = object.skeleton?.getBoneByName("右腕");
  if (left) {
    hangBone(left, new THREE.Vector3(0.28, -1, 0.16));
  }
  if (right) {
    hangBone(right, new THREE.Vector3(-0.28, -1, 0.16));
  }
  object.updateMatrixWorld(true);
}

/**
 * Schedule the next idle blink after a short random delay.
 * Uses the same monotonic clock as the animation loop.
 * @param {number} now Current performance time in seconds.
 * @returns {void}
 */
function scheduleBlink(now) {
  blink = {
    start: now + 2.2 + Math.random() * 3.4,
    close: 0.07,
    hold: 0.05,
    open: 0.11,
  };
}

/**
 * Calculate the blink morph weight, scheduling another blink after reopening.
 * A weight of 0 is open; 1 is fully closed.
 * @param {number} now Current performance time in seconds.
 * @returns {number} Blink morph weight between 0 and 1.
 */
function blinkWeightAt(now) {
  if (!blink || now < blink.start) {
    return 0;
  }
  const t = now - blink.start;
  if (t < blink.close) {
    return t / blink.close;
  }
  if (t < blink.close + blink.hold) {
    return 1;
  }
  const opening = t - blink.close - blink.hold;
  if (opening < blink.open) {
    return 1 - opening / blink.open;
  }
  scheduleBlink(now);
  return 0;
}

/**
 * Apply the current blink weight if the PMX provides the blink morph.
 * @param {number} now Current performance time in seconds.
 * @returns {void}
 */
function updateBlink(now) {
  if (blinkIndex < 0 || !mesh) {
    return;
  }
  mesh.morphTargetInfluences[blinkIndex] = blinkWeightAt(now);
}

/**
 * Toggle the local happy preview and expose its state to assistive technology.
 * @returns {void}
 */
function toggleHappy() {
  if (!expressions) {
    return;
  }
  const next = expressions.activeExpression === "happy" ? "neutral" : "happy";
  if (expressions.setExpression(next)) {
    happyButton.setAttribute("aria-pressed", String(next === "happy"));
  }
}

happyButton.addEventListener("click", toggleHappy);

/**
 * Add the loaded PMX to the scene and initialize its pose and face controls.
 * @param {THREE.SkinnedMesh} loaded Mesh supplied by MMDLoader.
 * @returns {void}
 */
function onModelLoaded(loaded) {
  mesh = loaded;
  scene.add(mesh);
  frameModel(mesh);

  blinkIndex = mesh.morphTargetDictionary?.[BLINK_MORPH] ?? -1;
  expressions = new ExpressionController(mesh, EXPRESSION_CATALOG);
  restArms(mesh);

  const morphCount = mesh.morphTargetInfluences?.length ?? 0;
  happyButton.disabled = !expressions.isAvailable("happy");
  setStatus(happyButton.disabled
    ? `Ready · ${morphCount} morphs · ${expressions.getMissingMorphs("happy").join(", ")} unavailable`
    : `Ready · ${morphCount} morphs`);
  scheduleBlink(performance.now() / 1000);
}

/**
 * Report the percentage downloaded when the PMX response has a known size.
 * @param {ProgressEvent} event Loader progress event.
 * @returns {void}
 */
function onModelProgress(event) {
  if (event.lengthComputable) {
    const pct = Math.round((event.loaded / event.total) * 100);
    setStatus(`Loading PMX… ${pct}%`);
  }
}

/**
 * Log a PMX loading failure and show a useful message in the page.
 * @param {unknown} error Loader error.
 * @returns {void}
 */
function onModelError(error) {
  console.error(error);
  setStatus("Could not load the PMX. Is serve.py running?");
}

/**
 * Start loading the local PMX and register its completion callbacks.
 * @returns {void}
 */
function loadModel() {
  setStatus("Loading PMX…");
  const loader = new MMDLoader();
  loader.load(MODEL_URL, onModelLoaded, onModelProgress, onModelError);
}

/**
 * Update controls and face morphs, then render the current frame.
 * @returns {void}
 */
function animate() {
  const now = performance.now();
  const delta = Math.min((now - previousFrame) / 1000, 0.1);
  previousFrame = now;
  controls.update();
  updateBlink(now / 1000);
  expressions?.update(delta);
  outline.render(scene, camera);
}

resize();
window.addEventListener("resize", resize);
renderer.setAnimationLoop(animate);
loadModel();
