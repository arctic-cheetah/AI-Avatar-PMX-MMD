// See-through brows (#99 step 4): the brows sit under the bangs, so the
// brow-only triangles are drawn a second time over the hair, semi-transparent.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEE_THROUGH_BROWS_KEY, addSeeThroughBrows, bindSeeThroughBrowsToggle, browOnlyTriangles, movedVertices,
} from "../../renderer/see-through-brows.js";

/** A position attribute over [x, y, z] triples. */
const attr = (points) => ({
  count: points.length,
  getX: (i) => points[i][0], getY: (i) => points[i][1], getZ: (i) => points[i][2],
});

// Vertices 0–2 and 3–5 are two brow triangles, 6–8 an eyelid, 9 is shared by both.
const BASE = Array.from({ length: 10 }, (_, i) => [i, 0, 0]);
const shift = (moved, dy = 1) => BASE.map((p, i) => (moved.includes(i) ? [p[0], p[1] + dy, p[2]] : p));

function rig({ browMaterial = "睫眉", relative = false } = {}) {
  const targets = {
    "困る": shift([0, 1, 2, 3, 4, 5]),
    "怒り": shift([0, 1, 2, 9]),
    "まばたき": shift([6, 7, 8, 9]),
  };
  const offsets = (points) => points.map((p, i) => [p[0] - BASE[i][0], p[1] - BASE[i][1], p[2] - BASE[i][2]]);
  const names = Object.keys(targets);
  const geometry = {
    attributes: { position: attr(BASE) },
    morphTargetsRelative: relative,
    morphAttributes: { position: names.map((n) => attr(relative ? offsets(targets[n]) : targets[n])) },
    // Group 0 (face): one triangle. Group 1 (brows+lids): brow, brow, lid, mixed brow/lid.
    index: { array: Uint16Array.from([0, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 9]) },
    groups: [{ start: 0, count: 3, materialIndex: 0 }, { start: 3, count: 12, materialIndex: 1 }],
    setIndex(array) { this.index = { array }; },
    addGroup(start, count, materialIndex) { this.groups.push({ start, count, materialIndex }); },
  };
  const material = (name) => ({
    name, opacity: 1, transparent: false, depthTest: true, depthWrite: true, visible: true, userData: {},
    clone() { return { ...this, userData: structuredClone(this.userData) }; },
  });
  return {
    geometry,
    morphTargetDictionary: Object.fromEntries(names.map((n, i) => [n, i])),
    material: [material("颜"), material(browMaterial)],
  };
}

const BROWS = { brows: ["困る", "怒り"], eyes: ["まばたき"] };

test("moved vertices are found for absolute and relative morph targets", () => {
  for (const relative of [false, true]) {
    const mesh = rig({ relative });
    assert.deepEqual([...movedVertices(mesh, ["怒り"])].sort(), [0, 1, 2, 9], `relative=${relative}`);
    assert.deepEqual([...movedVertices(mesh, ["まばたき", "missing"])].sort(), [6, 7, 8, 9]);
  }
});

test("only triangles moved purely by brow morphs, inside the brow group, are picked", () => {
  const mesh = rig();
  const brow = movedVertices(mesh, BROWS.brows);
  const eye = movedVertices(mesh, BROWS.eyes);
  assert.deepEqual(browOnlyTriangles(mesh.geometry.index.array, mesh.geometry.groups[1], brow, eye), [0, 1, 2, 3, 4, 5]);
  // The face group's triangle touches brow vertex 0 but is outside the brow group.
  assert.deepEqual(browOnlyTriangles(mesh.geometry.index.array, mesh.geometry.groups[0], brow, eye), []);
});

test("the overlay redraws the brow triangles over the hair with its own material", () => {
  const mesh = rig();
  const before = [...mesh.geometry.index.array];
  const brows = addSeeThroughBrows(mesh, { ...BROWS, opacity: 0.6 });
  assert.equal(brows.triangles, 2);
  assert.equal(mesh.material.length, 3);
  const overlay = mesh.material[2];
  assert.equal(brows.material, overlay);
  assert.deepEqual(
    { transparent: overlay.transparent, depthTest: overlay.depthTest, depthWrite: overlay.depthWrite, opacity: overlay.opacity },
    { transparent: true, depthTest: false, depthWrite: false, opacity: 0.6 },
  );
  assert.equal(overlay.userData.outlineParameters.visible, false, "no outline drawn over the hair");
  assert.equal(mesh.material[1].depthTest, true, "the original brow material is untouched");
  assert.deepEqual([...mesh.geometry.index.array], [...before, 0, 1, 2, 3, 4, 5]);
  assert.deepEqual(mesh.geometry.groups.at(-1), { start: before.length, count: 6, materialIndex: 2 });
});

test("the overlay can be switched off and on without rebuilding", () => {
  const mesh = rig();
  const brows = addSeeThroughBrows(mesh, BROWS);
  brows.setEnabled(false);
  assert.equal(brows.material.visible, false);
  brows.setEnabled(true);
  assert.equal(brows.material.visible, true);
  assert.equal(mesh.geometry.groups.length, 3);
});

test("a model without the brow material or brow triangles is left untouched", () => {
  for (const mesh of [rig({ browMaterial: "eyebrows" }), rig()]) {
    const options = mesh.material[1].name === "睫眉" ? { brows: ["missing"], eyes: [] } : BROWS;
    const groups = mesh.geometry.groups.length;
    assert.equal(addSeeThroughBrows(mesh, options), null);
    assert.equal(mesh.material.length, 2);
    assert.equal(mesh.geometry.groups.length, groups);
  }
});

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

function toggle() {
  const listeners = [];
  return {
    checked: false,
    addEventListener: (type, fn) => type === "change" && listeners.push(fn),
    flip(value) { this.checked = value; for (const fn of listeners) fn(); },
  };
}

test("the page toggle starts on and remembers being turned off", () => {
  const local = storage();
  const brows = addSeeThroughBrows(rig(), BROWS);
  const box = toggle();
  bindSeeThroughBrowsToggle(brows, box, { local });
  assert.equal(box.checked, true);
  assert.equal(brows.material.visible, true);
  box.flip(false);
  assert.equal(brows.material.visible, false);
  assert.equal(local.map.get(SEE_THROUGH_BROWS_KEY), "0");

  const again = addSeeThroughBrows(rig(), BROWS);
  const reopened = toggle();
  bindSeeThroughBrowsToggle(again, reopened, { local });
  assert.equal(reopened.checked, false);
  assert.equal(again.material.visible, false);
});

test("the toggle still works when storage throws, and is disabled without an overlay", () => {
  const local = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const brows = addSeeThroughBrows(rig(), BROWS);
  const box = toggle();
  bindSeeThroughBrowsToggle(brows, box, { local });
  box.flip(false);
  assert.equal(brows.material.visible, false);

  const missing = { ...toggle(), disabled: false };
  bindSeeThroughBrowsToggle(null, missing, { local });
  assert.equal(missing.disabled, true);
});
