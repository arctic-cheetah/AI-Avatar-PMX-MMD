// Game shaders toggle (#251): load the baked Goo inputs (#250), swap in the
// game textures per PMX material, and fall back to today's material on any failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  GOO_SHADERS_KEY, bindGooShadersToggle, createGooMaterials, loadGooAssets, loadGooTextures,
} from "../../renderer/goo-material.js";

const MANIFEST = {
  version: 1, colSpace: "sRGB",
  pmx: { vertexCount: 3, materials: ["颜", "目影", "髮+"], samples: [{ index: 0, position: [0, 0, 0] }] },
};
const MATERIAL_MAP = {
  materials: [
    {
      pmx: "颜", game: "Yidhari Face", params: "Yidhari Face", hidden: false, shader: "zzzb",
      textures: { diffuse: "Yidhari_Face_D.png", faceLightmap: "Female_Face_Lightmap.png" },
      colorSpaces: { diffuse: "sRGB", faceLightmap: "Non-Color" },
    },
    { pmx: "目影", game: "Eye Shadow", hidden: false, shader: "transparent", color: [0.5, 0.25, 1, 1], textures: {} },
    { pmx: "髮+", game: null, hidden: true, shader: null, textures: {} },
  ],
};
const COLOR = [0.9, 0.8, 0.8, 1];
const PARAMS = {
  "Yidhari Face": {
    "Enable Face Shading": 1, "Enable Cast Shadows": 1, "Shadow Position": 0, "Shadow Softness": 0.25,
    "Shadow Fade Strength": 0, "SSS Effect Strength": 1, "Color Attribute Alpha": { attribute: "Col" },
    "Shadow Color Multiplier": COLOR, "Sun Light Color": [1.2, 1.15, 1.08, 1], "Shadow Transition Color": COLOR,
    ...Object.fromEntries(["", "2", "3", "4", "5"].flatMap((n) => [
      [`Shadow Color${n}`, COLOR], [`Shallow Color${n}`, COLOR], [`Local Indirect Color${n}`, [1, 0.3, 0.2, 1]],
    ])),
  },
};
const SCENE = {
  light: { eulerXYZ: [Math.PI / 2, 0, 0] },
  head: { forward: [0, -0.5, 0], up: [0, 0, 0.5] },
  ramps: Object.fromEntries(["Color Ramp.006", "Color Ramp", "Color Ramp.001", "Color Ramp.003", "Color Ramp.004"]
    .map((name) => [name, { samples: [0, 1, 1] }])),
};
const COL = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);

/** A fetch that serves the bake from memory; `missing` names files that 404. */
function fakeFetch({ missing = [], manifest = MANIFEST } = {}) {
  const files = {
    "manifest.json": manifest, "material-map.json": MATERIAL_MAP, "params.json": PARAMS, "col.bin": COL,
    "scene.json": SCENE,
  };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const name = url.split("/").pop();
    if (missing.includes(name) || !(name in files)) return { ok: false, status: 404 };
    const body = files[name];
    return {
      ok: true, status: 200,
      json: async () => structuredClone(body),
      arrayBuffer: async () => body.slice().buffer,
    };
  };
  return { fetch, calls };
}

/** A PMX-like mesh: three MMD materials plus the see-through brow copy appended after load. */
function fakeMesh() {
  const material = (name) => {
    const m = new THREE.MeshToonMaterial({ name });
    m.map = new THREE.Texture();
    return m;
  };
  const materials = [material("颜"), material("目影"), material("髮+"), material("睫眉 see-through")];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  return { geometry, material: materials, originals: [...materials] };
}

const PMX = { vertexCount: 3, materialNames: ["颜", "目影", "髮+"], positionOf: () => [0, 0, 0] };
/** Textures already loaded, as loadGooTextures() returns them. */
const textures = () => ({
  textures: new Map(["Yidhari_Face_D.png", "Female_Face_Lightmap.png"]
    .map((f) => [f, Object.assign(new THREE.Texture(), { url: `/goo/textures/${f}` })])),
});

test("loadGooAssets fetches the bake from its folder", async () => {
  const { fetch, calls } = fakeFetch();
  const assets = await loadGooAssets("/assets/private/goo", { fetch });
  assert.deepEqual(assets.manifest, MANIFEST);
  assert.deepEqual(assets.materialMap, MATERIAL_MAP);
  assert.deepEqual(assets.params, PARAMS);
  assert.deepEqual([...assets.colBytes], [...COL]);
  assert.deepEqual(assets.scene, SCENE);
  assert.deepEqual(calls.sort(), [
    "/assets/private/goo/col.bin", "/assets/private/goo/manifest.json",
    "/assets/private/goo/material-map.json", "/assets/private/goo/params.json",
    "/assets/private/goo/scene.json",
  ]);
});

test("loadGooAssets names the file that is missing", async () => {
  const { fetch } = fakeFetch({ missing: ["material-map.json"] });
  await assert.rejects(loadGooAssets("/goo", { fetch }), /material-map\.json: HTTP 404/);
});

test("createGooMaterials refuses a bake that does not match the PMX", async () => {
  const { fetch } = fakeFetch({ manifest: { ...MANIFEST, pmx: { ...MANIFEST.pmx, vertexCount: 4 } } });
  const assets = await loadGooAssets("/goo", { fetch });
  assert.throws(() => createGooMaterials(fakeMesh(), assets, { pmx: PMX, baseUrl: "/goo", ...textures() }),
    /baked for 4 vertices, the PMX has 3/);
});

test("enabling swaps in the game diffuse, the eye-shadow tint and the hidden shell", async () => {
  const mesh = fakeMesh();
  const tex = textures();
  const goo = createGooMaterials(mesh, await loadGooAssets("/goo", fakeFetch()), { pmx: PMX, baseUrl: "/goo", ...tex });
  goo.setEnabled(true);
  const [face, shadow, shell, brows] = mesh.material;

  assert.notEqual(face, mesh.originals[0]);
  assert.equal(face.map.url, "/goo/textures/Yidhari_Face_D.png");
  assert.equal(face.map.flipY, false);
  assert.equal(face.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(face.userData.goo, "zzzb");

  assert.equal(shadow.map, null);
  assert.equal(shadow.blending, THREE.MultiplyBlending);
  assert.equal(shadow.transparent, true);
  assert.equal(shadow.depthWrite, false);
  assert.deepEqual(shadow.color.toArray(), [0.5, 0.25, 1]);

  assert.equal(shell.visible, false);
  // Materials added after load (the see-through brows) are left as they are.
  assert.equal(brows, mesh.originals[3]);
  assert.equal(shadow.premultipliedAlpha, true, "three's multiply blend needs premultiplied alpha");
});

test("loadGooTextures loads each texture once and waits for it", async () => {
  const assets = await loadGooAssets("/goo", fakeFetch());
  const urls = [];
  const map = await loadGooTextures(assets, {
    baseUrl: "/goo", loadTexture: async (url) => { urls.push(url); return new THREE.Texture(); },
  });
  assert.deepEqual(urls, ["/goo/textures/Yidhari_Face_D.png", "/goo/textures/Female_Face_Lightmap.png"]);
  assert.ok(map.get("Yidhari_Face_D.png").isTexture);
});

test("a texture that fails to load rejects, so the fallback sees it", async () => {
  const assets = await loadGooAssets("/goo", fakeFetch());
  await assert.rejects(
    loadGooTextures(assets, { baseUrl: "/goo", loadTexture: async () => { throw new Error("404"); } }),
    /textures\/Yidhari_Face_D\.png: failed to load/,
  );
});

test("the eye-shadow tint is unlit: just its colour, multiplied in", async () => {
  const mesh = fakeMesh();
  const goo = createGooMaterials(mesh, await loadGooAssets("/goo", fakeFetch()), { pmx: PMX, baseUrl: "/goo", ...textures() });
  const shader = { uniforms: {}, vertexShader: "", fragmentShader: "void main() {\n#include <opaque_fragment>\n}" };
  goo.materials[1].onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /outgoingLight = diffuse;/);
});

test("enabling adds the baked Col as a normalised vertex attribute", async () => {
  const mesh = fakeMesh();
  createGooMaterials(mesh, await loadGooAssets("/goo", fakeFetch()), { pmx: PMX, baseUrl: "/goo", ...textures() });
  const col = mesh.geometry.getAttribute("gooCol");
  assert.equal(col.itemSize, 4);
  assert.equal(col.normalized, true);
  assert.deepEqual([...col.array], [...COL]);
});

test("disabling restores the original material objects", async () => {
  const mesh = fakeMesh();
  const goo = createGooMaterials(mesh, await loadGooAssets("/goo", fakeFetch()), { pmx: PMX, baseUrl: "/goo", ...textures() });
  goo.setEnabled(true);
  goo.setEnabled(false);
  assert.deepEqual(mesh.material, mesh.originals);
  assert.equal(mesh.originals[2].visible, true);
});

/** Checkbox and status line stand-ins. */
function controls() {
  const listeners = [];
  const toggle = {
    checked: false, disabled: false,
    addEventListener: (_type, fn) => listeners.push(fn),
    click() { this.checked = !this.checked; return Promise.all(listeners.map((fn) => fn())); },
  };
  return { toggle, status: { textContent: "" } };
}
const memoryStorage = (values = {}) => ({
  getItem: (k) => values[k] ?? null, setItem: (k, v) => { values[k] = v; }, values,
});

test("the toggle is off by default and loads nothing until switched on", async () => {
  const { toggle, status } = controls();
  let loads = 0;
  const binding = bindGooShadersToggle(toggle, status, { load: async () => { loads++; return { setEnabled() {} }; }, local: memoryStorage() });
  await binding.ready;
  assert.equal(toggle.checked, false);
  assert.equal(loads, 0);
  assert.equal(GOO_SHADERS_KEY, "yidhari.gooShaders");
});

test("switching on loads once, enables the game shaders and remembers the choice", async () => {
  const { toggle, status } = controls();
  const local = memoryStorage();
  const states = [];
  let loads = 0;
  bindGooShadersToggle(toggle, status, { load: async () => { loads++; return { setEnabled: (on) => states.push(on) }; }, local });
  await toggle.click();
  await toggle.click();
  await toggle.click();
  assert.deepEqual(states, [true, false, true]);
  assert.equal(loads, 1);
  assert.equal(local.values[GOO_SHADERS_KEY], "1");
  assert.match(status.textContent, /Game shaders on/);
});

test("a failed load keeps today's material, unticks the box and says why", async () => {
  const { toggle, status } = controls();
  const local = memoryStorage();
  bindGooShadersToggle(toggle, status, { load: async () => { throw new Error("manifest.json: HTTP 404"); }, local });
  await toggle.click();
  assert.equal(toggle.checked, false);
  assert.equal(local.values[GOO_SHADERS_KEY], "0");
  assert.match(status.textContent, /Game shaders unavailable: manifest\.json: HTTP 404/);
});

test("a load failure after switching off says nothing and stays off", async () => {
  const { toggle, status } = controls();
  let reject;
  bindGooShadersToggle(toggle, status, { load: () => new Promise((_, r) => { reject = r; }), local: memoryStorage() });
  const on = toggle.click(); // On: the load starts.
  const off = toggle.click(); // Off again before it finishes.
  reject(new Error("manifest.json: HTTP 404"));
  await Promise.all([on, off]);
  assert.doesNotMatch(status.textContent, /unavailable/);
  assert.equal(toggle.checked, false);
});

test("after a shader failure, switching on again loads afresh (a re-bake is picked up)", async () => {
  const { toggle, status } = controls();
  let loads = 0;
  const binding = bindGooShadersToggle(toggle, status, { load: async () => { loads++; return { setEnabled() {} }; }, local: memoryStorage() });
  await toggle.click();
  binding.shaderFailed("boom");
  await toggle.click();
  assert.equal(loads, 2);
});

test("a stored 'on' choice is applied at start", async () => {
  const { toggle, status } = controls();
  const states = [];
  const binding = bindGooShadersToggle(toggle, status, {
    load: async () => ({ setEnabled: (on) => states.push(on) }), local: memoryStorage({ [GOO_SHADERS_KEY]: "1" }),
  });
  await binding.ready;
  assert.equal(toggle.checked, true);
  assert.deepEqual(states, [true]);
});

test("a shader error while on falls back and reports it", async () => {
  const { toggle, status } = controls();
  const states = [];
  const binding = bindGooShadersToggle(toggle, status, { load: async () => ({ setEnabled: (on) => states.push(on) }), local: memoryStorage() });
  await toggle.click();
  binding.shaderFailed("'fragColor' undeclared");
  assert.deepEqual(states, [true, false]);
  assert.equal(toggle.checked, false);
  assert.match(status.textContent, /Game shaders failed to compile: 'fragColor' undeclared/);
});
