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
//   4. Blink on a timer and preview facial expressions.
//   5. Audition every PMX morph on a manual layer (see morph-audition.js).
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
import { loadExpressionCatalog } from "./expression-catalog.js";
import { ExpressionController } from "./expression-controller.js";
import { MorphAudition, buildMorphInventory } from "./morph-audition.js";
import { AuditionPanel } from "./audition-panel.js";
import { connectBridge } from "./bridge-client.js";

// Served by renderer/serve.py from the workspace root. Do not rename the PMX.
const MODEL_URL = "/yidhari-mmd/伊德海莉.pmx";
const BLINK_MORPH = "まばたき";
const WINK_MORPHS = { left: "ウィンク", right: "ウィンク右" };
const WINK_EASE_RATE = 12;
// Camera distances in PMX units from the head bone.
const FRAMING = { bust: 13, face: 8 };

const statusEl = document.querySelector("#status");
const EXPRESSION_CATALOG = await loadExpressionCatalog().catch((error) => {
  statusEl.textContent = "Could not load expressions.json. Check the catalog and reload.";
  throw error;
});
const canvas = document.querySelector("#view");
const expressionControls = document.querySelector("#expression-controls");
const winkButtons = document.querySelectorAll("#wink-controls button[data-wink]");
const loopButton = document.querySelector("#loop-button");
const editPresetButton = document.querySelector("#edit-preset-button");
const intensityInput = document.querySelector("#intensity");
const intensityOutput = document.querySelector("#intensity-value");
const blinkToggle = document.querySelector("#blink-toggle");
const frameButtons = {
  face: document.querySelector("#frame-face-button"),
  bust: document.querySelector("#frame-bust-button"),
};

// One preview button per catalog mood, so new catalog entries appear here.
const expressionButtons = Object.entries(EXPRESSION_CATALOG).map(([name, definition]) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.expression = name;
  button.title = definition.description;
  button.setAttribute("aria-pressed", "false");
  button.disabled = true;
  button.textContent = `[${name}] · ${Object.keys(definition.morphs).join(" + ")}`;
  expressionControls.append(button);
  return button;
});

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
/** @type {{ left: { index: number, weight: number, target: number }, right: { index: number, weight: number, target: number } }} */
const winks = {
  left: { index: -1, weight: 0, target: 0 },
  right: { index: -1, weight: 0, target: 0 },
};
/** @type {ExpressionController | null} */
let expressions = null;
/** @type {MorphAudition | null} */
let audition = null;
/** @type {AuditionPanel | null} */
let auditionPanel = null;
/** @type {THREE.Vector3 | null} Head position used by the camera framings. */
let headTarget = null;
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
 * Match the camera and both renderers to the canvas, which shares the
 * window with the test bench panel.
 * OutlineEffect maintains its own size, separate from WebGLRenderer.
 * @returns {void}
 */
function resize() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
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
 * The bust distance of 13 PMX units includes the face and shoulders.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @returns {void}
 */
function frameModel(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.position.y -= box.min.y;
  object.updateMatrixWorld(true);

  const head = boneWorld(object, "頭");
  headTarget = head
    ? new THREE.Vector3(head.x, head.y, head.z)
    : new THREE.Vector3(0, 15.0, 0);
  camera.near = 0.05;
  camera.far = 400;
  camera.updateProjectionMatrix();
  controls.minDistance = 2;
  controls.maxDistance = 80;
  frameCamera("bust");
  floor.scale.setScalar(Math.max(18, (head ? head.y : 22) * 0.9));
}

/**
 * Point the camera straight at the head from a preset distance.
 * The head bone sits near the jaw, so the face framing aims slightly higher.
 * @param {"face" | "bust"} framing Preset from FRAMING.
 * @returns {void}
 */
function frameCamera(framing) {
  if (!headTarget) {
    return;
  }
  const lookAt = headTarget.clone();
  if (framing === "face") {
    lookAt.y += headTarget.y * 0.02;
  }
  controls.target.copy(lookAt);
  camera.position.set(lookAt.x, lookAt.y, lookAt.z + FRAMING[framing]);
  controls.update();
}

for (const [framing, button] of Object.entries(frameButtons)) {
  button.addEventListener("click", () => frameCamera(framing));
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
  const weight = blinkWeightAt(now);
  mesh.morphTargetInfluences[blinkIndex] = blinkToggle.checked ? weight : 0;
}

/**
 * Ease each wink morph toward its target. Winks are an independent channel,
 * like the blink: they layer on top of the mood morphs instead of replacing
 * them, so a wink survives the 3-second expression loop.
 * @param {number} delta Seconds elapsed since the previous frame.
 * @returns {void}
 */
function updateWinks(delta) {
  if (!mesh) {
    return;
  }
  const blend = 1 - Math.exp(-WINK_EASE_RATE * Math.max(0, delta));
  for (const wink of Object.values(winks)) {
    if (wink.index < 0) {
      continue;
    }
    wink.weight += (wink.target - wink.weight) * blend;
    mesh.morphTargetInfluences[wink.index] = wink.weight;
  }
}

/**
 * Reflect each wink channel's target in its preview button.
 * @returns {void}
 */
function updateWinkButtons() {
  for (const button of winkButtons) {
    button.setAttribute("aria-pressed", String(winks[button.dataset.wink].target > 0));
  }
}

/**
 * Toggle one wink channel on or off from its preview button.
 * @param {MouseEvent} event Click event from a wink button.
 * @returns {void}
 */
function toggleWink(event) {
  const wink = winks[event.currentTarget.dataset.wink];
  if (!wink || wink.index < 0) {
    return;
  }
  wink.target = wink.target > 0 ? 0 : 1;
  updateWinkButtons();
}

for (const button of winkButtons) {
  button.addEventListener("click", toggleWink);
}

/**
 * Reflect the controller's active mood in the preview buttons.
 * @returns {void}
 */
function updateExpressionButtons() {
  for (const button of expressionButtons) {
    button.setAttribute("aria-pressed", String(
      expressions?.activeExpression === button.dataset.expression,
    ));
  }
  editPresetButton.disabled = !expressions || expressions.activeExpression === "neutral";
}

/**
 * Reflect the controller's loop state in the loop toggle button.
 * @returns {void}
 */
function updateLoopButton() {
  loopButton.setAttribute("aria-pressed", String(expressions?.looping ?? false));
  loopButton.textContent = expressions?.looping ? "⏸ loop" : "▶ loop";
}

/**
 * Start or stop the expression loop from its toggle button.
 * @returns {void}
 */
function toggleLoop() {
  if (!expressions) {
    return;
  }
  if (expressions.looping) {
    expressions.stopLoop();
  } else {
    audition?.stopSweep();
    expressions.startLoop(3, Number(intensityInput.value));
  }
  updateLoopButton();
}

loopButton.addEventListener("click", toggleLoop);

/**
 * Toggle the clicked mood preview through the shared expression controller.
 * Stops a morph sweep, but keeps manual sliders so they can layer on the mood.
 * @param {MouseEvent} event Click event from a preview button.
 * @returns {void}
 */
function toggleExpression(event) {
  if (!expressions) {
    return;
  }
  const name = event.currentTarget.dataset.expression;
  const next = expressions.activeExpression === name ? "neutral" : name;
  if (expressions.setExpression(next, Number(intensityInput.value))) {
    audition?.stopSweep();
    updateExpressionButtons();
  }
}

for (const button of expressionButtons) {
  button.addEventListener("click", toggleExpression);
}

/**
 * Rescale the active mood, or the loop, to the intensity slider.
 * @returns {void}
 */
function changeIntensity() {
  const weight = Number(intensityInput.value);
  intensityOutput.value = weight.toFixed(2);
  expressions?.setIntensity(weight);
}

intensityInput.addEventListener("input", changeIntensity);

/**
 * Copy the active mood, at the current intensity, into the manual sliders and
 * clear the mood so the combination can be tuned morph by morph.
 * @returns {void}
 */
function editPresetInSliders() {
  if (!expressions || !audition || expressions.activeExpression === "neutral") {
    return;
  }
  const intensity = Number(intensityInput.value);
  const morphs = {};
  for (const [morph, weight] of Object.entries(EXPRESSION_CATALOG[expressions.activeExpression].morphs)) {
    morphs[morph] = weight * intensity;
  }
  audition.clear();
  audition.setWeights(morphs);
  expressions.setExpression("neutral");
}

editPresetButton.addEventListener("click", editPresetInSliders);

/**
 * List which mood presets and independent channels drive each morph,
 * so overlaps are visible next to the audition sliders.
 * @returns {Map<string, string[]>} Users by PMX morph name.
 */
function buildMorphUsage() {
  const usage = new Map();
  const add = (morph, user) => usage.set(morph, [...(usage.get(morph) ?? []), user]);
  for (const [name, definition] of Object.entries(EXPRESSION_CATALOG)) {
    for (const morph of Object.keys(definition.morphs)) {
      add(morph, name);
    }
  }
  add(BLINK_MORPH, "blink");
  for (const [side, morph] of Object.entries(WINK_MORPHS)) {
    add(morph, `wink-${side}`);
  }
  return usage;
}

/**
 * Add the loaded PMX to the scene and initialize its pose and face controls.
 * @param {THREE.SkinnedMesh} loaded Mesh supplied by MMDLoader.
 * @param {{ morphs: { name: string, englishName: string, panel: number }[] }} data Parsed PMX.
 * @returns {void}
 */
function onModelLoaded(loaded, data) {
  mesh = loaded;
  scene.add(mesh);
  frameModel(mesh);

  blinkIndex = mesh.morphTargetDictionary?.[BLINK_MORPH] ?? -1;
  for (const [side, morph] of Object.entries(WINK_MORPHS)) {
    winks[side].index = mesh.morphTargetDictionary?.[morph] ?? -1;
  }
  for (const button of winkButtons) {
    button.disabled = winks[button.dataset.wink].index < 0;
  }
  for (const control of [loopButton, editPresetButton, intensityInput, blinkToggle,
    frameButtons.face, frameButtons.bust]) {
    control.disabled = false;
  }
  blinkToggle.disabled = blinkIndex < 0;
  expressions = new ExpressionController(mesh, EXPRESSION_CATALOG);
  expressions.startLoop(3, Number(intensityInput.value));
  audition = new MorphAudition(mesh, buildMorphInventory(data, mesh));
  // Local preview hook for the morph test bench. Not part of the mood API.
  globalThis.__yidhariPreview = {
    expressions,
    audition,
    frameCamera,
    /**
     * Hold one morph combination still, above the mood loop, for visual checks.
     * @param {Record<string, number>} morphs PMX morph names and weights.
     * @returns {void}
     */
    hold(morphs) {
      expressions.stopLoop();
      expressions.setExpression("neutral");
      audition.clear();
      audition.setWeights(morphs);
      blinkToggle.checked = false;
      frameCamera("face");
      globalThis.__yidhariHold = morphs;
    },
  };
  auditionPanel = new AuditionPanel(audition, {
    usage: buildMorphUsage(),
    onManualEdit: () => expressions.stopLoop(),
    onTakeover: () => expressions.setExpression("neutral"),
  });
  restArms(mesh);

  const morphCount = mesh.morphTargetInfluences?.length ?? 0;
  const unavailable = [];
  for (const button of expressionButtons) {
    const name = button.dataset.expression;
    button.disabled = !expressions.isAvailable(name);
    if (button.disabled) {
      unavailable.push(`${name}: ${expressions.getMissingMorphs(name).join(", ")}`);
    }
  }
  setStatus(unavailable.length > 0
    ? `Ready · ${morphCount} morphs · unavailable: ${unavailable.join("; ")}`
    : `Ready · ${morphCount} morphs`);
  scheduleBlink(performance.now() / 1000);
  const transcript = document.querySelector('#bridge-transcript');
  connectBridge({
    catalog: EXPRESSION_CATALOG,
    onStart: () => {
      for (const section of document.querySelectorAll('#panel > section:not(:first-child)')) section.inert = true;
      expressions.stopLoop();
      audition.stopSweep();
      audition.clear();
      globalThis.__yidhariHold = null;
      for (const wink of Object.values(winks)) wink.target = 0;
      transcript.textContent = '';
    },
    onFinish: () => {
      for (const section of document.querySelectorAll('#panel > section:not(:first-child)')) section.inert = false;
    },
    onExpression: (name, weight) => {
      if (!expressions.setExpression(name, weight)) console.warn('Unavailable expression', name);
      intensityInput.value = String(weight);
      intensityOutput.value = weight.toFixed(2);
    },
    onText: (text) => { transcript.textContent = (transcript.textContent + text).slice(-50000); },
  });
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
 * This is MMDLoader.load split in two, so the parsed PMX (morph panels and
 * English labels) stays available to the audition panel after the build.
 * @returns {void}
 */
function loadModel() {
  setStatus("Loading PMX…");
  const loader = new MMDLoader();
  const resourcePath = THREE.LoaderUtils.extractUrlBase(MODEL_URL);
  loader.loadPMX(MODEL_URL, (data) => {
    try {
      const built = loader.meshBuilder
        .setCrossOrigin(loader.crossOrigin)
        .build(data, resourcePath, onModelProgress, onModelError);
      onModelLoaded(built, data);
    } catch (error) {
      onModelError(error);
    }
  }, onModelProgress, onModelError);
}

/**
 * Update controls and face morphs, then render the current frame.
 * Every morph starts the frame at zero; each channel writes its own morphs
 * and the audition layer adds on top last.
 * @returns {void}
 */
function animate() {
  const now = performance.now();
  const delta = Math.min((now - previousFrame) / 1000, 0.1);
  previousFrame = now;
  controls.update();
  mesh?.morphTargetInfluences?.fill(0);
  expressions?.update(delta);
  updateBlink(now / 1000);
  updateWinks(delta);
  audition?.update(delta);
  audition?.apply();
  // A held preview wins the frame so a visual check is not overwritten by the mood loop.
  if (globalThis.__yidhariHold && mesh) {
    mesh.morphTargetInfluences.fill(0);
    audition.setWeights(globalThis.__yidhariHold);
    audition.apply();
  }
  updateExpressionButtons();
  updateLoopButton();
  auditionPanel?.refresh();
  outline.render(scene, camera);
}

resize();
new ResizeObserver(resize).observe(canvas);
renderer.setAnimationLoop(animate);
loadModel();
