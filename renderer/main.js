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
//   5. Sway the upper body on slow sine waves (see body-sway.js).
//   6. Audition every PMX morph on a manual layer (see morph-audition.js).
//   7. Play the saved speech sample with lip sync (see speech-player.js).
//   8. Pop out into an always-on-top window (see pop-out.js).
//
// What it does not own yet:
//   Live LLM speech, hand poses, hair/coat physics.
//
// Extension points:
//   restArms()  — add elbow, wrist, or finger rotations here.
//   updateBlink — copy this pattern for other morph weights.
//   applySway() — copy this pattern for other bone-motion layers.
//   animate()   — keep per-frame work here, not in the loader callback.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MMDLoader } from "three/addons/loaders/MMDLoader.js";
import { MMDPhysics } from "three/addons/animation/MMDPhysics.js";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";
import { loadExpressionCatalog } from "./expression-catalog.js";
import { readyStatus } from "./ready-status.js";
import { ExpressionController } from "./expression-controller.js";
import { MorphAudition, buildMorphInventory } from "./morph-audition.js";
import { AuditionPanel } from "./audition-panel.js";
import { connectBridge } from "./bridge-client.js";
import { SpeechPlayer, loadSpeechShapes } from "./speech-player.js";
import { VoiceVolume, bindVoiceVolume } from "./voice-volume.js";
import { LiveSpeechSession } from "./speech-session.js";
import { LastSpeechReplay, dropQueuedReplay, replayQueueItems } from "./speech-replay.js";
import { FillerSession } from "./filler-session.js";
import { ThinkingPose, THINKING_POSE, headGazeScale } from "./thinking-pose.js";
import { buildThinkingRig } from "./thinking-rig.js";
import { GazeController, normalisePointer, clampEyePitch } from "./gaze-tracking.js";
import { CameraGaze } from "./camera-gaze.js";
import { CameraControls } from "./camera-controls.js";
import { SWAY, SwayController, swayAnglesAt } from "./body-sway.js";
import { Spring, TIMING, frameDelta } from "./smoothing.js";
import { composeBlink, eyeClosure } from "./facial-layers.js";
import { GreetingGate, bindGreetingToggle } from "./greeting.js";
import { bindRestingFaceToggle } from "./resting-face.js";
import { addSeeThroughBrows, bindSeeThroughBrowsToggle } from "./see-through-brows.js";
import { installCollapsiblePanel } from "./collapsible-panel.js";
import { FrameLoop, PopOut, popupWindow } from "./pop-out.js";
import { IDLE_STATE_LABELS, IdleController, bindIdleSettings, idleBlocked } from "./idle-behaviour.js";
import { ACTION_LABELS, FACE_MORPHS, IDLE_MOTION, IdleMotion, bindActionSettings, manualPlayBlocked } from "./idle-motion.js";
import { fetchTurn, turnFile } from "./turn-replay.js";
import { createAmmoLoader } from "./ammo-loader.js";
import { filterPhysics } from "./physics-groups.js";
import { PhysicsLayer } from "./physics-layer.js";
import { bindStoredToggle } from "./stored-toggle.js";
import {
  HAIR_FOLLOW, RIGID_STRANDS, blendWeights, pinTargets, pinnedBones, sameMotionAs, stiffStrands,
} from "./weight-pins.js";

// Served by renderer/serve.py from the workspace root. Do not rename the PMX.
const MODEL_URL = "/yidhari-mmd/伊德海莉.pmx";
// Gitignored. Create the track with controller/speech_align.py.
const SPEECH_SAMPLE = {
  audio: "/assets/private/speech/sample-01.wav",
  track: "/assets/private/speech/sample-01.visemes.json",
};
// Clips without a turn (the local preview hook). Bridge clips live per turn (#152).
const LIVE_CLIP_DIR = "/assets/private/speech/live/";
const FILLER_DIR = "/assets/private/speech/filler/";
const BLINK_MORPH = "まばたき";
const WINK_MORPHS = { left: "ウィンク", right: "ウィンク右" };
// Camera distances in PMX units from the head bone.
const FRAMING = { bust: 13, face: 8 };

const statusEl = document.querySelector("#status");
const thinkingBubble = document.querySelector("#thinking-bubble");
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
const replayButton = document.querySelector("#speech-replay");
const replayStatus = document.querySelector("#speech-replay-status");
const voiceVolume = new VoiceVolume();
bindVoiceVolume(voiceVolume, {
  input: document.querySelector('#voice-volume'),
  output: document.querySelector('#voice-volume-value'),
  reset: document.querySelector('#voice-volume-reset'),
});
const expressionControls = document.querySelector("#expression-controls");
const winkButtons = document.querySelectorAll("#wink-controls button[data-wink]");
const loopButton = document.querySelector("#loop-button");
const editPresetButton = document.querySelector("#edit-preset-button");
const intensityInput = document.querySelector("#intensity");
const intensityOutput = document.querySelector("#intensity-value");
const blinkToggle = document.querySelector("#blink-toggle");
const swayToggle = document.querySelector("#sway-toggle");
const swayButton = document.querySelector("#sway-button");
const cursorGazeToggle = document.querySelector("#cursor-gaze-toggle");
const cameraGazeToggle = document.querySelector("#camera-gaze-toggle");
const restingFaceToggle = document.querySelector("#resting-face-toggle");
const seeThroughBrowsToggle = document.querySelector("#see-through-brows-toggle");
const physicsToggle = document.querySelector("#physics-toggle");
const chestPhysicsToggle = document.querySelector("#chest-physics-toggle");
const hipPhysicsToggle = document.querySelector("#hip-physics-toggle");
const physicsStatus = document.querySelector("#physics-status");
const physicsRateInput = document.querySelector("#physics-rate");
const physicsRateOutput = document.querySelector("#physics-rate-value");
const gazeStatus = document.querySelector("#gaze-status");
const idleToggle = document.querySelector("#idle-toggle");
const idleAfterInput = document.querySelector("#idle-after");
const sleepAfterInput = document.querySelector("#sleep-after");
const sleepActionEveryInput = document.querySelector("#sleep-action-every");
const idleStatus = document.querySelector("#idle-status");
const frameButtons = {
  face: document.querySelector("#frame-face-button"),
  bust: document.querySelector("#frame-bust-button"),
};
const panelEl = document.querySelector("#panel");
installCollapsiblePanel(panelEl);

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
/** @type {{ left: { index: number, spring: Spring, target: number }, right: { index: number, spring: Spring, target: number } }} */
const winks = {
  left: { index: -1, spring: new Spring(0), target: 0 },
  right: { index: -1, spring: new Spring(0), target: 0 },
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
/** @type {{ clip: Promise<import("./speech-player.js").SpeechClip>, expression: string, weight: number, text: string, filler?: boolean }[]} */
const speechQueue = [];
/** Bumped on every new response or stop, so stale clip loads are discarded. */
let liveRun = 0;
let speechTurn = 0;
let playingReplay = false;
let speechStarting = false;
let sampleStarting = false;
let replayStarting = false;
let chatResponding = false;
const lastSpeech = new LastSpeechReplay();
/** The chat log's replay buttons (#152), once the bridge client is connected. */
let bridgeControls = null;
const liveSpeech = new LiveSpeechSession();
const fillerSpeech = new FillerSession();
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
const thinkingPose = new ThinkingPose();
/** @type {{ bone: THREE.Bone, rest: THREE.Quaternion, posed: THREE.Quaternion }[]} */
let thinkingBones = [];
/** @type {{ bone: THREE.Bone, rest: THREE.Quaternion }[]} */
let swayBones = [];
const swayEuler = new THREE.Euler();
const swayQuat = new THREE.Quaternion();
/** Stop/start state for the sway button; mirrored onto the button label. */
const sway = new SwayController();
/** Idle-state timer (#71): sleepy after a long quiet, waking on activity. */
const idle = new IdleController();
bindIdleSettings(idle, { toggle: idleToggle, idleAfterInput, sleepAfterInput, sleepActionEveryInput });
/** Whether an agent ask is waiting for an answer; idle waits too. */
let askOpen = false;
/** The mood the idle controller last applied, so rest never overwrites someone else's. */
let idleMood = null;
let shownIdleState = null;
/** Glances, tilts, sighs and the stretch (#71), as a pose for this frame. */
const idleMotion = new IdleMotion();
let idlePose = idleMotion.update(0, "active", 0);
/**
 * One checkbox per action (#149), built from a registry so new actions appear by themselves.
 * @param {Record<string, string>} labels Label per action name.
 * @param {string} container Selector of the fieldset to fill.
 * @param {string} prefix Checkbox id prefix.
 * @returns {Record<string, HTMLInputElement>}
 */
function actionCheckboxes(labels, container, prefix) {
  const boxes = {};
  for (const [name, label] of Object.entries(labels)) {
    const row = document.createElement("label");
    row.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `${prefix}-${name}`;
    row.append(box, label);
    document.querySelector(container).append(row);
    boxes[name] = box;
  }
  return boxes;
}
bindActionSettings(idleMotion, actionCheckboxes(ACTION_LABELS, "#actions", "action"));

/**
 * One play button per action label (#164), disabled until refreshActionPlay
 * allows them. A click plays that action once; the same button again stops it.
 * @param {Record<string, string>} labels ACTION_LABELS.
 * @param {string} container Selector of the button grid.
 * @returns {Record<string, HTMLButtonElement>}
 */
function actionPlayButtons(labels, container) {
  const buttons = {};
  for (const [name, label] of Object.entries(labels)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = name;
    button.textContent = label;
    button.disabled = true;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      idleMotion.toggle(name);
      refreshActionPlay();
    });
    document.querySelector(container).append(button);
    buttons[name] = button;
  }
  return buttons;
}
const actionButtons = actionPlayButtons(ACTION_LABELS, "#action-play-controls");
const actionPlayStatus = document.querySelector("#action-play-status");
let shownActionPlay = null;

/**
 * Gate the play buttons each frame and stop a playing action when they are
 * gated: before the model, idle off, blocked, a held pose, stretching or waking.
 * @returns {void}
 */
function refreshActionPlay() {
  const reason = manualPlayBlocked({
    loaded: Boolean(mesh && expressions),
    idleEnabled: idle.enabled,
    blocked: idle.blocked,
    held: Boolean(globalThis.__yidhariIdlePose),
    state: idle.state,
  });
  if (reason) idleMotion.stop();
  const playing = idleMotion.playing;
  const shown = `${reason}|${playing}`;
  if (shown === shownActionPlay) return;
  shownActionPlay = shown;
  for (const [name, button] of Object.entries(actionButtons)) {
    button.disabled = Boolean(reason);
    button.setAttribute("aria-pressed", String(playing === name));
  }
  actionPlayStatus.textContent = reason
    ?? (playing ? `Playing: ${ACTION_LABELS[playing]}` : "Ready: click an action to play it once");
}
/**
 * Idle motion bones: which angle of the pose each one takes, and its sign
 * (checked on the model: negative pitch leans back, see docs/idle-behaviours.md).
 * Bones another layer rewrites each frame get the delta on top of that layer;
 * the shoulders have no other writer, so they keep their own rest.
 */
const IDLE_BONES = Object.freeze([
  { name: "上半身", pitch: [["back", -1]], roll: [["lean", 1]] },
  { name: "上半身2", pitch: [["chest", -1]], roll: [["shiverWave", 1]] },
  { name: "首", pitch: [["headPitch", -0.4]] },
  { name: "頭", pitch: [["headPitch", -0.6], ["bobPitch", 1]], roll: [["tilt", 1], ["bobRoll", 1]] },
  // Her left shoulder is on the right of the screen (#149 shrugs are named by screen side).
  { name: "左肩", roll: [["shoulders", -1], ["shoulderRight", -1], ["shiverWave", -0.8]], own: true },
  { name: "右肩", roll: [["shoulders", 1], ["shoulderLeft", 1], ["shiverWave", 0.8]], own: true },
]);
/** @type {{ bone: THREE.Bone, rest: THREE.Quaternion | null, pitch?: [string, number][], roll?: [string, number][] }[]} */
let idleBones = [];
const idleEuler = new THREE.Euler();
const idleQuat = new THREE.Quaternion();
// Only conversation keeps her awake: sent chat, voice input and bridge events.
// The mouse, keys and cursor gaze do not (see docs/idle-behaviours.md).
// Activity also ends an action played from the panel (#164), without the panel waking her.
const noteActivity = () => {
  idle.activity();
  idleMotion.stop();
};
const cameraGaze = new CameraGaze((target) => gaze.setCamera(target, cameraGazeToggle.checked));
const cameraControls = new CameraControls({
  camera: cameraGaze,
  toggle: cameraGazeToggle,
  select: document.querySelector("#camera-device"),
  refresh: document.querySelector("#camera-device-refresh"),
  status: gazeStatus,
  onEnabled: (enabled) => gaze.setCamera(null, enabled),
});
window.addEventListener("pagehide", () => cameraControls.interrupted(""));

/**
 * Only the window that shows the canvas has matching pointer coordinates,
 * which is the floating window while she is popped out.
 * @param {PointerEvent} event Pointer event from either window.
 * @returns {boolean}
 */
function overCanvasWindow(event) {
  return !event.view || event.view === canvas.ownerDocument.defaultView;
}

/** @param {PointerEvent} event */
function followCursor(event) {
  if (!overCanvasWindow(event)) return;
  const rect = canvas.getBoundingClientRect();
  gaze.setCursor(
    normalisePointer(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height),
    cursorGazeToggle.checked,
  );
}

/** @param {PointerEvent} event */
function centreCursor(event) {
  if (overCanvasWindow(event)) gaze.setCursor({ x: 0, y: 0 }, cursorGazeToggle.checked);
}

window.addEventListener("pointermove", followCursor);
window.addEventListener("pointerleave", centreCursor);
cursorGazeToggle.addEventListener("change", () => gaze.setCursor({ x: 0, y: 0 }, cursorGazeToggle.checked));

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
  cameraControls.setAvailable(hasEyes);
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
  // The chin-rest hand is solved against the resting head, so the head follows less while it is up.
  const headScale = headGazeScale(thinkingPose.weight);
  for (const { name, bone, rest } of gazeBones) {
    const isEye = name === "左目" || name === "右目";
    const yaw = isEye ? angles.eyeYaw : angles.headYaw * headScale;
    const pitch = isEye
      ? clampEyePitch(angles.eyePitch, thinkingPose.weight * THINKING_POSE.eyePitch)
      : angles.headPitch * headScale;
    gazeEuler.set(pitch, yaw, 0, "YXZ");
    bone.quaternion.copy(rest).multiply(gazeQuat.setFromEuler(gazeEuler));
  }
}

/** Cache the lowered-arm rest pose and a supported chin-rest pose. */
function setupThinkingPose(object) {
  thinkingBones = buildThinkingRig(object);
}

/** Blend the hand-to-chin gesture over the lowered-arm rest pose. */
function applyThinkingPose(delta) {
  const weight = thinkingPose.update(delta);
  for (const { bone, rest, posed } of thinkingBones) {
    bone.quaternion.copy(rest).slerp(posed, weight);
  }
}

/**
 * Capture the sway bones and their rest quaternions for body sway.
 * Runs after restArms() so the lowered-arm pose is the sway's rest state.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @returns {void}
 */
function setupSway(object) {
  swayBones = [];
  for (const name of [SWAY.roll.bone, SWAY.yaw.bone, SWAY.breath.bone]) {
    const bone = object.skeleton?.getBoneByName(name);
    if (bone && !swayBones.some(({ bone: known }) => known === bone)) {
      swayBones.push({ bone, rest: bone.quaternion.clone() });
    }
  }
  swayToggle.disabled = swayBones.length === 0;
  swayButton.disabled = swayBones.length === 0;
}

/**
 * Capture the idle motion bones (#71). Runs after restArms() and the gaze and
 * sway setup, so their rest poses are the lowered-arm pose.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @returns {void}
 */
function setupIdleMotion(object) {
  idleBones = [];
  for (const { name, pitch, roll, own } of IDLE_BONES) {
    const bone = object.skeleton?.getBoneByName(name);
    if (bone) idleBones.push({ bone, rest: own ? bone.quaternion.clone() : null, pitch, roll });
  }
}

/**
 * Add the idle actions' face channels (#71, #149) on top of the mood, speech
 * and wink-button morphs written this frame; it runs after updateWinks(),
 * which sets the wink morphs outright. Speech blocks idle, so the yawn has
 * eased shut before visemes take the mouth.
 * @returns {void}
 */
function applyYawn() {
  if (!mesh) return;
  const influences = mesh.morphTargetInfluences;
  // Every face channel of the idle actions (#71, #149): yawn, squint, winks, smile, wide eyes.
  for (const [channel, morphs] of Object.entries(FACE_MORPHS)) {
    const amount = idlePose[channel];
    if (!(amount > 0)) continue;
    for (const [name, weight] of Object.entries(morphs)) {
      const index = mesh.morphTargetDictionary[name];
      if (index !== undefined) influences[index] = Math.min(1, influences[index] + amount * weight);
    }
  }
}

/**
 * Multiply this frame's idle motion on top of the gaze and sway layers.
 * Those layers rewrite their bones every frame, so nothing accumulates.
 * @returns {void}
 */
function applyIdleMotion() {
  const sum = (parts = []) => parts.reduce((total, [key, sign]) => total + (idlePose[key] ?? 0) * sign, 0);
  for (const { bone, rest, pitch, roll } of idleBones) {
    const x = sum(pitch);
    const z = sum(roll);
    if (rest) bone.quaternion.copy(rest);
    if (x === 0 && z === 0) continue;
    idleEuler.set(x, 0, z, "YXZ");
    bone.quaternion.multiply(idleQuat.setFromEuler(idleEuler));
  }
}

/**
 * Reflect the stop/start state in the sway button.
 * @returns {void}
 */
function updateSwayButton() {
  swayButton.setAttribute("aria-pressed", String(sway.enabled));
  swayButton.textContent = sway.enabled ? "⏸ sway" : "▶ sway";
}

/**
 * Stop or start the body sway from its button, keeping the checkbox in sync.
 * The pose fades back to rest because applySway scales the angles by the sway gain.
 * @returns {void}
 */
function toggleSway() {
  sway.setEnabled(!sway.enabled);
  swayToggle.checked = sway.enabled;
  updateSwayButton();
}

swayButton.addEventListener("click", toggleSway);
swayToggle.addEventListener("change", () => {
  sway.setEnabled(swayToggle.checked);
  updateSwayButton();
});

/**
 * Apply the slow sine-wave sway for this frame.
 * Each bone fades toward its rest pose when the toggle is off, and each
 * channel multiplies a small delta on top of rest so the lowered-arm pose
 * and the gaze layer are never overwritten.
 * @param {number} now Seconds since the animation clock started.
 * @param {number} delta Seconds elapsed since the previous frame.
 * @returns {void}
 */
function applySway(now, delta) {
  if (!swayBones.length) {
    return;
  }
  const gain = sway.update(delta);
  const angles = swayAnglesAt(now);
  for (const { bone, rest } of swayBones) {
    const pitch = bone.name === SWAY.breath.bone ? angles.breath * gain : 0;
    const yaw = bone.name === SWAY.yaw.bone ? angles.yaw * gain : 0;
    const roll = bone.name === SWAY.roll.bone ? angles.roll * gain : 0;
    swayEuler.set(pitch, yaw, roll, "YXZ");
    bone.quaternion.copy(rest).multiply(swayQuat.setFromEuler(swayEuler));
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
 * Neither may write an inline CSS size: the stylesheet sizes the canvas,
 * in the page and in the pop-out window alike.
 * @returns {void}
 */
function resize() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  outline.setSize(width, height, false);
}

const PANEL_WIDTH_KEY = "yidhari.panelWidth";
const PANEL_MIN = 280;
const PANEL_STAGE_MIN = 280;

/**
 * Drag the divider between the portrait and the settings panel.
 * Width is a CSS variable on the wide layout; below 720px the same
 * control sets the panel's row height. The canvas ResizeObserver
 * already follows either change.
 * The divider may be in the pop-out window, so sizes and layout come from
 * whichever window holds it now.
 * @returns {{ refresh(): void }} Re-apply the saved size, e.g. after moving windows.
 */
function installPanelResizer() {
  const handle = document.querySelector("#panel-resizer");
  const panel = document.querySelector("#panel");
  if (!(handle instanceof HTMLElement) || !(panel instanceof HTMLElement)) return { refresh() {} };

  const view = () => handle.ownerDocument.defaultView;
  const body = () => handle.ownerDocument.body;
  const STACKED = "(max-width: 720px)";
  const stacked = () => view().matchMedia(STACKED).matches;

  const syncOrientation = () => {
    handle.setAttribute("aria-orientation", stacked() ? "horizontal" : "vertical");
  };

  const limits = () => {
    if (stacked()) {
      const max = Math.max(160, view().innerHeight - PANEL_STAGE_MIN - 6);
      return { min: 160, max };
    }
    const max = Math.max(PANEL_MIN, view().innerWidth - PANEL_STAGE_MIN - 6);
    return { min: PANEL_MIN, max };
  };

  const apply = (size) => {
    const { min, max } = limits();
    const next = Math.round(Math.min(max, Math.max(min, size)));
    if (stacked()) {
      body().style.gridTemplateRows = `minmax(0, 1fr) 6px ${next}px`;
      body().style.removeProperty("--panel-width");
    } else {
      body().style.removeProperty("grid-template-rows");
      body().style.setProperty("--panel-width", `${next}px`);
    }
    handle.setAttribute("aria-valuenow", String(next));
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    syncOrientation();
    return next;
  };

  syncOrientation();

  // The size the user chose. A small window (such as the pop-out) clamps
  // what is shown, but must not overwrite this choice.
  /** @type {number | null} */
  let preferred = null;

  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      preferred = saved;
      apply(saved);
    }
  } catch {
    // Storage can be blocked; the CSS default width still applies.
  }

  const persist = (size) => {
    preferred = size;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(size));
    } catch {
      // Remembering the width is a convenience, not required to resize.
    }
  };

  /** @param {number} client */
  const sizeFromPointer = (client) => stacked()
    ? view().innerHeight - client - handle.offsetHeight / 2
    : view().innerWidth - client - handle.offsetWidth / 2;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    body().classList.add("panel-resizing");
    const move = (ev) => {
      apply(sizeFromPointer(stacked() ? ev.clientY : ev.clientX));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      body().classList.remove("panel-resizing");
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

  const refresh = () => {
    if (preferred !== null) apply(preferred);
    else syncOrientation();
  };
  // The main window's own changes; onPopOut() wires the floating window's.
  window.matchMedia(STACKED).addEventListener("change", refresh);
  window.addEventListener("resize", refresh);
  return { refresh };
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

  // The chat box may be in the pop-out window; measure the window it is in.
  const view = () => box.ownerDocument.defaultView;
  const body = () => box.ownerDocument.body;

  const heightLimits = () => {
    const floating = box.classList.contains("floating");
    const max = floating
      ? Math.max(CHAT_MIN_HEIGHT, view().innerHeight - 48)
      : Math.max(CHAT_MIN_HEIGHT, view().innerHeight - 220);
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
    body().classList.add("chat-resizing");
    const move = (ev) => applyHeight(origin + ev.clientY - originY);
    const stop = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
      body().classList.remove("chat-resizing");
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
    const nextX = Math.round(Math.min(view().innerWidth - width - 8, Math.max(8, x)));
    const nextY = Math.round(Math.min(view().innerHeight - height - 8, Math.max(8, y)));
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
    body().classList.add("chat-dragging");
    const move = (ev) => placeFloating(ev.clientX - originX, ev.clientY - originY);
    const stop = (ev) => {
      drag.removeEventListener("pointermove", move);
      drag.removeEventListener("pointerup", stop);
      drag.removeEventListener("pointercancel", stop);
      body().classList.remove("chat-dragging");
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
  // Sleepy blinks (#71) come further apart and close and open more slowly.
  const { interval, duration } = idle.blinkScale;
  blink = {
    start: now + (2.2 + Math.random() * 3.4) * interval,
    close: 0.07 * duration,
    hold: 0.05 * duration,
    open: 0.11 * duration,
  };
}

/**
 * Advance the idle-state timer (#71) and apply its moods.
 * Speech, thinking, an open ask, a streaming reply or a morph audition block it.
 * The mood preview loop that starts on load does not: turning sleepy stops it.
 * @param {{ real: number, eased: number }} delta Real (uncapped) and eased (capped) frame seconds.
 * @returns {void}
 */
function updateIdle(delta) {
  if (!expressions) return;
  idle.setBlocked(idleBlocked({
    speaking: !speechIdle(),
    chatResponding,
    askOpen,
    previewing: Boolean(audition?.sweeping || globalThis.__yidhariHold),
    mood: expressions.activeExpression,
    looping: expressions.looping,
  }));
  for (const action of idle.update(delta.real)) {
    if (action.type === "mood") {
      applyMood(action.name, action.weight);
      idleMood = action.name;
      continue;
    }
    // Rest only if her face still shows the idle mood and nothing is speaking.
    if (idleMood && expressions.activeExpression === idleMood && speechIdle()) {
      applyMood(liveSpeech.restMood.name, liveSpeech.restMood.weight);
    }
    idleMood = null;
  }
  refreshActionPlay();
  // A held pose lets previews and comparison grids show one motion on demand.
  idlePose = globalThis.__yidhariIdlePose
    ? { glance: null, tilt: 0, chest: 0, shoulders: 0, shoulderLeft: 0, shoulderRight: 0, back: 0, headPitch: 0, yawn: 0, squint: 0, winkLeft: 0, winkRight: 0, mouthLift: 0, surprise: 0,
      shiver: 0, shiverWave: 0, smile: 0, browRaise: 0, hum: 0, bobPitch: 0, bobRoll: 0, lean: 0, shy: 0, exhale: 0,
      ...globalThis.__yidhariIdlePose }
    : idleMotion.update(delta.eased, idle.state, idle.stateTime, idle.timing.sleepActionEvery);
  gaze.setIdle(idlePose.glance);
  if (idle.state !== shownIdleState) {
    shownIdleState = idle.state;
    idleStatus.textContent = `Idle state: ${IDLE_STATE_LABELS[idle.state]}`;
  }
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
 * Combine the idle blink with what the mood and winks already wrote this frame.
 * A mood's own blink weight survives, and closed eyes do not blink on top.
 * @param {number} now Current performance time in seconds.
 * @returns {void}
 */
function updateBlink(now) {
  if (blinkIndex < 0 || !mesh) {
    return;
  }
  const weight = blinkToggle.checked ? blinkWeightAt(now) : 0;
  const influences = mesh.morphTargetInfluences;
  influences[blinkIndex] = composeBlink(influences[blinkIndex], weight, eyeClosure(mesh));
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
  for (const wink of Object.values(winks)) {
    if (wink.index < 0) {
      continue;
    }
    wink.spring.step(wink.target, delta, TIMING.wink);
    mesh.morphTargetInfluences[wink.index] = wink.spring.clamp(0, 1);
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
    syncThinkingState();
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
  syncThinkingState();
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
  clearToBareMesh();
  syncThinkingState();
}

/**
 * Clear the mood and rest on the bare mesh, so slider weights show on their own
 * instead of on top of the resting face (#99). Not saved: a reload restores it.
 * @returns {void}
 */
function clearToBareMesh() {
  expressions.setExpression("neutral");
  if (expressions.restingFace !== null && expressions.setRestingFace(null)) {
    restingFaceToggle.checked = false;
  }
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
  const run = liveRun;
  sampleStarting = true;
  syncReplayControls();
  speechButton.disabled = true;
  speechStatus.textContent = "Loading sample…";
  try {
    speechClip ??= speech.load(SPEECH_SAMPLE.audio, SPEECH_SAMPLE.track);
    const clip = await speechClip;
    if (run !== liveRun || !await speech.play(clip) || run !== liveRun) return;
    speechButton.textContent = "■ Stop";
    speechStatus.textContent = `Speaking in ${expressions.activeExpression}: ${clip.transcript ?? ""}`;
  } catch (error) {
    speechClip = null;
    console.error(error);
    speechStatus.textContent = error instanceof Error ? error.message : "Could not play the sample.";
  } finally {
    sampleStarting = false;
    speechButton.disabled = false;
    syncReplayControls();
  }
}

speechButton.addEventListener("click", toggleSpeech);

/** Replay never contacts the bridge, changes chat history, or answers a pending ask. */
function replayLastSpeech() {
  if (replayButton.disabled || lastSpeech.entries.length === 0) return;
  replayStarting = true;
  syncReplayControls();
  expressions.stopLoop();
  audition.stopSweep();
  globalThis.__yidhariHold = null;
  speechQueue.push(...replayQueueItems(lastSpeech.entries));
  liveSpeech.clipQueued();
  liveSpeech.responseFinished();
  replayStarting = false;
  playNextSpeech();
}

replayButton.addEventListener("click", replayLastSpeech);

/**
 * Replay one chat bubble's turn from disk (#152). Like replayLastSpeech it never
 * contacts the bridge, changes chat history, or answers a pending ask. Clips are
 * loaded now and dropped after playback, so memory holds only this turn.
 * @param {string} turn Validated turn ID from the chat log.
 * @returns {Promise<void>}
 */
async function replayTurn(turn) {
  if (!speech || chatResponding || !speechIdle()) return;
  const run = liveRun;
  replayStarting = true;
  syncReplayControls();
  speechStatus.textContent = "Loading replay…";
  try {
    const { status, clips } = await fetchTurn(turn, { catalog: EXPRESSION_CATALOG });
    if (status === "gone") {
      bridgeControls?.turnGone(turn);
      speechStatus.textContent = "That message is too old to replay.";
      return;
    }
    if (status === "empty") {
      bridgeControls?.turnEmpty(turn);
      speechStatus.textContent = "That message has no audio to replay.";
      return;
    }
    // Live speech or a new reply took the lane while the manifest loaded.
    if (run !== liveRun || chatResponding || speech.playing || speechStarting || speechQueue.length > 0) {
      speechStatus.textContent = "";
      return;
    }
    expressions.stopLoop();
    audition.stopSweep();
    globalThis.__yidhariHold = null;
    for (const item of clips) {
      const clip = speech.load(turnFile(turn, `${item.id}.wav`), turnFile(turn, `${item.id}.visemes.json`));
      clip.catch(() => {}); // Reported when its turn comes.
      speechQueue.push({ clip, expression: item.expression, weight: item.weight, text: item.text, replay: true });
    }
    liveSpeech.clipQueued();
    liveSpeech.responseFinished();
  } catch (error) {
    console.error(error);
    speechStatus.textContent = "Could not load that replay.";
    return;
  } finally {
    replayStarting = false;
    syncReplayControls();
  }
  playNextSpeech();
}

/** Keep replay out of the shared speech lane while playback or a chat reply is busy. */
function syncReplayControls() {
  const retained = lastSpeech.entries.length > 0;
  replayButton.disabled = !speech || !retained || chatResponding || !speechIdle();
  bridgeControls?.setReplayEnabled(Boolean(speech) && !chatResponding && speechIdle());
  replayStatus.textContent = retained
    ? (replayButton.disabled
      ? "Replay available when speech is idle."
      : (lastSpeech.partial
        ? "Replay keeps the start of the last turn. The rest was too long."
        : "Replay the last spoken turn, from the beginning."))
    : (lastSpeech.expired ? "The latest turn was too long to keep for replay." : "No speech to replay yet.");
}

/**
 * Stop the current clip, drop queued live clips, and reset the speech controls.
 * @param {string} message Status to show.
 * @returns {void}
 */
function stopSpeech(message) {
  liveRun += 1;
  playingReplay = false;
  speechQueue.length = 0;
  fillerSpeech.reset();
  speech?.stop();
  speechButton.textContent = "▶ Play sample";
  speechStatus.textContent = message;
  syncReplayControls();
}

/** Keep the thinking gesture and bubble on the same path for previews and bridge moods. */
function syncThinkingState() {
  const active = expressions?.activeExpression === "thinking" && Number(intensityInput.value) > 0;
  thinkingPose.setActive(active);
  thinkingBubble.hidden = !active;
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
  syncThinkingState();
}

/**
 * Queue a live clip announced by the bridge. Loading starts now so decoding
 * overlaps the clip before it; the mood changes when this clip starts.
 * @param {{ id: string, expression: string, weight: number, text: string, turn?: string }} event Validated speak event.
 * @returns {void}
 */
function enqueueSpeech({ id, expression, weight, text, turn: diskTurn }) {
  const kept = dropQueuedReplay(speechQueue);
  speechQueue.length = 0;
  speechQueue.push(...kept);
  const interruptReplay = playingReplay;
  playingReplay = false;
  liveSpeech.clipQueued();
  const fillerId = fillerSpeech.takeForAnswer();
  if (fillerId !== null) {
    const filler = speech.load(`${FILLER_DIR}${fillerId}.wav`, `${FILLER_DIR}${fillerId}.visemes.json`);
    filler.catch(() => {}); // Reported when its turn comes.
    speechQueue.push({ clip: filler, expression: "thinking", weight: 0.6, text: "Hmm…", filler: true });
  }
  const clip = diskTurn
    ? speech.load(turnFile(diskTurn, `${id}.wav`), turnFile(diskTurn, `${id}.visemes.json`))
    : speech.load(`${LIVE_CLIP_DIR}${id}.wav`, `${LIVE_CLIP_DIR}${id}.visemes.json`);
  clip.catch(() => {}); // Reported when its turn comes.
  speechQueue.push({ clip, expression, weight, text, turn: speechTurn });
  if (interruptReplay) speech.stop();
  if (interruptReplay || (!speech.playing && !speechStarting)) playNextSpeech();
  syncReplayControls();
}

/**
 * Start the next playable queued clip. A failed clip is skipped, not fatal.
 * @returns {Promise<void>}
 */
async function playNextSpeech() {
  speechStarting = true;
  syncReplayControls();
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
      const started = await speech.play(clip);
      if (run !== liveRun) {
        run = liveRun;
        continue;
      }
      if (!started) continue;
      if (!next.filler && !next.replay) lastSpeech.remember({ ...next, clip, turn: next.turn });
      playingReplay = Boolean(next.replay);
      speechButton.textContent = "■ Stop";
      speechStatus.textContent = `${next.replay ? "Replaying" : "Speaking"} (${next.expression}): ${next.text}`;
      break;
    } catch (error) {
      console.error(error);
      speechStatus.textContent = "Skipped a clip that could not be played.";
    }
  }
  speechStarting = false;
  syncReplayControls();
  if (!speech.playing) {
    // The last queued clip could not be played; the response may still be over.
    relaxAfterSpeech();
  }
}

/** @returns {boolean} Whether no clip is playing, loading or queued. */
function speechIdle() {
  return !speech?.playing && !speechStarting && !sampleStarting && !replayStarting && speechQueue.length === 0;
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
      applyMood(liveSpeech.restMood.name, liveSpeech.restMood.weight);
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
    swayToggle, swayButton, frameButtons.face, frameButtons.bust]) {
    control.disabled = false;
  }
  blinkToggle.disabled = blinkIndex < 0;
  expressions = new ExpressionController(mesh, EXPRESSION_CATALOG);
  bindRestingFaceToggle(expressions, restingFaceToggle);
  restingFaceToggle.disabled = !expressions.isAvailable("calm");
  seeThroughBrowsToggle.disabled = false;
  bindSeeThroughBrowsToggle(addSeeThroughBrows(mesh), seeThroughBrowsToggle);
  expressions.startLoop(3, Number(intensityInput.value));
  audition = new MorphAudition(mesh, buildMorphInventory(data, mesh));
  speech = new SpeechPlayer(mesh, SPEECH_SHAPES, voiceVolume);
  speech.onEnded = () => {
    playingReplay = false;
    if (speechQueue.length > 0) {
      playNextSpeech();
      return;
    }
    speechButton.textContent = "▶ Play sample";
    speechStatus.textContent = "Finished.";
    syncReplayControls();
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
    physics,
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
      clearToBareMesh();
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
    onTakeover: clearToBareMesh,
  });
  restArms(mesh);
  setupGaze(mesh);
  setupThinkingPose(mesh);
  setupSway(mesh);
  setupIdleMotion(mesh);
  pinStrands(mesh, data);
  setupPhysics(mesh, data);

  const morphCount = mesh.morphTargetInfluences?.length ?? 0;
  const unavailable = [];
  for (const button of expressionButtons) {
    const name = button.dataset.expression;
    button.disabled = !expressions.isAvailable(name);
    if (button.disabled) {
      unavailable.push([name, expressions.getMissingMorphs(name)]);
    }
  }
  setStatus(readyStatus({ moods: expressionButtons.length, morphs: morphCount, unavailable }));
  scheduleBlink(performance.now() / 1000);
  const transcript = document.querySelector('#bridge-transcript');
  // Page-open greeting (#72): claimed once per page load here, shown on first connect.
  const greetingGate = bindGreetingToggle(new GreetingGate(), document.querySelector('#greeting-toggle'));
  bridgeControls = connectBridge({
    catalog: EXPRESSION_CATALOG,
    onReplayTurn: replayTurn,
    greeting: greetingGate.claim(new Date()),
    onGreeting: ({ mood, weight }) => { expressions.stopLoop(); applyMood(mood, weight); },
    onStart: () => {
      chatResponding = true;
      for (const section of panelEl.querySelectorAll(':scope > section:not(:first-child)')) section.inert = true;
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
      chatResponding = false;
      for (const section of panelEl.querySelectorAll(':scope > section:not(:first-child)')) section.inert = false;
      liveSpeech.responseFinished();
      relaxAfterSpeech();
      syncReplayControls();
    },
    onReset: () => {
      // Silence any reply still speaking; the bridge has already cancelled it.
      lastSpeech.clear();
      stopSpeech("");
      liveSpeech.reset();
      applyMood("neutral", 1);
      transcript.textContent = '';
    },
    onExpression: applyMood,
    onText: (text) => { transcript.textContent = (transcript.textContent + text).slice(-50000); },
    onFiller: ({ id }) => fillerSpeech.reserve(id),
    onSpeak: enqueueSpeech,
    onTurn: () => { speechTurn += 1; },
    onAgentSay: (chatBusy) => {
      // The bubble arrives when the item is queued. The turn opens on the later turn event.
      if (!chatBusy) liveSpeech.responseFinished();
    },
    onAgentMood: (name, weight) => {
      liveSpeech.setRestMood(name, weight);
      if (speechIdle()) applyMood(name, weight);
    },
    onActivity: noteActivity,
    onAskChange: (open) => { askOpen = open; },
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

// Hair, hat, tail and accessory physics (#114). See docs/physics.md.
const loadAmmo = createAmmoLoader({ url: import.meta.resolve("three/addons/libs/ammo.wasm.js") });
let resolvePhysicsModel;
/** Resolves with the mesh and parsed PMX once the rest pose is captured. */
const physicsModel = new Promise((resolve) => { resolvePhysicsModel = resolve; });
/** One Ammo world shared by every rebuild, since MMDPhysics has no dispose(). */
let physicsWorld = null;
/** Bones driven by dynamic bodies, with their rest pose. */
let physicsBones = [];

/**
 * Build MMDPhysics for the enabled groups. Waits for Ammo and the model, so
 * the Ammo download runs alongside the PMX load.
 * @param {Set<string>} groups Enabled physics group ids.
 * @returns {Promise<import("./physics-layer.js").PhysicsRun>}
 */
async function buildPhysics(groups) {
  const [, { object, data }] = await Promise.all([loadAmmo(), physicsModel]);
  const rigBones = data.bones.map((bone) => ({ name: bone.name, parent: bone.parentIndex }));
  // The loader's copies, not the raw PMX: it turns 40 physics+bone (type 2)
  // chain bodies into type 1, which stops them vibrating against their parent.
  const loaded = object.geometry.userData.MMD;
  // Only the curl's root keeps physics; the rest of the spiral follows it rigidly.
  const rigid = pinnedBones(rigBones, RIGID_STRANDS);
  const filtered = filterPhysics(loaded.rigidBodies, loaded.constraints, groups,
    { drop: (body) => rigid.has(body.boneIndex) });
  if (filtered.orphaned.length > 0) {
    console.warn(`Physics: dropped ${filtered.orphaned.length} bodies with no anchor left`, filtered.orphaned);
  }
  const physics = new MMDPhysics(object, filtered.rigidBodies, filtered.constraints,
    physicsWorld ? { world: physicsWorld } : {});
  physicsWorld = physics.world;
  return {
    update: (delta) => physics.update(delta),
    reset: () => physics.reset(),
    warmup: (cycles) => physics.warmup(cycles),
    setStep({ unitStep, maxStepNum }) {
      physics.unitStep = unitStep;
      physics.maxStepNum = maxStepNum;
    },
    dispose() {
      for (const constraint of physics.constraints) physicsWorld.removeConstraint(constraint.constraint);
      for (const body of physics.bodies) physicsWorld.removeRigidBody(body.body);
    },
  };
}

/**
 * Put every physics-driven bone back at its rest pose, for when physics stops.
 * @returns {void}
 */
function restorePhysicsBones() {
  for (const { bone, quaternion, position } of physicsBones) {
    bone.quaternion.copy(quaternion);
    bone.position.copy(position);
  }
}

const physics = new PhysicsLayer({ build: buildPhysics, restoreBones: restorePhysicsBones });

/** @returns {void} */
function showPhysicsStatus() {
  const text = {
    off: "",
    loading: "Loading physics…",
    on: "",
    error: `Physics unavailable: ${physics.error?.message ?? "unknown error"}`,
  };
  physicsStatus.textContent = text[physics.status] ?? "";
}
/** Longest the model stays hidden while physics loads on a cold start. */
const PHYSICS_REVEAL_TIMEOUT_MS = 5000;
let physicsRevealTimer = 0;

/**
 * Show the model once physics has settled (or failed, or been switched off),
 * so the tails' drop from the bind pose never shows on screen.
 * @returns {void}
 */
function revealModel() {
  clearTimeout(physicsRevealTimer);
  if (mesh) mesh.visible = true;
}

physics.onStatus = () => {
  showPhysicsStatus();
  if (physics.status !== "loading") revealModel();
};

bindStoredToggle(physicsToggle, "yidhari.physics", (on) => physics.setEnabled(on));
const PHYSICS_RATE_KEY = "yidhari.physics.rate";

/**
 * Show and apply the physics step rate, and remember it when storage allows.
 * @param {unknown} rate Steps per second.
 * @param {boolean} save Whether to store it.
 * @returns {void}
 */
function applyPhysicsRate(rate, save) {
  physics.setStepRate(rate);
  physicsRateInput.value = String(physics.stepRate);
  physicsRateOutput.textContent = `${physics.stepRate} /s`;
  if (!save) return;
  try { localStorage.setItem(PHYSICS_RATE_KEY, String(physics.stepRate)); } catch { /* Session-only. */ }
}

let storedPhysicsRate = null;
try { storedPhysicsRate = localStorage.getItem(PHYSICS_RATE_KEY); } catch { /* Use the default. */ }
applyPhysicsRate(storedPhysicsRate ?? undefined, false);
physicsRateInput.addEventListener("input", () => applyPhysicsRate(physicsRateInput.value, true));

bindStoredToggle(chestPhysicsToggle, "yidhari.physics.chest", (on) => physics.setGroup("chest", on),
  { defaultOn: false });
bindStoredToggle(hipPhysicsToggle, "yidhari.physics.hips", (on) => physics.setGroup("hips", on),
  { defaultOn: false });

/**
 * Capture the rest pose of every bone a dynamic body drives, then let physics
 * build. Runs after restArms() and the other setups, so the warm-up starts
 * from the lowered-arm pose.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @param {object} data Parsed PMX.
 * @returns {void}
 */
function setupPhysics(object, data) {
  const bones = object.skeleton?.bones ?? [];
  const driven = new Set(data.rigidBodies.filter((body) => body.type !== 0).map((body) => body.boneIndex));
  physicsBones = [...driven].filter((index) => bones[index]).map((index) => ({
    bone: bones[index],
    quaternion: bones[index].quaternion.clone(),
    position: bones[index].position.clone(),
  }));
  if (physics.status === "loading") {
    object.visible = false;
    physicsRevealTimer = setTimeout(revealModel, PHYSICS_REVEAL_TIMEOUT_MS);
  }
  resolvePhysicsModel({ object, data });
}

/**
 * Blend her hair's vertex weights so it shows only HAIR_FOLLOW of its physics
 * motion, the rest riding a still bone. The PMX stays untouched.
 * @param {THREE.SkinnedMesh} object Loaded PMX mesh.
 * @param {object} data Parsed PMX.
 * @returns {void}
 */
function pinStrands(object, data) {
  const driven = new Set(data.rigidBodies.filter((body) => body.type !== 0).map((body) => body.boneIndex));
  const bones = data.bones.map((bone) => ({ name: bone.name, parent: bone.parentIndex }));
  const isDynamic = (index) => driven.has(index);
  const { skinIndex, skinWeight } = object.geometry.attributes;
  // The rest of her hair shows only part of its physics motion (see docs/physics.md).
  // Only bones that physics moves; plain bones such as Ctr_F_Hair_01 stay as they are.
  const strands = stiffStrands(bones.map((bone) => bone.name)).filter((name) =>
    isDynamic(bones.findIndex((bone) => bone.name === name)));
  const stiff = blendWeights(skinIndex.array, skinWeight.array, pinTargets(bones, strands, isDynamic), HAIR_FOLLOW,
    { sameMotion: sameMotionAs(bones, isDynamic) });
  if (stiff.skipped > 0) console.warn(`Hair: ${stiff.skipped} vertices had no slot for the still bone and keep full physics`);
  if (stiff.changed > 0) {
    skinIndex.needsUpdate = true;
    skinWeight.needsUpdate = true;
  }
}

/**
 * Step physics last, after every bone layer has posed the body.
 * @param {number} delta Seconds since the previous frame.
 * @returns {void}
 */
function applyPhysics(delta) {
  if (!mesh || physics.status !== "on") return;
  mesh.updateMatrixWorld(true);
  physics.update(delta);
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
 * speech blends over the mood's mouth, the blink combines with the mood and
 * winks, and the audition layer adds on top last.
 * See docs/animation-transitions.md.
 * @returns {void}
 */
function animate() {
  const now = performance.now();
  const delta = frameDelta(now, previousFrame);
  // The idle timer counts real time, so a hidden tab still ages it (#71).
  const idleDelta = Math.max(0, (now - previousFrame) / 1000);
  previousFrame = now;
  updateIdle({ real: idleDelta, eased: delta });
  controls.update();
  mesh?.morphTargetInfluences?.fill(0);
  expressions?.update(delta);
  syncThinkingState();
  speech?.update(delta);
  updateWinks(delta);
  applyYawn();
  updateBlink(now / 1000);
  applyThinkingPose(delta);
  applyGaze(delta);
  applySway(now / 1000, delta);
  applyIdleMotion();
  applyPhysics(delta);
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

const POP_OUT_PANEL_KEY = "yidhari.popOutPanel";
const POP_OUT_SIZE = { width: 360, height: 480 };
const POP_OUT_PANEL_HEIGHT = 640;
const stageEl = document.querySelector("#stage");
const panelResizerEl = document.querySelector("#panel-resizer");
const popOutButton = document.querySelector("#pop-out-button");
const popOutPanelButton = document.querySelector("#pop-out-panel");
const popOutNote = document.querySelector("#pop-out-note");

/** @returns {boolean} Whether the pop-out shows the chat and settings panel. */
function popOutPanelWanted() {
  try {
    return localStorage.getItem(POP_OUT_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Width the side panel and its divider add to the floating window.
 * @returns {number}
 */
function popOutPanelExtra() {
  let width = 390; // the CSS default --panel-width
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) width = saved;
  } catch {
    // Storage can be blocked; the default width applies.
  }
  return width + 6;
}

/**
 * Show or hide the chat and settings panel in the floating window, and widen
 * or narrow the window to match when the browser allows it.
 * @param {boolean} show
 * @returns {void}
 */
function setPopOutPanel(show) {
  const view = popOut.window;
  if (!view) return;
  const body = view.document.body;
  const shown = body.classList.contains("with-panel");
  // Measure before hiding: the panel has no width once it is hidden.
  const extra = shown ? panelEl.getBoundingClientRect().width + panelResizerEl.offsetWidth : popOutPanelExtra();
  body.classList.toggle("with-panel", show);
  popOutPanelButton.setAttribute("aria-pressed", String(show));
  popOutPanelButton.title = show ? "Hide the chat and settings panel" : "Show the chat and settings panel";
  popOutPanelButton.setAttribute("aria-label", show ? "Hide chat and settings" : "Show chat and settings");
  try {
    localStorage.setItem(POP_OUT_PANEL_KEY, show ? "1" : "0");
  } catch {
    // Remembering the choice is a convenience.
  }
  if (show !== shown) {
    try {
      const height = show ? Math.max(view.outerHeight, POP_OUT_PANEL_HEIGHT) : view.outerHeight;
      view.resizeTo(view.outerWidth + (show ? extra : -extra), height);
    } catch {
      // Some browsers refuse to resize; the user can drag the window edge.
    }
  }
  panelResizer.refresh();
  resize();
}

/** @returns {void} Label the pop-out button for the window it will open. */
function labelPopOutButton() {
  if (!popOut.supported) {
    popOutButton.disabled = true;
    popOutButton.title = PopOut.unsupportedReason;
    return;
  }
  const popup = popOut.kind === "popup";
  popOutButton.textContent = popup ? "🪟 Pop out (window)" : "📌 Pop out";
  popOutButton.title = popup
    ? "Open her in a separate window. Keep it above other windows with your window manager's Always on Top."
    : "Float her in an always-on-top window";
}

/**
 * Follow the page between the main window and the pop-out window: frames,
 * pixel ratio, size and cursor gaze come from whichever window shows her.
 * @param {Window | null} view The floating window, or null after returning.
 * @returns {void}
 */
function onPopOut(view) {
  const shown = view ?? window;
  frameLoop.use(shown);
  cameraGaze.useFrames(shown);
  renderer.setPixelRatio(Math.min(shown.devicePixelRatio, 2));
  if (view) {
    view.addEventListener("pointermove", followCursor);
    view.addEventListener("pointerleave", centreCursor);
    view.addEventListener("resize", resize);
    view.addEventListener("resize", panelResizer.refresh);
    // An observer from the floating window's own realm follows the canvas there.
    new view.ResizeObserver(resize).observe(canvas);
    const panel = popOutPanelWanted();
    view.document.body.classList.toggle("with-panel", panel);
    popOutPanelButton.setAttribute("aria-pressed", String(panel));
  }
  gaze.setCursor({ x: 0, y: 0 }, cursorGazeToggle.checked);
  document.body.classList.toggle("popped-out", Boolean(view));
  popOutNote.hidden = !view;
  labelPopOutButton();
  panelResizer.refresh();
  resize();
}

const popOut = new PopOut({
  api: window.documentPictureInPicture,
  fallback: popupWindow(window),
  host: window,
  nodes: [stageEl, panelResizerEl, panelEl],
  size: POP_OUT_SIZE,
  onChange: onPopOut,
});
labelPopOutButton();
popOutButton.addEventListener("click", async () => {
  if (popOut.window) {
    popOut.close();
    return;
  }
  const size = popOutPanelWanted()
    ? { width: POP_OUT_SIZE.width + popOutPanelExtra(), height: POP_OUT_PANEL_HEIGHT }
    : POP_OUT_SIZE;
  try {
    await popOut.open(size);
  } catch (error) {
    labelPopOutButton();
    setStatus(error.message);
  }
});
popOutPanelButton.addEventListener("click", () => {
  setPopOutPanel(popOutPanelButton.getAttribute("aria-pressed") !== "true");
});
document.querySelector("#pop-out-return").addEventListener("click", () => popOut.close());
document.querySelector("#pop-out-home").addEventListener("click", () => popOut.close());

const frameLoop = new FrameLoop(animate, window);
resize();
new ResizeObserver(resize).observe(canvas);
const panelResizer = installPanelResizer();
installChatBox();
frameLoop.start();
loadModel();
