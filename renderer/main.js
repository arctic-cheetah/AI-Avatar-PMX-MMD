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
//   6. Play the saved speech sample with lip sync (see speech-player.js).
//
// What it does not own yet:
//   Live LLM speech, hand poses, hair/coat physics.
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
import { SpeechPlayer, loadSpeechShapes } from "./speech-player.js";
import { LiveSpeechSession } from "./speech-session.js";
import { GazeController, normalisePointer } from "./gaze-tracking.js";
import { CameraGaze } from "./camera-gaze.js";

// Served by renderer/serve.py from the workspace root. Do not rename the PMX.
const MODEL_URL = "/yidhari-mmd/伊德海莉.pmx";
// Gitignored. Create the track with controller/speech_align.py.
const SPEECH_SAMPLE = {
  audio: "/assets/private/speech/sample-01.wav",
  track: "/assets/private/speech/sample-01.visemes.json",
};
// Live clips written by the bridge in --speech mode; only IDs arrive over the socket.
const LIVE_CLIP_DIR = "/assets/private/speech/live/";
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
const SPEECH_SHAPES = await loadSpeechShapes().catch((error) => {
  statusEl.textContent = "Could not load speech-shapes.json. Check the catalog and reload.";
  throw error;
});
const canvas = document.querySelector("#view");
const speechButton = document.querySelector("#speech-button");
const speechStatus = document.querySelector("#speech-status");
const expressionControls = document.querySelector("#expression-controls");
const winkButtons = document.querySelectorAll("#wink-controls button[data-wink]");
const loopButton = document.querySelector("#loop-button");
const editPresetButton = document.querySelector("#edit-preset-button");
const intensityInput = document.querySelector("#intensity");
const intensityOutput = document.querySelector("#intensity-value");
const blinkToggle = document.querySelector("#blink-toggle");
const cursorGazeToggle = document.querySelector("#cursor-gaze-toggle");
const cameraGazeToggle = document.querySelector("#camera-gaze-toggle");
const gazeStatus = document.querySelector("#gaze-status");
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
/** @type {SpeechPlayer | null} */
let speech = null;
/** @type {Promise<import("./speech-player.js").SpeechClip> | null} */
let speechClip = null;
/** @type {{ clip: Promise<import("./speech-player.js").SpeechClip>, expression: string, weight: number, text: string }[]} */
const speechQueue = [];
/** Bumped on every new response or stop, so stale clip loads are discarded. */
let liveRun = 0;
let speechStarting = false;
const liveSpeech = new LiveSpeechSession();
// Linger on the last mood briefly after the final word, then ease to neutral.
const RELAX_DELAY_MS = 600;
/** @type {THREE.Vector3 | null} Head position used by the camera framings. */
let headTarget = null;
let previousFrame = performance.now();
/** @type {{ start: number, close: number, hold: number, open: number } | null} */
let blink = null;
const gaze = new GazeController();
/** @type {{ bone: THREE.Bone, rest: THREE.Quaternion }[]} */
let gazeBones = [];
const gazeEuler = new THREE.Euler();
const gazeQuat = new THREE.Quaternion();
const cameraGaze = new CameraGaze((target) => gaze.setCamera(target, cameraGazeToggle.checked));

window.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  gaze.setCursor(
    normalisePointer(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height),
    cursorGazeToggle.checked,
  );
});
window.addEventListener("pointerleave", () => gaze.setCursor({ x: 0, y: 0 }, cursorGazeToggle.checked));
cursorGazeToggle.addEventListener("change", () => gaze.setCursor({ x: 0, y: 0 }, cursorGazeToggle.checked));
cameraGazeToggle.addEventListener("change", async () => {
  gaze.setCamera({ x: 0, y: 0 }, cameraGazeToggle.checked);
  if (!cameraGazeToggle.checked) {
    cameraGaze.stop();
    gazeStatus.textContent = "";
    return;
  }
  gazeStatus.textContent = "Starting camera…";
  try {
    await cameraGaze.start();
    gazeStatus.textContent = "Camera on · processed locally, nothing is recorded or sent.";
  } catch (error) {
    cameraGazeToggle.checked = false;
    gaze.setCamera(null, false);
    gazeStatus.textContent = error.message;
  }
});

/**
 * Capture the eye/neck/head bones and their rest quaternions for gaze.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @returns {void}
 */
function setupGaze(object) {
  gazeBones = [];
  for (const name of ["左目", "右目", "首", "頭"]) {
    const bone = object.skeleton?.getBoneByName(name);
    if (bone) gazeBones.push({ name, bone, rest: bone.quaternion.clone() });
  }
  const hasEyes = gazeBones.some(({ name }) => name === "左目" || name === "右目");
  cursorGazeToggle.disabled = !hasEyes;
  cameraGazeToggle.disabled = !hasEyes;
  if (!hasEyes) gazeStatus.textContent = "This model has no eye bones, so gaze tracking is unavailable.";
}

/**
 * Ease gaze bones toward the active pointer/face target for this frame.
 * The PMX faces +Z toward the camera, so positive yaw turns screen-right.
 * @param {number} delta Seconds elapsed since the previous frame.
 * @returns {void}
 */
function applyGaze(delta) {
  if (!gazeBones.length) return;
  const angles = gaze.update(delta);
  for (const { name, bone, rest } of gazeBones) {
    const yaw = name === "左目" || name === "右目" ? angles.eyeYaw : angles.headYaw;
    const pitch = name === "左目" || name === "右目" ? angles.eyePitch : angles.headPitch;
    gazeEuler.set(pitch, yaw, 0, "YXZ");
    bone.quaternion.copy(rest).multiply(gazeQuat.setFromEuler(gazeEuler));
  }
}

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

const PANEL_WIDTH_KEY = "yidhari.panelWidth";
const PANEL_MIN = 280;
const PANEL_STAGE_MIN = 280;

/**
 * Drag the divider between the portrait and the settings panel.
 * Width is a CSS variable on the wide layout; below 720px the same
 * control sets the panel's row height. The canvas ResizeObserver
 * already follows either change.
 * @returns {void}
 */
function installPanelResizer() {
  const handle = document.querySelector("#panel-resizer");
  const panel = document.querySelector("#panel");
  if (!(handle instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;

  const stackedQuery = window.matchMedia("(max-width: 720px)");
  const stacked = () => stackedQuery.matches;

  const syncOrientation = () => {
    handle.setAttribute("aria-orientation", stacked() ? "horizontal" : "vertical");
  };

  const limits = () => {
    if (stacked()) {
      const max = Math.max(160, window.innerHeight - PANEL_STAGE_MIN - 6);
      return { min: 160, max };
    }
    const max = Math.max(PANEL_MIN, window.innerWidth - PANEL_STAGE_MIN - 6);
    return { min: PANEL_MIN, max };
  };

  const apply = (size) => {
    const { min, max } = limits();
    const next = Math.round(Math.min(max, Math.max(min, size)));
    if (stacked()) {
      document.body.style.gridTemplateRows = `minmax(0, 1fr) 6px ${next}px`;
      document.body.style.removeProperty("--panel-width");
    } else {
      document.body.style.removeProperty("grid-template-rows");
      document.body.style.setProperty("--panel-width", `${next}px`);
    }
    handle.setAttribute("aria-valuenow", String(next));
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    syncOrientation();
    return next;
  };

  syncOrientation();

  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) apply(saved);
  } catch {
    // Storage can be blocked; the CSS default width still applies.
  }

  const persist = (size) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(size));
    } catch {
      // Remembering the width is a convenience, not required to resize.
    }
  };

  /** @param {number} client */
  const sizeFromPointer = (client) => stacked()
    ? window.innerHeight - client - handle.offsetHeight / 2
    : window.innerWidth - client - handle.offsetWidth / 2;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("panel-resizing");
    const move = (ev) => {
      apply(sizeFromPointer(stacked() ? ev.clientY : ev.clientX));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      document.body.classList.remove("panel-resizing");
      persist(Number(handle.getAttribute("aria-valuenow")));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });

  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    const box = panel.getBoundingClientRect();
    const current = stacked() ? box.height : box.width;
    // Toward the stage grows the panel; toward the outer edge shrinks it.
    const grow = stacked() ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const shrink = stacked() ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (grow || shrink) {
      event.preventDefault();
      persist(apply(current + (grow ? step : -step)));
    } else if (event.key === "Home") {
      event.preventDefault();
      persist(apply(stacked() ? limits().max : limits().min));
    } else if (event.key === "End") {
      event.preventDefault();
      persist(apply(stacked() ? limits().min : limits().max));
    }
  });

  stackedQuery.addEventListener("change", () => {
    const saved = Number(handle.getAttribute("aria-valuenow"));
    if (Number.isFinite(saved)) apply(saved);
    else syncOrientation();
  });
  window.addEventListener("resize", () => {
    const saved = Number(handle.getAttribute("aria-valuenow"));
    if (Number.isFinite(saved)) apply(saved);
  });
}

const CHAT_HEIGHT_KEY = "yidhari.chatHeight";
const CHAT_FLOAT_KEY = "yidhari.chatFloat";
const CHAT_MIN_HEIGHT = 96;

/**
 * Let the side chat grow from its bottom edge, and float over the portrait.
 * Height and float position are remembered in this browser.
 * @returns {void}
 */
function installChatBox() {
  const box = document.querySelector("#chat-box");
  const log = document.querySelector("#chat-log");
  const resizer = document.querySelector("#chat-resizer");
  const drag = document.querySelector("#chat-drag");
  const floatButton = document.querySelector("#chat-float");
  if (!(box instanceof HTMLElement) || !(log instanceof HTMLElement) ||
      !(resizer instanceof HTMLElement) || !(drag instanceof HTMLElement) ||
      !(floatButton instanceof HTMLButtonElement)) return;

  const heightLimits = () => {
    const floating = box.classList.contains("floating");
    const max = floating
      ? Math.max(CHAT_MIN_HEIGHT, window.innerHeight - 48)
      : Math.max(CHAT_MIN_HEIGHT, window.innerHeight - 220);
    return { min: CHAT_MIN_HEIGHT, max };
  };

  const applyHeight = (size) => {
    const { min, max } = heightLimits();
    const next = Math.round(Math.min(max, Math.max(min, size)));
    box.style.setProperty("--chat-height", `${next}px`);
    resizer.setAttribute("aria-valuenow", String(next));
    resizer.setAttribute("aria-valuemin", String(min));
    resizer.setAttribute("aria-valuemax", String(max));
    return next;
  };

  const remember = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Remembering the chat layout is a convenience.
    }
  };

  try {
    const savedHeight = Number(localStorage.getItem(CHAT_HEIGHT_KEY));
    if (Number.isFinite(savedHeight) && savedHeight > 0) applyHeight(savedHeight);
  } catch {
    // Storage can be blocked; the CSS default height still applies.
  }

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizer.setPointerCapture(event.pointerId);
    const originY = event.clientY;
    const origin = log.getBoundingClientRect().height;
    document.body.classList.add("chat-resizing");
    const move = (ev) => applyHeight(origin + ev.clientY - originY);
    const stop = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
      document.body.classList.remove("chat-resizing");
      remember(CHAT_HEIGHT_KEY, resizer.getAttribute("aria-valuenow") ?? "");
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });

  resizer.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    const current = log.getBoundingClientRect().height;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      remember(CHAT_HEIGHT_KEY, String(applyHeight(current + step)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      remember(CHAT_HEIGHT_KEY, String(applyHeight(current - step)));
    }
  });

  const placeFloating = (x, y) => {
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const nextX = Math.round(Math.min(window.innerWidth - width - 8, Math.max(8, x)));
    const nextY = Math.round(Math.min(window.innerHeight - height - 8, Math.max(8, y)));
    box.style.left = `${nextX}px`;
    box.style.top = `${nextY}px`;
    return { x: nextX, y: nextY };
  };

  const setFloating = (floating, point) => {
    box.classList.toggle("floating", floating);
    floatButton.setAttribute("aria-pressed", String(floating));
    floatButton.textContent = floating ? "Dock" : "Float";
    drag.hidden = !floating;
    if (floating) {
      const start = point ?? { x: 24, y: 72 };
      const placed = placeFloating(start.x, start.y);
      remember(CHAT_FLOAT_KEY, JSON.stringify({ floating: true, ...placed }));
    } else {
      box.style.removeProperty("left");
      box.style.removeProperty("top");
      remember(CHAT_FLOAT_KEY, JSON.stringify({ floating: false }));
    }
    applyHeight(log.getBoundingClientRect().height);
  };

  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_FLOAT_KEY) ?? "null");
    if (saved?.floating === true) {
      setFloating(true, {
        x: Number(saved.x) || 24,
        y: Number(saved.y) || 72,
      });
    }
  } catch {
    // A bad saved position just leaves the chat docked.
  }

  floatButton.addEventListener("click", () => {
    const floating = !box.classList.contains("floating");
    setFloating(floating, floating ? { x: 24, y: 72 } : undefined);
  });

  drag.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !box.classList.contains("floating")) return;
    event.preventDefault();
    drag.setPointerCapture(event.pointerId);
    const originX = event.clientX - box.getBoundingClientRect().left;
    const originY = event.clientY - box.getBoundingClientRect().top;
    document.body.classList.add("chat-dragging");
    const move = (ev) => placeFloating(ev.clientX - originX, ev.clientY - originY);
    const stop = (ev) => {
      drag.removeEventListener("pointermove", move);
      drag.removeEventListener("pointerup", stop);
      drag.removeEventListener("pointercancel", stop);
      document.body.classList.remove("chat-dragging");
      const placed = placeFloating(ev.clientX - originX, ev.clientY - originY);
      remember(CHAT_FLOAT_KEY, JSON.stringify({ floating: true, ...placed }));
    };
    drag.addEventListener("pointermove", move);
    drag.addEventListener("pointerup", stop);
    drag.addEventListener("pointercancel", stop);
  });
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
 * Play or stop the saved speech sample. The mood stays as selected, but the
 * loop and sweep stop so the comparison is fixed for the whole sentence.
 * @returns {Promise<void>}
 */
async function toggleSpeech() {
  if (!speech) {
    return;
  }
  if (speech.playing) {
    stopSpeech("Stopped.");
    return;
  }
  expressions.stopLoop();
  audition.stopSweep();
  globalThis.__yidhariHold = null;
  speechButton.disabled = true;
  speechStatus.textContent = "Loading sample…";
  try {
    speechClip ??= speech.load(SPEECH_SAMPLE.audio, SPEECH_SAMPLE.track);
    const clip = await speechClip;
    await speech.play(clip);
    speechButton.textContent = "■ Stop";
    speechStatus.textContent = `Speaking in ${expressions.activeExpression}: ${clip.transcript ?? ""}`;
  } catch (error) {
    speechClip = null;
    console.error(error);
    speechStatus.textContent = error instanceof Error ? error.message : "Could not play the sample.";
  } finally {
    speechButton.disabled = false;
  }
}

speechButton.addEventListener("click", toggleSpeech);

/**
 * Stop the current clip, drop queued live clips, and reset the speech controls.
 * @param {string} message Status to show.
 * @returns {void}
 */
function stopSpeech(message) {
  liveRun += 1;
  speechQueue.length = 0;
  speech?.stop();
  speechButton.textContent = "▶ Play sample";
  speechStatus.textContent = message;
}

/**
 * Apply a mood from the bridge and mirror it in the intensity controls.
 * @param {string} name Catalog expression.
 * @param {number} weight Intensity from 0 to 1.
 * @returns {void}
 */
function applyMood(name, weight) {
  if (!expressions.setExpression(name, weight)) console.warn("Unavailable expression", name);
  intensityInput.value = String(weight);
  intensityOutput.value = weight.toFixed(2);
}

/**
 * Queue a live clip announced by the bridge. Loading starts now so decoding
 * overlaps the clip before it; the mood changes when this clip starts.
 * @param {{ id: string, expression: string, weight: number, text: string }} event Validated speak event.
 * @returns {void}
 */
function enqueueSpeech({ id, expression, weight, text }) {
  liveSpeech.clipQueued();
  const clip = speech.load(`${LIVE_CLIP_DIR}${id}.wav`, `${LIVE_CLIP_DIR}${id}.visemes.json`);
  clip.catch(() => {}); // Reported when its turn comes.
  speechQueue.push({ clip, expression, weight, text });
  if (!speech.playing && !speechStarting) {
    playNextSpeech();
  }
}

/**
 * Start the next playable queued clip. A failed clip is skipped, not fatal.
 * @returns {Promise<void>}
 */
async function playNextSpeech() {
  speechStarting = true;
  let run = liveRun;
  while (speechQueue.length > 0) {
    const next = speechQueue.shift();
    try {
      const clip = await next.clip;
      if (run !== liveRun) {
        // A new response or a stop arrived while loading; serve the current queue.
        run = liveRun;
        continue;
      }
      applyMood(next.expression, next.weight);
      await speech.play(clip);
      speechButton.textContent = "■ Stop";
      speechStatus.textContent = `Speaking (${next.expression}): ${next.text}`;
      break;
    } catch (error) {
      console.error(error);
      speechStatus.textContent = "Skipped a clip that could not be played.";
    }
  }
  speechStarting = false;
  if (!speech.playing) {
    // The last queued clip could not be played; the response may still be over.
    relaxAfterSpeech();
  }
}

/** @returns {boolean} Whether no clip is playing, loading or queued. */
function speechIdle() {
  return !speech.playing && !speechStarting && speechQueue.length === 0;
}

/**
 * Return the face to neutral once a live spoken response has fully finished.
 * Re-checks after the delay, so a new response or clip cancels the relax.
 * @returns {void}
 */
function relaxAfterSpeech() {
  if (!liveSpeech.shouldRelax(speechIdle())) {
    return;
  }
  const run = liveRun;
  setTimeout(() => {
    if (run === liveRun && liveSpeech.shouldRelax(speechIdle())) {
      liveSpeech.relaxed();
      applyMood("neutral", 1);
    }
  }, RELAX_DELAY_MS);
}

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
  speech = new SpeechPlayer(mesh, SPEECH_SHAPES);
  speech.onEnded = () => {
    if (speechQueue.length > 0) {
      playNextSpeech();
      return;
    }
    speechButton.textContent = "▶ Play sample";
    speechStatus.textContent = "Finished.";
    relaxAfterSpeech();
  };
  speechButton.disabled = false;
  if (speech.missingMorphs.length > 0) {
    speechStatus.textContent = `Missing speech morphs: ${speech.missingMorphs.join(", ")}`;
  }
  // Local preview hook for the morph test bench. Not part of the mood API.
  globalThis.__yidhariPreview = {
    expressions,
    audition,
    speech,
    speak: enqueueSpeech,
    /** Simulate the bridge ending a response (end, error or disconnect). */
    finish() {
      liveSpeech.responseFinished();
      relaxAfterSpeech();
    },
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
  setupGaze(mesh);

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
      stopSpeech("");
      liveSpeech.reset();
      audition.stopSweep();
      audition.clear();
      globalThis.__yidhariHold = null;
      for (const wink of Object.values(winks)) wink.target = 0;
      transcript.textContent = '';
    },
    onFinish: () => {
      for (const section of document.querySelectorAll('#panel > section:not(:first-child)')) section.inert = false;
      liveSpeech.responseFinished();
      relaxAfterSpeech();
    },
    onReset: () => {
      // Silence any reply still speaking; the bridge has already cancelled it.
      stopSpeech("");
      liveSpeech.reset();
      transcript.textContent = '';
    },
    onExpression: applyMood,
    onText: (text) => { transcript.textContent = (transcript.textContent + text).slice(-50000); },
    onSpeak: enqueueSpeech,
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
 * Every morph starts the frame at zero; each channel writes its own morphs,
 * speech blends over the mood's mouth, and the audition layer adds on top last.
 * @returns {void}
 */
function animate() {
  const now = performance.now();
  const delta = Math.min((now - previousFrame) / 1000, 0.1);
  previousFrame = now;
  controls.update();
  mesh?.morphTargetInfluences?.fill(0);
  expressions?.update(delta);
  speech?.update(delta);
  updateBlink(now / 1000);
  updateWinks(delta);
  applyGaze(delta);
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
installPanelResizer();
installChatBox();
renderer.setAnimationLoop(animate);
loadModel();
