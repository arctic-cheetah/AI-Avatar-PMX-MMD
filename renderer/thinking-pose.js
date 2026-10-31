/** Pure timing and angle rules for the optional thinking gesture. */
export const THINKING_POSE = Object.freeze({
  easeRate: 8,
  eyePitch: -0.18,
});

/** Smoothly enter/leave the gesture without retaining stale mood state. */
export class ThinkingPose {
  constructor() {
    this.active = false;
    this.weight = 0;
  }

  setActive(active) {
    this.active = Boolean(active);
  }

  update(delta) {
    const blend = 1 - Math.exp(-THINKING_POSE.easeRate * Math.max(0, delta));
    this.weight += ((this.active ? 1 : 0) - this.weight) * blend;
    if (!this.active && this.weight < 0.001) this.weight = 0;
    return this.weight;
  }
}
