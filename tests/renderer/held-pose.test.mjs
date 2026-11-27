// Run with: node --test tests/renderer/*.test.mjs
// Held VPD poses (#49): a pose authored in Blender (#261) and saved as VPD is
// held on top of the other bone layers. VPD rotations are measured from the
// PMX bind pose, not the renderer's lowered-arm rest, so a held bone gets
// bind ⊗ vpd, the way MMDAnimationHelper.pose() sets it after mesh.pose().
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";
import { HeldPose, POSE_EASE_KEY, bindPoseEase, idleMayPlay, poseActionTicks, poseFileNames, readVpd, savePoseActionTick } from "../../renderer/held-pose.js";
import { fixture } from "./arm-fixture.mjs";

const VPD = [
  "Vocaloid Pose Data file",
  "",
  "Yidhari.osm;\t\t// 親ファイル名",
  "2;\t\t\t\t// 総ポーズボーン数",
  "",
  "Bone0{右腕",
  "  0.000000,0.000000,0.000000;\t\t\t\t// trans x,y,z",
  "  0.100000,0.200000,-0.150000,0.961800;\t\t// Quaternion x,y,z,w",
  "}",
  "",
  "Bone1{右人指１",
  "  0.000000,0.000000,0.000000;\t\t\t\t// trans x,y,z",
  "  0.000000,0.000000,0.258819,0.965926;\t\t// Quaternion x,y,z,w",
  "}",
  "",
  "Morph0{ウィンク右",
  "  1.000000;\t\t\t\t// weight",
  "}",
  "",
].join("\r\n");

const BONES_ONLY = VPD.split("Morph0")[0];

/** @returns {{ mesh: THREE.Object3D, get: (name: string) => THREE.Bone }} */
function rig() {
  const built = fixture();
  const bones = [];
  built.mesh.traverse((node) => { if (node.isBone) bones.push(node); });
  built.mesh.skeleton = { bones, getBoneByName: (name) => bones.find((b) => b.name === name) };
  built.mesh.morphTargetDictionary = { "ウィンク右": 1, "あ": 0 };
  built.mesh.morphTargetInfluences = [0, 0];
  return built;
}

const close = (a, b, eps = 1e-6) => Math.abs(Math.abs(a.dot(b)) - 1) < eps;

test("readVpd parses the bones three.js reads and keeps the morphs it rejects", () => {
  const pose = readVpd(VPD);
  const reference = new MMDParser.Parser().parseVpd(BONES_ONLY, true);
  assert.deepEqual(pose.bones, reference.bones);
  assert.deepEqual(pose.morphs, [{ name: "ウィンク右", weight: 1 }]);
});

test("readVpd says plainly when a file is not a pose", () => {
  assert.throws(() => readVpd("Vocaloid Motion Data 0002"), /not a VPD pose/);
});

test("poseFileNames lists the .vpd files in a server directory listing", () => {
  const html = `<ul>
    <li><a href="wink-v-sign.vpd">wink-v-sign.vpd</a></li>
    <li><a href="grids/">grids/</a></li>
    <li><a href="%E8%80%83%E3%81%88%E4%B8%AD.vpd">考え中.vpd</a></li>
    <li><a href="notes.txt">notes.txt</a></li>
  </ul>`;
  assert.deepEqual(poseFileNames(html), ["wink-v-sign", "考え中"]);
});

test("a fully held bone is bind ⊗ vpd, whatever the rest pose did to it", () => {
  const { mesh, get } = rig();
  const bind = get("右腕").quaternion.clone();
  const held = new HeldPose(mesh);
  // restArms() and the idle layers turn the arm after the bind pose was captured.
  get("右腕").quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0, -1.1)));
  held.load("wink-v-sign", readVpd(VPD));
  held.hold(true);
  held.update(10);
  held.apply();
  const vpd = new THREE.Quaternion().fromArray(readVpd(VPD).bones.find((b) => b.name === "右腕").quaternion).normalize();
  assert.ok(close(get("右腕").quaternion, bind.clone().multiply(vpd)));
});

test("bones the pose does not name keep what the other layers wrote", () => {
  const { mesh, get } = rig();
  const held = new HeldPose(mesh);
  const turned = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.3, 0.2));
  get("左腕").quaternion.copy(turned);
  held.load("p", readVpd(VPD));
  held.hold(true);
  held.update(10);
  held.apply();
  assert.ok(close(get("左腕").quaternion, turned));
});

test("load reports bones and morphs the model does not have", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh);
  const text = VPD.replace("右人指１", "右足ＩＫ").replace("ウィンク右", "笑い");
  assert.deepEqual(held.load("p", readVpd(text)), { bones: 1, missing: ["右足ＩＫ", "笑い"] });
});

test("the pose eases in and out at the same speed whatever the frame rate", () => {
  const { mesh } = rig();
  const coarse = new HeldPose(mesh, { easeSeconds: 0.4 });
  const fine = new HeldPose(mesh, { easeSeconds: 0.4 });
  coarse.hold(true);
  fine.hold(true);
  coarse.update(0.2);
  for (let i = 0; i < 10; i += 1) fine.update(0.02);
  assert.ok(coarse.weight > 0 && coarse.weight < 1);
  assert.ok(Math.abs(coarse.weight - fine.weight) < 1e-9);
  coarse.update(1);
  assert.equal(coarse.weight, 1);
  coarse.hold(false);
  coarse.update(1);
  assert.equal(coarse.weight, 0);
});

test("releasing halfway curves back without a jump", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.hold(true);
  held.update(0.1);
  const before = held.weight;
  held.hold(false);
  held.update(0.001);
  assert.ok(Math.abs(held.weight - before) < 0.02);
  held.update(1);
  assert.equal(held.weight, 0);
});

test("the ease time can change, and the next transition uses it", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 1 });
  held.easeSeconds = 1.5;
  held.hold(true);
  held.update(0.75);
  assert.ok(Math.abs(held.weight - 0.5) < 1e-9);
});

test("bindPoseEase starts at 1 s, restores a saved time and keeps it in range", () => {
  const store = new Map();
  const local = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const input = { value: "", min: "0.3", max: "3", listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  const output = { textContent: "" };
  const seen = [];
  bindPoseEase(input, output, (seconds) => seen.push(seconds), { local });
  assert.deepEqual(seen, [1]);
  assert.equal(output.textContent, "1.0 s");
  input.value = "1.5";
  input.listeners.forEach((fn) => fn());
  assert.deepEqual(seen, [1, 1.5]);
  assert.equal(store.get(POSE_EASE_KEY), "1.5");
  store.set(POSE_EASE_KEY, "9");
  bindPoseEase(input, output, (seconds) => seen.push(seconds), { local });
  assert.equal(seen.at(-1), 3, "a saved time out of range is clamped");
});

test("at weight 0 apply leaves every bone as the layers wrote it", () => {
  const { mesh, get } = rig();
  const held = new HeldPose(mesh);
  held.load("p", readVpd(VPD));
  const arm = get("右腕").quaternion.clone();
  held.apply();
  assert.ok(close(get("右腕").quaternion, arm, 1e-12));
});

test("a bone no layer rewrites goes back to where it was after release", () => {
  // 口左/口右 (mouth corners) are written by no other layer, so nothing else
  // would put them back: the pose must restore them itself.
  const { mesh, get } = rig();
  const finger = get("右人指１");
  const before = finger.quaternion.clone();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.load("p", readVpd(VPD));
  held.hold(true);
  for (let i = 0; i < 30; i += 1) { held.update(1 / 30); held.apply(); }
  assert.ok(!close(finger.quaternion, before));
  held.hold(false);
  held.update(0.2);
  held.apply();
  assert.ok(!close(finger.quaternion, before), "still easing out halfway");
  for (let i = 0; i < 30; i += 1) { held.update(1 / 30); held.apply(); }
  assert.ok(close(finger.quaternion, before, 1e-12));
});

test("a bone a layer rewrites every frame still eases from what the layer wrote", () => {
  const { mesh, get } = rig();
  const arm = get("右腕");
  const rest = arm.quaternion.clone();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.load("p", readVpd(VPD));
  held.hold(true);
  for (let i = 0; i < 30; i += 1) { arm.quaternion.copy(rest); held.update(1 / 30); held.apply(); }
  held.hold(false);
  for (let i = 0; i < 30; i += 1) { arm.quaternion.copy(rest); held.update(1 / 30); held.apply(); }
  assert.ok(close(arm.quaternion, rest, 1e-12));
});

test("play() eases in, holds for its seconds, then eases out on its own", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.play(2);
  assert.equal(held.playing, true);
  held.update(0.4);
  assert.equal(held.weight, 1);
  held.update(1.9);
  assert.equal(held.weight, 1, "still holding before its 2 s are up");
  held.update(0.2);
  assert.ok(held.weight < 1, "easing out once the hold is over");
  held.update(0.4);
  assert.equal(held.weight, 0);
  assert.equal(held.playing, false);
});

test("stop() ends a playing pose early, and hold(true) keeps it until stopped", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.play(5);
  held.update(1);
  held.stop();
  held.update(0.4);
  assert.equal(held.playing, false);
  held.hold(true);
  held.update(60);
  assert.equal(held.weight, 1);
  assert.equal(held.playing, true);
});

test("the pose's morphs rise with the pose and never lower a stronger morph", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.load("p", readVpd(VPD));
  held.hold(true);
  held.update(10);
  held.applyMorphs();
  assert.equal(mesh.morphTargetInfluences[1], 1);
  mesh.morphTargetInfluences[1] = 0;
  held.hold(false);
  held.update(0.2);
  held.applyMorphs();
  assert.ok(mesh.morphTargetInfluences[1] > 0 && mesh.morphTargetInfluences[1] < 1);
  mesh.morphTargetInfluences[1] = 0.95;
  held.applyMorphs();
  assert.equal(mesh.morphTargetInfluences[1], 0.95);
});

test("loading another pose while held swaps the targets without dropping the weight", () => {
  const { mesh, get } = rig();
  const bind = get("右人指１").quaternion.clone();
  const held = new HeldPose(mesh);
  held.load("a", readVpd(VPD));
  held.hold(true);
  held.update(10);
  held.load("b", readVpd(BONES_ONLY.replace("0.000000,0.000000,0.258819,0.965926", "0.000000,0.000000,0.000000,1.000000")));
  assert.equal(held.weight, 1);
  assert.equal(held.name, "b");
  held.apply();
  assert.ok(close(get("右人指１").quaternion, bind));
});

test("pose action ticks default to on and remember what was unticked", () => {
  const store = new Map();
  const local = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(poseActionTicks(["wink-v-sign", "考え中"], { local }), { "wink-v-sign": true, "考え中": true });
  savePoseActionTick("考え中", false, { local });
  assert.deepEqual(poseActionTicks(["wink-v-sign", "考え中", "new"], { local }), { "wink-v-sign": true, "考え中": false, new: true });
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(poseActionTicks(["a"], { local: blocked }), { a: true });
  savePoseActionTick("a", false, { local: blocked });
});

// Fluid transition (#49): the user found 0.4 s smoothstep too quick. The
// default is a 1 s smootherstep, which also starts and stops with no jolt.
test("by default the pose eases over 1 s and starts and lands gently", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh);
  assert.equal(held.easeSeconds, 1);
  held.hold(true);
  held.update(0.1);
  assert.ok(held.weight < 0.01, `gentle start, got ${held.weight}`);
  held.update(0.4);
  assert.ok(Math.abs(held.weight - 0.5) < 1e-9);
  held.update(0.4);
  assert.ok(held.weight > 0.99, `gentle landing, got ${held.weight}`);
  held.update(0.1);
  assert.equal(held.weight, 1);
});

// Face panels (#49): the wink-clap smile lost its teeth because the mood's own
// smirk (にやり２) stayed on top of the pose's え + にやり. A pose with morphs in
// a panel (brow 1, eye 2, mouth 3) owns that panel while it is held; the
// independent blink (まばたき) is left alone.
function faceRig() {
  const built = rig();
  const names = ["え", "にやり", "にやり２", "ウィンク", "笑い", "まばたき", "困る"];
  built.mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
  built.mesh.morphTargetInfluences = names.map(() => 0);
  const panels = { "え": 3, "にやり": 3, "にやり２": 3, "ウィンク": 2, "笑い": 2, "まばたき": 2, "困る": 1 };
  const set = (weights) => names.forEach((n, i) => { built.mesh.morphTargetInfluences[i] = weights[n] ?? 0; });
  const get = (n) => built.mesh.morphTargetInfluences[built.mesh.morphTargetDictionary[n]];
  return { ...built, panels, set, get };
}
const SMILE = VPD.replace("Morph0{ウィンク右\r\n  1.000000;", "Morph0{え\r\n  0.300000;\t\t\t\t// weight\r\n}\r\n\r\nMorph1{にやり\r\n  0.800000;");

test("a pose with mouth morphs owns the mouth: the mood's mouth fades out as it fades in", () => {
  const { mesh, panels, set, get } = faceRig();
  const held = new HeldPose(mesh, { easeSeconds: 1, morphPanels: panels });
  held.load("smile", readVpd(SMILE));
  held.hold(true);
  held.update(0.5);
  set({ "にやり２": 1, "笑い": 0.4, "困る": 0.5, "まばたき": 0.3 });
  held.applyMorphs();
  assert.ok(Math.abs(get("にやり２") - 0.5) < 1e-9, "halfway: the mood smirk is halved");
  assert.ok(Math.abs(get("え") - 0.15) < 1e-9);
  held.update(1);
  set({ "にやり２": 1, "笑い": 0.4, "困る": 0.5, "まばたき": 0.3 });
  held.applyMorphs();
  assert.equal(get("にやり２"), 0, "held: only the pose's mouth");
  assert.ok(Math.abs(get("え") - 0.3) < 1e-9);
  assert.ok(Math.abs(get("にやり") - 0.8) < 1e-9);
  assert.equal(get("笑い"), 0.4, "no eye morph in the pose: the eyes stay the mood's");
  assert.equal(get("困る"), 0.5, "brows untouched");
  assert.equal(get("まばたき"), 0.3, "the blink is independent");
});

// Speech actions (#269): a pose played while she speaks keeps its bones, eyes
// and brows, but leaves the mouth to the mood and lip sync.
test("quietMouth leaves the mouth panel alone while the rest of the face follows the pose", () => {
  const { mesh, panels, set, get } = faceRig();
  const held = new HeldPose(mesh, { easeSeconds: 1, morphPanels: panels });
  held.load("smile-wink", readVpd(`${SMILE}Morph2{ウィンク\r\n  1.000000;\t\t\t\t// weight\r\n}\r\n`));
  held.quietMouth = true;
  held.hold(true);
  held.update(1);
  set({ "にやり２": 1, "笑い": 0.4 });
  held.applyMorphs();
  assert.equal(get("にやり２"), 1, "the mood's mouth stays");
  assert.equal(get("え"), 0, "the pose's mouth is not applied");
  assert.equal(get("にやり"), 0);
  assert.equal(get("ウィンク"), 1, "the pose's eyes still apply");
  assert.equal(get("笑い"), 0, "and own the eye panel");
  held.quietMouth = false;
  set({ "にやり２": 1, "笑い": 0.4 });
  held.applyMorphs();
  assert.equal(get("にやり２"), 0, "after speech the pose owns the mouth again");
  assert.ok(Math.abs(get("え") - 0.3) < 1e-9);
});

// Switching poses (#49): wink-clap → wink-v-sign snapped, because loading the
// new pose put the old bones back at once while the weight stayed at 1.
test("switching poses while held crossfades from what was shown", () => {
  const { mesh, get } = rig();
  const arm = get("右腕");
  const finger = get("右人指１");
  const held = new HeldPose(mesh, { easeSeconds: 1 });
  held.load("a", readVpd(VPD));
  held.hold(true);
  for (let i = 0; i < 60; i += 1) { held.update(1 / 30); held.apply(); }
  const shownArm = arm.quaternion.clone();
  const shownFinger = finger.quaternion.clone();
  held.load("b", readVpd(BONES_ONLY.replace("Bone0{右腕", "Bone0{左腕")));
  held.update(1 / 60);
  held.apply();
  assert.ok(close(arm.quaternion, shownArm, 1e-3), "右腕 (only in a) does not jump back");
  assert.ok(close(finger.quaternion, shownFinger, 1e-3), "右人指１ (in both) does not jump");
  for (let i = 0; i < 90; i += 1) { held.update(1 / 60); held.apply(); }
  const bindQ = held.bind.get(arm).quaternion;
  assert.ok(close(arm.quaternion, bindQ, 1e-9), "右腕 has eased back to where it was before");
  const leftTarget = held.bind.get(get("左腕")).quaternion.clone()
    .multiply(new THREE.Quaternion().fromArray(readVpd(VPD).bones[0].quaternion).normalize());
  assert.ok(close(get("左腕").quaternion, leftTarget, 1e-9), "左腕 reached pose b");
});

// The buttons play poses (play(seconds)), not hold(): the crossfade stalled
// there, so wink-clap → wink-v-sign never moved (#49).
test("switching poses while one plays from its button crossfades too", () => {
  const { mesh, get } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 1 });
  held.load("a", readVpd(VPD));
  held.play(4);
  for (let i = 0; i < 60; i += 1) { held.update(1 / 30); held.apply(); }
  held.load("b", readVpd(BONES_ONLY.replace("Bone0{右腕", "Bone0{左腕")));
  held.play(4);
  for (let i = 0; i < 90; i += 1) { held.update(1 / 60); held.apply(); }
  const leftTarget = held.bind.get(get("左腕")).quaternion.clone()
    .multiply(new THREE.Quaternion().fromArray(readVpd(VPD).bones[0].quaternion).normalize());
  assert.ok(close(get("左腕").quaternion, leftTarget, 1e-9), "左腕 reached pose b");
  assert.equal(held.fade, null, "the crossfade finished");
});

// Teeth (#49): the add-on writes 齿下 as 歯下 (Shift-JIS has no 齿), and 齿下 may
// be negative: −0.32 pulls the lower teeth back to show them in a smile.
test("a pose reads 歯/結 names back to the model's 齿/结, and sets a negative 齿下", () => {
  const { mesh, panels, set, get } = faceRig();
  mesh.morphTargetDictionary["齿下"] = 7;
  mesh.morphTargetInfluences.push(0);
  panels["齿下"] = 3;
  const held = new HeldPose(mesh, { easeSeconds: 1, morphPanels: panels });
  const text = SMILE.replace("Morph1{にやり\r\n  0.800000;", "Morph1{歯下\r\n  -0.320000;");
  const { missing } = held.load("teeth", readVpd(text));
  assert.deepEqual(missing, []);
  held.hold(true);
  held.update(2);
  set({});
  mesh.morphTargetInfluences[7] = 0;
  held.applyMorphs();
  assert.ok(Math.abs(mesh.morphTargetInfluences[7] + 0.32) < 1e-9);
});

// Review on #263: an idle pick must not take over a pose the user started
// (a button play or a ?pose= hold); it may follow on from an idle-started one.
test("idle may play a pose only when no user-started pose is showing", () => {
  assert.equal(idleMayPlay({ picked: null, playing: false }), false, "nothing picked");
  assert.equal(idleMayPlay({ picked: "wink-clap", playing: false }), true, "nothing showing");
  assert.equal(idleMayPlay({ picked: "wink-clap", playing: true, name: "wink-v-sign", startedBy: "user" }), false);
  assert.equal(idleMayPlay({ picked: "wink-clap", playing: true, name: "wink-v-sign", startedBy: "url" }), false);
  assert.equal(idleMayPlay({ picked: "wink-clap", playing: true, name: "wink-v-sign", startedBy: "idle" }), true);
  assert.equal(idleMayPlay({ picked: "wink-clap", playing: true, name: "wink-clap", startedBy: "idle" }), false,
    "already showing: a toggle would stop it");
});

test("a driven pose follows the weight it is given instead of its ease (#270)", () => {
  const { mesh, get } = rig();
  const pose = new HeldPose(mesh);
  const arm = get("右腕");
  const rest = arm.quaternion.clone();
  pose.load("yawn", readVpd(VPD));
  const target = pose.targets.get(arm).quaternion.clone();
  pose.drive(1);
  pose.apply();
  assert.ok(close(arm.quaternion, target), "full weight reaches the pose");
  arm.quaternion.copy(rest); // the layers rewrite it next frame
  pose.drive(0.5);
  pose.apply();
  assert.ok(Math.abs(rest.angleTo(arm.quaternion) - rest.angleTo(target) / 2) < 1e-6, "half weight is halfway");
  pose.update(10); // its own ease does not move a driven pose
  assert.equal(pose.weight, 0.5);
  pose.drive(0);
  pose.apply();
  assert.deepEqual(arm.quaternion.toArray(), rest.toArray(), "weight 0 lets the bone go back");
  for (const bad of [Number.NaN, -1, 3]) {
    pose.drive(bad);
    assert.ok(pose.weight >= 0 && pose.weight <= 1, `clamped for ${bad}`);
  }
});
