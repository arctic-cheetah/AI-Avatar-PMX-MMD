// Run with: node --test tests/renderer/*.test.mjs
// Idle-state timer for #71: active → idle → sleepy → waking → active.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_ENABLED_KEY,
  IDLE_MOODS,
  IDLE_TIMING,
  IDLE_TIMING_KEY,
  IdleController,
  SLEEPY_BLINK,
  bindIdleSettings,
  normaliseIdleTiming,
} from "../../renderer/idle-behaviour.js";

/** Advance the controller in fixed frames, collecting every action it emits. */
function run(idle, seconds, fps = 60) {
  const actions = [];
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i += 1) actions.push(...idle.update(1 / fps));
  return actions;
}

const moods = (actions) => actions.filter((a) => a.type === "mood").map((a) => a.name);
const rests = (actions) => actions.filter((a) => a.type === "rest").length;

test("defaults follow the ticket: about a minute to idle, ten to sleepy", () => {
  assert.equal(IDLE_TIMING.idleAfter, 60);
  assert.equal(IDLE_TIMING.sleepAfter, 600);
  for (const mood of Object.values(IDLE_MOODS)) {
    assert.ok(mood.weight > 0 && mood.weight <= 1, mood.name);
  }
  assert.equal(IDLE_MOODS.sleepy.name, "sleepy");
  assert.equal(IDLE_MOODS.surprised.name, "surprised");
  assert.equal(IDLE_MOODS.happy.name, "happy");
});

test("she stays active until the idle time passes, then idles without changing her face", () => {
  const idle = new IdleController();
  assert.equal(idle.state, "active");
  assert.deepEqual(run(idle, 59), []);
  assert.equal(idle.state, "active");
  const actions = run(idle, 2);
  assert.equal(idle.state, "idle");
  assert.deepEqual(actions, [], "short idle leaves the mood alone");
});

test("after the sleep time she turns sleepy once", () => {
  const idle = new IdleController();
  const actions = run(idle, 601);
  assert.equal(idle.state, "sleepy");
  assert.deepEqual(actions, [{ type: "mood", ...IDLE_MOODS.sleepy }]);
  assert.deepEqual(run(idle, 60), [], "sleepy is not re-applied every frame");
});

test("activity while sleepy wakes her: surprised, then happy, then her resting mood", () => {
  const idle = new IdleController();
  run(idle, 601);
  idle.activity();
  const first = idle.update(1 / 60);
  assert.equal(idle.state, "waking");
  assert.deepEqual(first, [{ type: "mood", ...IDLE_MOODS.surprised }]);
  const rest = run(idle, IDLE_TIMING.wakeSurprised + IDLE_TIMING.wakeHappy + 0.1);
  assert.deepEqual(moods(rest), ["happy"]);
  assert.equal(rests(rest), 1);
  assert.equal(idle.state, "active");
});

test("waking is timed: happy follows the surprised beat, rest follows happy", () => {
  const idle = new IdleController();
  run(idle, 601);
  idle.activity();
  idle.update(0);
  assert.deepEqual(run(idle, IDLE_TIMING.wakeSurprised - 0.05), []);
  assert.deepEqual(moods(run(idle, 0.1)), ["happy"]);
  assert.deepEqual(run(idle, IDLE_TIMING.wakeHappy - 0.1), []);
  assert.equal(rests(run(idle, 0.1)), 1);
});

test("activity during a short idle returns to active without a startle", () => {
  const idle = new IdleController();
  run(idle, 61);
  idle.activity();
  assert.deepEqual(idle.update(1 / 60), []);
  assert.equal(idle.state, "active");
});

test("activity restarts the timer", () => {
  const idle = new IdleController();
  run(idle, 50);
  idle.activity();
  run(idle, 50);
  assert.equal(idle.state, "active", "only 50 s since the last activity");
  run(idle, 11);
  assert.equal(idle.state, "idle");
});

test("activity during waking does not restart the wake-up", () => {
  const idle = new IdleController();
  run(idle, 601);
  idle.activity();
  idle.update(0);
  idle.activity();
  const actions = run(idle, 3);
  assert.deepEqual(moods(actions), ["happy"], "no second surprised");
  assert.equal(rests(actions), 1);
});

test("speech, thinking or an open ask freezes the timer while blocked", () => {
  const idle = new IdleController();
  run(idle, 40);
  idle.setBlocked(true);
  assert.deepEqual(run(idle, 2000, 10), []);
  assert.equal(idle.state, "active");
  idle.setBlocked(false);
  run(idle, 59);
  assert.equal(idle.state, "active", "the timer starts again from zero");
  run(idle, 2);
  assert.equal(idle.state, "idle");
});

test("blocking a sleepy face hands it back to rest at once", () => {
  const idle = new IdleController();
  run(idle, 601);
  idle.setBlocked(true);
  const actions = idle.update(1 / 60);
  assert.deepEqual(actions, [{ type: "rest" }]);
  assert.equal(idle.state, "active");
});

test("blocking during waking stops the wake-up before happy", () => {
  const idle = new IdleController();
  run(idle, 601);
  idle.activity();
  idle.update(0);
  idle.setBlocked(true);
  const actions = run(idle, 3);
  assert.deepEqual(moods(actions), [], "speech owns the face now");
  assert.equal(rests(actions), 1);
  assert.equal(idle.state, "active");
});

test("blocking a short idle needs no rest: the face was never changed", () => {
  const idle = new IdleController();
  run(idle, 61);
  idle.setBlocked(true);
  assert.deepEqual(idle.update(1 / 60), []);
  assert.equal(idle.state, "active");
});

test("switched off, she never idles; switching off while sleepy rests her", () => {
  const off = new IdleController({ enabled: false });
  assert.deepEqual(run(off, 2000, 10), []);
  assert.equal(off.state, "active");

  const idle = new IdleController();
  run(idle, 601);
  idle.setEnabled(false);
  assert.deepEqual(idle.update(1 / 60), [{ type: "rest" }]);
  assert.equal(idle.state, "active");
  idle.setEnabled(true);
  run(idle, 59);
  assert.equal(idle.state, "active", "re-enabling starts the timer from zero");
});

test("custom timings change when she idles and sleeps", () => {
  const idle = new IdleController({ timing: { idleAfter: 5, sleepAfter: 10 } });
  run(idle, 5.1);
  assert.equal(idle.state, "idle");
  assert.deepEqual(moods(run(idle, 5)), ["sleepy"]);
  idle.setTiming({ idleAfter: 20, sleepAfter: 40 });
  assert.equal(idle.timing.idleAfter, 20);
  assert.equal(idle.timing.sleepAfter, 40);
});

test("a long hidden-tab gap lands in sleepy with one action", () => {
  const idle = new IdleController();
  assert.deepEqual(idle.update(20 * 60), [{ type: "mood", ...IDLE_MOODS.sleepy }]);
  assert.equal(idle.state, "sleepy");
});

test("the timer is frame-rate independent", () => {
  for (const fps of [15, 30, 60, 144]) {
    const idle = new IdleController({ timing: { idleAfter: 5, sleepAfter: 10 } });
    run(idle, 4.9, fps);
    assert.equal(idle.state, "active", `${fps} fps`);
    run(idle, 5.2, fps);
    assert.equal(idle.state, "sleepy", `${fps} fps`);
  }
});

test("invalid deltas never move the timer", () => {
  const idle = new IdleController({ timing: { idleAfter: 5, sleepAfter: 10 } });
  for (const delta of [Number.NaN, -10, Number.POSITIVE_INFINITY]) idle.update(delta);
  assert.equal(idle.state, "active");
});

test("sleepy blinks are slower and further apart; awake blinks are unchanged", () => {
  const idle = new IdleController();
  assert.deepEqual(idle.blinkScale, { interval: 1, duration: 1 });
  run(idle, 601);
  assert.deepEqual(idle.blinkScale, SLEEPY_BLINK);
  assert.ok(SLEEPY_BLINK.interval > 1 && SLEEPY_BLINK.duration > 1);
  idle.activity();
  idle.update(0);
  assert.deepEqual(idle.blinkScale, { interval: 1, duration: 1 }, "waking eyes blink normally");
});

test("timings are normalised: bad values fall back, ranges are clamped, sleep never precedes idle", () => {
  assert.deepEqual(normaliseIdleTiming({}), { ...IDLE_TIMING });
  assert.deepEqual(normaliseIdleTiming(null), { ...IDLE_TIMING });
  const bad = normaliseIdleTiming({ idleAfter: "x", sleepAfter: Number.NaN });
  assert.equal(bad.idleAfter, IDLE_TIMING.idleAfter);
  assert.equal(bad.sleepAfter, IDLE_TIMING.sleepAfter);
  assert.equal(normaliseIdleTiming({ idleAfter: 1 }).idleAfter, 5);
  assert.equal(normaliseIdleTiming({ idleAfter: 1e9 }).idleAfter, 3600);
  assert.equal(normaliseIdleTiming({ sleepAfter: 1e9 }).sleepAfter, 86400);
  const order = normaliseIdleTiming({ idleAfter: 120, sleepAfter: 30 });
  assert.equal(order.sleepAfter, 120);
  assert.equal(normaliseIdleTiming({ wakeHappy: 99 }).wakeHappy, IDLE_TIMING.wakeHappy, "wake beats are fixed");
});

/** A checkbox or number input double with change listeners. */
function control(props) {
  const listeners = [];
  return {
    ...props,
    addEventListener: (type, fn) => { if (type === "change") listeners.push(fn); },
    change(patch) { Object.assign(this, patch); for (const fn of listeners) fn(); },
  };
}

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

test("the settings panel shows defaults and switches idle behaviours off and on", () => {
  const idle = new IdleController();
  const toggle = control({ checked: false });
  const idleAfterInput = control({ value: "" });
  const sleepAfterInput = control({ value: "" });
  const local = storage();
  bindIdleSettings(idle, { toggle, idleAfterInput, sleepAfterInput, local });
  assert.equal(toggle.checked, true, "on by default");
  assert.equal(idleAfterInput.value, "60");
  assert.equal(sleepAfterInput.value, "10", "sleep time shows in minutes");
  toggle.change({ checked: false });
  assert.equal(idle.enabled, false);
  assert.equal(local.map.get(IDLE_ENABLED_KEY), "0");
  toggle.change({ checked: true });
  assert.equal(idle.enabled, true);
});

test("timing inputs are saved in seconds and restored on the next page load", () => {
  const local = storage();
  const idle = new IdleController();
  const inputs = { toggle: control({ checked: true }), idleAfterInput: control({ value: "" }), sleepAfterInput: control({ value: "" }) };
  bindIdleSettings(idle, { ...inputs, local });
  inputs.idleAfterInput.change({ value: "30" });
  inputs.sleepAfterInput.change({ value: "2.5" });
  assert.equal(idle.timing.idleAfter, 30);
  assert.equal(idle.timing.sleepAfter, 150);
  assert.deepEqual(JSON.parse(local.map.get(IDLE_TIMING_KEY)), { idleAfter: 30, sleepAfter: 150 });

  const next = new IdleController();
  const again = { toggle: control({ checked: true }), idleAfterInput: control({ value: "" }), sleepAfterInput: control({ value: "" }) };
  bindIdleSettings(next, { ...again, local });
  assert.equal(next.timing.idleAfter, 30);
  assert.equal(next.timing.sleepAfter, 150);
  assert.equal(again.sleepAfterInput.value, "2.5");
});

test("out-of-range input is clamped and written back to the field", () => {
  const idle = new IdleController();
  const inputs = { toggle: control({ checked: true }), idleAfterInput: control({ value: "" }), sleepAfterInput: control({ value: "" }) };
  bindIdleSettings(idle, { ...inputs, local: storage() });
  inputs.idleAfterInput.change({ value: "-4" });
  assert.equal(idle.timing.idleAfter, 5);
  assert.equal(inputs.idleAfterInput.value, "5");
  inputs.sleepAfterInput.change({ value: "abc" });
  assert.equal(idle.timing.sleepAfter, IDLE_TIMING.sleepAfter, "unreadable input keeps the last value");
  assert.equal(inputs.sleepAfterInput.value, "10");
});

test("corrupt or blocked storage falls back to the defaults", () => {
  const idle = new IdleController();
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const inputs = { toggle: control({ checked: true }), idleAfterInput: control({ value: "" }), sleepAfterInput: control({ value: "" }) };
  bindIdleSettings(idle, { ...inputs, local: throwing });
  assert.deepEqual(idle.timing, { ...IDLE_TIMING });
  inputs.idleAfterInput.change({ value: "30" });
  assert.equal(idle.timing.idleAfter, 30, "the change still applies for this session");

  const corrupt = new IdleController();
  bindIdleSettings(corrupt, { toggle: null, idleAfterInput: null, sleepAfterInput: null, local: storage({ [IDLE_TIMING_KEY]: "{not json" }) });
  assert.deepEqual(corrupt.timing, { ...IDLE_TIMING });
});
