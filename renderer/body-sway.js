// Pure sway math for issue #4: animation-clock time -> small bone angles.
// No DOM or Three.js imports, so node --test can cover it (see
// tests/renderer/body-sway.test.mjs). Browser wiring lives in main.js,
// which caches each bone's base quaternion and multiplies this delta on top.

import { Spring, TIMING } from "./smoothing.js";

export const DEG = Math.PI / 180;

/** Sway channels: bone, local axis, amplitude (rad), period (s). */
export const SWAY = Object.freeze({
  roll: Object.freeze({ bone: "上半身2", axis: "z", amplitude: 1.5 * DEG, period: 6 }),
  yaw: Object.freeze({ bone: "上半身", axis: "y", amplitude: 1.0 * DEG, period: 9 }),
  breath: Object.freeze({ bone: "グルーブ", axis: "x", amplitude: 0.8 * DEG, period: 4 }),
});

const channelAt = ({ amplitude, period }, now) =>
  amplitude * Math.sin((2 * Math.PI * now) / period);

/**
 * Small sway angles at a monotonic animation-clock time.
 * Each channel starts at zero so the pose eases in from rest.
 * @param {number} now Seconds since the animation clock started.
 * @returns {{roll:number,yaw:number,breath:number}} Angles in radians.
 */
export function swayAnglesAt(now) {
  if (!Number.isFinite(now) || now < 0) {
    return { roll: 0, yaw: 0, breath: 0 };
  }
  return {
    roll: channelAt(SWAY.roll, now),
    yaw: channelAt(SWAY.yaw, now),
    breath: channelAt(SWAY.breath, now),
  };
}

/**
 * Largest absolute angle any channel can produce.
 * @returns {number} Bound in radians; sway never exceeds it per channel.
 */
export function maxSwayAmplitude() {
  return Math.max(SWAY.roll.amplitude, SWAY.yaw.amplitude, SWAY.breath.amplitude);
}

/**
 * Enabled state for the sway stop/start button, plus a gain that fades the
 * sway in and out instead of snapping it to rest.
 * Lives here (no DOM) so node --test can cover the toggle behaviour;
 * main.js owns one instance and mirrors it onto the button.
 */
export class SwayController {
  /** @param {boolean} enabled Whether sway starts enabled. */
  constructor(enabled = true) {
    this.enabled = enabled !== false;
    this.fade = new Spring(this.enabled ? 1 : 0);
  }

  /** @returns {number} Current sway gain from 0 (rest) to 1 (full). */
  get gain() {
    return this.fade.value;
  }

  /**
   * Ease the gain toward the enabled state for this frame.
   * @param {number} delta Seconds since the previous frame.
   * @returns {number} Gain to multiply the sway angles by.
   */
  update(delta) {
    const target = this.enabled ? 1 : 0;
    this.fade.step(target, delta, TIMING.swayFade);
    this.fade.clamp(0, 1);
    return this.fade.settle(target);
  }

  /** Flip the enabled state and report it. @returns {boolean} New state. */
  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  /** Set the enabled state explicitly. @param {boolean} enabled New state. */
  setEnabled(enabled) {
    this.enabled = enabled !== false;
  }
}
