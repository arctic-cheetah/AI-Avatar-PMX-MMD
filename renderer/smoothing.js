// Shared, time-based easing for issue #54. No DOM or Three.js imports, so
// node --test covers it (tests/renderer/smoothing.test.mjs). Rates are in 1/s:
// a time constant tau is 1 / rate. See docs/animation-transitions.md.

/** Per-channel rates. Springs: angular frequency; exponential: 1 / tau. */
export const TIMING = Object.freeze({
  /** Mood morphs (spring). */
  expression: 14,
  /** Thinking chin-rest gesture weight (spring). */
  thinkingPose: 10,
  /** Gaze target (spring). */
  gaze: 15,
  /** Wink morphs (spring). */
  wink: 16,
  /** Sway gain when toggled (spring). */
  swayFade: 4,
  /** Speech shape easing (exponential): about 28 ms to close most of the gap. */
  speechShape: 35,
  /** Lip closures (A) are short; snap faster so they survive dropped frames (exponential). */
  speechClosure: 80,
  /** Handing the mouth between speech and mood (exponential). */
  speechEnvelope: 18,
});

/** Longest frame step eased in real time; longer pauses resume as this step. */
export const MAX_FRAME_DELTA = 0.25;

/**
 * Seconds between two performance.now() readings, never negative and capped.
 * @param {number} nowMs Current timestamp in ms.
 * @param {number} previousMs Previous timestamp in ms.
 * @returns {number} Frame delta in seconds.
 */
export function frameDelta(nowMs, previousMs) {
  const delta = (nowMs - previousMs) / 1000;
  if (!(delta > 0)) return 0;
  return Math.min(delta, MAX_FRAME_DELTA);
}

/**
 * Fraction of the remaining gap a first-order ease closes in one step:
 * 1 - exp(-dt / tau), with tau = 1 / rate.
 * @param {number} delta Seconds elapsed.
 * @param {number} rate Rate in 1/s.
 * @returns {number} Blend factor from 0 to 1.
 */
export function exponentialBlend(delta, rate) {
  return 1 - Math.exp(-rate * Math.max(0, delta));
}

/**
 * Advance a critically damped spring exactly by one step toward a target.
 * Closed form, so the result depends only on elapsed time, not frame count.
 * @param {{ value: number, velocity: number }} state Mutated in place.
 * @param {number} target Value to settle at.
 * @param {number} delta Seconds elapsed; negative steps are ignored.
 * @param {number} rate Angular frequency in 1/s.
 * @returns {number} The new value.
 */
export function springStep(state, target, delta, rate) {
  const dt = Math.max(0, delta);
  if (dt === 0) return state.value;
  const offset = state.value - target;
  const decay = Math.exp(-rate * dt);
  const drive = state.velocity + rate * offset;
  state.value = target + (offset + drive * dt) * decay;
  state.velocity = (state.velocity - rate * drive * dt) * decay;
  return state.value;
}

/** One eased scalar with velocity, for any channel that needs smooth starts and stops. */
export class Spring {
  /** @param {number} [value=0] Initial value, at rest. */
  constructor(value = 0) {
    this.value = value;
    this.velocity = 0;
  }

  /**
   * @param {number} target Value to settle at.
   * @param {number} delta Seconds elapsed.
   * @param {number} rate Angular frequency in 1/s.
   * @returns {number} The new value.
   */
  step(target, delta, rate) {
    return springStep(this, target, delta, rate);
  }

  /**
   * Keep the value within bounds; hitting a bound stops motion past it.
   * @param {number} min Lower bound.
   * @param {number} max Upper bound.
   * @returns {number} The clamped value.
   */
  clamp(min, max) {
    if (this.value < min) {
      this.value = min;
      this.velocity = Math.max(0, this.velocity);
    } else if (this.value > max) {
      this.value = max;
      this.velocity = Math.min(0, this.velocity);
    }
    return this.value;
  }

  /**
   * Snap to the target once the remaining motion is invisible.
   * @param {number} target Settled value.
   * @param {number} [epsilon=1e-4] Largest offset and speed treated as settled.
   * @returns {number} The value.
   */
  settle(target, epsilon = 1e-4) {
    if (Math.abs(this.value - target) < epsilon && Math.abs(this.velocity) < epsilon * 10) {
      this.value = target;
      this.velocity = 0;
    }
    return this.value;
  }
}

/**
 * A 0-1 transition for whole poses (#49): the Blender poses and the thinking
 * pose. From rest it follows smootherstep (6p⁵ − 15p⁴ + 10p³) over `duration`
 * seconds, so it starts and lands with no speed and no jolt. Given a new
 * target midway, it plans a quintic from where it is at its current speed,
 * so it keeps moving a moment and curves round instead of snapping back.
 * Each segment is evaluated from elapsed time, so any frame rate gives the
 * same motion.
 */
export class PoseEase {
  /** @param {number} [duration=1] Seconds for a full 0 → 1 transition. */
  constructor(duration = 1) {
    this.duration = duration;
    this.value = 0;
    this.velocity = 0;
    this.target = 0;
    this.segment = null;
  }

  /** @returns {number} Seconds until the current transition lands; 0 at rest. */
  get timeLeft() {
    return this.segment ? this.segment.T - this.segment.t : 0;
  }

  /** @param {number} target 0 or 1 (or anything between). */
  setTarget(target) {
    if (target === this.target) return;
    this.target = target;
    const distance = Math.abs(target - this.value);
    const scale = Math.min(1, Math.max(0.35, distance + Math.abs(this.velocity) * this.duration / 4));
    const T = Math.max(1e-6, this.duration * scale);
    const V0 = this.velocity * T;
    const D = target - this.value - V0;
    const E = -V0;
    this.segment = { t: 0, T, p0: this.value, V0, c3: 10 * D - 4 * E, c4: 7 * E - 15 * D, c5: 6 * D - 3 * E };
  }

  /**
   * @param {number} delta Seconds elapsed; negative or broken values count as 0.
   * @returns {number} The new value.
   */
  update(delta) {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const segment = this.segment;
    if (!segment || dt === 0) return this.value;
    segment.t += dt;
    if (segment.t >= segment.T) {
      this.value = this.target;
      this.velocity = 0;
      this.segment = null;
      return this.value;
    }
    const s = segment.t / segment.T;
    const { p0, V0, c3, c4, c5, T } = segment;
    this.value = Math.min(1, Math.max(0, p0 + V0 * s + c3 * s ** 3 + c4 * s ** 4 + c5 * s ** 5));
    this.velocity = (V0 + 3 * c3 * s ** 2 + 4 * c4 * s ** 3 + 5 * c5 * s ** 4) / T;
    return this.value;
  }
}
