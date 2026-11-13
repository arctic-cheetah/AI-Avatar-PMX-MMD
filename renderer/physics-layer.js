/**
 * Physics lifecycle (#114): build on demand, warm up, run each frame, rebuild
 * on group changes, and put bones back at rest when switched off.
 * Pure module: the MMDPhysics build and the bone restore are injected, so
 * `node --test` covers it. See docs/physics.md.
 */

import { PHYSICS_GROUPS, defaultPhysicsGroups } from "./physics-groups.js";

/**
 * Warm-up steps of 1/60 s before the first simulated frame (2 s): the tails
 * start straight out behind her in the bind pose and must settle first.
 */
export const PHYSICS_WARMUP_CYCLES = 120;

const GROUP_IDS = new Set(PHYSICS_GROUPS.map((group) => group.id));

/** Physics steps per second: the PMX default, up to two per 60 fps frame. */
export const PHYSICS_RATE_MIN = 65;
export const PHYSICS_RATE_MAX = 120;
export const PHYSICS_RATE_DEFAULT = 120;

/**
 * MMDPhysics step settings for a rate. maxStepNum keeps the catch-up of the
 * PMX default (3 steps of 1/65 s, about 46 ms) at any rate.
 * @param {unknown} rate Steps per second; clamped, nonsense falls back to the default.
 * @returns {{rate: number, unitStep: number, maxStepNum: number}}
 */
export function physicsStep(rate) {
  let hz = Number(rate);
  if (rate === undefined || rate === null || rate === "" || !Number.isFinite(hz)) hz = PHYSICS_RATE_DEFAULT;
  hz = Math.min(PHYSICS_RATE_MAX, Math.max(PHYSICS_RATE_MIN, Math.round(hz)));
  return { rate: hz, unitStep: 1 / hz, maxStepNum: Math.ceil((hz * 3) / PHYSICS_RATE_MIN) };
}

/**
 * @typedef {{update(delta: number): void, reset(): void, warmup(cycles: number): void, dispose(): void,
 *   setStep?: (step: {unitStep: number, maxStepNum: number}) => void}} PhysicsRun
 */

export class PhysicsLayer {
  /**
   * @param {{build: (groups: Set<string>) => Promise<PhysicsRun>, restoreBones: () => void,
   *   warmupCycles?: number}} options
   */
  constructor({ build, restoreBones, warmupCycles = PHYSICS_WARMUP_CYCLES }) {
    this._build = build;
    this._restoreBones = restoreBones;
    this._warmupCycles = warmupCycles;
    this._groups = defaultPhysicsGroups();
    this._enabled = false;
    /** @type {PhysicsRun | null} */
    this._run = null;
    this._generation = 0;
    this._loading = false;
    this._step = physicsStep(PHYSICS_RATE_DEFAULT);
    this.status = "off";
    this.error = null;
    /** @type {(status: string) => void} */
    this.onStatus = () => {};
  }

  /** @returns {Set<string>} A copy of the enabled group ids. */
  get groups() {
    return new Set(this._groups);
  }

  /** @returns {number} Physics steps per second. */
  get stepRate() {
    return this._step.rate;
  }

  /**
   * Set the physics step rate. A running build takes it at once; new builds
   * take it before their warm-up.
   * @param {unknown} rate Steps per second, 65 to 120.
   * @returns {void}
   */
  setStepRate(rate) {
    this._step = physicsStep(rate);
    this._run?.setStep?.(this._step);
  }

  /** @returns {boolean} Whether physics is switched on. */
  get enabled() {
    return this._enabled;
  }

  /**
   * @param {boolean} on
   * @returns {Promise<void>} Settles once any build this starts is done.
   */
  async setEnabled(on) {
    on = Boolean(on);
    if (on === this._enabled && !(on && this.status === "error")) return;
    this._enabled = on;
    if (!on) {
      if (this._run) this._restoreBones();
      this._setStatus("off");
      return;
    }
    if (this._run) {
      this._start(this._run);
      return;
    }
    if (this._loading) {
      this._setStatus("loading");
      return;
    }
    await this._rebuild();
  }

  /**
   * @param {string} id Group id from PHYSICS_GROUPS.
   * @param {boolean} on
   * @returns {Promise<void>}
   */
  async setGroup(id, on) {
    if (!GROUP_IDS.has(id)) throw new RangeError(`Unknown physics group: ${id}`);
    if (this._groups.has(id) === Boolean(on)) return;
    if (on) this._groups.add(id);
    else this._groups.delete(id);
    if (this._run) {
      if (this._enabled) this._restoreBones();
      this._run.dispose();
      this._run = null;
    }
    // Overlapping builds are discarded when they finish.
    this._generation += 1;
    this._loading = false;
    if (this._enabled) await this._rebuild();
  }

  /**
   * Step the simulation by this frame's delta. MMDPhysics keeps its own fixed
   * step, so delta goes straight through.
   * @param {number} delta Seconds since the previous frame.
   * @returns {void}
   */
  update(delta) {
    if (this._enabled && this.status === "on") this._run.update(delta);
  }

  /** @returns {Promise<void>} */
  async _rebuild() {
    const generation = ++this._generation;
    this._loading = true;
    this.error = null;
    this._setStatus("loading");
    let run;
    try {
      run = await this._build(this.groups);
    } catch (error) {
      if (generation !== this._generation) return;
      this._loading = false;
      this.error = error;
      this._setStatus("error");
      return;
    }
    if (generation !== this._generation) {
      run.dispose();
      return;
    }
    this._loading = false;
    this._run = run;
    if (this._enabled) this._start(run);
    else this._setStatus("off");
  }

  /** @param {PhysicsRun} run */
  _start(run) {
    run.setStep?.(this._step);
    run.reset();
    run.warmup(this._warmupCycles);
    this._setStatus("on");
  }

  /** @param {string} status */
  _setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }
}
