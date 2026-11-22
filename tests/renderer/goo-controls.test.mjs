// Part e (#254): light controls, per-part live switches and the Goo outline hull.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { eulerForDirection, lightDirection, lightEulerFor } from "../../renderer/goo-frame.js";
import { GOO_LIGHT_KEY, GOO_PART_KEYS, bindGooControls, createGooMaterials, createOutlineHull } from "../../renderer/goo-material.js";

const close = (a, e, eps = 1e-6) => (Array.isArray(e) ? e.forEach((v, i) => close(a[i], v, eps)) : assert.ok(Math.abs(a - e) <= eps, `${a} ≈ ${e}`));
const BASE_EULER = [Math.PI / 2, 0, 0];

test("fixed light: yaw turns it round her, pitch raises it", () => {
  close(lightEulerFor({ mode: "fixed", yaw: 0, pitch: 0 }, { baseEuler: BASE_EULER }), BASE_EULER);
  const raised = lightDirection(lightEulerFor({ mode: "fixed", yaw: 0, pitch: 30 }, { baseEuler: BASE_EULER }));
  close(raised, [0, -Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]);
  const side = lightDirection(lightEulerFor({ mode: "fixed", yaw: 90, pitch: 0 }, { baseEuler: BASE_EULER }));
  close(side, [1, 0, 0]);
});

test("follow-camera light points at the camera", () => {
  const euler = lightEulerFor({ mode: "camera", yaw: 0, pitch: 0 }, { baseEuler: BASE_EULER, cameraBack: [0.6, -0.8, 0] });
  close(lightDirection(euler), [0.6, -0.8, 0]);
});

test("eulerForDirection inverts lightDirection", () => {
  for (const d of [[0, -1, 0], [0, 0, 1], [0.48, -0.6, 0.64], [-1, 0, 0]]) close(lightDirection(eulerForDirection(d)), d);
});

// --- materials, switches and the outline hull ---
const C = (r, g, b) => [r, g, b, 1];
const ids = ["", "2", "3", "4", "5"];
const params = (face) => ({
  "Enable Face Shading": face ? 1 : 0, "Enable Cast Shadows": 1, "Shadow Position": 0, "Shadow Softness": 0.25,
  "Shadow Fade Strength": 0, "SSS Effect Strength": 1, "Color Attribute Alpha": { attribute: "Col" },
  "Shadow Color Multiplier": C(0.6, 0.6, 0.6), "Sun Light Color": C(1.2, 1.1, 1.0), "Shadow Transition Color": C(0.8, 0.7, 0.7),
  ...Object.fromEntries(ids.flatMap((n) => [[`Shadow Color${n}`, C(0.9, 0.8, 0.8)], [`Shallow Color${n}`, C(0.9, 0.9, 0.9)], [`Local Indirect Color${n}`, C(1, 0.3, 0.2)]])),
  "Outline Color": C(1, 0.5, 0.5), "Outline Color2": C(1, 1, 1), "Outline Color3": C(0.2, 0.13, 0.14), "Outline Color4": C(1, 1, 1), "Outline Color5": C(1, 1, 1),
});
const RAMPS = Object.fromEntries(["Color Ramp.006", "Color Ramp", "Color Ramp.001", "Color Ramp.003", "Color Ramp.004"].map((n) => [n, { samples: [0, 1, 1] }]));
function bake() {
  return {
    manifest: { version: 1, colSpace: "sRGB", pmx: { vertexCount: 3, materials: ["颜", "目影", "髮+"], samples: [{ index: 0, position: [0, 0, 0] }] } },
    materialMap: { materials: [
      { pmx: "颜", game: "Yidhari Face", params: "Yidhari Face", hidden: false, shader: "zzzb", textures: { diffuse: "F.png", faceLightmap: "L.png" } },
      { pmx: "目影", game: "Eye Shadow", hidden: false, shader: "transparent", color: [0.5, 0.5, 0.5, 1], textures: {} },
      { pmx: "髮+", game: null, hidden: true, shader: null, textures: {} },
    ] },
    params: { "Yidhari Face": params(true) },
    colBytes: new Uint8Array(12),
    scene: { light: { eulerXYZ: BASE_EULER }, head: { forward: [0, -0.5, 0], up: [0, 0, 0.5] }, ramps: RAMPS },
  };
}
function skinnedMesh() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(12), 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(new Float32Array(12), 4));
  geometry.addGroup(0, 3, 0);
  const materials = ["颜", "目影", "髮+", "睫眉 see-through"].map((name) => Object.assign(new THREE.MeshToonMaterial({ name }), { map: new THREE.Texture() }));
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  mesh.morphTargetInfluences = [0.25];
  mesh.morphTargetDictionary = { "まばたき": 0 };
  return mesh;
}
const TEXTURES = new Map(["F.png", "L.png"].map((f) => [f, new THREE.Texture()]));
const PMX_INFO = (names) => ({ vertexCount: 3, materialNames: names, positionOf: () => [0, 0, 0] });
const build = (mesh = skinnedMesh()) => createGooMaterials(mesh, bake(), {
  pmx: PMX_INFO(["颜", "目影", "髮+"]), textures: TEXTURES,
});

test("part switches are shared uniforms that need no recompile", () => {
  const goo = build();
  const face = goo.materials[0];
  const before = face.customProgramCacheKey();
  goo.setParts({ cel: false, faceShadow: false, matcaps: true, highlights: false, rim: false, edgeSss: false });
  const u = face.userData.gooUniforms;
  assert.equal(u.gooPartCel.value, 0);
  assert.equal(u.gooPartFaceShadow.value, 0);
  assert.equal(u.gooPartMatcaps.value, 1);
  assert.equal(u.gooPartEdgeSss.value, 0);
  assert.equal(face.customProgramCacheKey(), before);
});

test("Goo materials hide the MMD outline; the hull draws Goo's instead", () => {
  const mesh = skinnedMesh();
  const goo = build(mesh);
  assert.equal(goo.materials[0].userData.outlineParameters.visible, false);
  const hull = createOutlineHull(mesh, goo);
  assert.ok(hull.isSkinnedMesh);
  assert.equal(hull.geometry, mesh.geometry);
  assert.equal(hull.skeleton, mesh.skeleton);
  assert.equal(hull.morphTargetInfluences, mesh.morphTargetInfluences, "shares the live morph weights");
  assert.equal(hull.parent, mesh);
  const [face, shadow, shell, extra] = hull.material;
  assert.equal(face.side, THREE.BackSide);
  assert.equal(face.defines.GOO_OUTLINE, "");
  // Outline Color (ID 1) is screened with 0.75 grey in Blender: 1 − (1 − 0.5)·0.25 = 0.875.
  close(face.userData.gooUniforms.gooOutlineColors.value[0].toArray(), [1, 0.875, 0.875]);
  close(face.userData.gooUniforms.gooOutlineColors.value[2].toArray(), [0.2, 0.13, 0.14]);
  for (const m of [shadow, shell, extra]) assert.equal(m.visible, false);
});

test("the hull follows the Game shaders switch and the outline part", () => {
  const mesh = skinnedMesh();
  const goo = build(mesh);
  const hull = createOutlineHull(mesh, goo);
  assert.equal(hull.visible, false);
  goo.setEnabled(true);
  assert.equal(hull.visible, true);
  goo.setParts({ outlines: false });
  assert.equal(hull.visible, false);
  goo.setParts({ outlines: true });
  goo.setEnabled(false);
  assert.equal(hull.visible, false);
});

test("the outline vertex shader pushes along the normal by Col.r and distance", () => {
  const mesh = skinnedMesh();
  const goo = build(mesh);
  const hull = createOutlineHull(mesh, goo);
  const shader = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "#include <common>\n#include <clipping_planes_pars_fragment>\nvoid main() {\n#include <map_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n}",
  };
  hull.material[0].onBeforeCompile(shader);
  assert.match(shader.vertexShader, /gooOutlineWidth\(/);
  assert.match(shader.vertexShader, /gooCol\.r/);
  assert.match(shader.fragmentShader, /gooOutlineColors\[/);
});

/** Form control stand-ins. */
function control(value) {
  const listeners = [];
  return {
    value: String(value), checked: Boolean(value), listeners,
    addEventListener: (_t, fn) => listeners.push(fn),
    set(v) { if (typeof v === "boolean") this.checked = v; else this.value = String(v); listeners.forEach((fn) => fn()); },
  };
}
const storage = (values = {}) => ({ getItem: (k) => values[k] ?? null, setItem: (k, v) => { values[k] = v; }, values });

test("controls apply remembered parts and light, and save changes", () => {
  const parts = Object.fromEntries(Object.keys(GOO_PART_KEYS).map((p) => [p, control(true)]));
  const light = { mode: control("fixed"), yaw: control(0), pitch: control(0) };
  const local = storage({ [GOO_PART_KEYS.rim]: "0", [GOO_LIGHT_KEY]: JSON.stringify({ mode: "camera", yaw: 20, pitch: 10 }) });
  const applied = { parts: null, light: null };
  bindGooControls({ parts, light }, { setParts: (p) => { applied.parts = { ...applied.parts, ...p }; }, setLight: (l) => { applied.light = l; } }, { local });
  assert.equal(applied.parts.rim, false);
  assert.equal(applied.parts.cel, true);
  assert.equal(parts.rim.checked, false);
  assert.deepEqual(applied.light, { mode: "camera", yaw: 20, pitch: 10 });
  assert.equal(light.mode.value, "camera");

  parts.cel.set(false);
  assert.equal(applied.parts.cel, false);
  assert.equal(local.values[GOO_PART_KEYS.cel], "0");
  light.yaw.set(-45);
  assert.deepEqual(applied.light, { mode: "camera", yaw: -45, pitch: 10 });
  assert.deepEqual(JSON.parse(local.values[GOO_LIGHT_KEY]), { mode: "camera", yaw: -45, pitch: 10 });
});

test("the nose line strength is a shared uniform, remembered, default 1", () => {
  const goo = build();
  const u = goo.materials[0].userData.gooUniforms;
  assert.equal(u.gooNoseLine.value, 1);
  goo.setParts({ noseLine: 0.4 });
  assert.equal(u.gooNoseLine.value, 0.4);

  const parts = Object.fromEntries(Object.keys(GOO_PART_KEYS).map((p) => [p, control(true)]));
  const nose = control(1);
  const local = storage({ "yidhari.gooNoseLine": "0.25" });
  const applied = {};
  bindGooControls({ parts, light: {}, noseLine: nose }, { setParts: (p) => Object.assign(applied, p), setLight() {} }, { local });
  assert.equal(applied.noseLine, 0.25);
  assert.equal(nose.value, "0.25");
  nose.set(0.75);
  assert.equal(applied.noseLine, 0.75);
  assert.equal(local.values["yidhari.gooNoseLine"], "0.75");
});

test("the face shader blends the nose mark in by the nose line strength", () => {
  const goo = build();
  const shader = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "#include <common>\n#include <clipping_planes_pars_fragment>\nvoid main() {\n#include <map_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n}",
  };
  goo.materials[0].onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /gooNoseLine/);
});

function shineBuild() {
  const mesh = skinnedMesh();
  const assets = bake();
  assets.manifest.pmx.materials = ["目光", "目影", "髮+"];
  assets.materialMap.materials[0] = { ...assets.materialMap.materials[0], pmx: "目光" };
  const goo = createGooMaterials(mesh, assets, { pmx: PMX_INFO(["目光", "目影", "髮+"]), textures: TEXTURES });
  return goo;
}

test("the eye light overlay (目光) gets a soft, shrinkable eye shine", () => {
  const goo = shineBuild();
  const shine = goo.materials[0];
  assert.equal(shine.defines.GOO_EYE_SHINE, "");
  assert.equal(shine.transparent, true);
  assert.equal(shine.depthWrite, false);
  assert.equal(shine.alphaTest, 0);
  assert.equal(shine.userData.gooUniforms.gooEyeShine.value, 0.5, "smaller than the game by default");
  goo.setParts({ eyeShine: 0.2 });
  assert.equal(shine.userData.gooUniforms.gooEyeShine.value, 0.2);
  assert.equal(build().materials[0].defines.GOO_EYE_SHINE, undefined, "only the eye light overlay");
  const shader = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "#include <common>\n#include <clipping_planes_pars_fragment>\nvoid main() {\n#include <map_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n}",
  };
  shine.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /gooEyeShine/);
});

test("the eye shine slider is remembered", () => {
  const parts = Object.fromEntries(Object.keys(GOO_PART_KEYS).map((p) => [p, control(true)]));
  const eyeShine = control(0.5);
  const local = storage({ "yidhari.gooEyeShine": "0.3" });
  const applied = {};
  bindGooControls({ parts, light: {}, eyeShine }, { setParts: (p) => Object.assign(applied, p), setLight() {} }, { local });
  assert.equal(applied.eyeShine, 0.3);
  assert.equal(eyeShine.value, "0.3");
  eyeShine.set(0.8);
  assert.equal(applied.eyeShine, 0.8);
  assert.equal(local.values["yidhari.gooEyeShine"], "0.8");
});
