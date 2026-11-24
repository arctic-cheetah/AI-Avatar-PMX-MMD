import { PoseEase, TIMING } from "./smoothing.js";
import { thinkingFidgetAngles } from "./thinking-fidget.js";

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

/**
 * Smoothly enter/leave the gesture without retaining stale mood state. It
 * uses the shared pose ease (#49): smootherstep from rest over `easeSeconds`,
 * and a smooth turn when interrupted.
 */
export class ThinkingPose {
  constructor() {
    this.active = false;
    this.ease = new PoseEase(1);
    /** Seconds the pose has had weight, for the fidget (#218); 0 once fully released. */
    this.clock = 0;
  }

  /** @returns {number} Seconds for a full ease in or out. */
  get easeSeconds() {
    return this.ease.duration;
  }

  /** @param {number} seconds Used from the next transition. */
  set easeSeconds(seconds) {
    this.ease.duration = seconds;
  }

  /** @returns {number} Displayed pose weight from 0 to 1. */
  get weight() {
    return this.ease.value;
  }

  setActive(active) {
    this.active = Boolean(active);
  }

  update(delta) {
    this.ease.setTarget(this.active ? 1 : 0);
    this.ease.update(delta);
    this.clock = this.ease.value > 0 ? this.clock + Math.max(0, Number(delta) || 0) : 0;
    return this.ease.value;
  }

  /**
   * The finger and fist fidget for this frame, eased by the pose weight (#218).
   * @param {Partial<import("./thinking-fidget.js").THINKING_FIDGET>} [sizes] Overrides for previews.
   * @returns {Record<string, number>} Radians per hand drift channel.
   */
  fidget(sizes) {
    return thinkingFidgetAngles(this.clock, this.weight, sizes);
  }
}
