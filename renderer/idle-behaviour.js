// Idle-state timer for issue #71: active -> idle -> stretching -> sleepy -> waking -> active.
// No DOM or Three.js imports, so node --test covers it
// (tests/renderer/idle-behaviour.test.mjs). main.js feeds it activity and
// blocking each frame and applies the actions it returns; the expression
// springs from #54 ease every mood change. See docs/idle-behaviours.md.

import { bindStoredToggle } from "./stored-toggle.js";

export const IDLE_ENABLED_KEY = "yidhari.idle-enabled";
export const IDLE_TIMING_KEY = "yidhari.idle-timing";

/** Default timings in seconds. Only idleAfter and sleepAfter are configurable. */
export const IDLE_TIMING = Object.freeze({
  /** Quiet time before she is idle. */
  idleAfter: 60,
  /** Quiet time, from the last activity, before she turns sleepy. */
  sleepAfter: 600,
  /** Wake-up beats: surprised, then happy, then her resting mood. */
  wakeSurprised: 0.6,
  wakeHappy: 1.6,
  /** The stretch fills the last seconds before sleepy, so sleepy starts on time. */
  stretch: 3.2,
  /** While sleepy, stretch and yawn again this often; 0 keeps only the first. */
  stretchEvery: 120,
});

const LIMITS = Object.freeze({
  idleAfter: [5, 3600],
  sleepAfter: [5, 86400],
  stretchEvery: [10, 3600],
});

/** Moods the idle controller asks for; every name exists in expressions.json. */
export const IDLE_MOODS = Object.freeze({
  sleepy: Object.freeze({ name: "sleepy", weight: 0.8 }),
  surprised: Object.freeze({ name: "surprised", weight: 0.6 }),
  happy: Object.freeze({ name: "happy", weight: 0.8 }),
});

/** Blink scaling while sleepy: blinks twice as far apart, 2.5x slower ramps. */
export const SLEEPY_BLINK = Object.freeze({ interval: 2, duration: 2.5 });
const AWAKE_BLINK = Object.freeze({ interval: 1, duration: 1 });

/** Short labels for the panel's status line. */
export const IDLE_STATE_LABELS = Object.freeze({
  active: "Active",
  idle: "Idle",
  stretching: "Stretching",
  sleepy: "Sleepy 💤",
  waking: "Waking up",
});

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));
const finiteOr = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** 0 or less turns the sleepy repeat off; anything else is clamped. */
const repeatEvery = (seconds) => (seconds <= 0 ? 0 : clamp(seconds, LIMITS.stretchEvery));

/**
 * Fill in and clamp idle timings. Unreadable values fall back to the
 * defaults, and sleepy never starts before idle.
 * @param {unknown} raw Partial timings in seconds.
 * @returns {{idleAfter:number,sleepAfter:number,wakeSurprised:number,wakeHappy:number,stretch:number,stretchEvery:number}}
 */
export function normaliseIdleTiming(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const idleAfter = clamp(finiteOr(source.idleAfter, IDLE_TIMING.idleAfter), LIMITS.idleAfter);
  const sleepAfter = Math.max(
    clamp(finiteOr(source.sleepAfter, IDLE_TIMING.sleepAfter), LIMITS.sleepAfter),
    idleAfter,
  );
  return {
    idleAfter,
    sleepAfter,
    wakeSurprised: IDLE_TIMING.wakeSurprised,
    wakeHappy: IDLE_TIMING.wakeHappy,
    stretch: IDLE_TIMING.stretch,
    stretchEvery: repeatEvery(finiteOr(source.stretchEvery, IDLE_TIMING.stretchEvery)),
  };
}

/**
 * Time since the last interaction, as a small state machine.
 * update() returns actions for main.js to apply:
 * `{ type: "mood", name, weight }` or `{ type: "rest" }` (back to her resting mood).
 */
export class IdleController {
  /** @param {{ timing?: object, enabled?: boolean }} [options] */
  constructor({ timing, enabled = true } = {}) {
    this.timing = normaliseIdleTiming(timing);
    this.enabled = enabled !== false;
    this.blocked = false;
    /** @type {"active"|"idle"|"stretching"|"sleepy"|"waking"} */
    this.state = "active";
    /** Seconds since the current state began; drives the idle motions. */
    this.stateTime = 0;
    this.elapsed = 0;
    this.wakeTime = 0;
    this.wakeStep = null;
    this.pendingActivity = false;
  }

  /** Something happened: pointer, keys, chat, voice or the bridge. */
  activity() {
    this.pendingActivity = true;
  }

  /** @param {boolean} blocked Speech, thinking, an open ask or a streaming reply. */
  setBlocked(blocked) {
    this.blocked = Boolean(blocked);
  }

  /** @param {boolean} enabled The panel's on/off switch. */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  /** @param {object} timing Partial timings in seconds; normalised. */
  setTiming(timing) {
    this.timing = normaliseIdleTiming({ ...this.timing, ...timing });
  }

  /** @returns {{interval:number,duration:number}} Multipliers for the idle blink. */
  get blinkScale() {
    return this.state === "sleepy" ? SLEEPY_BLINK : AWAKE_BLINK;
  }

  /** Whether her face currently shows a mood this controller set. */
  get faceChanged() {
    return this.state === "sleepy" || this.state === "waking";
  }

  /**
   * Advance the timer by real elapsed time.
   * @param {number} delta Seconds since the previous frame; invalid values count as 0.
   * @returns {Array<{type:"mood",name:string,weight:number}|{type:"rest"}>}
   */
  update(delta) {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const actions = [];
    if (!this.enabled || this.blocked) {
      if (this.faceChanged) actions.push({ type: "rest" });
      this.#toActive();
      this.pendingActivity = false;
      return actions;
    }
    this.stateTime += dt;
    if (this.pendingActivity) {
      this.pendingActivity = false;
      if (this.state === "sleepy") {
        this.#enter("waking");
        this.wakeTime = 0;
        this.wakeStep = "surprised";
        actions.push({ type: "mood", ...IDLE_MOODS.surprised });
        return actions;
      }
      if (this.state !== "waking") this.#toActive();
    }
    if (this.state === "waking") {
      this.wakeTime += dt;
      const { wakeSurprised, wakeHappy } = this.timing;
      if (this.wakeStep === "surprised" && this.wakeTime >= wakeSurprised) {
        this.wakeStep = "happy";
        actions.push({ type: "mood", ...IDLE_MOODS.happy });
      }
      if (this.wakeStep === "happy" && this.wakeTime >= wakeSurprised + wakeHappy) {
        actions.push({ type: "rest" });
        this.#toActive();
      }
      return actions;
    }
    this.elapsed += dt;
    const { idleAfter, sleepAfter, stretch } = this.timing;
    const stretchAt = Math.max(idleAfter, sleepAfter - stretch);
    if (this.state === "active" && this.elapsed >= idleAfter) this.#enter("idle");
    if (this.state === "idle" && this.elapsed >= stretchAt && this.elapsed < sleepAfter) {
      this.#enter("stretching");
    }
    if ((this.state === "idle" || this.state === "stretching") && this.elapsed >= sleepAfter) {
      this.#enter("sleepy");
      actions.push({ type: "mood", ...IDLE_MOODS.sleepy });
    }
    return actions;
  }

  #enter(state) {
    this.state = state;
    this.stateTime = 0;
  }

  #toActive() {
    this.#enter("active");
    this.elapsed = 0;
    this.wakeTime = 0;
    this.wakeStep = null;
  }
}

/**
 * Bind the panel's idle controls: the on/off checkbox, Idle after (seconds)
 * and Sleepy after (minutes). Timings are saved in seconds when storage allows.
 * @param {IdleController} idle
 * @param {{ toggle?: object|null, idleAfterInput?: object|null, sleepAfterInput?: object|null, stretchEveryInput?: object|null, local?: Storage }} controls
 * @returns {void}
 */
export function bindIdleSettings(idle, { toggle, idleAfterInput, sleepAfterInput, stretchEveryInput, local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  bindStoredToggle(toggle, IDLE_ENABLED_KEY, (on) => idle.setEnabled(on), { local });

  let saved = {};
  try {
    saved = JSON.parse(local?.getItem(IDLE_TIMING_KEY) ?? "{}");
  } catch { /* Missing, blocked or corrupt: defaults. */ }
  idle.setTiming(saved);

  const show = () => {
    if (idleAfterInput) idleAfterInput.value = String(idle.timing.idleAfter);
    if (sleepAfterInput) sleepAfterInput.value = String(Number((idle.timing.sleepAfter / 60).toFixed(2)));
    if (stretchEveryInput) stretchEveryInput.value = String(Number((idle.timing.stretchEvery / 60).toFixed(2)));
  };
  const save = () => {
    const { idleAfter, sleepAfter, stretchEvery } = idle.timing;
    try {
      local?.setItem(IDLE_TIMING_KEY, JSON.stringify({ idleAfter, sleepAfter, stretchEvery }));
    } catch { /* Session-only. */ }
  };
  const onInput = (input, key, scale) => () => {
    const text = String(input.value ?? "").trim();
    const value = Number(text);
    if (text && Number.isFinite(value)) {
      idle.setTiming({ [key]: value * scale });
      save();
    }
    show();
  };
  idleAfterInput?.addEventListener("change", onInput(idleAfterInput, "idleAfter", 1));
  sleepAfterInput?.addEventListener("change", onInput(sleepAfterInput, "sleepAfter", 60));
  stretchEveryInput?.addEventListener("change", onInput(stretchEveryInput, "stretchEvery", 60));
  show();
}
