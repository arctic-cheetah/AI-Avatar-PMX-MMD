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
 * Eye-closing morphs per eye (#99). `笑い` closes both eyes; each wink closes
 * one. Left and right are the model's own sides, as in the wink buttons.
 */
export const EYE_CLOSURE_BY_SIDE = Object.freeze({
  left: Object.freeze({ "笑い": 1, "ウィンク": 1 }),
  right: Object.freeze({ "笑い": 1, "ウィンク右": 1 }),
});

/**
 * How closed each eye already is this frame.
 * @param {Parameters<typeof eyeClosure>[0]} mesh Face mesh.
 * @returns {{ left: number, right: number }} Closure from 0 (open) to 1 (closed).
 */
export function eyeClosures(mesh) {
  return {
    left: eyeClosure(mesh, EYE_CLOSURE_BY_SIDE.left),
    right: eyeClosure(mesh, EYE_CLOSURE_BY_SIDE.right),
  };
}

/**
 * Split an idle blink between the both-eyes blink morph and each eye's wink
 * morph. `まばたき` takes what both eyes still need; each wink morph takes what
 * its own eye needs beyond that. So equal closures blink exactly as before,
 * and while one eye winks, the open eye still blinks.
 * @param {number} blinkWeight Idle blink from 0 (open) to 1 (closed).
 * @param {number} left Left eye closure.
 * @param {number} right Right eye closure.
 * @returns {{ both: number, left: number, right: number }} Weights to combine in.
 */
export function splitBlink(blinkWeight, left, right) {
  const blink = clamp01(blinkWeight);
  const needLeft = blink * (1 - clamp01(left));
  const needRight = blink * (1 - clamp01(right));
  const both = Math.min(needLeft, needRight);
  return { both, left: needLeft - both, right: needRight - both };
}

/**
 * Combine the wink channel with a mood's own wink on the same morph, so a mood
 * such as `playful` keeps its wink while the wink buttons are off.
 * @param {number} moodWeight Wink morph weight written by the mood.
 * @param {number} winkWeight Wink channel from 0 (open) to 1 (closed).
 * @returns {number} Final wink morph weight.
 */
export function composeWink(moodWeight, winkWeight) {
  return 1 - (1 - clamp01(moodWeight)) * (1 - clamp01(winkWeight));
}
