// Run with: node --test tests/renderer/*.test.mjs
// Animation actions while she speaks (#269): the shared action catalog, action
// references from the bridge, the speech-time gate, pose settings and the
// Gestures while speaking toggle. See docs/speech-actions.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTION_CATALOG, SPEECH_ACTIONS_KEY, SPEECH_POSE_HOLD, bindSpeechActionsSetting, parseActionRef,
  poseSpeechSettings, speechActionBlocked, speechMayPlayPose,
} from "../../renderer/speech-actions.js";
import { ACTION_LABELS, ACTIONS, IdleMotion } from "../../renderer/idle-motion.js";
import { TENTACLE_ACTIONS } from "../../renderer/tentacle-motion.js";
import { connectBridge, agentEvent } from "../../renderer/bridge-client.js";
import { installPage } from "./fake-dom.mjs";

const JSON_CATALOG = JSON.parse(readFileSync(new URL("../../renderer/actions.json", import.meta.url), "utf8"));
const NFD_POSE = "ポーズ".normalize("NFD");

test("the renderer reads the same action catalog as the bridge", () => {
  assert.deepEqual(ACTION_CATALOG, JSON_CATALOG);
});

test("every body action in the catalog is an IdleMotion action with the catalog's label", () => {
  const body = Object.entries(ACTION_CATALOG).filter(([, entry]) => (entry.layer ?? "body") === "body");
  assert.deepEqual(body.map(([name]) => name).sort(), Object.keys(ACTIONS).sort());
  for (const [name, entry] of body) assert.equal(ACTION_LABELS[name], entry.label, name);
});

test("every tentacle action in the catalog names a TENTACLE_ACTIONS motion with its label", () => {
  const tails = Object.values(ACTION_CATALOG).filter((entry) => entry.layer === "tentacle");
  assert.deepEqual(tails.map((entry) => entry.target).sort(), Object.keys(TENTACLE_ACTIONS).sort());
  for (const entry of tails) assert.equal(entry.label, TENTACLE_ACTIONS[entry.target].label);
});

test("action references resolve to a layer and name, poses in NFC", () => {
  assert.deepEqual(parseActionRef("tilt-left"), { layer: "body", name: "tilt-left", ref: "tilt-left" });
  assert.deepEqual(parseActionRef("tentacle-perk"), { layer: "tentacle", name: "perk", ref: "tentacle-perk" });
  assert.deepEqual(parseActionRef("pose:elated-fist"), { layer: "pose", name: "elated-fist", ref: "pose:elated-fist" });
  assert.deepEqual(parseActionRef(`pose:${NFD_POSE}`), { layer: "pose", name: "ポーズ", ref: "pose:ポーズ" });
  assert.deepEqual(parseActionRef("pose:glance"), { layer: "pose", name: "glance", ref: "pose:glance" },
    "a pose called glance stays a pose");
});

test("unknown or malformed references are refused", () => {
  for (const ref of ["moonwalk", "toString", "__proto__", "pose:", "pose:../x", "pose:a/b", "pose:a\\b",
    "pose:.hidden", `pose:${"x".repeat(65)}`, "pose:a\u001bb", "pose:a b", "", null, 3, {}]) {
    assert.equal(parseActionRef(ref), null, String(ref));
  }
});

test("speech actions play while she speaks, but not before the model, with the toggle off, or during previews", () => {
  const ready = { loaded: true, enabled: true, held: false, previewing: false, state: "active" };
  assert.equal(speechActionBlocked(ready), null);
  assert.match(speechActionBlocked({ ...ready, loaded: false }), /model/);
  assert.match(speechActionBlocked({ ...ready, enabled: false }), /Gestures while speaking/);
  assert.match(speechActionBlocked({ ...ready, held: true }), /pose is held/);
  assert.match(speechActionBlocked({ ...ready, previewing: true }), /preview/);
  assert.match(speechActionBlocked({ ...ready, state: "waking" }), /Waking/);
  assert.match(speechActionBlocked({ ...ready, state: "stretching" }), /Stretching/);
});

test("a speech pose never replaces a pose the user started", () => {
  assert.equal(speechMayPlayPose({ playing: false, startedBy: "user" }), true);
  assert.equal(speechMayPlayPose({ playing: true, startedBy: "user" }), false);
  assert.equal(speechMayPlayPose({ playing: true, startedBy: "url" }), false);
  assert.equal(speechMayPlayPose({ playing: true, startedBy: "idle" }), true);
  assert.equal(speechMayPlayPose({ playing: true, startedBy: "speech" }), true);
});

test("pose sidecar settings: speech on by default, hold clamped", () => {
  assert.deepEqual(poseSpeechSettings(null), { speech: true, speechHold: SPEECH_POSE_HOLD });
  assert.deepEqual(poseSpeechSettings({ speech: false, speechHold: 1.5 }), { speech: false, speechHold: 1.5 });
  assert.deepEqual(poseSpeechSettings({ speech: "no", speechHold: 99 }), { speech: true, speechHold: 4 });
  assert.deepEqual(poseSpeechSettings({ speechHold: 0.1 }), { speech: true, speechHold: 0.5 });
  assert.deepEqual(poseSpeechSettings([1, 2]), { speech: true, speechHold: SPEECH_POSE_HOLD });
});

test("the Gestures while speaking toggle is on by default and saved", () => {
  const store = new Map();
  const local = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const listeners = [];
  const box = { checked: false, addEventListener: (type, fn) => listeners.push(fn) };
  const seen = [];
  bindSpeechActionsSetting(box, (on) => seen.push(on), { local });
  assert.equal(box.checked, true);
  assert.deepEqual(seen, [true]);
  box.checked = false;
  listeners.forEach((fn) => fn());
  assert.equal(store.get(SPEECH_ACTIONS_KEY), "0");
  assert.deepEqual(seen, [true, false]);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const other = { checked: false, addEventListener() {} };
  bindSpeechActionsSetting(other, () => {}, { local: blocked });
  assert.equal(other.checked, true, "blocked storage: on for the session");
});

test("IdleMotion remembers who started an action", () => {
  const motion = new IdleMotion({ random: () => 0.5 });
  motion.play("tilt-left", "speech");
  assert.equal(motion.playing, "tilt-left");
  assert.equal(motion.playingSource, "speech");
  motion.play("glance");
  assert.equal(motion.playingSource, "user", "a button press is the user's");
  motion.stop();
  assert.equal(motion.playingSource, null);
});

test("speak events pass a valid action to onSpeak and drop an invalid one, keeping the clip", (t) => {
  const page = installPage(t);
  const clips = [];
  connectBridge({
    catalog: { neutral: {}, happy: {} }, onStart() {}, onFinish() {}, onExpression() {}, onText() {},
    onSpeak: (clip) => clips.push(clip),
  });
  const speak = { type: "speak", id: "0123456789abcdef", expression: "happy", weight: 1, text: "Hi." };
  page.receive({ ...speak, action: "tilt-left" });
  page.receive({ ...speak, action: `pose:${NFD_POSE}` });
  page.receive({ ...speak, action: "moonwalk" });
  page.receive({ ...speak, action: 7 });
  page.receive(speak);
  assert.deepEqual(clips.map((clip) => clip.action ?? null), ["tilt-left", "pose:ポーズ", null, null, null]);
});

test("text-only action events and agent play_action reach onAction", (t) => {
  const page = installPage(t);
  const actions = [];
  connectBridge({
    catalog: { neutral: {} }, onStart() {}, onFinish() {}, onExpression() {}, onText() {}, onSpeak() {},
    onAction: (ref, source) => actions.push([ref, source]),
  });
  page.receive({ type: "action", name: "shrug-both" });
  page.receive({ type: "action", name: "moonwalk" });
  page.receive({ type: "agent", kind: "action", source: "Codex", name: "pose:elated-fist" });
  assert.deepEqual(actions, [["shrug-both", "chat"], ["pose:elated-fist", "Codex"]]);
});

test("agentEvent validates action events", () => {
  assert.deepEqual(agentEvent({ kind: "action", source: "Codex", name: "sneeze" }, {}),
    { kind: "action", source: "Codex", name: "sneeze" });
  assert.throws(() => agentEvent({ kind: "action", source: "Codex", name: "moonwalk" }, {}));
  assert.throws(() => agentEvent({ kind: "action", source: "Codex", name: "pose:../x" }, {}));
});
