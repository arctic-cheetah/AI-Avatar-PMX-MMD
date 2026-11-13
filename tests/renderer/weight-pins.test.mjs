// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { RIGID_STRANDS, pinTargets, pinWeights, pinnedBones } from "../../renderer/weight-pins.js";
import { filterPhysics, defaultPhysicsGroups } from "../../renderer/physics-groups.js";

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

test("only the curl's root (012) keeps physics; the rest of the curl is rigid", () => {
  assert.deepEqual([...RIGID_STRANDS], [
    "Ctr_F_Hair_013", "Ctr_F_Hair_014", "Ctr_F_Hair_015", "Ctr_F_Hair_016", "Ctr_F_Hair_018",
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
  assert.equal(targets.size, 42, "all 42 hair bones");
  for (const curl of ["Ctr_F_Hair_012", "Ctr_F_Hair_013", "Ctr_F_Hair_016", "Ctr_F_Hair_018"]) {
    assert.ok(names.includes(curl), `${curl} is blended like the rest`);
  }
  for (const target of targets.values()) assert.ok(!driven.has(target), `${rigBones[target].name} is still`);
});

test("her real rig: the rigid curl loses only its own 10 bodies and nothing orphans", { skip: !haveModel && "PMX or MMD parser absent" }, async () => {
  const { MMDParser } = await import(PARSER.href);
  const bytes = readFileSync(PMX);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
  const rigBones = data.bones.map((b) => ({ name: b.name, parent: b.parentIndex }));
  const rigid = pinnedBones(rigBones, RIGID_STRANDS);
  const dropped = data.rigidBodies.filter((rb) => rigid.has(rb.boneIndex)).map((rb) => rb.name).sort();
  assert.deepEqual(dropped, [
    "Ctr_F_Hair_013", "Ctr_F_Hair_013錘", "Ctr_F_Hair_014", "Ctr_F_Hair_014錘", "Ctr_F_Hair_015", "Ctr_F_Hair_015錘",
    "Ctr_F_Hair_016", "Ctr_F_Hair_016錘", "Ctr_F_Hair_018", "Ctr_F_Hair_018錘",
  ]);
  const out = filterPhysics(data.rigidBodies, data.constraints, defaultPhysicsGroups(),
    { drop: (body) => rigid.has(body.boneIndex) });
  assert.ok(out.rigidBodies.some((rb) => rb.name === "Ctr_F_Hair_012"), "the root keeps its physics");
  assert.deepEqual(out.orphaned, []);
});

test("every hair strand is stiffened, without weight (錘) bones", async () => {
  const { stiffStrands, HAIR_FOLLOW } = await import("../../renderer/weight-pins.js");
  const names = [
    "頭", "Ctr_F_Hair_01", "Ctr_F_Hair_02", "Ctr_F_Hair_02錘", "Ctr_F_Hair_09", "Ctr_F_HairB_01",
    "Ctr_F_Hair_013", "Ctr_L_HairA_03", "Ctr_R_HairB_02", "Ctr_B_HairC_01", "Ctr_T_Hair_01",
    "Ctr_Hat_05", "左Tail1_1", "左腕",
  ];
  assert.deepEqual(stiffStrands(names), [
    "Ctr_F_Hair_01", "Ctr_F_Hair_02", "Ctr_F_Hair_09", "Ctr_F_HairB_01",
    "Ctr_F_Hair_013", "Ctr_L_HairA_03", "Ctr_R_HairB_02", "Ctr_B_HairC_01", "Ctr_T_Hair_01",
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
  assert.deepEqual(result, { changed: 2, skipped: 1, folded: 0 });
});

test("blendWeights with follow 1 changes nothing, and with 0 matches a full pin", async () => {
  const { blendWeights } = await import("../../renderer/weight-pins.js");
  const idx = new Uint16Array([2, 0, 0, 0]);
  const w = new Float32Array([1, 0, 0, 0]);
  assert.deepEqual(blendWeights(idx, w, new Map([[2, 1]]), 1), { changed: 0, skipped: 0, folded: 0 });
  assert.deepEqual([...idx], [2, 0, 0, 0]);
  blendWeights(idx, w, new Map([[2, 1]]), 0);
  assert.equal(idx[0], 1);
  assert.equal(w[0], 1);
});

test("blendWeights puts the share on a bone that moves exactly like the target, instead of skipping", async () => {
  const { blendWeights } = await import("../../renderer/weight-pins.js");
  // Bone 7 (say 頭) moves exactly like target 1 (a plain still child of it); no free slot.
  const skinIndex = new Uint16Array([2, 3, 4, 7]);
  const skinWeight = new Float32Array([0.4, 0.3, 0.2, 0.1]);
  const sameMotion = (a, b) => (a === 1 || a === 7) && (b === 1 || b === 7);
  const result = blendWeights(skinIndex, skinWeight, new Map([[2, 1], [3, 1], [4, 1]]), 0.4, { sameMotion });
  assert.deepEqual(result, { changed: 1, skipped: 0, folded: 0 });
  assert.deepEqual([...skinIndex], [2, 3, 4, 7]);
  assert.deepEqual([...skinWeight].map((w) => +w.toFixed(3)), [0.16, 0.12, 0.08, 0.64]);
});

test("blendWeights folds the smallest moving influence into the largest when all four slots move", async () => {
  const { blendWeights } = await import("../../renderer/weight-pins.js");
  const skinIndex = new Uint16Array([2, 3, 4, 5]);
  const skinWeight = new Float32Array([0.4, 0.3, 0.2, 0.1]);
  const targets = new Map([[2, 1], [3, 1], [4, 1], [5, 1]]);
  const result = blendWeights(skinIndex, skinWeight, targets, 0.4);
  assert.deepEqual(result, { changed: 1, skipped: 0, folded: 1 });
  const influence = (bone) => [0, 1, 2, 3].reduce((s, k) => s + (skinIndex[k] === bone ? skinWeight[k] : 0), 0);
  // 5 folded into 2 (0.5), then every moving weight keeps 40% and the target gets 60% of the moving total.
  assert.ok(Math.abs(influence(2) - 0.2) < 1e-6, `bone 2 ${influence(2)}`);
  assert.ok(Math.abs(influence(3) - 0.12) < 1e-6 && Math.abs(influence(4) - 0.08) < 1e-6);
  assert.ok(Math.abs(influence(1) - 0.6) < 1e-6, "the still target carries 60%");
  assert.equal(influence(5), 0);
});

test("every vertex on a blended strand ends with the same 40% on moving bones", async () => {
  const { blendWeights } = await import("../../renderer/weight-pins.js");
  // v0 has a free slot, v1 has the target's twin, v2 is full of moving bones.
  const skinIndex = new Uint16Array([2, 0, 0, 0, 2, 3, 4, 7, 2, 3, 4, 5]);
  const skinWeight = new Float32Array([1, 0, 0, 0, 0.4, 0.3, 0.2, 0.1, 0.4, 0.3, 0.2, 0.1]);
  const moving = new Set([2, 3, 4, 5]);
  const targets = new Map([...moving].map((b) => [b, 1]));
  const sameMotion = (a, b) => (a === 1 || a === 7) && (b === 1 || b === 7);
  blendWeights(skinIndex, skinWeight, targets, 0.4, { sameMotion });
  const share = (v) => [0, 1, 2, 3].reduce((s, k) => s + (moving.has(skinIndex[v * 4 + k]) ? skinWeight[v * 4 + k] : 0), 0);
  assert.ok(Math.abs(share(0) - 0.4) < 1e-6, `v0 ${share(0)}`);
  assert.ok(Math.abs(share(1) - 0.9 * 0.4) < 1e-6, `v1 ${share(1)}`); // 0.1 was already on the still twin
  assert.ok(Math.abs(share(2) - 0.4) < 1e-6, `v2 ${share(2)}`);
});

test("sameMotionAs: a plain Ctr_ bone with no body moves exactly like its parent", async () => {
  const { sameMotionAs } = await import("../../renderer/weight-pins.js");
  // 0 首, 1 頭 (posed by gaze), 2 Ctr_F_Hair_01 (no body), 3 Ctr_F_Hair_02 (dynamic), 4 Ctr_F_Hair_x (no body, under 3)
  const rig = [
    { name: "首", parent: -1 }, { name: "頭", parent: 0 }, { name: "Ctr_F_Hair_01", parent: 1 },
    { name: "Ctr_F_Hair_02", parent: 2 }, { name: "Ctr_F_Hair_x", parent: 3 },
  ];
  const same = sameMotionAs(rig, (i) => i === 3);
  assert.ok(same(2, 1) && same(1, 2), "Ctr_F_Hair_01 ≡ 頭");
  assert.ok(!same(1, 0), "頭 is posed by gaze, so not ≡ 首");
  assert.ok(!same(3, 2), "a dynamic bone is its own motion");
  assert.ok(same(4, 3), "a plain child follows its dynamic parent exactly");
  assert.ok(same(2, 2));
});
