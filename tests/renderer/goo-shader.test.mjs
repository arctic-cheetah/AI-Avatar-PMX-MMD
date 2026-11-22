// Goo shader core (#252): cel steps, shadow tint by material ID and the face
// lightmap shadow, patched into the MMD material with onBeforeCompile.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createGooMaterials } from "../../renderer/goo-material.js";

const C = (r, g, b) => [r, g, b, 1];
const ids = ["", "2", "3", "4", "5"];
function params({ face }) {
  return {
    "Enable Face Shading": face ? 1 : 0, "Enable Cast Shadows": 1, "Shadow Position": 0, "Shadow Softness": 0.25,
    "Shadow Fade Strength": 0, "SSS Effect Strength": 1,
    "Color Attribute Alpha": face ? { attribute: "Col" } : 0,
    "Shadow Color Multiplier": C(0.6, 0.62, 0.66), "Sun Light Color": C(1.2, 1.15, 1.08), "Shadow Transition Color": C(0.79, 0.75, 0.73),
    ...Object.fromEntries(ids.flatMap((n, i) => [
      [`Shadow Color${n}`, C(0.1 * (i + 1), 0, 0)], [`Shallow Color${n}`, C(0, 0.1 * (i + 1), 0)], [`Local Indirect Color${n}`, C(1, 0.3, 0.2)],
    ])),
  };
}
const SCENE = {
  light: { eulerXYZ: [Math.PI / 2, 0, 0] },
  head: { forward: [0, -0.5, 0], up: [0, 0, 0.5] },
  ramps: { "Color Ramp.006": { samples: [1, 0.33, 1] }, "Color Ramp": { samples: [0, 1, 1] } },
};

function bake() {
  const names = ["颜", "髮"];
  return {
    manifest: { version: 1, colSpace: "sRGB", pmx: { vertexCount: 3, materials: names, samples: [{ index: 0, position: [0, 0, 0] }] } },
    materialMap: {
      materials: [
        {
          pmx: "颜", game: "Yidhari Face", params: "Yidhari Face", hidden: false, shader: "zzzb",
          textures: { diffuse: "Face_D.png", faceLightmap: "Lightmap.png" },
          colorSpaces: { diffuse: "sRGB", faceLightmap: "Non-Color" },
        },
        {
          pmx: "髮", game: "Yidhari Hair", params: "Yidhari Hair", hidden: false, shader: "zzzb",
          textures: { diffuse: "Map2_D.png", m: "Map2_M.png", normal: "Map2_N.png" },
          colorSpaces: { diffuse: "sRGB", m: "sRGB", normal: "Non-Color" },
        },
      ],
    },
    params: { "Yidhari Face": params({ face: true }), "Yidhari Hair": params({ face: false }) },
    colBytes: new Uint8Array(12),
    scene: SCENE,
  };
}

function build(assets = bake()) {
  const materials = ["颜", "髮"].map((name) => Object.assign(new THREE.MeshToonMaterial({ name }), { map: new THREE.Texture() }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const mesh = { geometry, material: materials };
  const files = assets.materialMap.materials.flatMap((e) => Object.values(e.textures));
  const textures = new Map(files.map((f) => [f, Object.assign(new THREE.Texture(), { url: `/goo/textures/${f}` })]));
  const goo = createGooMaterials(mesh, assets, {
    pmx: { vertexCount: 3, materialNames: ["颜", "髮"], positionOf: () => [0, 0, 0] }, textures,
  });
  return { goo, face: goo.materials[0], hair: goo.materials[1] };
}

const FAKE_SHADER = () => ({
  uniforms: {},
  vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n}",
  fragmentShader: "#include <common>\n#include <clipping_planes_pars_fragment>\nvoid main() {\n#include <map_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n}",
});

test("face materials use the lightmap; body materials the mask and normal maps", () => {
  const { face, hair } = build();
  assert.equal(face.defines.GOO_FACE, "");
  assert.equal(face.userData.gooUniforms.gooLightmap.value.url, "/goo/textures/Lightmap.png");
  assert.equal(face.userData.gooUniforms.gooLightmap.value.colorSpace, THREE.NoColorSpace);
  assert.equal(face.normalMap, null);

  assert.equal(hair.defines.GOO_FACE, undefined);
  assert.equal(hair.userData.gooUniforms.gooMask.value.url, "/goo/textures/Map2_M.png");
  // Blender reads the hair _M map as sRGB: the ID thresholds apply after decoding.
  assert.equal(hair.userData.gooUniforms.gooMask.value.colorSpace, THREE.SRGBColorSpace);
  assert.equal(hair.normalMap.url, "/goo/textures/Map2_N.png");
  assert.deepEqual(hair.normalScale.toArray(), [1, -1]);
  for (const m of [face, hair]) {
    assert.equal(m.defines.GOO_ZZZB, "");
    assert.deepEqual(m.color.toArray(), [1, 1, 1]);
  }
});

test("a material without a mask map gets the constant the Blender node holds", () => {
  const assets = bake();
  assets.params["Yidhari Face"]["_M Map Color"] = C(0.8, 0.8, 0.8);
  const { face } = build(assets);
  assert.equal(face.userData.gooUniforms.gooMask.value, null);
  assert.deepEqual(face.userData.gooUniforms.gooMaskConstant.value.toArray(), [0.8, 0.8, 0.8]);
});

test("the five shadow, shallow and indirect colours come from the params", () => {
  const { hair } = build();
  const u = hair.userData.gooUniforms;
  assert.equal(u.gooShadowColors.value.length, 5);
  assert.deepEqual(u.gooShadowColors.value.map((c) => Number(c.x.toFixed(3))), [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(u.gooShallowColors.value.map((c) => Number(c.y.toFixed(3))), [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(u.gooSunColor.value.toArray().map((v) => Number(v.toFixed(3))), [1.2, 1.15, 1.08]);
  assert.equal(u.gooShadowSoftness.value, 0.25);
  // Hair's Color Attribute Alpha is a constant 0 in Blender, not the Col alpha.
  assert.equal(u.gooColAlphaFromAttribute.value, 0);
  assert.equal(u.gooColAlphaConstant.value, 0);
});

test("a Goo material without its params is refused", () => {
  const assets = bake();
  delete assets.params["Yidhari Hair"];
  assert.throws(() => build(assets), /uses params Yidhari Hair, which params\.json does not have/);
});

test("onBeforeCompile adds the Col attribute and replaces the lighting", () => {
  const { hair } = build();
  const shader = FAKE_SHADER();
  hair.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /attribute vec4 gooCol;/);
  assert.match(shader.vertexShader, /vGooCol = vec4\( gooSrgbToLinear/);
  assert.match(shader.fragmentShader, /vec3 gooShade\(/);
  // It needs vMapUv and vViewPosition, which the pars chunks declare.
  assert.ok(shader.fragmentShader.indexOf("vec3 gooShade(") > shader.fragmentShader.indexOf("#include <clipping_planes_pars_fragment>"));
  assert.match(shader.fragmentShader, /outgoingLight = gooShade\(/);
  // Blender's Normal Map input ignores the blue channel: it is fixed to 1.
  assert.match(shader.fragmentShader, /mapN = vec3\( texture2D\( normalMap, vNormalMapUv \)\.xy \* 2\.0 - 1\.0, 1\.0 \)/);
  assert.equal(shader.uniforms.gooShadowColors, hair.userData.gooUniforms.gooShadowColors);
  assert.ok(shader.uniforms.gooLightView, "shared per-frame uniforms are attached");
});

test("all Goo materials share one set of per-frame uniforms", () => {
  const { goo, face, hair } = build();
  goo.setFrame({ lightView: [0, 0, 1], shadowRange: 0.4, mirrorU: true, facingForward: 0.2, facingDot: -0.5, lightFacingPow: 1, edgeLight: 0 });
  for (const m of [face, hair]) {
    const u = m.userData.gooUniforms;
    assert.deepEqual(u.gooLightView.value.toArray(), [0, 0, 1]);
    assert.equal(u.gooFaceShadowRange.value, 0.4);
    assert.equal(u.gooFaceMirrorU.value, 1);
    assert.equal(u.gooFacingForward.value, 0.2);
  }
});

test("the shading ramps are resampled to fixed-size LUT uniforms", () => {
  const { hair } = build();
  const u = hair.userData.gooUniforms;
  assert.equal(u.gooSssRamp.value.length, 33);
  assert.deepEqual([u.gooSssRamp.value[0], u.gooSssRamp.value[16], u.gooSssRamp.value[32]].map((v) => Number(v.toFixed(3))), [1, 0.33, 1]);
  assert.deepEqual([u.gooFadeRamp.value[0], u.gooFadeRamp.value[16], u.gooFadeRamp.value[32]], [0, 1, 1]);
});

test("the baked sRGB Col is decoded to linear in the vertex shader", () => {
  const { hair } = build();
  const shader = FAKE_SHADER();
  hair.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /vGooCol = vec4\( gooSrgbToLinear\( gooCol\.rgb \), gooCol\.a \);/);
});

test("a shader chunk that is missing (a three.js upgrade) throws instead of failing silently", () => {
  const { hair } = build();
  const shader = FAKE_SHADER();
  shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", "");
  assert.throws(() => hair.onBeforeCompile(shader), /shader chunk #include <opaque_fragment> not found/);
});
