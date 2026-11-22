/**
 * The ZZZB Goo shader core in GLSL (#252, docs/goo-shader.md). Patched into the
 * MMD (phong-based) material with onBeforeCompile, so skinning, morph targets
 * and the map/normal-map chunks keep working. Comments name the Blender nodes
 * each line reproduces.
 */
import * as THREE from "three";
import { sampleRamp } from "./goo-frame.js";

export const RAMP_SIZE = 33;

const VERTEX_PARS = /* glsl */ `
attribute vec4 gooCol;
varying vec4 vGooCol;
// col.bin holds Blender's sRGB bytes; the Color Attribute node gives the shader linear values.
vec3 gooSrgbToLinear( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
}
#ifdef GOO_OUTLINE
// [ZZZB] Outlines V0.8: Col.r · 0.01 · mix(0.125, 0.375, clamp(distance − 0.75)) metres,
// converted to PMX units (the import scale is 0.08 m per unit).
float gooOutlineWidth( float colR, float distanceUnits ) {
  float metres = distanceUnits * 0.08;
  return colR * 0.01 * mix( 0.125, 0.375, clamp( metres - 0.75, 0.0, 1.0 ) ) / 0.08;
}
#endif
`;

const OUTLINE_PUSH = /* glsl */ `
#ifdef GOO_OUTLINE
  {
    vec3 worldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    transformed += normalize( objectNormal ) * gooOutlineWidth( vGooCol.r, distance( worldPos, cameraPosition ) );
  }
#endif
#include <project_vertex>`;

const FRAGMENT_PARS = /* glsl */ `
#define GOO_RAMP_SIZE ${RAMP_SIZE}
varying vec4 vGooCol;
uniform vec3 gooShadowColors[5];
uniform vec3 gooShallowColors[5];
uniform vec3 gooIndirectColors[5];
uniform vec3 gooShadowMultiplier;
uniform vec3 gooSunColor;
uniform vec3 gooTransitionColor;
uniform float gooShadowPosition;
uniform float gooShadowSoftness;
uniform float gooFadeStrength;
uniform float gooSssStrength;
uniform float gooCastShadows;
uniform float gooColAlphaFromAttribute;
uniform float gooColAlphaConstant;
// All ramps in one shared texture, one row each (see RAMP_ROWS).
uniform sampler2D gooRamps;
uniform vec3 gooMaskConstant;
#ifdef GOO_MASK
uniform sampler2D gooMask;
#endif
#ifdef GOO_FACE
uniform sampler2D gooLightmap;
#endif
// Per frame, shared by every Goo material (renderer/goo-frame.js).
uniform vec3 gooLightView;
uniform float gooFaceShadowRange;
uniform float gooFaceMirrorU;
uniform float gooFacingForward;
uniform float gooFacingDot;
uniform float gooLightFacingPow;
uniform float gooEdgeLight;
// Live part switches (#254), 1 = on.
uniform float gooPartCel;
uniform float gooPartFaceShadow;
uniform float gooPartMatcaps;
uniform float gooPartHighlights;
uniform float gooPartRim;
uniform float gooPartEdgeSss;
// Nose line strength (#254): 0 = Blender (hidden when facing the camera), 1 = always drawn.
uniform float gooNoseLine;
// Eye shine (#254): the 目光 overlay's blue highlights. 1 = game size, lower = smaller and fainter.
uniform float gooEyeShine;

// The smoothstep node group: t clamped, t²(3 − 2t). Blender's divide gives 0 for /0.
float gooSmooth( float e0, float e1, float x ) {
  float d = e1 - e0;
  float t = d == 0.0 ? 0.0 : clamp( ( x - e0 ) / d, 0.0, 1.0 );
  return t * t * ( 3.0 - 2.0 * t );
}

#define GOO_RAMP_SSS 0
#define GOO_RAMP_FADE 1
#define GOO_RAMP_RIM 2
#define GOO_RAMP_BODY_HIGHLIGHT 3
#define GOO_RAMP_BODY_SHADE 4
#define GOO_RAMP_ROWS 5
// Sample texel centres so linear filtering reproduces the 33-sample table.
float gooRamp( int row, float x ) {
  float u = ( clamp( x, 0.0, 1.0 ) * float( GOO_RAMP_SIZE - 1 ) + 0.5 ) / float( GOO_RAMP_SIZE );
  float v = ( float( row ) + 0.5 ) / float( GOO_RAMP_ROWS );
  return texture2D( gooRamps, vec2( u, v ) ).r;
}

// [ZZZB] matIDs + idSwitcher: _M.r bands -> Shadow/Shallow colour index (0-based).
int gooMatId( float r ) {
  if ( r > 0.79 ) return 2;
  if ( r > 0.56 ) return 1;
  if ( r > 0.43 ) return 0;
  if ( r > 0.21 ) return 4;
  return 3;
}

vec3 gooScreen( vec3 a, vec3 b ) { return 1.0 - ( 1.0 - a ) * ( 1.0 - b ); }

// Highlights [HAIR] and [BODY] (#253).
uniform float gooHairHighlightMask;
uniform float gooHairHighlightIntensity;
uniform float gooHairHighlightSpread;
uniform vec3 gooHairHighlightColor;
uniform float gooMatcapEnabled;

vec3 gooHighlights( vec3 col, vec3 mask, float NdotL, float NdotH ) {
  // Hair Mask: Col.b · 10 > 0.05, only where Enable Hair Highlight Mask is on.
  float hairMask = clamp( ( vGooCol.b * 10.0 > 0.05 ? 1.0 : 0.0 ) * gooHairHighlightMask, 0.0, 1.0 );
  float spread = clamp( pow( max( NdotL * 0.5 + 0.5, 0.0 ), gooHairHighlightSpread ), 0.0, 1.0 );
  float inv = 1.0 - spread;
  float band = gooSmooth( clamp( clamp( inv - 0.3, 0.0, 1.0 ) + 0.5, 0.0, 1.0 ), clamp( inv + 0.5, 0.0, 1.0 ), mask.b );
  vec3 hair = col * gooHairHighlightColor * band * spread * 1.314;
  vec3 withHair = mix( col, mix( col, gooScreen( col, hair ), gooHairHighlightIntensity ), hairMask );
  // Body: (smoothstep(_M.b) · N·H)^10 through two ramps; skipped on the hair.
  float h = clamp( pow( abs( gooSmooth( 0.0, 1.0, mask.b ) * NdotH ), 10.0 ), 0.0, 1.0 );
  vec3 body = mix( ( h * 3.14 + gooRamp( GOO_RAMP_BODY_HIGHLIGHT, h ) ) * col * gooMatcapEnabled, vec3( 0.0 ), hairMask );
  float shade = mix( 1.0, mix( 1.0, gooRamp( GOO_RAMP_BODY_SHADE, h ), mask.b ), gooMatcapEnabled );
  shade = mix( shade, 1.0, mix( 1.0, hairMask, gooHairHighlightMask ) );
  return ( withHair + body ) * shade;
}

#ifdef GOO_MATCAP
uniform sampler2D gooMatcapA;
uniform sampler2D gooMatcapB;
uniform vec3 gooMatcapColors[5];
uniform float gooMatcapSampler[5];
uniform float gooMatcapAdd[5];
uniform float gooMatcapMultiplyFactor;
uniform float gooMatcapAddFactor;

// [ZZZB] MatCaps + [MatCaps]: the matcap for this ID, multiplied or added, by _M.b.
vec3 gooMatcap( vec3 D, vec3 N, int id, float strength ) {
  // matCap Mapping: view-space normal · 0.5 + 0.5; v flipped because flipY = false.
  vec2 uv = N.xy * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  vec3 m = gooMatcapColors[ id ];
  float s = gooMatcapSampler[ id ];
  if ( s > 1.5 ) m *= texture2D( gooMatcapB, uv ).rgb;
  else if ( s > 0.5 ) m *= texture2D( gooMatcapA, uv ).rgb;
  m = clamp( m, 0.0, 1.0 );
  float add = gooMatcapAdd[ id ];
  vec3 m066 = mix( D, D * mix( vec3( 1.0 ), m, 1.0 - add ), gooMatcapMultiplyFactor );
  vec3 m067 = clamp( mix( vec3( 0.0 ), m, add ) * m066, 0.0, 1.0 );
  return clamp( mix( D, m066 + gooMatcapAddFactor * m067, clamp( strength, 0.0, 1.0 ) ), 0.0, 1.0 );
}
#endif

#ifdef GOO_RIM
uniform vec3 gooRimMultiplier;
uniform vec3 gooRimAdditional;

// Rim Lighting. Goo's screen-space Scene Rim is approximated by a fresnel term.
vec3 gooRim( vec3 col, float NdotL, float NdotV, float normalRed ) {
  float rim = gooRamp( GOO_RAMP_RIM, pow( clamp( 1.0 - NdotV, 0.0, 1.0 ), 4.0 ) );
  float lightSide = clamp( pow( max( NdotL, 0.0 ), 5.0 ), 0.0, 1.0 );
  float mask = gooSmooth( 0.25, 0.3, normalRed );   // Normal Map Mask
  vec3 tint = gooScreen( col * gooRimMultiplier, gooRimAdditional );
  return col + tint * clamp( clamp( rim * lightSide, 0.0, 1.0 ) * mask, 0.0, 1.0 );
}
#endif

#ifdef GOO_OUTLINE
uniform vec3 gooOutlineColors[5];
// [Outline Colors] + [Adjust Colors To Match Some Stuff] + [Fix Outline Discoloration].
vec3 gooOutlineColour( vec3 shaded, int id ) {
  vec3 c = shaded * gooOutlineColors[ id ];
  float f = id == 1 ? 1.0 : clamp( 1.0 - gooSmooth( 0.25, 0.5, vGooCol.g ), 0.0, 1.0 );
  return mix( c, c * 0.25, f );
}
#endif

vec3 gooShade( vec4 diffuse, vec3 n ) {
  vec3 D = diffuse.rgb;
  float pos = gooShadowPosition;
  float soft = gooShadowSoftness;
#ifdef GOO_MASK
  vec3 mask = texture2D( gooMask, vMapUv ).rgb;
#else
  vec3 mask = gooMaskConstant;
#endif
  int id = gooMatId( mask.r );
  vec3 indirect = gooIndirectColors[ id ];
#ifdef GOO_FACE
  // [[Process Diffuse]] nose line: the diffuse alpha, faded by Face Facing Forward.
  float m090 = mix( -0.11, 0.8888, gooFacingForward );
  float m106 = vGooCol.b < 0.005 ? 1.0 : diffuse.a;
  float m089 = mix( diffuse.a, 1.0, gooSmooth( m090, m090 + 0.1, m106 ) );
  // Nose line: blend towards the raw mark in the diffuse alpha (1 everywhere else).
  m089 = mix( m089, diffuse.a, gooNoseLine );
  vec3 base = mix( D, D * m089 * 0.25, clamp( 1.0 - m089, 0.0, 1.0 ) );
  // Dynamic Face Highlight from the lightmap's blue channel.
  vec4 lmN = texture2D( gooLightmap, vMapUv );
  float highlight = clamp( lmN.b * gooFacingDot * gooLightFacingPow * gooPartHighlights, 0.0, 1.0 );
  base += 0.6771 * base * highlight;
  // Shadows [FACE]: faceLogic mirrors u for one light side; the red channel is the SDF.
  vec2 uvL = gooFaceMirrorU > 0.5 ? vec2( - vMapUv.x, vMapUv.y ) : vMapUv;
  vec4 lmV = texture2D( gooLightmap, uvL );
  float edge1 = 1.0 - pow( gooFaceShadowRange, 3.14 ) + pos;
  float lit = mix( 1.0, clamp( gooSmooth( edge1 - soft, edge1, lmV.r ), 0.0, 1.0 ), gooPartFaceShadow );
  vec3 light = mix( mix( gooShallowColors[ 2 ], gooShadowColors[ 2 ], lit ) * gooShadowMultiplier, gooSunColor, lit );
  // Body/Face Transition: outside the lightmap's alpha the transition colour shows.
  light = mix( light, gooTransitionColor * gooShadowMultiplier, 1.0 - lmV.a );
  // Fake SSS [FACE].
  float sss = mix( 1.0, gooRamp( GOO_RAMP_SSS, lit ), gooSssStrength * gooPartEdgeSss );
  sss = mix( 1.0, mix( sss, 1.0, lit ), lmV.a );
#else
  vec3 N = normalize( n );
  vec3 L = normalize( gooLightView );
  vec3 V = normalize( vViewPosition );
  float NdotL = dot( N, L );
  float NdotV = dot( N, V );
#ifdef GOO_MATCAP
  D = gooMatcap( D, N, id, mask.b * gooMatcapEnabled * gooPartMatcaps );
#endif
  vec3 shadowColor = gooShadowColors[ id ];
  float colA = mix( gooColAlphaConstant, vGooCol.a, gooColAlphaFromAttribute );
  float s4 = gooSmooth( pos, pos + soft, NdotL );               // Shallow
  float s5 = gooSmooth( pos - 0.5, pos - 0.5 + soft, NdotL );   // Shadow [No Cast Shadows]
  float s16 = gooSmooth( pos - 0.4, pos - 0.4 + soft, NdotL );
  // Edge Highlights: screen the diffuse with itself tinted by the shadow colour.
  float edge = clamp( pow( clamp( 1.0 - NdotV, 0.0, 1.0 ), 10.0 ), 0.0, 1.0 ) * s4 * gooEdgeLight * gooPartEdgeSss;
  vec3 base = gooScreen( D, D * edge * shadowColor );
  // Cast Shadow Mask: no Goo cast shadows here, so only the shallow edge.
  float castMask = mix( 1.0, s4, gooCastShadows );
  // Fake SSS [BODY].
  float sss = mix( 1.0, gooRamp( GOO_RAMP_SSS, castMask ), gooSssStrength * gooPartEdgeSss );
  sss = mix( mix( sss, 1.0, s4 ), 1.0, colA );
  // Shadows [BODY].
  vec3 shadow = shadowColor * gooShadowMultiplier;
  vec3 shallow = gooShallowColors[ id ] * gooShadowMultiplier;
  vec3 dark = mix( shadow, shadow * shallow, 0.5 );
  float fadeX = clamp( ( NdotL - 0.5 ) * 0.5 + 0.5, 0.0, 1.0 );
  float fade = mix( 1.0, mix( 1.0, gooRamp( GOO_RAMP_FADE, fadeX ), s5 ), gooFadeStrength );
  vec3 lit3 = mix( mix( dark, shallow, fade ), gooSunColor, clamp( castMask + clamp( 1.0 - s5, 0.0, 1.0 ), 0.0, 1.0 ) );
  vec3 light = mix( dark, lit3, s16 );
  light = mix( light, gooTransitionColor * gooShadowMultiplier, colA );
#endif
  // Local Indirect Color, then the SSS blend; times the processed diffuse.
  vec3 indirectLight = mix( indirect * light, vec3( 1.0 ), 0.666 );
  vec3 col = base * mix( indirectLight, light, sss );
  // Cel lighting off: the processed diffuse without any light.
  col = mix( base, col, gooPartCel );
#ifndef GOO_FACE
  col = mix( col, gooHighlights( col, mask, NdotL, dot( normalize( V + L ), N ) ), gooPartHighlights );
#ifdef GOO_RIM
#ifdef USE_NORMALMAP
  float normalRed = texture2D( normalMap, vNormalMapUv ).r;
#else
  float normalRed = 1.0;
#endif
  col = mix( col, gooRim( col, NdotL, NdotV, normalRed ), gooPartRim );
#endif
#endif
#ifdef GOO_OUTLINE
  col = gooOutlineColour( col, id );
#endif
  return col;
}
`;

const OPAQUE = /* glsl */ `
#ifdef GOO_EYE_SHINE
  float gooShineAlpha = diffuseColor.a;
#endif
  outgoingLight = gooShade( diffuseColor, normal );
  diffuseColor.a = 1.0;
#ifdef GOO_EYE_SHINE
  {
    // Raise the alpha threshold to shrink the soft blobs, and fade them out below 0.5.
    float edge = ( 1.0 - gooEyeShine ) * 0.9;
    diffuseColor.a = smoothstep( edge, edge + 0.1, gooShineAlpha ) * clamp( gooEyeShine * 2.0, 0.0, 1.0 );
  }
#endif
#include <opaque_fragment>`;

const NORMAL_MAP_LINE = "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;";
if (!THREE.ShaderChunk.normal_fragment_maps.includes(NORMAL_MAP_LINE)) {
  throw new Error("three's normal_fragment_maps chunk changed; update the [Fix Blue Channel] patch");
}
const NORMAL_MAPS = THREE.ShaderChunk.normal_fragment_maps.replace(
  "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
  // [Fix Blue Channel]: Blender's Normal Map input sees blue = 1.
  "vec3 mapN = vec3( texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0, 1.0 );",
);

/**
 * Patch a phong-based shader with the Goo core.
 * @param {{ vertexShader: string, fragmentShader: string, uniforms: object }} shader
 * @param {object} uniforms This material's Goo uniforms (shared per-frame ones included).
 */
export function patchGooShader(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  // Each chunk must be found: a three.js upgrade that renames one throws here,
  // so the existing fallback reports it instead of a quiet visual regression.
  const swap = (source, chunk, replacement) => {
    if (!source.includes(chunk)) throw new Error(`shader chunk ${chunk} not found`);
    return source.replace(chunk, replacement);
  };
  let vertex = swap(shader.vertexShader, "#include <common>", `#include <common>\n${VERTEX_PARS}`);
  vertex = swap(vertex, "#include <begin_vertex>", "#include <begin_vertex>\n  vGooCol = vec4( gooSrgbToLinear( gooCol.rgb ), gooCol.a );");
  vertex = swap(vertex, "#include <project_vertex>", OUTLINE_PUSH);
  shader.vertexShader = vertex;
  // After the last pars chunk, so vMapUv and vViewPosition are declared.
  let fragment = swap(shader.fragmentShader, "#include <clipping_planes_pars_fragment>", `#include <clipping_planes_pars_fragment>\n${FRAGMENT_PARS}`);
  fragment = swap(fragment, "#include <normal_fragment_maps>", NORMAL_MAPS);
  // Blender's Enable Alpha Usage is off: the shader output is opaque.
  fragment = swap(fragment, "#include <opaque_fragment>", OPAQUE);
  shader.fragmentShader = fragment;
}

const vec3 = (c) => new THREE.Vector3(c[0], c[1], c[2]);
const resample = (samples) => Float32Array.from({ length: RAMP_SIZE }, (_, i) => sampleRamp(samples, i / (RAMP_SIZE - 1)));

/** Rows of the shared ramp texture, in the order the GLSL GOO_RAMP_* defines use. */
export const RAMP_ROWS = ["Color Ramp.006", "Color Ramp", "Color Ramp.001", "Color Ramp.003", "Color Ramp.004"];

/**
 * Pack every ramp the port uses into one 33 × 5 8-bit texture, shared by all
 * Goo materials, instead of five float[33] uniform arrays per material.
 * @param {{ ramps: Record<string, { samples: number[] }> }} scene
 * @returns {THREE.DataTexture}
 */
export function createRampTexture(scene) {
  const data = new Uint8Array(RAMP_SIZE * RAMP_ROWS.length);
  RAMP_ROWS.forEach((name, row) => {
    resample(scene.ramps[name].samples).forEach((v, i) => {
      data[row * RAMP_SIZE + i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    });
  });
  const texture = new THREE.DataTexture(data, RAMP_SIZE, RAMP_ROWS.length, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
const NUMBERED = ["", "2", "3", "4", "5"];

/**
 * The per-material uniforms from a material's baked params.
 * @param {Record<string, any>} p params.json entry for the game material.
 * @param {any} scene scene.json.
 */
export function gooMaterialUniforms(p, scene) {
  const colA = p["Color Attribute Alpha"];
  const fromAttribute = typeof colA === "object" && colA?.attribute === "Col";
  const maskConstant = Array.isArray(p["_M Map Color"]) ? p["_M Map Color"] : [0.8, 0.8, 0.8];
  return {
    gooShadowColors: { value: NUMBERED.map((n) => vec3(p[`Shadow Color${n}`])) },
    gooShallowColors: { value: NUMBERED.map((n) => vec3(p[`Shallow Color${n}`])) },
    gooIndirectColors: { value: NUMBERED.map((n) => vec3(p[`Local Indirect Color${n}`])) },
    gooShadowMultiplier: { value: vec3(p["Shadow Color Multiplier"]) },
    gooSunColor: { value: vec3(p["Sun Light Color"]) },
    gooTransitionColor: { value: vec3(p["Shadow Transition Color"]) },
    gooShadowPosition: { value: p["Shadow Position"] },
    gooShadowSoftness: { value: p["Shadow Softness"] },
    gooFadeStrength: { value: p["Shadow Fade Strength"] },
    gooSssStrength: { value: p["SSS Effect Strength"] },
    gooCastShadows: { value: p["Enable Cast Shadows"] },
    gooColAlphaFromAttribute: { value: fromAttribute ? 1 : 0 },
    gooColAlphaConstant: { value: fromAttribute ? 0 : Number(colA) || 0 },
    gooMaskConstant: { value: vec3(maskConstant) },
    gooMask: { value: null },
    gooLightmap: { value: null },
    // Highlights and rim (#253).
    gooHairHighlightMask: { value: snap(p["Enable Hair Highlight Mask"]) },
    gooHairHighlightIntensity: { value: Number(p["Hair Highlight Intensity"] ?? 0) },
    gooHairHighlightSpread: { value: Number(p["Hair Highlight Spread Power"] ?? 1) },
    gooHairHighlightColor: { value: vec3(p["Hair Highlight Color Multiplier"] ?? [1, 1, 1]) },
    gooMatcapEnabled: { value: snap(p["Enable MatCap Effect"]) },
    gooRimMultiplier: { value: vec3(p["Rim Light Color Multiplier"] ?? [1, 1, 1]) },
    gooRimAdditional: { value: vec3(p["Rim Light Additional Color"] ?? [0, 0, 0]) },
    gooMatcapA: { value: null },
    gooMatcapB: { value: null },
    gooMatcapColors: { value: NUMBERED.map(() => new THREE.Vector3(1, 1, 1)) },
    gooMatcapSampler: { value: new Float32Array(5) },
    gooMatcapAdd: { value: new Float32Array(5) },
    gooMatcapMultiplyFactor: { value: Number(p["MatCap Multiplier Factor"] ?? 1) },
    gooMatcapAddFactor: { value: Number(p["MatCap Addition Factor"] ?? 1) },
  };
}

/** Blender's Math SNAP to 1, clamped: 1 when the switch is on. */
const snap = (v) => (Number(v) >= 1 ? 1 : 0);

/**
 * Fill the matcap slots from the baked `[ZZZB] MatCaps` inputs.
 * @param {object} uniforms From gooMaterialUniforms().
 * @param {Record<string, any>} matcaps params._matcaps.
 * @param {(file: string) => THREE.Texture} texture Loads a game texture.
 */
export function setUpMatcaps(uniforms, matcaps, texture, name = "material") {
  const samplers = [];
  NUMBERED.forEach((n, i) => {
    const color = matcaps[`MatCap Map Color${n}`];
    const tint = matcaps[`MatCap Color Tint${n}`] ?? [1, 1, 1];
    uniforms.gooMatcapAdd.value[i] = snap(matcaps[`MatCap Multiplier/Addition${n}`]);
    if (color?.texture) {
      let slot = samplers.indexOf(color.texture);
      if (slot < 0) slot = samplers.push(color.texture) - 1;
      if (slot > 1) throw new Error(`${name}: more than two matcap textures`);
      uniforms.gooMatcapSampler.value[i] = slot + 1;
      uniforms.gooMatcapColors.value[i].set(tint[0], tint[1], tint[2]);
    } else {
      const c = Array.isArray(color) ? color : [1, 1, 1];
      uniforms.gooMatcapColors.value[i].set(c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]);
    }
  });
  if (samplers[0]) uniforms.gooMatcapA.value = texture(samplers[0]);
  if (samplers[1]) uniforms.gooMatcapB.value = texture(samplers[1]);
}

/** Per-frame uniforms, one object shared by every Goo material. */
export function gooFrameUniforms() {
  return {
    gooLightView: { value: new THREE.Vector3(0, 0, 1) },
    gooFaceShadowRange: { value: 1 },
    gooFaceMirrorU: { value: 0 },
    gooFacingForward: { value: 0 },
    gooFacingDot: { value: 0 },
    gooLightFacingPow: { value: 0 },
    gooEdgeLight: { value: 0 },
    gooPartCel: { value: 1 },
    gooPartFaceShadow: { value: 1 },
    gooPartMatcaps: { value: 1 },
    gooPartHighlights: { value: 1 },
    gooPartRim: { value: 1 },
    gooPartEdgeSss: { value: 1 },
    gooNoseLine: { value: 1 },
    gooEyeShine: { value: 0.5 },
  };
}

/**
 * JS mirror of the GLSL gooOutlineWidth (PMX units), so tests can check the numbers.
 * @param {number} colR Linear Col.r.
 * @param {number} distanceUnits Camera distance in PMX units.
 */
export function gooOutlineWidthUnits(colR, distanceUnits) {
  const metres = distanceUnits * 0.08;
  const t = Math.min(1, Math.max(0, metres - 0.75));
  return (colR * 0.01 * (0.125 + (0.375 - 0.125) * t)) / 0.08;
}

/**
 * JS mirror of the outline darkening factor f in gooOutlineColour: 1 on ID 2
 * (0-based index 1), else 1 − smoothstep(0.25, 0.5, Col.g).
 */
export function gooOutlineFactor(index, colG) {
  if (index === 1) return 1;
  const t = Math.min(1, Math.max(0, (colG - 0.25) / 0.25));
  return 1 - t * t * (3 - 2 * t);
}

/** Outline colours per material ID; ID 1 is screened with 0.75 grey first, as in Blender. */
export function gooOutlineColors(p) {
  return NUMBERED.map((n, i) => {
    const c = p[`Outline Color${n}`] ?? [0, 0, 0];
    return i === 0
      ? new THREE.Vector3(1 - (1 - c[0]) * 0.25, 1 - (1 - c[1]) * 0.25, 1 - (1 - c[2]) * 0.25)
      : vec3(c);
  });
}
