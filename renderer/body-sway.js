// Pure sway math for issue #4: animation-clock time -> small bone angles.
// No DOM or Three.js imports, so node --test can cover it (see
// tests/renderer/body-sway.test.mjs). Browser wiring lives in main.js,
// which caches each bone's base quaternion and multiplies this delta on top.

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
