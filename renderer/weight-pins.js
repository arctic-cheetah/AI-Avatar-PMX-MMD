/**
 * Pin strands to still bones (#114): move the vertex weights of chosen
 * physics-driven bones onto their nearest ancestor that physics doesn't
 * move, at load time, so the PMX stays untouched. See docs/physics.md.
 *
 * Pure module: no DOM or Three.js imports, so `node --test` covers it.
 */

/** The tiny front curl, which buzzed at frame rate and clipped with physics on. */
export const PINNED_STRANDS = Object.freeze([
  "Ctr_F_Hair_012", "Ctr_F_Hair_013", "Ctr_F_Hair_014", "Ctr_F_Hair_015", "Ctr_F_Hair_016", "Ctr_F_Hair_018",
]);

/**
 * @param {{name: string, parent: number}[]} bones Bone names and parent indices (-1 for a root).
 * @param {Iterable<string>} names Bones to pin; names missing from the rig are skipped.
 * @param {(index: number) => boolean} isDynamic Whether physics moves the bone.
 * @returns {Map<number, number>} Pinned bone index → target bone index.
 */
export function pinTargets(bones, names, isDynamic) {
  const pinned = new Set();
  for (const name of names) {
    const index = bones.findIndex((bone) => bone.name === name);
    if (index >= 0) pinned.add(index);
  }
  const targets = new Map();
  for (const index of pinned) {
    let target = bones[index].parent;
    while (target >= 0 && (pinned.has(target) || isDynamic(target))) target = bones[target].parent;
    if (target >= 0) targets.set(index, target);
  }
  return targets;
}

/**
 * Move weights in place, four influences per vertex. A vertex that already
 * has the target bone gets one merged influence; the freed slot is zeroed.
 * @param {ArrayLike<number> & {[i: number]: number}} skinIndex
 * @param {ArrayLike<number> & {[i: number]: number}} skinWeight
 * @param {Map<number, number>} targets From pinTargets().
 * @returns {number} How many vertices changed.
 */
export function pinWeights(skinIndex, skinWeight, targets) {
  if (targets.size === 0) return 0;
  let changed = 0;
  for (let base = 0; base < skinIndex.length; base += 4) {
    let touched = false;
    for (let k = 0; k < 4; k++) {
      const target = targets.get(skinIndex[base + k]);
      if (target === undefined || !(skinWeight[base + k] > 0)) continue;
      touched = true;
      const existing = [0, 1, 2, 3].find((j) => j !== k && skinIndex[base + j] === target && skinWeight[base + j] > 0);
      if (existing === undefined) {
        skinIndex[base + k] = target;
      } else {
        skinWeight[base + existing] += skinWeight[base + k];
        skinWeight[base + k] = 0;
        skinIndex[base + k] = 0;
      }
    }
    if (touched) changed += 1;
  }
  return changed;
}
