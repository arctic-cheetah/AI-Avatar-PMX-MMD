/**
 * Game shaders (#249, #251; docs/goo-bake.md): swap the PMX materials for ones
 * built from the baked Goo inputs, behind a remembered toggle that is off by
 * default. Any failure keeps today's material and says why.
 *
 * Goo-shader materials get the game diffuse and the ZZZB core (#252,
 * docs/goo-shader.md); rim, matcaps, highlights and outlines follow in #253–#254.
 */
import * as THREE from "three";
import { decodeCol, validateGooAssets } from "./goo-assets.js";
import {
  createRampTexture, gooFrameUniforms, gooMaterialUniforms, gooOutlineColors, patchGooShader, setUpMatcaps,
} from "./goo-shader.js";

export const GOO_SHADERS_KEY = "yidhari.gooShaders";
export const GOO_ASSETS_URL = "/assets/private/goo";
/** localStorage keys of the live part switches (#254); each defaults to on. */
export const GOO_PART_KEYS = Object.freeze({
  cel: "yidhari.gooParts.cel",
  faceShadow: "yidhari.gooParts.faceShadow",
  matcaps: "yidhari.gooParts.matcaps",
  highlights: "yidhari.gooParts.highlights",
  rim: "yidhari.gooParts.rim",
  edgeSss: "yidhari.gooParts.edgeSss",
  outlines: "yidhari.gooParts.outlines",
});
export const GOO_LIGHT_KEY = "yidhari.gooLight";
export const GOO_NOSE_LINE_KEY = "yidhari.gooNoseLine";
export const GOO_EYE_SHINE_KEY = "yidhari.gooEyeShine";
/** The PMX eye light overlay: blue highlight blobs drawn over the irises. */
const EYE_LIGHT_MATERIAL = "目光";
const PART_UNIFORMS = {
  cel: "gooPartCel", faceShadow: "gooPartFaceShadow", matcaps: "gooPartMatcaps",
  highlights: "gooPartHighlights", rim: "gooPartRim", edgeSss: "gooPartEdgeSss",
};

const FILES = ["manifest.json", "material-map.json", "params.json", "col.bin", "scene.json"];

/**
 * Fetch a bake from its folder.
 * @param {string} baseUrl Folder that holds manifest.json and the rest.
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {Promise<{ manifest: any, materialMap: any, params: any, colBytes: Uint8Array, scene: any }>}
 */
export async function loadGooAssets(baseUrl, { fetch = globalThis.fetch } = {}) {
  const get = async (name) => {
    const response = await fetch(`${baseUrl}/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return name.endsWith(".json") ? response.json() : new Uint8Array(await response.arrayBuffer());
  };
  const [manifest, materialMap, params, colBytes, scene] = await Promise.all(FILES.map(get));
  return { manifest, materialMap, params, colBytes, scene };
}

/**
 * Load every texture the Goo materials use, once each, and wait for them, so a
 * missing or broken image goes through the fallback instead of drawing blank.
 * @param {Awaited<ReturnType<typeof loadGooAssets>>} assets
 * @param {{ baseUrl: string, loadTexture: (url: string) => Promise<THREE.Texture> }} options
 * @returns {Promise<Map<string, THREE.Texture>>} By file name.
 */
export async function loadGooTextures(assets, { baseUrl, loadTexture }) {
  const files = new Set();
  for (const entry of assets.materialMap?.materials ?? []) {
    if (entry && !entry.hidden && entry.shader === "zzzb") Object.values(entry.textures ?? {}).forEach((f) => files.add(f));
  }
  const loaded = await Promise.all([...files].map(async (file) => {
    try {
      return [file, await loadTexture(`${baseUrl}/textures/${file}`)];
    } catch {
      throw new Error(`textures/${file}: failed to load`);
    }
  }));
  return new Map(loaded);
}

/** Share the source's textures: a clone made before an image loads would never upload it. */
function cloneSharingTextures(source) {
  const material = source.clone();
  for (const [key, uniform] of Object.entries(source.uniforms ?? {})) {
    if (uniform?.value?.isTexture && material.uniforms?.[key]) material.uniforms[key].value = uniform.value;
  }
  return material;
}

function hideOutline(material) {
  material.userData.outlineParameters = { ...material.userData.outlineParameters, visible: false };
}

/**
 * Build the game-shader materials for a loaded PMX mesh.
 * @param {{ material: any[], geometry: any }} mesh Mesh from MMDLoader (material array in PMX order).
 * @param {Awaited<ReturnType<typeof loadGooAssets>>} assets
 * @param {{ pmx: { vertexCount: number, materialNames: string[], positionOf?: (i: number) => number[] },
 *   textures: Map<string, THREE.Texture> }} options Textures from loadGooTextures(), already loaded.
 * @returns {{ materials: any[], readonly enabled: boolean, setEnabled(on: boolean): void,
 *   setFrame(values: { lightView: number[], shadowRange: number, mirrorU: boolean, facingForward: number,
 *     facingDot: number, lightFacingPow: number, edgeLight: number }): void }}
 * @throws {Error} When the bake does not line up with the PMX.
 */
export function createGooMaterials(mesh, assets, { pmx, textures }) {
  const check = validateGooAssets(assets, pmx);
  if (!check.ok) throw new Error(check.errors.join("; "));
  mesh.geometry.setAttribute("gooCol", new THREE.BufferAttribute(decodeCol(assets.colBytes, pmx.vertexCount), 4, true));

  const texture = (file, colorSpace = "sRGB") => {
    const t = textures.get(file);
    if (!t) throw new Error(`textures/${file} was not loaded`);
    t.flipY = false;
    // Blender decodes sRGB-tagged images before the shader maths; Non-Color ones are read raw.
    t.colorSpace = colorSpace === "sRGB" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const frame = gooFrameUniforms();
  // One ramp texture for every material (#258 review: uniform budget).
  frame.gooRamps = { value: createRampTexture(assets.scene) };
  const sources = mesh.material.slice(0, pmx.materialNames.length);
  const materials = assets.materialMap.materials.map((entry, i) => {
    const material = cloneSharingTextures(sources[i]);
    material.name = `${entry.pmx} (game)`;
    material.userData.goo = entry.hidden ? "hidden" : entry.shader;
    if (entry.hidden) {
      material.visible = false;
      hideOutline(material);
    } else if (entry.shader === "transparent") {
      material.map = null;
      material.color.setRGB(entry.color[0], entry.color[1], entry.color[2]);
      // Like Blender's Transparent BSDF: unlit, multiplies what is behind by the colour.
      Object.assign(material, {
        transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
      });
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <opaque_fragment>", "outgoingLight = diffuse;\n  diffuseColor.a = 1.0;\n#include <opaque_fragment>",
        );
      };
      material.customProgramCacheKey = () => "goo-tint";
      hideOutline(material);
    } else {
      setUpZzzb(material, entry, assets, texture, frame);
    }
    material.needsUpdate = true;
    return material;
  });

  let originals = null;
  let outlines = true;
  const goo = {
    materials,
    frame,
    hull: null,
    get enabled() { return originals !== null; },
    setEnabled(on) {
      if (on && originals === null) {
        originals = mesh.material;
        // Keep materials added after load (the see-through brows) as they are.
        mesh.material = originals.map((m, i) => (i < materials.length ? materials[i] : m));
      } else if (!on && originals !== null) {
        mesh.material = originals;
        originals = null;
      }
      syncHull();
    },
    /** Live part switches: shared uniforms (no recompile) and the outline hull. */
    setParts(parts) {
      for (const [part, on] of Object.entries(parts)) {
        if (part === "outlines") outlines = Boolean(on);
        else if (part === "noseLine") frame.gooNoseLine.value = Number(on);
        else if (part === "eyeShine") frame.gooEyeShine.value = Number(on);
        else if (PART_UNIFORMS[part]) frame[PART_UNIFORMS[part]].value = on ? 1 : 0;
      }
      syncHull();
    },
    setFrame(values) {
      frame.gooLightView.value.fromArray(values.lightView);
      frame.gooFaceShadowRange.value = values.shadowRange;
      frame.gooFaceMirrorU.value = values.mirrorU ? 1 : 0;
      frame.gooFacingForward.value = values.facingForward;
      frame.gooFacingDot.value = values.facingDot;
      frame.gooLightFacingPow.value = values.lightFacingPow;
      frame.gooEdgeLight.value = values.edgeLight;
    },
  };
  function syncHull() {
    if (goo.hull) goo.hull.visible = goo.enabled && outlines;
  }
  goo.syncHull = syncHull;
  return goo;
}

/**
 * The Goo outline (#254): a back-face copy of the mesh that shares its geometry,
 * skeleton and live morph weights, pushed out by Col.r in the vertex shader.
 * @param {THREE.SkinnedMesh} mesh Loaded PMX mesh.
 * @param {ReturnType<typeof createGooMaterials>} goo
 * @returns {THREE.SkinnedMesh}
 */
export function createOutlineHull(mesh, goo) {
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  hidden.userData.outlineParameters = { visible: false };
  const count = Array.isArray(mesh.material) ? mesh.material.length : goo.materials.length;
  const materials = Array.from({ length: count }, (_, i) => {
    const source = goo.materials[i];
    if (!source || source.userData.goo !== "zzzb" || source.defines?.GOO_EYE_SHINE !== undefined) return hidden;
    const outline = cloneSharingTextures(source);
    Object.assign(outline, { name: `${source.name} outline`, side: THREE.BackSide, map: source.map, normalMap: null });
    outline.defines = { ...source.defines, GOO_OUTLINE: "" };
    delete outline.defines.GOO_RIM;
    const uniforms = { ...source.userData.gooUniforms, gooOutlineColors: { value: gooOutlineColors(source.userData.gooParams) } };
    outline.userData = { ...outline.userData, goo: "outline", gooUniforms: uniforms, outlineParameters: { visible: false } };
    outline.onBeforeCompile = (shader) => patchGooShader(shader, uniforms);
    outline.customProgramCacheKey = () => `${source.customProgramCacheKey()}-outline`;
    return outline;
  });
  // A reload after a failure builds a new hull: drop any earlier one first.
  for (const old of mesh.children.filter((child) => child.name === "goo-outline-hull")) mesh.remove(old);
  const hull = new THREE.SkinnedMesh(mesh.geometry, materials);
  hull.name = "goo-outline-hull";
  hull.bind(mesh.skeleton, mesh.bindMatrix);
  // Shared by reference: the hull follows every morph change. If the mesh's
  // morph array is ever replaced (updateMorphTargets, a model swap), re-link it.
  hull.morphTargetInfluences = mesh.morphTargetInfluences;
  hull.morphTargetDictionary = mesh.morphTargetDictionary;
  hull.frustumCulled = mesh.frustumCulled;
  mesh.add(hull);
  goo.hull = hull;
  goo.syncHull();
  return hull;
}

/**
 * Bind the part checkboxes and the light controls (#254). Choices are
 * remembered; parts default to on and the light to the Blender scene.
 * @param {{ parts: Record<string, { checked: boolean, addEventListener(t: string, f: () => void): void } | null>,
 *   light: { mode: any, yaw: any, pitch: any } }} controls
 * @param {{ setParts(p: Record<string, boolean>): void, setLight(l: { mode: string, yaw: number, pitch: number }): void }} target
 * @param {{ local?: Storage }} [options]
 */
export function bindGooControls(controls, target, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  const read = (key) => { try { return local?.getItem(key) ?? null; } catch { return null; } };
  const write = (key, value) => { try { local?.setItem(key, value); } catch { /* Session-only. */ } };

  const parts = {};
  for (const [part, key] of Object.entries(GOO_PART_KEYS)) {
    const box = controls.parts?.[part];
    parts[part] = read(key) !== "0";
    if (box) {
      box.checked = parts[part];
      box.addEventListener("change", () => {
        write(key, box.checked ? "1" : "0");
        target.setParts({ [part]: box.checked });
      });
    }
  }
  // Strength sliders: remembered numbers.
  for (const [part, key, fallback] of [["noseLine", GOO_NOSE_LINE_KEY, 1], ["eyeShine", GOO_EYE_SHINE_KEY, 0.5]]) {
    const slider = controls[part];
    const stored = read(key);
    parts[part] = stored !== null && Number.isFinite(Number(stored)) ? Number(stored) : fallback;
    if (!slider) continue;
    slider.value = String(parts[part]);
    slider.addEventListener("input", () => {
      write(key, String(slider.value));
      target.setParts({ [part]: Number(slider.value) });
    });
  }
  target.setParts(parts);

  const num = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
  let light = { mode: "fixed", yaw: 0, pitch: 0 };
  try {
    const stored = JSON.parse(read(GOO_LIGHT_KEY) ?? "{}") ?? {};
    // A hand-edited or old value must not reach the shader as NaN.
    light = {
      mode: stored.mode === "camera" ? "camera" : "fixed",
      yaw: num(stored.yaw, -180, 180, 0),
      pitch: num(stored.pitch, -60, 80, 0),
    };
  } catch { /* Keep the default. */ }
  const { mode, yaw, pitch } = controls.light ?? {};
  if (mode) mode.value = light.mode;
  if (yaw) yaw.value = String(light.yaw);
  if (pitch) pitch.value = String(light.pitch);
  const update = () => {
    light = { mode: mode?.value === "camera" ? "camera" : "fixed", yaw: Number(yaw?.value ?? 0), pitch: Number(pitch?.value ?? 0) };
    write(GOO_LIGHT_KEY, JSON.stringify(light));
    target.setLight(light);
  };
  for (const control of [mode, yaw, pitch]) control?.addEventListener(control === mode ? "change" : "input", update);
  target.setLight(light);
}

/** Turn a material clone into the ZZZB Goo shader for one PMX material. */
function setUpZzzb(material, entry, assets, texture, frame) {
  const params = assets.params[entry.params ?? entry.game];
  if (!params) throw new Error(`no shader params for ${entry.params ?? entry.game}`);
  const spaces = entry.colorSpaces ?? {};
  const face = Number(params["Enable Face Shading"]) >= 1;
  const uniforms = { ...gooMaterialUniforms(params, assets.scene), ...frame };
  material.color.setRGB(1, 1, 1);
  material.map = texture(entry.textures.diffuse, spaces.diffuse);
  material.defines = { ...material.defines, GOO_ZZZB: "" };
  if (face) {
    material.defines.GOO_FACE = "";
    uniforms.gooLightmap.value = texture(entry.textures.faceLightmap, spaces.faceLightmap ?? "Non-Color");
    material.normalMap = null;
  } else if (entry.textures.normal) {
    material.normalMap = texture(entry.textures.normal, spaces.normal ?? "Non-Color");
    // PMX UVs run down the image (flipY = false); Blender's run up, so green flips.
    material.normalScale = new THREE.Vector2(1, -1);
  }
  if (entry.textures.m) {
    material.defines.GOO_MASK = "";
    uniforms.gooMask.value = texture(entry.textures.m, spaces.m);
  }
  if (!face && Number(params["Enable MatCap Effect"]) >= 1 && params._matcaps) {
    material.defines.GOO_MATCAP = "";
    const roleOf = Object.fromEntries(Object.entries(entry.textures).map(([role, file]) => [file, role]));
    setUpMatcaps(uniforms, params._matcaps, (file) => texture(file, spaces[roleOf[file]] ?? "sRGB"), entry.params ?? entry.game);
  }
  if (!face && Number(params["Enable Rim Lighting"]) >= 1) material.defines.GOO_RIM = "";
  if (entry.pmx === EYE_LIGHT_MATERIAL) {
    // Soft, shrinkable highlights instead of the opaque Goo output (#254).
    material.defines.GOO_EYE_SHINE = "";
    Object.assign(material, { transparent: true, depthWrite: false, alphaTest: 0, opacity: 1 });
  }
  material.userData.gooUniforms = uniforms;
  material.userData.gooParams = params;
  // The Goo outline hull (#254) replaces three's MMD outline for these materials.
  material.userData.outlineParameters = { ...material.userData.outlineParameters, visible: false };
  material.onBeforeCompile = (shader) => patchGooShader(shader, uniforms);
  material.customProgramCacheKey = () => `goo-zzzb-${Object.keys(material.defines).filter((k) => k.startsWith("GOO_")).sort().join("-")}`;
}

/**
 * Bind the Game shaders checkbox: off by default, remembered, and loaded on first use.
 * @param {{ checked: boolean, addEventListener(type: string, fn: () => unknown): void } | null} toggle
 * @param {{ textContent: string } | null} status Line that says what happened.
 * @param {{ load: () => Promise<{ setEnabled(on: boolean): void }>, local?: Storage }} options
 * @returns {{ ready: Promise<void>, shaderFailed(message: string): void }}
 */
export function bindGooShadersToggle(toggle, status, { load, local }) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  const store = (on) => {
    try { local?.setItem(GOO_SHADERS_KEY, on ? "1" : "0"); } catch { /* Session-only. */ }
  };
  const say = (text) => { if (status) status.textContent = text; };
  let controller = null;
  let loading = null;
  let on = false;

  const fail = (message) => {
    controller?.setEnabled(false);
    // Forget this load, so switching on again picks up a re-bake.
    controller = null;
    loading = null;
    on = false;
    if (toggle) toggle.checked = false;
    store(false);
    say(message);
  };
  const apply = async (want) => {
    on = want;
    if (!want) {
      controller?.setEnabled(false);
      say("");
      return;
    }
    try {
      loading ??= load();
      controller = await loading;
    } catch (error) {
      loading = null;
      if (!on) return; // Switched off while loading: nothing to report.
      fail(`Game shaders unavailable: ${error?.message ?? error}`);
      return;
    }
    if (!on) return; // Switched off while loading.
    controller.setEnabled(true);
    say("Game shaders on. Switch parts and the light below.");
  };

  let stored = false;
  try { stored = local?.getItem(GOO_SHADERS_KEY) === "1"; } catch { /* Keep off. */ }
  if (toggle) {
    toggle.checked = stored;
    toggle.addEventListener("change", () => {
      store(toggle.checked);
      return apply(toggle.checked);
    });
  }
  return {
    ready: stored ? apply(true) : Promise.resolve(),
    shaderFailed(message) {
      if (on && controller) fail(`Game shaders failed to compile: ${message}`);
    },
  };
}
