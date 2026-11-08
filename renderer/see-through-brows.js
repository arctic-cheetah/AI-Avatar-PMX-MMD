import { bindStoredToggle } from './stored-toggle.js';

/**
 * See-through brows (#99): the brows sit under the bangs, so the brow-only
 * triangles of the lash/brow material are drawn a second time over the hair,
 * semi-transparent. They stay in the same mesh, so morphs, blinks and bones
 * move them together with the original. The PMX file is not changed.
 */
export const SEE_THROUGH_BROWS_KEY = 'yidhari.see-through-brows';
export const BROW_MATERIAL = '睫眉';
export const SEE_THROUGH_OPACITY = 0.6;
/** Yidhari's brow-panel morphs. */
export const BROW_MORPHS = Object.freeze([
  '真面目', '困る', '困る右', '怒り', '怒り左', '怒り右', 'にこり', 'にこり左', 'にこり右',
  '上', '上左', '上右', '下', '下左', '下右', '前', '前左', '前右',
]);
/** Eye-panel morphs; triangles they move include the eyelid covers, so they are excluded. */
export const EYE_MORPHS = Object.freeze([
  'まばたき', '笑い', 'ウィンク２', 'ウィンク２右', 'ウィンク', 'ウィンク右', 'びっくり', 'びっくり左',
  'びっくり右', '怒り目', '怒り目２', 'じと目', '下眼上', '眼角下', '悲しむ',
]);

/**
 * Vertices that any of the named morphs moves. three r170's MMDLoader stores
 * absolute target positions (morphTargetsRelative false); relative targets
 * store offsets. Unknown names are ignored.
 * @param {{ geometry: object, morphTargetDictionary?: Record<string, number> }} mesh Loaded mesh.
 * @param {readonly string[]} names Morph names.
 * @returns {Set<number>} Vertex indices.
 */
export function movedVertices(mesh, names) {
  const { geometry, morphTargetDictionary: dictionary = {} } = mesh;
  const base = geometry.attributes.position;
  const relative = geometry.morphTargetsRelative;
  const moved = new Set();
  for (const name of names) {
    const target = geometry.morphAttributes?.position?.[dictionary[name]];
    if (!target) continue;
    for (let v = 0; v < target.count; v += 1) {
      const [x, y, z] = relative ? [0, 0, 0] : [base.getX(v), base.getY(v), base.getZ(v)];
      if (target.getX(v) !== x || target.getY(v) !== y || target.getZ(v) !== z) moved.add(v);
    }
  }
  return moved;
}

/**
 * Triangles of one geometry group whose corners all move with brow morphs and
 * none with eye morphs.
 * @param {ArrayLike<number>} index Index array.
 * @param {{ start: number, count: number }} group Geometry group.
 * @param {Set<number>} brow Vertices moved by brow morphs.
 * @param {Set<number>} eye Vertices moved by eye morphs.
 * @returns {number[]} Flat vertex indices, three per triangle.
 */
export function browOnlyTriangles(index, group, brow, eye) {
  const picked = [];
  for (let i = group.start; i < group.start + group.count; i += 3) {
    const corners = [index[i], index[i + 1], index[i + 2]];
    if (corners.every((v) => brow.has(v) && !eye.has(v))) picked.push(...corners);
  }
  return picked;
}

/**
 * Add the see-through brow layer to a loaded PMX mesh.
 * @param {object} mesh Loaded mesh with an indexed, grouped geometry and a material array.
 * @param {{ brows?: readonly string[], eyes?: readonly string[], opacity?: number }} [options]
 * @returns {{ material: object, triangles: number, setEnabled(on: boolean): void } | null}
 *   The layer, or null when the model has no brow material or no brow-only triangles.
 */
export function addSeeThroughBrows(mesh, { brows = BROW_MORPHS, eyes = EYE_MORPHS, opacity = SEE_THROUGH_OPACITY } = {}) {
  const materials = mesh.material;
  const geometry = mesh.geometry;
  const browIndex = Array.isArray(materials) ? materials.findIndex((m) => m.name === BROW_MATERIAL) : -1;
  const group = geometry.groups?.find((g) => g.materialIndex === browIndex);
  if (!group || !geometry.index) return null;
  const index = geometry.index.array;
  const picked = browOnlyTriangles(index, group, movedVertices(mesh, brows), movedVertices(mesh, eyes));
  if (picked.length === 0) return null;

  const source = materials[browIndex];
  const material = source.clone();
  // ShaderMaterial.clone() copies texture uniforms; a copy made before the
  // image loads never uploads, so share the original textures instead.
  for (const [key, uniform] of Object.entries(source.uniforms ?? {})) {
    if (uniform?.value?.isTexture && material.uniforms?.[key]) material.uniforms[key].value = uniform.value;
  }
  Object.assign(material, {
    name: `${BROW_MATERIAL} see-through`, transparent: true, depthTest: false, depthWrite: false, opacity,
  });
  material.userData.outlineParameters = { visible: false };
  materials.push(material);
  // three's setIndex takes a plain array and picks a 16- or 32-bit buffer.
  geometry.setIndex([...index, ...picked]);
  geometry.addGroup(index.length, picked.length, materials.length - 1);
  return {
    material,
    triangles: picked.length / 3,
    setEnabled(on) { material.visible = Boolean(on); },
  };
}

/**
 * Bind the See-through brows checkbox; on by default and remembered.
 * @param {ReturnType<typeof addSeeThroughBrows>} layer Brow layer, or null.
 * @param {{ checked: boolean, disabled?: boolean, addEventListener(type: string, fn: () => void): void } | null} toggle
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindSeeThroughBrowsToggle(layer, toggle, options) {
  if (!layer) {
    if (toggle) toggle.disabled = true;
    return;
  }
  bindStoredToggle(toggle, SEE_THROUGH_BROWS_KEY, (on) => layer.setEnabled(on), options);
}
