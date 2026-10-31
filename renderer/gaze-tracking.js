// Pure gaze logic for issue #6: pointer/face targets -> eye & head angles.
// No DOM or Three.js imports, so node --test can cover it (see
// tests/renderer/gaze-tracking.test.mjs). Browser wiring lives in main.js
// and camera-gaze.js.

export const LIMITS = Object.freeze({
  eyeYaw: 0.38,
  eyePitch: 0.22,
  eyePitchUp: 0.12,
  headScale: 0.45,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Limit the final eye pitch after mood offsets, without restricting the head. */
export function clampEyePitch(pitch, offset = 0) {
  return clamp(pitch + offset, -LIMITS.eyePitchUp, LIMITS.eyePitch);
}

/**
 * Clamp a normalised gaze target to the -1..1 square.
 * @param {{x:number,y:number}|null|undefined} target Normalised target.
 * @returns {{x:number,y:number}} Clamped target; null becomes centre.
 */
export function clampTarget(target) {
  if (!target) return { x: 0, y: 0 };
  return { x: clamp(Number(target.x) || 0, -1, 1), y: clamp(Number(target.y) || 0, -1, 1) };
}

/**
 * Convert a pointer position in an element to a normalised gaze target.
 * Screen y grows downwards, so top of the element is y=-1 (look up).
 * @param {number} clientX Pointer x, same origin as the element rect.
 * @param {number} clientY Pointer y, same origin as the element rect.
 * @param {number} width Element width in px.
 * @param {number} height Element height in px.
 * @returns {{x:number,y:number}} Normalised target in -1..1.
 */
export function normalisePointer(clientX, clientY, width, height) {
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0 };
  return clampTarget({ x: (clientX / width) * 2 - 1, y: (clientY / height) * 2 - 1 });
}

/**
 * Map a normalised target to bone angles in radians.
 * Eyes travel to the limits; head/neck follow at LIMITS.headScale.
 * @param {{x:number,y:number}} target Normalised target.
 * @returns {{eyeYaw:number,eyePitch:number,headYaw:number,headPitch:number}}
 */
export function targetToAngles(target) {
  const { x, y } = clampTarget(target);
  const eyeYaw = x * LIMITS.eyeYaw;
  const pitch = y * LIMITS.eyePitch;
  return { eyeYaw, eyePitch: clampEyePitch(pitch), headYaw: eyeYaw * LIMITS.headScale,
    headPitch: pitch * LIMITS.headScale };
}

export class GazeController {
  /**
   * @param {{rate?:number,cameraTimeout?:number}} [options]
   *   rate: exponential smoothing rate (per second).
   *   cameraTimeout: ms after which a camera target is stale.
   */
  constructor({ rate = 10, cameraTimeout = 500 } = {}) {
    this.rate = rate;
    this.cameraTimeout = cameraTimeout;
    this.cursor = { enabled: false, target: { x: 0, y: 0 } };
    this.camera = { enabled: false, target: { x: 0, y: 0 }, at: -Infinity };
    this.current = { x: 0, y: 0 };
  }

  /**
   * @param {{x:number,y:number}|null} target Normalised cursor target.
   * @param {boolean} enabled Whether cursor tracking is toggled on.
   * @returns {void}
   */
  setCursor(target, enabled) {
    this.cursor = { enabled: Boolean(enabled), target: clampTarget(target) };
  }

  /**
   * @param {{x:number,y:number}|null} target Normalised face target.
   * @param {boolean} enabled Whether camera tracking is toggled on.
   * @param {number} [now] Timestamp in ms, for staleness checks.
   * @returns {void}
   */
  setCamera(target, enabled, now = performance.now()) {
    this.camera = { enabled: Boolean(enabled), target: clampTarget(target), at: now };
  }

  /**
   * Pick the active target: fresh camera beats cursor; none means centre.
   * @param {number} now Timestamp in ms.
   * @returns {{x:number,y:number}} Active normalised target.
   */
  #activeTarget(now) {
    if (this.camera.enabled && now - this.camera.at <= this.cameraTimeout) return this.camera.target;
    if (this.cursor.enabled) return this.cursor.target;
    return { x: 0, y: 0 };
  }

  /**
   * Ease the gaze toward the active target and return bone angles.
   * @param {number} delta Seconds since the previous frame.
   * @param {number} [now] Timestamp in ms.
   * @returns {{eyeYaw:number,eyePitch:number,headYaw:number,headPitch:number}}
   */
  update(delta, now = performance.now()) {
    const target = this.#activeTarget(now);
    const blend = 1 - Math.exp(-this.rate * Math.max(0, delta));
    this.current.x += (target.x - this.current.x) * blend;
    this.current.y += (target.y - this.current.y) * blend;
    if (Math.abs(this.current.x) < 1e-4 && target.x === 0) this.current.x = 0;
    if (Math.abs(this.current.y) < 1e-4 && target.y === 0) this.current.y = 0;
    return targetToAngles(this.current);
  }
}
