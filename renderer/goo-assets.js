/**
 * Baked Goo shader inputs (#250, docs/goo-bake.md). The renderer uses them only
 * when they line up with the PMX it loaded; otherwise it keeps today's material.
 */

export const GOO_MANIFEST_VERSION = 1;

/**
 * Material shaders a bake can name:
 * - "zzzb": the Zenless Zone Zero Braincells Goo shader, with textures and params;
 * - "transparent": a tinted Transparent BSDF that multiplies what is behind it by `color`.
 * Hidden entries (the 髮+ shell) have `shader: null` and are not drawn.
 */

/**
 * The `Col` attribute from col.bin: RGBA8 per PMX vertex.
 * @param {ArrayBuffer | Uint8Array} buffer
 * @param {number} vertexCount
 * @returns {Uint8Array}
 */
export function decodeCol(buffer, vertexCount) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const expected = vertexCount * 4;
  if (bytes.length !== expected) throw new Error(`col.bin has ${bytes.length} bytes, expected ${expected}`);
  return bytes;
}

/**
 * Check a bake against the loaded PMX.
 * @param {{ manifest: any, materialMap: any, colBytes: Uint8Array, scene: any }} baked
 * @param {{ vertexCount: number, materialNames: string[] }} pmx
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGooAssets({ manifest, materialMap, colBytes, scene }, { vertexCount, materialNames }) {
  const errors = [];
  if (manifest?.version !== GOO_MANIFEST_VERSION) {
    errors.push(`manifest version ${manifest?.version} is not supported`);
  }
  const baked = manifest?.pmx ?? {};
  if (baked.vertexCount !== vertexCount) {
    errors.push(`baked for ${baked.vertexCount} vertices, the PMX has ${vertexCount}`);
  }
  const bakedNames = baked.materials ?? [];
  if (bakedNames.length !== materialNames.length) {
    errors.push(`baked for ${bakedNames.length} materials, the PMX has ${materialNames.length}`);
  }
  bakedNames.forEach((name, i) => {
    if (i < materialNames.length && name !== materialNames[i]) {
      errors.push(`material ${i} is ${name} in the bake, ${materialNames[i]} in the PMX`);
    }
  });
  const entries = materialMap?.materials ?? [];
  if (entries.length !== bakedNames.length) {
    errors.push(`material map has ${entries.length} entries, the manifest ${bakedNames.length}`);
  }
  entries.forEach((entry, i) => {
    if (entry.pmx !== bakedNames[i]) errors.push(`material map entry ${i} is ${entry.pmx}, expected ${bakedNames[i]}`);
    if (entry.hidden) return;
    if (entry.shader === "zzzb") {
      if (!entry.textures?.diffuse) errors.push(`${entry.pmx} has no diffuse texture`);
    } else if (entry.shader === "transparent") {
      if (!Array.isArray(entry.color) || entry.color.length !== 4) {
        errors.push(`${entry.pmx} is a transparent tint without a colour`);
      }
    } else {
      errors.push(`${entry.pmx} uses unsupported shader ${entry.shader}`);
    }
  });
  const expected = vertexCount * 4;
  if (colBytes?.length !== expected) errors.push(`col.bin has ${colBytes?.length} bytes, expected ${expected}`);
  errors.push(...sceneErrors(scene));
  return { ok: errors.length === 0, errors };
}

/** Ramps the ported shader samples (Fake SSS and Shadow Fade Gradient). */
export const REQUIRED_RAMPS = ["Color Ramp.006", "Color Ramp"];

const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

function sceneErrors(scene) {
  if (!scene) return ["scene.json is missing"];
  const errors = [];
  if (!isVec(scene.light?.eulerXYZ, 3)) errors.push("scene.json has no light rotation");
  if (!isVec(scene.head?.forward, 3) || !isVec(scene.head?.up, 3)) errors.push("scene.json has no head forward/up vectors");
  for (const name of REQUIRED_RAMPS) {
    if (!(scene.ramps?.[name]?.samples?.length >= 2)) errors.push(`scene.json has no ramp ${name}`);
  }
  return errors;
}
