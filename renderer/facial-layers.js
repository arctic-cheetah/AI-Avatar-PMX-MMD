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
