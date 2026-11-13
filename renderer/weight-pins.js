/**
 * Pin strands to still bones (#114): move the vertex weights of chosen
 * physics-driven bones onto their nearest ancestor that physics doesn't
 * move, at load time, so the PMX stays untouched. See docs/physics.md.
 *
 * Pure module: no DOM or Three.js imports, so `node --test` covers it.
 */

/**
 * The spiral curl below its root: these bones lose their rigid bodies, so they
 * follow Ctr_F_Hair_012 and the spiral swings as one piece without bending.
 */
export const RIGID_STRANDS = Object.freeze([
  "Ctr_F_Hair_013", "Ctr_F_Hair_014", "Ctr_F_Hair_015", "Ctr_F_Hair_016", "Ctr_F_Hair_018",
]);

/**
 * @param {{name: string, parent: number}[]} bones Bone names and parent indices.
 * @param {Iterable<string>} names Strand bones; names missing from the rig are skipped.
 * @returns {Set<number>} Those bones and all their descendants (such as …錘 weights).
 */
export function pinnedBones(bones, names) {
  const pinned = new Set();
  for (const name of names) {
    const index = bones.findIndex((bone) => bone.name === name);
    if (index >= 0) pinned.add(index);
  }
  let grew = true;
  while (grew) {
    grew = false;
    bones.forEach((bone, i) => {
      if (!pinned.has(i) && pinned.has(bone.parent)) {
        pinned.add(i);
        grew = true;
      }
    });
  }
  return pinned;
}

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

/** Hair bones: every Ctr_[BFLRT]_Hair… bone; their …錘 weight bones carry no vertices. */
const HAIR_BONE = /^Ctr_[BFLRT]_Hair/;

/**
 * The hair strands that follow only part of their physics motion: all of her
 * hair except the …錘 weight bones.
 * @param {Iterable<string>} boneNames Every bone name in the rig.
 * @returns {string[]} In rig order.
 */
export function stiffStrands(boneNames) {
  return [...boneNames].filter((name) => HAIR_BONE.test(name) && !name.endsWith("錘"));
}

/** Share of the stiffened hair's weight left on its moving bones (see docs/physics.md). */
export const HAIR_FOLLOW = 0.4;

/**
 * A test of whether two bones always move identically: a plain Ctr_ bone with
 * no rigid body is never posed, so it moves exactly like its parent (for
 * example Ctr_F_Hair_01 ≡ 頭). Skinning to either gives the same result.
 * @param {{name: string, parent: number}[]} bones
 * @param {(index: number) => boolean} isDynamic Whether physics moves the bone.
 * @returns {(a: number, b: number) => boolean}
 */
export function sameMotionAs(bones, isDynamic) {
  const key = (bone) => {
    let b = bone;
    while (b >= 0 && !isDynamic(b) && bones[b].name.startsWith("Ctr_") && bones[b].parent >= 0) b = bones[b].parent;
    return b;
  };
  return (a, b) => key(a) === key(b);
}

/**
 * Keep `follow` of each weight on a moving bone and give the rest to its still
 * target, in place, so every vertex shows the same share of the motion. The
 * share goes onto the target, a bone that moves exactly like it, or a free
 * slot. A vertex whose four slots all move folds its smallest moving
 * influence into its largest to free one. follow 0 is a full pin.
 * @param {ArrayLike<number> & {[i: number]: number}} skinIndex
 * @param {ArrayLike<number> & {[i: number]: number}} skinWeight
 * @param {Map<number, number>} targets From pinTargets(): moving bone → still target.
 * @param {number} follow Share left on the moving bones, 0 to 1.
 * @param {{sameMotion?: (a: number, b: number) => boolean}} [options]
 * @returns {{changed: number, skipped: number, folded: number}}
 */
export function blendWeights(skinIndex, skinWeight, targets, follow, { sameMotion = (a, b) => a === b } = {}) {
  if (targets.size === 0 || follow >= 1) return { changed: 0, skipped: 0, folded: 0 };
  if (follow <= 0) return { changed: pinWeights(skinIndex, skinWeight, targets), skipped: 0, folded: 0 };
  let changed = 0;
  let skipped = 0;
  let folded = 0;
  const slots = [0, 1, 2, 3];
  for (let base = 0; base < skinIndex.length; base += 4) {
    const used = (k) => skinWeight[base + k] > 0;
    const moving = () => slots.filter((k) => used(k) && targets.has(skinIndex[base + k]));
    if (moving().length === 0) continue;
    let touched = false;
    let blocked = false;
    for (const target of new Set(moving().map((k) => targets.get(skinIndex[base + k])))) {
      const own = () => moving().filter((k) => targets.get(skinIndex[base + k]) === target);
      const findSlot = () => slots.find((k) => used(k) && !targets.has(skinIndex[base + k])
        && sameMotion(skinIndex[base + k], target)) ?? slots.find((k) => !used(k));
      let slot = findSlot();
      if (slot === undefined && moving().length >= 2) {
        const byWeight = moving().sort((a, b) => skinWeight[base + a] - skinWeight[base + b]);
        const [smallest, largest] = [byWeight[0], byWeight[byWeight.length - 1]];
        skinWeight[base + largest] += skinWeight[base + smallest];
        skinWeight[base + smallest] = 0;
        skinIndex[base + smallest] = 0;
        folded += 1;
        slot = findSlot();
      }
      if (slot === undefined) {
        blocked = true;
        continue;
      }
      let moved = 0;
      for (const k of own()) {
        moved += skinWeight[base + k] * (1 - follow);
        skinWeight[base + k] *= follow;
      }
      if (!used(slot)) skinIndex[base + slot] = target;
      skinWeight[base + slot] += moved;
      touched = true;
    }
    if (touched) changed += 1;
    else if (blocked) skipped += 1;
  }
  return { changed, skipped, folded };
}
