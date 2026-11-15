/**
 * Tentacle wave (#182): a slow wave travels along her four tails while she
 * idles, each tail out of step with the others. main.js adds it on top of the
 * pose physics gives the tails, after the physics step, and takes it off
 * before the next one, so physics still owns them.
 *
 * Pure module: no DOM or Three.js imports, so `node --test` covers it
 * (tests/renderer/tentacle-motion.test.mjs). See docs/physics.md#tentacle-wave-182.
 */

import { Spring } from "./smoothing.js";

/** Sizes in radians, times in seconds. */
export const TENTACLE_WAVE = Object.freeze({
  /** Wave size; a tail bends at most 1.5x this from root to tip. Picked from the #182 grids. */
  amplitude: 0.4,
  /** Each link bends at most amplitude / linkDivisor, scaled up toward the tip. */
  linkDivisor: 6,
  /** Seconds per wave. */
  period: 5,
  /** Phase lag per link, so the wave travels from the root to the tip. */
  travel: 0.35,
  /** Up-and-down share of the side-to-side bend, a quarter period ahead. */
  lift: 0.5,
  /** Seconds to ease in or out. */
  ease: 1.5,
  /** Wave size per idle state; any other state is still. */
  stateGain: Object.freeze({ active: 0, waking: 0, idle: 1, stretching: 1, sleepy: 0.5 }),
  /** A phase per tail, so no two wave in step. */
  phases: Object.freeze({ "左Tail1": 0, "右Tail1": 2.1, "左Tail2": 4.2, "右Tail2": 1.05 }),
});

/** localStorage key of the panel toggle. */
export const TENTACLE_WAVE_KEY = "yidhari.tentacles";

const TAIL_LINK = /^([左右]Tail\d)_(\d+)$/;
/** A critically damped spring settles to within 1 % in about 6.6 / rate seconds. */
const SPRING_RATE = 6.6 / TENTACLE_WAVE.ease;

/**
 * Find her tail chains in the rig.
 * @param {string[]} boneNames Every bone name, in rig order.
 * @returns {{name: string, phase: number, links: {index: number, k: number}[]}[]}
 *   One entry per tail, its links sorted from the root (k = 1) to the tip.
 */
export function tailChains(boneNames) {
  const chains = new Map();
  boneNames.forEach((name, index) => {
    const match = TAIL_LINK.exec(name);
    if (!match) return;
    if (!chains.has(match[1])) chains.set(match[1], []);
    chains.get(match[1]).push({ index, k: Number(match[2]) });
  });
  const fallback = Object.keys(TENTACLE_WAVE.phases).length;
  return [...chains].map(([name, links], i) => ({
    name,
    phase: TENTACLE_WAVE.phases[name] ?? (2 * Math.PI * (i + 0.5)) / (fallback + 1),
    links: links.sort((a, b) => a.k - b.k),
  }));
}

/**
 * The bend of one link at a moment of the wave, before easing.
 * @param {number} t Wave time in seconds.
 * @param {number} phase The tail's phase.
 * @param {number} k Link number, 1 at the root.
 * @param {number} count Links in the tail.
 * @param {number} amplitude Wave size.
 * @returns {{yaw: number, pitch: number}} Radians: side to side, up and down.
 */
export function waveAngles(t, phase, k, count, amplitude) {
  if (amplitude === 0) return { yaw: 0, pitch: 0 };
  const { linkDivisor, period, travel, lift } = TENTACLE_WAVE;
  const size = (amplitude / linkDivisor) * (k / count);
  const angle = (2 * Math.PI * t) / period + phase - k * travel;
  return { yaw: size * Math.sin(angle), pitch: size * lift * Math.sin(angle + Math.PI / 2) };
}

export class TentacleWave {
  /** @param {{enabled?: boolean, amplitude?: number}} [options] */
  constructor({ enabled = true, amplitude = TENTACLE_WAVE.amplitude } = {}) {
    this.enabled = Boolean(enabled);
    this.amplitude = amplitude;
    /** Wave time in seconds. */
    this.time = 0;
    this._spring = new Spring(0);
  }

  /** @returns {number} The eased wave size, 0 to 1. */
  get gain() {
    return this._spring.value;
  }

  /** @param {boolean} on The panel toggle; off eases the tails back to rest. */
  setEnabled(on) {
    this.enabled = Boolean(on);
  }

  /**
   * Advance the wave and ease its size toward the idle state's.
   * @param {number} delta Seconds since the previous frame; invalid values change nothing.
   * @param {string} state Idle state from IdleController.
   * @returns {number} The eased gain.
   */
  update(delta, state) {
    if (!(Number.isFinite(delta) && delta > 0)) return this.gain;
    const target = this.enabled ? (TENTACLE_WAVE.stateGain[state] ?? 0) : 0;
    if (target === 0 && this.gain === 0) return 0;
    this.time += delta;
    this._spring.step(target, delta, SPRING_RATE);
    this._spring.clamp(0, 1);
    // Settle exactly, so a still tail is truly still.
    if (Math.abs(this._spring.value - target) < 1e-4 && Math.abs(this._spring.velocity) < 1e-3) {
      this._spring.value = target;
      this._spring.velocity = 0;
    }
    return this.gain;
  }

  /**
   * This frame's bend of one link.
   * @param {number} phase The tail's phase.
   * @param {number} k Link number, 1 at the root.
   * @param {number} count Links in the tail.
   * @returns {{yaw: number, pitch: number}} Radians.
   */
  angles(phase, k, count) {
    if (this.gain === 0) return { yaw: 0, pitch: 0 };
    const { yaw, pitch } = waveAngles(this.time, phase, k, count, this.amplitude);
    return { yaw: yaw * this.gain, pitch: pitch * this.gain };
  }
}
