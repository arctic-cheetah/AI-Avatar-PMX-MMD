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

test("the static strands are the spiral curl and the strand over the brow", () => {
  assert.deepEqual([...PINNED_STRANDS], [
    "Ctr_F_Hair_012", "Ctr_F_Hair_013", "Ctr_F_Hair_014", "Ctr_F_Hair_015", "Ctr_F_Hair_016", "Ctr_F_Hair_018",
    "Ctr_F_Hair_09", "Ctr_F_Hair_010",
  ]);
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

test("her real rig: the curl pins to Ctr_F_Hair_01, which has no body", { skip: !haveModel && "PMX or MMD parser absent" }, async () => {
  const { MMDParser } = await import(PARSER.href);
  const bytes = readFileSync(PMX);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
  const rigBones = data.bones.map((b) => ({ name: b.name, parent: b.parentIndex }));
  const driven = new Set(data.rigidBodies.filter((rb) => rb.type !== 0).map((rb) => rb.boneIndex));
  const targets = pinTargets(rigBones, PINNED_STRANDS, (i) => driven.has(i));
  assert.equal(targets.size, PINNED_STRANDS.length);
  for (const target of new Set(targets.values())) assert.equal(rigBones[target].name, "Ctr_F_Hair_01");
  // Each strand's bodies hang off pinned bones: 6 curl + 2 brow-strand bones, each with its 錘.
  const pinned = pinnedBones(rigBones, PINNED_STRANDS);
  const bodies = data.rigidBodies.filter((rb) => pinned.has(rb.boneIndex)).map((rb) => rb.name).sort();
  assert.deepEqual(bodies, [
    "Ctr_F_Hair_010", "Ctr_F_Hair_010錘", "Ctr_F_Hair_012", "Ctr_F_Hair_012錘", "Ctr_F_Hair_013", "Ctr_F_Hair_013錘",
    "Ctr_F_Hair_014", "Ctr_F_Hair_014錘", "Ctr_F_Hair_015", "Ctr_F_Hair_015錘", "Ctr_F_Hair_016", "Ctr_F_Hair_016錘",
    "Ctr_F_Hair_018", "Ctr_F_Hair_018錘", "Ctr_F_Hair_09", "Ctr_F_Hair_09錘",
  ]);
});

test("the stiffened strands are the rest of the front fringe", async () => {
  const { STIFF_STRANDS, FRINGE_FOLLOW } = await import("../../renderer/weight-pins.js");
  assert.deepEqual([...STIFF_STRANDS], [
    "Ctr_F_Hair_02", "Ctr_F_Hair_03", "Ctr_F_Hair_04", "Ctr_F_Hair_06", "Ctr_F_Hair_07", "Ctr_F_HairB_01",
  ]);
  assert.ok(FRINGE_FOLLOW > 0 && FRINGE_FOLLOW < 1, "the fringe still moves, just less");
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
