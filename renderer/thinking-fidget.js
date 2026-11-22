// Thinking fidget (#218): a small, slow idle of her fingers and right fist
// while she holds the thinking pose. It only uses the forearm twist and finger
// channels of the hand drift rig, so the elbows and wrists stay where the
// thinking rig (#217) put them. No DOM or Three.js imports, so node --test
// covers it (tests/renderer/thinking-fidget.test.mjs).
// See docs/thinking-pose.md#thinking-fidget-218.

import { ARM_CHANNELS } from "./idle-motion.js";

const DEG = Math.PI / 180;

/**
 * Sizes in radians, times in seconds. Picked with the user from comparison
 * grids; see docs/thinking-pose.md.
 * - roll: the right fist's roll on its twist bone, on two sine waves (`rollPeriods`).
 * - squeeze: the right fist tightening and loosening, per finger joint (`squeezePeriods`).
 * - tap: how far each left finger lifts off the sleeve in a tap (negative curl).
 * - tapEvery: seconds from one tap to the next; tapStart: when the first tap begins.
 * - tapDuration: one finger's lift and return; tapLag: the next finger starts this much later.
 * - pinkyLift: the left little finger is held this much open (negative curl), so it stays out of the sleeve.
 */
export const THINKING_FIDGET = Object.freeze({
  roll: 5 * DEG,
  rollPeriods: Object.freeze([5, 8]),
  squeeze: 4 * DEG,
  squeezePeriods: Object.freeze([7, 11]),
  tap: 5 * DEG,
  tapEvery: 7,
  tapStart: 2,
  tapDuration: 0.5,
  tapLag: 0.15,
  pinkyLift: 18 * DEG,
});

/** Her right arm is on the left of the screen. The fist squeezes with every finger. */
const SQUEEZE = Object.freeze(["Thumb", "Index", "Middle", "Ring", "Little"].map((finger) => `curl${finger}Left`));
/** The left fingers tap from the little finger to the index; the thumb keeps holding the elbow. */
const TAP = Object.freeze(["Little", "Ring", "Middle", "Index"].map((finger) => `curl${finger}Right`));

/** Every hand drift channel the fidget writes. */
export const FIDGET_CHANNELS = Object.freeze(["forearmLeft", ...SQUEEZE, ...TAP]);

/** A two-sine mix that stays within ±1. */
const wave = (clock, [first, second], phase) => 0.6 * Math.sin((2 * Math.PI * clock) / first + phase)
  + 0.4 * Math.sin((2 * Math.PI * clock) / second + 1.7 * phase + 0.9);

/** A smooth 0 → 1 → 0 bump over `duration` seconds, zero outside it. */
const bump = (t, duration) => (t <= 0 || t >= duration ? 0 : Math.sin((Math.PI * t) / duration) ** 2);

/**
 * The fidget angles at `clock` seconds of thinking, scaled by the pose weight.
 * @param {number} clock Seconds since the pose started.
 * @param {number} amount Thinking pose weight, 0-1.
 * @param {Partial<typeof THINKING_FIDGET>} [sizes] Overrides for previews.
 * @returns {Record<string, number>} Radians per FIDGET_CHANNELS name.
 */
export function thinkingFidgetAngles(clock, amount, sizes = {}) {
  const fidget = { ...THINKING_FIDGET, ...sizes };
  const weight = amount > 0 ? Math.min(1, amount) : 0;
  const angles = Object.fromEntries(FIDGET_CHANNELS.map((channel) => [channel, 0]));
  if (weight === 0 || !Number.isFinite(clock)) return angles;
  angles.forearmLeft = weight * fidget.roll * wave(clock, fidget.rollPeriods, 0.4);
  const squeeze = weight * fidget.squeeze * wave(clock, fidget.squeezePeriods, 2.1);
  for (const channel of SQUEEZE) angles[channel] = squeeze;
  const inCycle = (((clock - fidget.tapStart) % fidget.tapEvery) + fidget.tapEvery) % fidget.tapEvery;
  const started = clock >= fidget.tapStart;
  for (const [index, channel] of TAP.entries()) {
    angles[channel] = started ? -weight * fidget.tap * bump(inCycle - index * fidget.tapLag, fidget.tapDuration) : 0;
  }
  angles.curlLittleRight -= weight * fidget.pinkyLift;
  // A zero size or a still moment is exactly 0, never −0.
  for (const channel of FIDGET_CHANNELS) angles[channel] ||= 0;
  return angles;
}

/**
 * Mix the idle arm drift's hand channels with the fidget: the drift fades by
 * the pose weight, and the fidget (already scaled by it) adds on top.
 * @param {Record<string, number>} idlePose The idle motion pose; missing channels count as 0.
 * @param {Record<string, number>} fidget thinkingFidgetAngles() for this frame.
 * @param {number} weight Thinking pose weight, 0-1.
 * @returns {Record<string, number>} Radians per ARM_CHANNELS name.
 */
export function handAngles(idlePose, fidget, weight) {
  const fade = 1 - Math.min(1, Math.max(0, Number.isFinite(weight) ? weight : 0));
  const angles = {};
  for (const channel of new Set([...ARM_CHANNELS, ...Object.keys(fidget)])) {
    const drift = fade === 0 ? 0 : fade * (idlePose[channel] ?? 0);
    angles[channel] = drift + (fidget[channel] ?? 0);
  }
  return angles;
}
