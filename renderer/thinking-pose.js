import { Spring, TIMING } from "./smoothing.js";

/** Pure timing and angle rules for the optional thinking gesture. */
export const THINKING_POSE = Object.freeze({
  easeRate: TIMING.thinkingPose,
  eyePitch: -0.18,
  /** Share of the usual head/neck gaze range kept while the chin rests on the hand. */
  headGaze: 0.35,
});

/**
 * Head/neck gaze scale for a pose weight. The hand is solved against the
 * resting head, so turning the head fully would lift the chin off the hand.
 * @param {number} weight Thinking pose weight from 0 to 1.
 * @returns {number} Multiplier for head and neck gaze angles.
 */
export function headGazeScale(weight) {
  const amount = Math.min(1, Math.max(0, Number.isFinite(weight) ? weight : 0));
  return 1 - amount * (1 - THINKING_POSE.headGaze);
}

/** Smoothly enter/leave the gesture without retaining stale mood state. */
export class ThinkingPose {
  constructor() {
    this.active = false;
    this.spring = new Spring(0);
  }

  /** @returns {number} Displayed pose weight from 0 to 1. */
  get weight() {
    return this.spring.value;
  }

  setActive(active) {
    this.active = Boolean(active);
  }

  update(delta) {
    const target = this.active ? 1 : 0;
    this.spring.step(target, delta, THINKING_POSE.easeRate);
    this.spring.clamp(0, 1);
    if (!this.active) this.spring.settle(0, 1e-3);
    return this.spring.value;
  }
}
