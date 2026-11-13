// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PINNED_STRANDS, pinTargets, pinWeights, pinnedBones } from "../../renderer/weight-pins.js";

// 0 head → 1 strand root (no body) → 2 curl (dynamic) → 3 curl tip (dynamic) → 5 its weight (錘);
// 4 other hair (dynamic)
const bones = [
  { name: "頭", parent: -1 },
  { name: "Ctr_F_Hair_01", parent: 0 },
  { name: "Ctr_F_Hair_012", parent: 1 },
  { name: "Ctr_F_Hair_013", parent: 2 },
  { name: "Ctr_L_HairA_01", parent: 0 },
  { name: "Ctr_F_Hair_013錘", parent: 3 },
];
const dynamic = new Set([2, 3, 4]);

test("only the curl's root (012, 013) is pinned; its tips stay on physics", () => {
  assert.deepEqual([...PINNED_STRANDS], ["Ctr_F_Hair_012", "Ctr_F_Hair_013"]);
});

test("kinematicBodies: the named bodies follow their bones, keep their own chain, and let go of other strands", async () => {
  const { kinematicBodies } = await import("../../renderer/weight-pins.js");
  // bones: 0 head, 1 curl root (012), 2 curl 013, 3 tip 014, 4 fringe base 02
  const rigBones = [
    { name: "頭", parent: -1 }, { name: "Ctr_F_Hair_012", parent: 0 }, { name: "Ctr_F_Hair_013", parent: 1 },
    { name: "Ctr_F_Hair_014", parent: 2 }, { name: "Ctr_F_Hair_02", parent: 0 },
  ];
  const body = (name, boneIndex, type) => ({ name, boneIndex, type });
  const rigidBodies = [
    body("頭", 0, 0), body("Ctr_F_Hair_012", 1, 2), body("Ctr_F_Hair_013", 2, 1),
    body("Ctr_F_Hair_014", 3, 1), body("Ctr_F_Hair_02", 4, 2),
  ];
  const joint = (name, a, b) => ({ name, rigidBodyIndex1: a, rigidBodyIndex2: b });
  const constraints = [
    joint("head-012", 0, 1), joint("012-013", 1, 2), joint("013-014", 2, 3),
    joint("012横", 1, 4), joint("head-02", 0, 4),
  ];
  const before = JSON.stringify({ rigidBodies, constraints });
  const out = kinematicBodies(rigidBodies, constraints, rigBones, ["Ctr_F_Hair_012", "Ctr_F_Hair_013"]);
  assert.deepEqual(out.rigidBodies.map((b) => b.type), [0, 0, 0, 1, 2]);
  assert.deepEqual(out.rigidBodies.map((b) => b.boneIndex), [0, 1, 2, 3, 4], "same bones, same indices");
  // The weld to the fringe base would hold the base still, so it goes; the tip still hangs from 013.
  assert.deepEqual(out.constraints.map((c) => c.name), ["head-012", "012-013", "013-014", "head-02"]);
  assert.equal(JSON.stringify({ rigidBodies, constraints }), before, "inputs not mutated");
});

test("pinned bones include every descendant, such as the strand's weight (錘) bones", () => {
  assert.deepEqual([...pinnedBones(bones, ["Ctr_F_Hair_013"])].sort(), [3, 5]);
  assert.deepEqual([...pinnedBones(bones, ["Ctr_F_Hair_012", "No_Such_Bone"])].sort(), [2, 3, 5]);
});

test("each pinned bone maps to its nearest ancestor that physics doesn't move", () => {
  const targets = pinTargets(bones, ["Ctr_F_Hair_012", "Ctr_F_Hair_013"], (i) => dynamic.has(i));
  assert.deepEqual([...targets], [[2, 1], [3, 1]]);
});

test("names missing from the rig are skipped, not fatal", () => {
  const targets = pinTargets(bones, ["Ctr_F_Hair_013", "No_Such_Bone"], (i) => dynamic.has(i));
  assert.deepEqual([...targets], [[3, 1]]);
});

test("weights on pinned bones move to the target and each vertex still sums to 1", () => {
  // v0: all on the curl tip; v1: shared root/curl; v2: untouched other hair
  const skinIndex = new Uint16Array([3, 0, 0, 0, 1, 2, 3, 0, 4, 0, 0, 0]);
  const skinWeight = new Float32Array([1, 0, 0, 0, 0.5, 0.3, 0.2, 0, 1, 0, 0, 0]);
  const changed = pinWeights(skinIndex, skinWeight, new Map([[2, 1], [3, 1]]));
  assert.equal(changed, 2);
  const influence = (v, bone) => [0, 1, 2, 3].reduce((sum, k) =>
    sum + (skinIndex[v * 4 + k] === bone ? skinWeight[v * 4 + k] : 0), 0);
  assert.ok(Math.abs(influence(0, 1) - 1) < 1e-6, "v0 rides on the root");
  assert.ok(Math.abs(influence(1, 1) - 1) < 1e-6, "v1 merges into one root influence");
  for (const v of [0, 1, 2]) {
    assert.equal(influence(v, 2) + influence(v, 3), 0, `v${v} keeps no curl weight`);
    const total = [0, 1, 2, 3].reduce((s, k) => s + skinWeight[v * 4 + k], 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `v${v} sums to 1`);
  }
  assert.deepEqual([...skinIndex.slice(8)], [4, 0, 0, 0], "other hair is untouched");
  assert.deepEqual([...skinWeight.slice(8)], [1, 0, 0, 0]);
});

test("a merged influence leaves an empty slot at weight 0", () => {
  const skinIndex = new Uint16Array([1, 2, 0, 0]);
  const skinWeight = new Float32Array([0.6, 0.4, 0, 0]);
  pinWeights(skinIndex, skinWeight, new Map([[2, 1]]));
  assert.deepEqual([...skinWeight].map((w) => +w.toFixed(3)), [1, 0, 0, 0]);
});

test("with nothing to pin, nothing changes", () => {
  const skinIndex = new Uint16Array([3, 0, 0, 0]);
  const skinWeight = new Float32Array([1, 0, 0, 0]);
  assert.equal(pinWeights(skinIndex, skinWeight, new Map()), 0);
  assert.deepEqual([...skinIndex], [3, 0, 0, 0]);
});

const PMX = new URL("../../yidhari-mmd/伊德海莉.pmx", import.meta.url);
const PARSER = new URL("../../node_modules/three/examples/jsm/libs/mmdparser.module.js", import.meta.url);
const haveModel = existsSync(PMX) && existsSync(PARSER);

test("her real rig: every stiffened strand blends towards a bone that physics doesn't move", { skip: !haveModel && "PMX or MMD parser absent" }, async () => {
  const { stiffStrands } = await import("../../renderer/weight-pins.js");
  const { MMDParser } = await import(PARSER.href);
  const bytes = readFileSync(PMX);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
  const rigBones = data.bones.map((b) => ({ name: b.name, parent: b.parentIndex }));
  const driven = new Set(data.rigidBodies.filter((rb) => rb.type !== 0).map((rb) => rb.boneIndex));
  const names = stiffStrands(rigBones.map((b) => b.name));
  for (const side of ["Ctr_L_HairA_03", "Ctr_R_HairA_04", "Ctr_B_HairB_01", "Ctr_F_Hair_09", "Ctr_F_HairB_01"]) {
    assert.ok(names.includes(side), side);
  }
  const targets = pinTargets(rigBones, names, (i) => driven.has(i));
  assert.equal(targets.size, 40, "40 hair bones outside the curl's pinned root");
  for (const tip of ["Ctr_F_Hair_014", "Ctr_F_Hair_015", "Ctr_F_Hair_016", "Ctr_F_Hair_018"]) {
    assert.ok(names.includes(tip), `${tip} is blended, not pinned`);
  }
  for (const target of targets.values()) assert.ok(!driven.has(target), `${rigBones[target].name} is still`);
});

test("her real rig: the curl pins to Ctr_F_Hair_01, which has no body", { skip: !haveModel && "PMX or MMD parser absent" }, async () => {
  const { MMDParser } = await import(PARSER.href);
  const bytes = readFileSync(PMX);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
  const rigBones = data.bones.map((b) => ({ name: b.name, parent: b.parentIndex }));
  const driven = new Set(data.rigidBodies.filter((rb) => rb.type !== 0).map((rb) => rb.boneIndex));
  const targets = pinTargets(rigBones, PINNED_STRANDS, (i) => driven.has(i));
  assert.equal(targets.size, PINNED_STRANDS.length);
  for (const target of new Set(targets.values())) assert.equal(rigBones[target].name, "Ctr_F_Hair_01");
  // The root's kinematic bodies are its own two; their 錘 weights are the only bodies dropped.
  const { kinematicBodies, CURL_ROOT_WEIGHTS } = await import("../../renderer/weight-pins.js");
  assert.deepEqual([...CURL_ROOT_WEIGHTS], ["Ctr_F_Hair_012錘", "Ctr_F_Hair_013錘"]);
  const out = kinematicBodies(data.rigidBodies, data.constraints, rigBones, PINNED_STRANDS);
  const kinematic = out.rigidBodies.filter((rb, i) => rb.type === 0 && data.rigidBodies[i].type !== 0).map((rb) => rb.name);
  assert.deepEqual(kinematic, ["Ctr_F_Hair_012", "Ctr_F_Hair_013"]);
  const dropped = data.constraints.filter((c) => !out.constraints.includes(c)).map((c) => c.name);
  assert.deepEqual(dropped, ["Ctr_F_Hair_012横"], "only the weld to the fringe base goes");
});

test("every hair strand except the static curl is stiffened, without weight (錘) bones", async () => {
  const { stiffStrands, HAIR_FOLLOW } = await import("../../renderer/weight-pins.js");
  const names = [
    "頭", "Ctr_F_Hair_01", "Ctr_F_Hair_02", "Ctr_F_Hair_02錘", "Ctr_F_Hair_09", "Ctr_F_HairB_01",
    "Ctr_F_Hair_013", "Ctr_L_HairA_03", "Ctr_R_HairB_02", "Ctr_B_HairC_01", "Ctr_T_Hair_01",
    "Ctr_Hat_05", "左Tail1_1", "左腕",
  ];
  assert.deepEqual(stiffStrands(names), [
    "Ctr_F_Hair_01", "Ctr_F_Hair_02", "Ctr_F_Hair_09", "Ctr_F_HairB_01",
    "Ctr_L_HairA_03", "Ctr_R_HairB_02", "Ctr_B_HairC_01", "Ctr_T_Hair_01",
  ]);
  assert.equal(HAIR_FOLLOW, 0.4, "40% follows physics, 60% rides a still bone");
});

test("blendWeights keeps a share on the moving bone and gives the rest to the still bone", async () => {
  const { blendWeights } = await import("../../renderer/weight-pins.js");
  // v0: all on the strand (2); v1: strand + still bone already present; v2: four influences, no free slot
  const skinIndex = new Uint16Array([2, 0, 0, 0, 2, 1, 0, 0, 2, 4, 5, 6]);
  const skinWeight = new Float32Array([1, 0, 0, 0, 0.6, 0.4, 0, 0, 0.4, 0.2, 0.2, 0.2]);
  const result = blendWeights(skinIndex, skinWeight, new Map([[2, 1]]), 0.4);
  const influence = (v, bone) => [0, 1, 2, 3].reduce((sum, k) =>
    sum + (skinIndex[v * 4 + k] === bone ? skinWeight[v * 4 + k] : 0), 0);
  assert.ok(Math.abs(influence(0, 2) - 0.4) < 1e-6 && Math.abs(influence(0, 1) - 0.6) < 1e-6, "v0 split 40/60");
  assert.ok(Math.abs(influence(1, 2) - 0.24) < 1e-6 && Math.abs(influence(1, 1) - 0.76) < 1e-6, "v1 merges the share");
  for (const v of [0, 1, 2]) {
    const total = [0, 1, 2, 3].reduce((s, k) => s + skinWeight[v * 4 + k], 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `v${v} sums to 1`);
  }
  assert.deepEqual([...skinIndex.slice(8)], [2, 4, 5, 6], "a full vertex is left alone");
  assert.deepEqual(result, { changed: 2, skipped: 1 });
});

test("blendWeights with follow 1 changes nothing, and with 0 matches a full pin", async () => {
  const { blendWeights } = await import("../../renderer/weight-pins.js");
  const idx = new Uint16Array([2, 0, 0, 0]);
  const w = new Float32Array([1, 0, 0, 0]);
  assert.deepEqual(blendWeights(idx, w, new Map([[2, 1]]), 1), { changed: 0, skipped: 0 });
  assert.deepEqual([...idx], [2, 0, 0, 0]);
  blendWeights(idx, w, new Map([[2, 1]]), 0);
  assert.equal(idx[0], 1);
  assert.equal(w[0], 1);
});
