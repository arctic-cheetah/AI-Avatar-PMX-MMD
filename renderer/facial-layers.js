// Rules for morphs that several facial channels touch (issue #54). No DOM or
// Three.js imports, so node --test covers it (tests/renderer/facial-layers.test.mjs).
// See docs/animation-transitions.md for the frame order these assume.

/**
 * Morphs that already close the eyes, and how much. The idle blink only
 * closes the rest of the way, so a closed-eye smile or a wink does not
 * blink on top of itself. Names match Yidhari's PMX (docs/pmx-morph-catalog.md).
 */
export const EYE_CLOSURE = Object.freeze({
  "笑い": 1,
  "ウィンク": 1,
  "ウィンク右": 1,
});

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * Strongest eye closure currently written to the face.
 * @param {{ morphTargetDictionary?: Record<string, number>, morphTargetInfluences?: ArrayLike<number> } | null} mesh
 * @param {Record<string, number>} [table=EYE_CLOSURE] Closing morph factors.
 * @returns {number} Closure from 0 (open) to 1 (closed).
 */
export function eyeClosure(mesh, table = EYE_CLOSURE) {
  const dictionary = mesh?.morphTargetDictionary;
  const influences = mesh?.morphTargetInfluences;
  if (!dictionary || !influences) return 0;
  let closure = 0;
  for (const [name, factor] of Object.entries(table)) {
    const index = dictionary[name];
    if (index != null) closure = Math.max(closure, clamp01(influences[index]) * factor);
  }
  return clamp01(closure);
}

/**
 * Combine the idle blink with a mood's own value on the same blink morph.
 * The blink is reduced by any closure already on the face, then screened over
 * the mood value: 1 - (1 - mood) * (1 - blink * (1 - closure)).
 * @param {number} moodWeight Blink morph weight written by the mood.
 * @param {number} blinkWeight Idle blink from 0 (open) to 1 (closed).
 * @param {number} [closure=0] Eye closure from other morphs.
 * @returns {number} Final blink morph weight.
 */
export function composeBlink(moodWeight, blinkWeight, closure = 0) {
  const mood = clamp01(moodWeight);
  const blink = clamp01(blinkWeight) * (1 - clamp01(closure));
  return 1 - (1 - mood) * (1 - blink);
}

/**
 * The morphs that close each eye (#49). 笑い and まばたき close both; the winks
 * one each. Names match Yidhari's PMX (docs/pmx-morph-catalog.md).
 */
export const EYE_GROUPS = Object.freeze({
  left: Object.freeze(["笑い", "まばたき", "ウィンク", "ウィンク２"]),
  right: Object.freeze(["笑い", "まばたき", "ウィンク右", "ウィンク２右"]),
});

/**
 * Keep each eye's closing morphs at or under 1 in total, after every layer
 * has written the face. An eye over budget has all its closers scaled down
 * by the same factor, so a wink on top of a closed-eye smile closes the eye
 * once instead of pushing the lid through. When both eyes are over, all their
 * closers share one factor from the fullest eye, so both close exactly once.
 * @param {{ morphTargetDictionary?: Record<string, number>, morphTargetInfluences?: number[] } | null} mesh
 * @param {Record<string, readonly string[]>} [groups=EYE_GROUPS]
 * @returns {void}
 */
export function capEyeClosure(mesh, groups = EYE_GROUPS) {
  const dictionary = mesh?.morphTargetDictionary;
  const influences = mesh?.morphTargetInfluences;
  if (!dictionary || !influences) return;
  // One shared factor for every closer of the eyes over budget, from the
  // fullest eye: with both over (笑い + both winks), both end at exactly 1
  // instead of the second eye's pass shrinking the first (review on #263).
  let worst = 1;
  const over = new Set();
  for (const names of Object.values(groups)) {
    const indices = names.map((name) => dictionary[name]).filter((index) => index != null);
    const sum = indices.reduce((total, index) => total + Math.max(0, influences[index]), 0);
    if (sum <= 1) continue;
    worst = Math.max(worst, sum);
    for (const index of indices) over.add(index);
  }
  for (const index of over) influences[index] = Math.max(0, influences[index]) / worst;
}

/**
 * Keep every morph within 0 to 1 after every layer has written the face
 * (#49). Layers add up (a held pose, the mood, speech, audition sliders), and
 * a morph pushed past 1 over-deforms the mesh. Sums across different morphs
 * are left alone: 上左 + 上右 move different brows. The teeth (SIGNED_MORPHS)
 * may go down to −1. Run before capEyeClosure().
 * @param {{ morphTargetDictionary?: Record<string, number>, morphTargetInfluences?: number[] } | null} mesh
 * @param {readonly string[]} [signed]
 * @returns {void}
 */
export function clampMorphs(mesh, signed = SIGNED_MORPHS) {
  const influences = mesh?.morphTargetInfluences;
  if (!influences) return;
  const dictionary = mesh.morphTargetDictionary ?? {};
  const negative = new Set(signed.map((name) => dictionary[name]).filter((index) => index != null));
  for (let i = 0; i < influences.length; i += 1) {
    const value = Number.isFinite(influences[i]) ? influences[i] : 0;
    influences[i] = negative.has(i) ? Math.min(1, Math.max(-1, value)) : clamp01(value);
  }
}

/**
 * Morphs that may go below 0, down to −1 (the user, 25 Nov 2026): pulling the
 * teeth back shows them in a smile. Every other morph stays within 0 to 1.
 */
export const SIGNED_MORPHS = Object.freeze(["齿上", "齿下"]);
