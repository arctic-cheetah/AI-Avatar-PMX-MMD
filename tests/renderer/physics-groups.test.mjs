// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  PHYSICS_GROUPS,
  classifyBody,
  defaultPhysicsGroups,
  filterPhysics,
} from "../../renderer/physics-groups.js";

const KINEMATIC = 0;
const PHYSICS = 1;
const PHYSICS_BONE = 2;

const body = (name, type) => ({ name, type, boneIndex: 0 });
const joint = (name, a, b) => ({ name, rigidBodyIndex1: a, rigidBodyIndex2: b });

/**
 * A small rig shaped like hers: a kinematic head and waist, hair with a hat
 * jointed to it, a tail, chest, hips, and a bag that hangs only from a chain.
 */
function rig() {
  const rigidBodies = [
    body("頭", KINEMATIC), //                  0
    body("下半身", KINEMATIC), //              1
    body("Ctr_B_Hair_01", PHYSICS_BONE), //    2
    body("Ctr_B_Hair_01錘", PHYSICS), //       3
    body("Ctr_Hat_03", PHYSICS_BONE), //       4
    body("左Tail1_1", PHYSICS), //             5
    body("左胸上", PHYSICS), //                6
    body("左尻上", PHYSICS_BONE), //           7
    body("Skn_B_Chain_01", PHYSICS), //        8
    body("Ctr_Bag_01", PHYSICS), //            9
  ];
  const constraints = [
    joint("head-hair", 0, 2), //   0
    joint("hair-weight", 2, 3), // 1
    joint("head-hat", 0, 4), //    2
    joint("hair-hat", 3, 4), //    3 crosses hair and hat
    joint("waist-tail", 1, 5), //  4
    joint("waist-chest", 1, 6), // 5
    joint("waist-hips", 1, 7), //  6
    joint("waist-chain", 1, 8), // 7
    joint("chain-bag", 8, 9), //   8 the bag's only anchor
  ];
  return { rigidBodies, constraints };
}

const ALL = PHYSICS_GROUPS.map((group) => group.id);
const names = (bodies) => bodies.map((b) => b.name);

test("groups cover the rig's simulated parts, each with a label and default", () => {
  assert.deepEqual(ALL, [
    "fringe", "hair", "hat", "tails", "bag", "chains", "butterflies", "footRings", "chest", "hips",
  ]);
  for (const group of PHYSICS_GROUPS) {
    assert.equal(typeof group.label, "string", group.id);
    assert.equal(typeof group.enabledByDefault, "boolean", group.id);
  }
});

test("dynamic bodies are classified by name, including their weight (錘) bodies", () => {
  const cases = {
    Ctr_F_Hair_013: "fringe",
    Ctr_F_Hair_010錘: "fringe",
    Ctr_F_HairB_01: "fringe",
    Ctr_B_HairA_03: "hair",
    Ctr_L_HairA_01錘: "hair",
    Ctr_T_Hair_01: "hair",
    Ctr_Hat_05錘: "hat",
    右Tail2_17: "tails",
    Ctr_Tail_Root: "tails",
    Ctr_Bag_Z_03錘: "bag",
    Skn_F_Chain_02: "chains",
    Ctr_Badge_01: "chains",
    Skn_B_Daizi_01: "chains",
    Skn_L_Butterfly_03錘: "butterflies",
    Skn_R_FootRing_02: "footRings",
    左胸上: "chest",
    右胸下: "chest",
    左尻下錘: "hips",
    右ひざ2: "hips",
    左足2錘: "hips",
  };
  for (const [name, group] of Object.entries(cases)) {
    assert.equal(classifyBody(body(name, PHYSICS)), group, name);
  }
});

test("kinematic bodies belong to no group, even when their name matches one", () => {
  for (const name of ["頭", "左胸", "上半身2", "Ctr_Hat_01"]) {
    assert.equal(classifyBody(body(name, KINEMATIC)), null, name);
  }
});

test("an unknown dynamic body is 'other', so a new rig part is never silently lost", () => {
  assert.equal(classifyBody(body("Yid_L_Sleeve_01", PHYSICS)), "other");
});

test("defaults keep hair, hat, tails, bag and chains; the fringe follows its bones", () => {
  assert.deepEqual([...defaultPhysicsGroups()].sort(), ["bag", "chains", "hair", "hat", "tails"]);
});

test("with every group enabled, nothing is dropped and indices are unchanged", () => {
  const { rigidBodies, constraints } = rig();
  const out = filterPhysics(rigidBodies, constraints, ALL);
  assert.deepEqual(names(out.rigidBodies), names(rigidBodies));
  assert.deepEqual(
    out.constraints.map((c) => [c.rigidBodyIndex1, c.rigidBodyIndex2]),
    constraints.map((c) => [c.rigidBodyIndex1, c.rigidBodyIndex2]),
  );
  assert.deepEqual(out.orphaned, []);
});

test("a disabled group loses its bodies and every joint that touches them", () => {
  const { rigidBodies, constraints } = rig();
  const out = filterPhysics(rigidBodies, constraints, ALL.filter((id) => id !== "hair"));
  assert.ok(!names(out.rigidBodies).some((n) => n.includes("Hair")));
  assert.deepEqual(
    out.constraints.map((c) => c.name),
    ["head-hat", "waist-tail", "waist-chest", "waist-hips", "waist-chain", "chain-bag"],
  );
});

test("joint indices are remapped to the bodies' new positions", () => {
  const { rigidBodies, constraints } = rig();
  const out = filterPhysics(rigidBodies, constraints, ["tails", "bag", "chains"]);
  assert.deepEqual(names(out.rigidBodies), ["頭", "下半身", "左Tail1_1", "Skn_B_Chain_01", "Ctr_Bag_01"]);
  for (const c of out.constraints) {
    const original = constraints.find((o) => o.name === c.name);
    assert.equal(out.rigidBodies[c.rigidBodyIndex1].name, rigidBodies[original.rigidBodyIndex1].name, c.name);
    assert.equal(out.rigidBodies[c.rigidBodyIndex2].name, rigidBodies[original.rigidBodyIndex2].name, c.name);
  }
  assert.deepEqual([...out.bodyIndex], [0, 1, -1, -1, -1, 2, -1, -1, 3, 4]);
});

test("a cross-group joint goes, but a body still anchored elsewhere stays", () => {
  const { rigidBodies, constraints } = rig();
  const out = filterPhysics(rigidBodies, constraints, ["hat"]);
  assert.ok(names(out.rigidBodies).includes("Ctr_Hat_03"));
  assert.ok(!out.constraints.some((c) => c.name === "hair-hat"));
  assert.deepEqual(out.orphaned, []);
});

test("a body left with no path to a kinematic body is dropped and reported, not left to fall", () => {
  const { rigidBodies, constraints } = rig();
  const out = filterPhysics(rigidBodies, constraints, ["bag"]);
  assert.ok(!names(out.rigidBodies).includes("Ctr_Bag_01"));
  assert.deepEqual(out.orphaned, ["Ctr_Bag_01"]);
  assert.ok(!out.constraints.some((c) => c.name === "chain-bag"));
});

test("chest and hips switch on and off independently", () => {
  const { rigidBodies, constraints } = rig();
  const chestOnly = names(filterPhysics(rigidBodies, constraints, ["chest"]).rigidBodies);
  const hipsOnly = names(filterPhysics(rigidBodies, constraints, ["hips"]).rigidBodies);
  assert.ok(chestOnly.includes("左胸上") && !chestOnly.includes("左尻上"));
  assert.ok(hipsOnly.includes("左尻上") && !hipsOnly.includes("左胸上"));
});

test("unknown dynamic bodies are always kept", () => {
  const rigidBodies = [body("頭", KINEMATIC), body("Yid_L_Sleeve_01", PHYSICS)];
  const constraints = [joint("head-sleeve", 0, 1)];
  const out = filterPhysics(rigidBodies, constraints, []);
  assert.deepEqual(names(out.rigidBodies), ["頭", "Yid_L_Sleeve_01"]);
});

test("the input params are never mutated", () => {
  const { rigidBodies, constraints } = rig();
  const before = JSON.stringify({ rigidBodies, constraints });
  filterPhysics(rigidBodies, constraints, ["tails"]);
  assert.equal(JSON.stringify({ rigidBodies, constraints }), before);
});

test("a joint with an out-of-range body index is dropped, not passed to Ammo", () => {
  const rigidBodies = [body("頭", KINEMATIC), body("Ctr_B_Hair_01", PHYSICS_BONE)];
  const constraints = [joint("ok", 0, 1), joint("bad", 0, 7), joint("none", -1, 1)];
  const out = filterPhysics(rigidBodies, constraints, ["hair"]);
  assert.deepEqual(out.constraints.map((c) => c.name), ["ok"]);
});

const PMX = new URL("../../yidhari-mmd/伊德海莉.pmx", import.meta.url);
const PARSER = new URL("../../node_modules/three/examples/jsm/libs/mmdparser.module.js", import.meta.url);
const haveModel = existsSync(PMX) && existsSync(PARSER);

test("her real rig: every dynamic body has a group and the defaults leave no orphans", { skip: !haveModel && "PMX or MMD parser absent" }, async () => {
  const { MMDParser } = await import(PARSER.href);
  const bytes = readFileSync(PMX);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
  const counts = {};
  for (const rb of data.rigidBodies) {
    const group = classifyBody(rb);
    if (group) counts[group] = (counts[group] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    fringe: 28, hair: 52, hat: 12, tails: 69, bag: 25, chains: 23,
    butterflies: 24, footRings: 16, chest: 6, hips: 16,
  });
  const out = filterPhysics(data.rigidBodies, data.constraints, defaultPhysicsGroups());
  assert.deepEqual(out.orphaned, []);
  assert.equal(out.rigidBodies.filter((rb) => rb.type !== KINEMATIC).length, 52 + 12 + 69 + 25 + 23);
  // The fringe on its own still hangs from the head, so it never orphans.
  assert.deepEqual(filterPhysics(data.rigidBodies, data.constraints, ["fringe"]).orphaned, []);
  // Bag without chains has no anchor left: it must be dropped, not left to fall.
  const bagOnly = filterPhysics(data.rigidBodies, data.constraints, ["bag"]);
  assert.equal(bagOnly.orphaned.length, 25);
});
