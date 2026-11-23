// Run with: node --test tests/renderer/*.test.mjs
// Held VPD poses (#49): a pose authored in Blender (#261) and saved as VPD is
// held on top of the other bone layers. VPD rotations are measured from the
// PMX bind pose, not the renderer's lowered-arm rest, so a held bone gets
// bind ⊗ vpd, the way MMDAnimationHelper.pose() sets it after mesh.pose().
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MMDParser } from "three/examples/jsm/libs/mmdparser.module.js";
import { HeldPose, poseFileNames, readVpd } from "../../renderer/held-pose.js";
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

test("releasing halfway reverses from where it is, without a jump", () => {
  const { mesh } = rig();
  const held = new HeldPose(mesh, { easeSeconds: 0.4 });
  held.hold(true);
  held.update(0.1);
  const before = held.weight;
  held.hold(false);
  held.update(0.001);
  assert.ok(Math.abs(held.weight - before) < 0.02);
  assert.ok(held.weight < before);
});

test("at weight 0 apply leaves every bone as the layers wrote it", () => {
  const { mesh, get } = rig();
  const held = new HeldPose(mesh);
  held.load("p", readVpd(VPD));
  const arm = get("右腕").quaternion.clone();
  held.apply();
  assert.ok(close(get("右腕").quaternion, arm, 1e-12));
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
