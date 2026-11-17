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
  /** The size slider's range, extended from 0–2 to 0–6 for bigger waves (docs/physics.md#wave-size-slider). */
  sizeRange: Object.freeze({ min: 0, max: 6, step: 0.05 }),
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
  /** Wave size while she speaks: a gentle sway, even though speech blocks idle. */
  speakingGain: 0.35,
  /** Wave size per idle state; any other state is still. */
  stateGain: Object.freeze({ active: 0, waking: 0, idle: 1, stretching: 1, sleepy: 0.5 }),
  /** A phase per tail, so no two wave in step. */
  phases: Object.freeze({ "左Tail1": 0, "右Tail1": 2.1, "左Tail2": 4.2, "右Tail2": 1.05 }),
});

/**
 * Mood reactions, as a total arc along each tail in radians (positive lifts).
 * Perk and lift rise, hold and fall once when the mood arrives; droop holds
 * while the mood lasts.
 */
export const TENTACLE_REACTIONS = Object.freeze({
  perk: Object.freeze({ lift: 0.5, rise: 0.35, hold: 0.4, fall: 1.2,
    moods: Object.freeze(["surprised", "shocked", "gasp", "scared"]) }),
  lift: Object.freeze({ lift: 0.3, rise: 0.8, hold: 1.2, fall: 1.6,
    moods: Object.freeze(["happy", "joyful", "excited", "grin", "lovestruck"]) }),
  droop: Object.freeze({ lift: -0.35, moods: Object.freeze(["sleepy", "sad", "sorrowful", "disappointed", "cry"]) }),
});

const bumpLength = ({ rise, hold, fall }) => rise + hold + fall;

/** Tentacle actions for the Animation actions buttons (#164), lengths in seconds. */
export const TENTACLE_ACTIONS = Object.freeze({
  wave: Object.freeze({ label: "Tentacle wave", duration: 10 }),
  perk: Object.freeze({ label: "Tentacle perk", duration: bumpLength(TENTACLE_REACTIONS.perk) }),
  droop: Object.freeze({ label: "Tentacle droop", duration: 4 }),
  sway: Object.freeze({ label: "Tentacle sway", duration: 8 }),
});

/** localStorage key of the panel toggle. */
export const TENTACLE_WAVE_KEY = "yidhari.tentacles";
/** localStorage key of the size slider. */
export const TENTACLE_SIZE_KEY = "yidhari.tentacles.size";

/**
 * A wave size from the slider or storage: clamped, snapped to the step.
 * @param {unknown} value
 * @returns {number} The size; anything unreadable gives the default.
 */
export function tentacleSize(value) {
  const { min, max, step } = TENTACLE_WAVE.sizeRange;
  const size = value === null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(size)) return TENTACLE_WAVE.amplitude;
  const snapped = Math.round(Math.min(max, Math.max(min, size)) / step) * step;
  return Number(snapped.toFixed(2));
}

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

/** 0 → 1 with zero slope at both ends. */
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * A perk or lift's share at time t: rise, hold, fall.
 * @param {{rise: number, hold: number, fall: number}} shape
 * @param {number} t Seconds since it fired.
 * @returns {number} 0 to 1.
 */
function bumpAt({ rise, hold, fall }, t) {
  if (t < rise) return smooth(t / rise);
  if (t < rise + hold) return 1;
  return 1 - smooth((t - rise - hold) / fall);
}

/** Put a spring exactly at rest on its target. */
function settle(spring, target) {
  spring.value = target;
  spring.velocity = 0;
}

/** Settle a spring exactly once it is close, so a still tail is truly still. */
function settleNear(spring, target) {
  if (Math.abs(spring.value - target) < 1e-4 && Math.abs(spring.velocity) < 1e-3) settle(spring, target);
}

/**
 * Bind the Wave size slider: apply the stored size, then apply and store
 * each change. Storage can throw (private mode); the size then lasts for the session.
 * @param {TentacleWave} wave
 * @param {{value: string, addEventListener(type: string, fn: () => void): void} | null} input Range input.
 * @param {{local?: Storage, show?: (size: number) => void}} [options] Storage to use, and a
 *   callback that shows the size beside the slider.
 * @returns {void}
 */
export function bindTentacleSize(wave, input, { local, show = () => {} } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  let stored = null;
  try {
    stored = local?.getItem(TENTACLE_SIZE_KEY) ?? null;
  } catch { /* Blocked: the default. */ }
  const apply = (value) => {
    wave.setAmplitude(value);
    if (input) input.value = String(wave.amplitudeTarget);
    show(wave.amplitudeTarget);
  };
  apply(stored);
  if (!input) return;
  input.addEventListener("input", () => {
    apply(input.value);
    try {
      local?.setItem(TENTACLE_SIZE_KEY, String(wave.amplitudeTarget));
    } catch { /* Session-only. */ }
  });
}

export class TentacleWave {
  /** @param {{enabled?: boolean, amplitude?: number}} [options] */
  constructor({ enabled = true, amplitude = TENTACLE_WAVE.amplitude } = {}) {
    this.enabled = Boolean(enabled);
    this._size = new Spring(amplitude);
    this._sizeTarget = amplitude;
    /** Wave time in seconds. */
    this.time = 0;
    this._spring = new Spring(0);
    /** The held droop, and any reaction handed over when one is cut short. */
    this._lift = new Spring(0);
    /** A perk or lift in flight: {shape, t}. */
    this._bump = null;
    this._bumpLift = 0;
    this._mood = null;
    this._droopMood = false;
    /** A played tentacle action: {name, t}. */
    this._manual = null;
  }

  /** @returns {number} This frame's total arc along each tail, in radians (positive lifts). */
  get lift() {
    return this._bumpLift + this._lift.value;
  }

  /** @returns {string|null} The tentacle action playing from a button. */
  get playing() {
    return this._manual?.name ?? null;
  }

  /**
   * Tell the tails her mood. A change into a perk or lift mood fires it once;
   * a droop mood holds the droop until the mood changes.
   * @param {string} mood Expression name.
   * @returns {void}
   */
  setMood(mood) {
    if (mood === this._mood) return;
    this._mood = mood;
    this._droopMood = TENTACLE_REACTIONS.droop.moods.includes(mood);
    for (const name of ["perk", "lift"]) {
      if (TENTACLE_REACTIONS[name].moods.includes(mood) && this.enabled) this._fire(name);
    }
  }

  /**
   * Play a tentacle action from its button.
   * @param {string} name A TENTACLE_ACTIONS key.
   * @returns {void}
   */
  play(name) {
    if (!TENTACLE_ACTIONS[name]) throw new RangeError(`Unknown tentacle action: ${name}`);
    this.stop();
    this._manual = { name, t: 0 };
    if (name === "perk" && this.enabled) this._fire("perk");
  }

  /** Stop a played action; the tails ease back. */
  stop() {
    if (this._manual?.name === "perk") this._handOver();
    this._manual = null;
  }

  /**
   * The same button again stops its action; another switches to it.
   * @param {string} name A TENTACLE_ACTIONS key.
   * @returns {void}
   */
  toggle(name) {
    if (this.playing === name) this.stop();
    else this.play(name);
  }

  /** @param {"perk"|"lift"} name */
  _fire(name) {
    this._handOver();
    this._bump = { shape: TENTACLE_REACTIONS[name], t: 0 };
  }

  /** Cut a perk or lift short: its current arc eases back through the droop spring. */
  _handOver() {
    if (!this._bump) return;
    this._lift.value += this._bumpLift;
    this._bump = null;
    this._bumpLift = 0;
  }

  /** @returns {number} The eased wave size, 0 to 1. */
  get gain() {
    return this._spring.value;
  }

  /** @returns {number} The eased wave size. */
  get amplitude() {
    return this._size.value;
  }

  /** @returns {number} The size the slider asked for. */
  get amplitudeTarget() {
    return this._sizeTarget;
  }

  /**
   * Set the wave size from the slider. It eases in while the tails wave and
   * applies at once while they are still.
   * @param {unknown} size Clamped and snapped by tentacleSize().
   * @returns {void}
   */
  setAmplitude(size) {
    this._sizeTarget = tentacleSize(size);
    if (this.gain === 0) settle(this._size, this._sizeTarget);
  }

  /** @param {boolean} on The panel toggle; off eases the tails back to rest. */
  setEnabled(on) {
    this.enabled = Boolean(on);
  }

  /**
   * Advance the wave and reactions, easing toward the idle state's wave size.
   * @param {number} delta Seconds since the previous frame; invalid values change nothing.
   * @param {string} state Idle state from IdleController.
   * @param {{speaking?: boolean, composed?: boolean}} [options] She is speaking (a gentle
   *   sway), or idle is blocked by anything else (everything eases out).
   * @returns {number} The eased gain.
   */
  update(delta, state, { speaking = false, composed = false } = {}) {
    if (!(Number.isFinite(delta) && delta > 0)) return this.gain;
    const still = composed || !this.enabled;
    if (this._manual) {
      this._manual.t += delta;
      if (this._manual.t >= TENTACLE_ACTIONS[this._manual.name].duration) this._manual = null;
    }
    if (still) this._handOver();
    if (this._bump) {
      this._bump.t += delta;
      if (this._bump.t >= bumpLength(this._bump.shape)) {
        this._bump = null;
        this._bumpLift = 0;
      } else {
        this._bumpLift = this._bump.shape.lift * bumpAt(this._bump.shape, this._bump.t);
      }
    }
    const droop = !still && (this._droopMood || this.playing === "droop");
    const liftTarget = droop ? TENTACLE_REACTIONS.droop.lift : 0;
    this._lift.step(liftTarget, delta, SPRING_RATE);
    settleNear(this._lift, liftTarget);
    const manualGain = { wave: 1, sway: TENTACLE_WAVE.speakingGain }[this.playing] ?? 0;
    const target = still ? 0 : Math.max(TENTACLE_WAVE.stateGain[state] ?? 0, speaking ? TENTACLE_WAVE.speakingGain : 0, manualGain);
    if (target === 0 && this.gain === 0) {
      settle(this._size, this._sizeTarget);
      return 0;
    }
    this.time += delta;
    this._spring.step(target, delta, SPRING_RATE);
    this._spring.clamp(0, 1);
    settleNear(this._spring, target);
    const { min, max } = TENTACLE_WAVE.sizeRange;
    this._size.step(this._sizeTarget, delta, SPRING_RATE);
    this._size.clamp(min, max);
    settleNear(this._size, this._sizeTarget);
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
    // Reactions follow the slider up to the default size, and stop at 0.
    const scale = Math.min(1, this.amplitude / TENTACLE_WAVE.amplitude);
    const lift = (this.lift * scale) / count;
    if (this.gain === 0) return { yaw: 0, pitch: lift };
    const { yaw, pitch } = waveAngles(this.time, phase, k, count, this.amplitude);
    return { yaw: yaw * this.gain, pitch: pitch * this.gain + lift };
  }
}
