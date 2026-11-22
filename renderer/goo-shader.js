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
`;

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
uniform float gooSssRamp[GOO_RAMP_SIZE];
uniform float gooFadeRamp[GOO_RAMP_SIZE];
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

// The smoothstep node group: t clamped, t²(3 − 2t).
float gooSmooth( float e0, float e1, float x ) {
  float t = clamp( ( x - e0 ) / ( e1 - e0 ), 0.0, 1.0 );
  return t * t * ( 3.0 - 2.0 * t );
}

float gooLut( const in float lut[ GOO_RAMP_SIZE ], float x ) {
  float t = clamp( x, 0.0, 1.0 ) * float( GOO_RAMP_SIZE - 1 );
  int i = int( min( floor( t ), float( GOO_RAMP_SIZE - 2 ) ) );
  return mix( lut[ i ], lut[ i + 1 ], t - float( i ) );
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
  vec3 base = mix( D, D * m089 * 0.25, clamp( 1.0 - m089, 0.0, 1.0 ) );
  // Dynamic Face Highlight from the lightmap's blue channel.
  vec4 lmN = texture2D( gooLightmap, vMapUv );
  float highlight = clamp( lmN.b * gooFacingDot * gooLightFacingPow, 0.0, 1.0 );
  base += 0.6771 * base * highlight;
  // Shadows [FACE]: faceLogic mirrors u for one light side; the red channel is the SDF.
  vec2 uvL = gooFaceMirrorU > 0.5 ? vec2( - vMapUv.x, vMapUv.y ) : vMapUv;
  vec4 lmV = texture2D( gooLightmap, uvL );
  float edge1 = 1.0 - pow( gooFaceShadowRange, 3.14 ) + pos;
  float lit = clamp( gooSmooth( edge1 - soft, edge1, lmV.r ), 0.0, 1.0 );
  vec3 light = mix( mix( gooShallowColors[ 2 ], gooShadowColors[ 2 ], lit ) * gooShadowMultiplier, gooSunColor, lit );
  // Body/Face Transition: outside the lightmap's alpha the transition colour shows.
  light = mix( light, gooTransitionColor * gooShadowMultiplier, 1.0 - lmV.a );
  // Fake SSS [FACE].
  float sss = mix( 1.0, gooLut( gooSssRamp, lit ), gooSssStrength );
  sss = mix( 1.0, mix( sss, 1.0, lit ), lmV.a );
#else
  vec3 N = normalize( n );
  vec3 L = normalize( gooLightView );
  vec3 V = normalize( vViewPosition );
  float NdotL = dot( N, L );
  float NdotV = dot( N, V );
  vec3 shadowColor = gooShadowColors[ id ];
  float colA = mix( gooColAlphaConstant, vGooCol.a, gooColAlphaFromAttribute );
  float s4 = gooSmooth( pos, pos + soft, NdotL );               // Shallow
  float s5 = gooSmooth( pos - 0.5, pos - 0.5 + soft, NdotL );   // Shadow [No Cast Shadows]
  float s16 = gooSmooth( pos - 0.4, pos - 0.4 + soft, NdotL );
  // Edge Highlights: screen the diffuse with itself tinted by the shadow colour.
  float edge = clamp( pow( clamp( 1.0 - NdotV, 0.0, 1.0 ), 10.0 ), 0.0, 1.0 ) * s4 * gooEdgeLight;
  vec3 base = gooScreen( D, D * edge * shadowColor );
  // Cast Shadow Mask: no Goo cast shadows here, so only the shallow edge.
  float castMask = mix( 1.0, s4, gooCastShadows );
  // Fake SSS [BODY].
  float sss = mix( 1.0, gooLut( gooSssRamp, castMask ), gooSssStrength );
  sss = mix( mix( sss, 1.0, s4 ), 1.0, colA );
  // Shadows [BODY].
  vec3 shadow = shadowColor * gooShadowMultiplier;
  vec3 shallow = gooShallowColors[ id ] * gooShadowMultiplier;
  vec3 dark = mix( shadow, shadow * shallow, 0.5 );
  float fadeX = clamp( ( NdotL - 0.5 ) * 0.5 + 0.5, 0.0, 1.0 );
  float fade = mix( 1.0, mix( 1.0, gooLut( gooFadeRamp, fadeX ), s5 ), gooFadeStrength );
  vec3 lit3 = mix( mix( dark, shallow, fade ), gooSunColor, clamp( castMask + clamp( 1.0 - s5, 0.0, 1.0 ), 0.0, 1.0 ) );
  vec3 light = mix( dark, lit3, s16 );
  light = mix( light, gooTransitionColor * gooShadowMultiplier, colA );
#endif
  // Local Indirect Color, then the SSS blend; times the processed diffuse.
  vec3 indirectLight = mix( indirect * light, vec3( 1.0 ), 0.666 );
  return base * mix( indirectLight, light, sss );
}
`;

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
  shader.vertexShader = vertex;
  // After the last pars chunk, so vMapUv and vViewPosition are declared.
  let fragment = swap(shader.fragmentShader, "#include <clipping_planes_pars_fragment>", `#include <clipping_planes_pars_fragment>\n${FRAGMENT_PARS}`);
  fragment = swap(fragment, "#include <normal_fragment_maps>", NORMAL_MAPS);
  // Blender's Enable Alpha Usage is off: the shader output is opaque.
  fragment = swap(fragment, "#include <opaque_fragment>", "outgoingLight = gooShade( diffuseColor, normal );\n  diffuseColor.a = 1.0;\n#include <opaque_fragment>");
  shader.fragmentShader = fragment;
}

const vec3 = (c) => new THREE.Vector3(c[0], c[1], c[2]);
const resample = (samples) => Float32Array.from({ length: RAMP_SIZE }, (_, i) => sampleRamp(samples, i / (RAMP_SIZE - 1)));
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
    gooSssRamp: { value: resample(scene.ramps["Color Ramp.006"].samples) },
    gooFadeRamp: { value: resample(scene.ramps["Color Ramp"].samples) },
  };
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
  };
}
