// Run with: node --test tests/renderer/*.test.mjs
// Tentacle wave (#182): a slow wave travels along her four tails while idle,
// layered on top of the physics pose, easing in and out with the idle states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  TENTACLE_ACTIONS, TENTACLE_HEIGHT_KEY, TENTACLE_REACTIONS, TENTACLE_SIZE_KEY, TENTACLE_WAVE, TENTACLE_WAVE_KEY, TentacleWave,
  bindTentacleHeight, bindTentacleSize, tailChains, tentacleBlocks, tentacleHeight, tentacleSize, waveAngles,
} from "../../renderer/tentacle-motion.js";

const LINKS = 17;
const CHAINS = ["左Tail1", "右Tail1", "右Tail2", "左Tail2"];

/** Her bone names around the tails, in rig order: the root, four chains, and some others. */
function rigNames() {
  const names = ["センター", "上半身", "Ctr_Tail_Root"];
  for (const chain of CHAINS) for (let k = 1; k <= LINKS; k += 1) names.push(`${chain}_${k}`);
  names.push("頭", "Ctr_F_Hair_01", "左Tail1錘", "Tail_extra");
  return names;
}

/** Step a wave through a state for some seconds at 60 fps; returns the gain after each frame. */
function run(wave, state, seconds) {
  const gains = [];
  for (let i = 0; i < Math.round(seconds * 60); i += 1) gains.push(wave.update(1 / 60, state));
  return gains;
}

test("tailChains finds her four tails with their links in order", () => {
  const names = rigNames();
  const chains = tailChains(names);
  assert.deepEqual(chains.map((chain) => chain.name).sort(), [...CHAINS].sort());
  for (const chain of chains) {
    assert.equal(chain.links.length, LINKS);
    assert.deepEqual(chain.links.map((link) => link.k), Array.from({ length: LINKS }, (_, i) => i + 1));
    for (const link of chain.links) assert.equal(names[link.index], `${chain.name}_${link.k}`);
  }
});

test("tailChains sorts links by number, not by rig order or text", () => {
  const chains = tailChains(["右Tail1_10", "右Tail1_2", "右Tail1_1"]);
  assert.deepEqual(chains[0].links.map((link) => link.k), [1, 2, 10]);
});

test("each tail has its own phase, so they never wave in step", () => {
  const phases = tailChains(rigNames()).map((chain) => chain.phase);
  assert.equal(new Set(phases).size, 4);
  for (const phase of phases) assert.ok(Number.isFinite(phase));
});

test("every link's bend stays within its share of the amplitude, growing toward the tip", () => {
  const amplitude = 0.4;
  const share = (k) => (amplitude / TENTACLE_WAVE.linkDivisor) * (k / LINKS);
  let biggestTip = 0;
  let biggestBase = 0;
  for (let t = 0; t < 2 * TENTACLE_WAVE.period; t += 0.05) {
    for (let k = 1; k <= LINKS; k += 1) {
      const { yaw, pitch } = waveAngles(t, 1.3, k, LINKS, amplitude);
      assert.ok(Math.abs(yaw) <= share(k) + 1e-12, `yaw at link ${k}`);
      assert.ok(Math.abs(pitch) <= TENTACLE_WAVE.lift * share(k) + 1e-12, `pitch at link ${k}`);
      if (k === 1) biggestBase = Math.max(biggestBase, Math.abs(yaw));
      if (k === LINKS) biggestTip = Math.max(biggestTip, Math.abs(yaw));
    }
  }
  assert.ok(biggestTip > 10 * biggestBase, "the tip moves far more than the root link");
});

test("the wave travels from the root toward the tip", () => {
  const omega = (2 * Math.PI) / TENTACLE_WAVE.period;
  const lag = TENTACLE_WAVE.travel / omega;
  const at = (t, k) => waveAngles(t, 0.5, k, LINKS, 1).yaw / k;
  for (const t of [0.3, 1.7, 4.1]) {
    assert.ok(Math.abs(at(t, 5) - at(t + lag, 6)) < 1e-9, "link 6 repeats link 5 one lag later");
  }
});

test("a zero amplitude bends nothing", () => {
  for (const t of [0, 1, 2.5]) assert.deepEqual(waveAngles(t, 0.7, 9, LINKS, 0), { yaw: 0, pitch: 0 });
});

/** Each link's share of the raised rest arc. */
const REST = TENTACLE_WAVE.restLift / LINKS;

test("while she is active the tails stay still, at their raised rest", () => {
  const wave = new TentacleWave();
  assert.ok(run(wave, "active", 5).every((gain) => gain === 0));
  assert.deepEqual(wave.angles(0.7, 9, LINKS), { yaw: 0, pitch: REST });
});

test("the wave eases in when she idles, without a snap or overshoot", () => {
  const wave = new TentacleWave();
  const gains = run(wave, "idle", TENTACLE_WAVE.ease * 4);
  assert.ok(gains[5] < 0.1, `after 0.1 s the gain is only ${gains[5]}`);
  for (let i = 1; i < gains.length; i += 1) {
    assert.ok(gains[i] - gains[i - 1] < 0.05, `frame ${i} jumped`);
    assert.ok(gains[i] >= gains[i - 1] - 1e-12, "it never dips while easing in");
  }
  assert.ok(gains.every((gain) => gain >= 0 && gain <= 1));
  assert.ok(gains.at(-1) > 0.95);
});

test("the wave eases out when she becomes active again", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 4);
  const gains = run(wave, "active", TENTACLE_WAVE.ease * 4);
  assert.ok(gains[0] > 0.9, "the first active frame does not snap to rest");
  for (let i = 1; i < gains.length; i += 1) assert.ok(gains[i - 1] - gains[i] < 0.05, `frame ${i} dropped`);
  assert.ok(gains.every((gain) => gain >= 0 && gain <= 1));
  assert.ok(gains.at(-1) < 0.01);
});

test("each idle state has its own wave size", () => {
  for (const [state, target] of Object.entries(TENTACLE_WAVE.stateGain)) {
    const wave = new TentacleWave();
    const gains = run(wave, state, TENTACLE_WAVE.ease * 6);
    assert.ok(Math.abs(gains.at(-1) - target) < 0.01, `${state} settles at ${target}`);
  }
  assert.equal(TENTACLE_WAVE.stateGain.active, 0);
  assert.equal(TENTACLE_WAVE.stateGain.waking, 0);
  assert.equal(TENTACLE_WAVE.stateGain.idle, 1);
  assert.ok(TENTACLE_WAVE.stateGain.sleepy < TENTACLE_WAVE.stateGain.idle);
});

test("an unknown state counts as active", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 4);
  assert.ok(run(wave, "dancing", TENTACLE_WAVE.ease * 4).at(-1) < 0.01);
});

test("switching the toggle off eases the tails back to rest, and on again eases them in", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 4);
  wave.setEnabled(false);
  assert.equal(wave.enabled, false);
  const off = run(wave, "idle", TENTACLE_WAVE.ease * 4);
  assert.ok(off[0] > 0.9, "no snap when switched off");
  assert.ok(off.at(-1) < 0.01);
  wave.setEnabled(true);
  const on = run(wave, "idle", TENTACLE_WAVE.ease * 4);
  assert.ok(on[0] < 0.1, "no snap when switched on");
  assert.ok(on.at(-1) > 0.95);
});

test("a wave built switched off stays still while idle", () => {
  const wave = new TentacleWave({ enabled: false });
  assert.ok(run(wave, "idle", 5).every((gain) => gain === 0));
});

test("invalid frame times change nothing", () => {
  const wave = new TentacleWave();
  run(wave, "idle", 1);
  const { time, gain } = wave;
  for (const delta of [NaN, -1, Infinity, undefined]) wave.update(delta, "idle");
  assert.equal(wave.time, time);
  assert.equal(wave.gain, gain);
});

test("angles scale with the eased gain and the chosen amplitude", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 6);
  const full = waveAngles(wave.time, 0.7, 9, LINKS, wave.amplitude);
  const scaled = wave.angles(0.7, 9, LINKS);
  assert.ok(Math.abs(scaled.yaw - full.yaw * wave.gain) < 1e-12);
  assert.ok(Math.abs(scaled.pitch - REST - full.pitch * wave.gain) < 1e-12);
  assert.equal(new TentacleWave({ amplitude: 0.1 }).amplitude, 0.1);
});

test("the toggle has its own storage key", () => {
  assert.equal(TENTACLE_WAVE_KEY, "yidhari.tentacles");
});

// The size slider (#182): 0 to 2, measured clean across that range.

/** A range input that records its listeners. */
function fakeSlider() {
  const listeners = {};
  return {
    value: "",
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type) { listeners[type]?.(); },
  };
}

/** localStorage stand-in; `broken` makes every call throw. */
function fakeStorage(entries = {}, { broken = false } = {}) {
  const map = new Map(Object.entries(entries));
  const guard = () => { if (broken) throw new Error("blocked"); };
  return {
    getItem(key) { guard(); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { guard(); map.set(key, String(value)); },
    map,
  };
}

test("the slider runs from 0 to 6 in steps of 0.05, starting at the picked 0.4", () => {
  assert.deepEqual(TENTACLE_WAVE.sizeRange, { min: 0, max: 6, step: 0.05 });
  assert.equal(TENTACLE_WAVE.amplitude, 0.4);
  assert.equal(TENTACLE_SIZE_KEY, "yidhari.tentacles.size");
});

test("tentacleSize clamps to the range, snaps to the step, and falls back to the default", () => {
  assert.equal(tentacleSize(-1), 0);
  assert.equal(tentacleSize(7), 6);
  assert.equal(tentacleSize(3), 3);
  assert.equal(tentacleSize("0.6"), 0.6);
  assert.equal(tentacleSize(0.63), 0.65);
  assert.equal(tentacleSize(1.2), 1.2);
  for (const bad of [NaN, Infinity, "", "big", null, undefined]) assert.equal(tentacleSize(bad), 0.4, String(bad));
});

test("a new size eases in while the tails wave, without a jump or overshoot", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 4);
  wave.setAmplitude(1.2);
  assert.equal(wave.amplitudeTarget, 1.2);
  let previous = wave.amplitude;
  for (let i = 0; i < 6 * 60; i += 1) {
    wave.update(1 / 60, "idle");
    assert.ok(wave.amplitude - previous < 0.05, `frame ${i} jumped`);
    assert.ok(wave.amplitude >= previous - 1e-12 && wave.amplitude <= 1.2 + 1e-12, "no dip or overshoot");
    previous = wave.amplitude;
  }
  assert.ok(Math.abs(wave.amplitude - 1.2) < 1e-9);
});

test("a new size applies at once while the tails are still", () => {
  const wave = new TentacleWave();
  wave.setAmplitude(1.5);
  assert.equal(wave.amplitude, 1.5);
  run(wave, "active", 1);
  wave.setAmplitude(0.2);
  assert.equal(wave.amplitude, 0.2);
});

test("setAmplitude clamps like the slider", () => {
  const wave = new TentacleWave();
  wave.setAmplitude(5);
  assert.equal(wave.amplitudeTarget, 5);
  wave.setAmplitude(9);
  assert.equal(wave.amplitudeTarget, 6);
  wave.setAmplitude("nonsense");
  assert.equal(wave.amplitudeTarget, 0.4);
});

test("size 0 settles the tails exactly still, even while idle", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 4);
  wave.setAmplitude(0);
  run(wave, "idle", TENTACLE_WAVE.ease * 6);
  assert.equal(wave.amplitude, 0);
  assert.deepEqual(wave.angles(0.7, 9, LINKS), { yaw: 0, pitch: REST });
});

test("bindTentacleSize shows and applies a stored size, and saves the slider's changes", () => {
  const wave = new TentacleWave();
  const input = fakeSlider();
  const shown = [];
  const local = fakeStorage({ [TENTACLE_SIZE_KEY]: "1.25" });
  bindTentacleSize(wave, input, { local, show: (size) => shown.push(size) });
  assert.equal(wave.amplitudeTarget, 1.25);
  assert.equal(input.value, "1.25");
  assert.deepEqual(shown, [1.25]);
  input.value = "2.4";
  input.fire("input");
  assert.equal(wave.amplitudeTarget, 2.4);
  assert.equal(input.value, "2.4", "an in-range value is written back snapped");
  assert.equal(local.map.get(TENTACLE_SIZE_KEY), "2.4");
  input.value = "7.2";
  input.fire("input");
  assert.equal(wave.amplitudeTarget, 6);
  assert.equal(input.value, "6", "an out-of-range value is written back clamped");
  assert.equal(local.map.get(TENTACLE_SIZE_KEY), "6");
  assert.deepEqual(shown, [1.25, 2.4, 6]);
});

test("bindTentacleSize starts at the default with nothing stored, and keeps working when storage is blocked", () => {
  const fresh = new TentacleWave({ amplitude: 1 });
  bindTentacleSize(fresh, fakeSlider(), { local: fakeStorage() });
  assert.equal(fresh.amplitudeTarget, 0.4);
  const wave = new TentacleWave();
  const input = fakeSlider();
  bindTentacleSize(wave, input, { local: fakeStorage({}, { broken: true }) });
  input.value = "0.8";
  assert.doesNotThrow(() => input.fire("input"));
  assert.equal(wave.amplitudeTarget, 0.8);
});

// Tail height slider (#231): the rest arc from 0 to 3 rad, saved like the size.

test("the tail height runs from 0 to 3 rad in steps of 0.05, starting at the picked 1.7", () => {
  assert.deepEqual(TENTACLE_WAVE.heightRange, { min: 0, max: 3, step: 0.05 });
  assert.equal(TENTACLE_HEIGHT_KEY, "yidhari.tentacles.height");
  assert.notEqual(TENTACLE_HEIGHT_KEY, TENTACLE_SIZE_KEY);
  assert.equal(new TentacleWave().restLiftTarget, TENTACLE_WAVE.restLift);
});

test("tentacleHeight clamps to the range, snaps to the step, and falls back to the default", () => {
  for (const [value, height] of [[2.5, 2.5], ["0.33", 0.35], [-1, 0], [3.4, 3], [0, 0], ["", 1.7], [null, 1.7], ["tall", 1.7], [Number.NaN, 1.7]]) {
    assert.equal(tentacleHeight(value), height, `${value}`);
  }
});

test("a new tail height eases in, without a jump or overshoot, even while the wave is still", () => {
  const wave = new TentacleWave();
  wave.setRestLift(3);
  assert.equal(wave.restLiftTarget, 3);
  assert.equal(wave.restLift, TENTACLE_WAVE.restLift, "no snap on the first frame");
  const heights = [];
  for (let i = 0; i < Math.round(TENTACLE_WAVE.ease * 6 * 60); i += 1) {
    wave.update(1 / 60, "active", { composed: true });
    heights.push(wave.restLift);
  }
  assert.equal(wave.gain, 0, "the wave stays still");
  for (let i = 1; i < heights.length; i += 1) {
    assert.ok(heights[i] >= heights[i - 1] && heights[i] - heights[i - 1] < 0.05, `frame ${i} jumped`);
  }
  assert.equal(heights.at(-1), 3, "settles exactly");
  const total = Array.from({ length: LINKS }, (_, i) => wave.angles(0.7, i + 1, LINKS).pitch).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 3) < 1e-9, "the tails arc by the new height");
});

test("setRestLift clamps like the slider, and can apply at once", () => {
  const wave = new TentacleWave();
  wave.setRestLift(9, { instant: true });
  assert.equal(wave.restLift, 3);
  wave.setRestLift(-2, { instant: true });
  assert.equal(wave.restLift, 0);
  assert.deepEqual(wave.angles(0.7, 9, LINKS), { yaw: 0, pitch: 0 });
});

test("bindTentacleHeight applies a stored height at once, and saves and eases the slider's changes", () => {
  const wave = new TentacleWave();
  const input = fakeSlider();
  const shown = [];
  const local = fakeStorage({ [TENTACLE_HEIGHT_KEY]: "2.5" });
  bindTentacleHeight(wave, input, { local, show: (height) => shown.push(height) });
  assert.equal(wave.restLift, 2.5, "the stored height is there on the first frame");
  assert.equal(input.value, "2.5");
  input.value = "3.4";
  input.fire("input");
  assert.equal(wave.restLiftTarget, 3);
  assert.equal(wave.restLift, 2.5, "a slider change eases rather than snapping");
  assert.equal(input.value, "3", "an out-of-range value is written back clamped");
  assert.equal(local.map.get(TENTACLE_HEIGHT_KEY), "3");
  assert.deepEqual(shown, [2.5, 3]);
});

test("bindTentacleHeight starts at 1.7 with nothing stored, and keeps working when storage is blocked or the slider is missing", () => {
  const fresh = new TentacleWave();
  bindTentacleHeight(fresh, fakeSlider(), { local: fakeStorage() });
  assert.equal(fresh.restLift, 1.7);
  const wave = new TentacleWave();
  const input = fakeSlider();
  bindTentacleHeight(wave, input, { local: fakeStorage({}, { broken: true }) });
  input.value = "0.5";
  assert.doesNotThrow(() => input.fire("input"));
  assert.equal(wave.restLiftTarget, 0.5);
  const headless = new TentacleWave();
  bindTentacleHeight(headless, null, { local: fakeStorage({ [TENTACLE_HEIGHT_KEY]: "1" }) });
  assert.equal(headless.restLift, 1);
});

test("bindTentacleSize without a slider still applies the stored size", () => {
  const wave = new TentacleWave();
  bindTentacleSize(wave, null, { local: fakeStorage({ [TENTACLE_SIZE_KEY]: "0.6" }) });
  assert.equal(wave.amplitudeTarget, 0.6);
});

// Reactions (#182): perk, lift and droop with her moods, a sway while she speaks.

/** Step a wave for some seconds at 60 fps with options; returns [gain, lift] after each frame. */
function trace(wave, state, seconds, options) {
  const out = [];
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    wave.update(1 / 60, state, options);
    out.push([wave.gain, wave.lift]);
  }
  return out;
}
const lifts = (rows) => rows.map(([, lift]) => lift);
const peak = (values) => values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);

test("each reaction answers its moods, and no mood answers twice", () => {
  const seen = new Set();
  for (const [name, reaction] of Object.entries(TENTACLE_REACTIONS)) {
    assert.ok(reaction.moods.length > 0, name);
    for (const mood of reaction.moods) {
      assert.ok(!seen.has(mood), `${mood} appears twice`);
      seen.add(mood);
    }
  }
  assert.ok(TENTACLE_REACTIONS.perk.moods.includes("surprised"));
  assert.ok(TENTACLE_REACTIONS.lift.moods.includes("happy"));
  assert.ok(TENTACLE_REACTIONS.droop.moods.includes("sleepy"));
  assert.ok(!seen.has("thinking"), "thinking has no reaction: it keeps a slow wave instead (#225)");
  assert.ok(TENTACLE_REACTIONS.perk.lift > TENTACLE_REACTIONS.lift.lift && TENTACLE_REACTIONS.lift.lift > 0);
  assert.ok(TENTACLE_REACTIONS.droop.lift < 0);
});

test("surprise perks the tails up quickly and they ease back to exactly rest", () => {
  const wave = new TentacleWave();
  wave.setMood("surprised");
  const rows = lifts(trace(wave, "active", 4));
  const top = peak(rows);
  assert.ok(Math.abs(top - TENTACLE_REACTIONS.perk.lift) < 1e-6, `peaks at ${top}`);
  assert.ok(rows.findIndex((lift) => lift >= top - 1e-9) < 0.5 * 60, "up within half a second");
  for (let i = 1; i < rows.length; i += 1) assert.ok(Math.abs(rows[i] - rows[i - 1]) < 0.05, `frame ${i} jumped`);
  assert.equal(rows.at(-1), 0);
  assert.equal(wave.gain, 0, "a reaction alone does not start the wave");
});

test("happiness lifts them more gently than surprise", () => {
  const happy = new TentacleWave();
  happy.setMood("happy");
  const rows = lifts(trace(happy, "active", 6));
  assert.ok(Math.abs(peak(rows) - TENTACLE_REACTIONS.lift.lift) < 1e-6);
  assert.ok(rows.findIndex((lift) => lift >= peak(rows) - 1e-9) > 0.5 * 60, "slower to rise than a perk");
  assert.equal(rows.at(-1), 0);
});

test("the same mood again does not fire twice, and other moods do nothing", () => {
  const wave = new TentacleWave();
  wave.setMood("happy");
  trace(wave, "active", 6);
  wave.setMood("happy");
  assert.ok(lifts(trace(wave, "active", 1)).every((lift) => lift === 0));
  for (const mood of ["neutral", "thinking", "serious", "calm"]) {
    wave.setMood(mood);
    assert.ok(lifts(trace(wave, "active", 1)).every((lift) => lift === 0), mood);
  }
});

test("sleepiness droops the tails for as long as it lasts, then they ease back", () => {
  const wave = new TentacleWave();
  wave.setMood("sleepy");
  const held = lifts(trace(wave, "sleepy", 6));
  assert.ok(Math.abs(held.at(-1) - TENTACLE_REACTIONS.droop.lift) < 1e-6, `holds at ${held.at(-1)}`);
  for (let i = 1; i < held.length; i += 1) assert.ok(Math.abs(held[i] - held[i - 1]) < 0.05, `frame ${i} jumped`);
  wave.setMood("neutral");
  const after = lifts(trace(wave, "active", 6));
  assert.ok(after[0] < -0.3, "no snap when the mood clears");
  assert.equal(after.at(-1), 0);
});

test("while she speaks the tails sway gently, even though idle is blocked", () => {
  const wave = new TentacleWave();
  const rows = trace(wave, "active", TENTACLE_WAVE.ease * 6, { speaking: true });
  assert.ok(Math.abs(rows.at(-1)[0] - TENTACLE_WAVE.speakingGain) < 0.01);
  assert.ok(TENTACLE_WAVE.speakingGain > 0 && TENTACLE_WAVE.speakingGain < TENTACLE_WAVE.stateGain.idle);
  const done = trace(wave, "active", TENTACLE_WAVE.ease * 6);
  assert.equal(done.at(-1)[0], 0, "and settle when speech ends");
});

test("moods still react while she speaks", () => {
  const wave = new TentacleWave();
  wave.setMood("surprised");
  assert.ok(peak(lifts(trace(wave, "active", 2, { speaking: true }))) > 0.9 * TENTACLE_REACTIONS.perk.lift);
});

test("an open ask or a streaming reply keeps the tails composed", () => {
  const wave = new TentacleWave();
  trace(wave, "idle", TENTACLE_WAVE.ease * 4);
  wave.setMood("sleepy");
  trace(wave, "idle", 3);
  const rows = trace(wave, "active", TENTACLE_WAVE.ease * 6, { composed: true });
  assert.ok(rows[0][0] > 0.9 && rows[0][1] < -0.1, "eases out rather than snapping");
  assert.deepEqual(rows.at(-1), [0, 0]);
  wave.setMood("surprised");
  assert.ok(trace(wave, "active", 2, { composed: true }).every(([gain, lift]) => gain === 0 && lift === 0),
    "a mood while composed does not move them");
});

test("tentacleBlocks keeps asks and previews composed while thinking ponders (#225, PR #227)", () => {
  // An open ask or a morph preview is a hard block: it never lets thinking wave.
  for (const hard of [{ askOpen: true }, { previewing: true }]) {
    const base = { blocked: true, speaking: false, thinking: true, askOpen: false, previewing: false, ...hard };
    assert.deepEqual(tentacleBlocks(base), { thinking: false, composed: true });
  }
  // A streaming reply (blocked, not speaking, thinking) still ponders.
  assert.deepEqual(
    tentacleBlocks({ blocked: true, speaking: false, thinking: true, askOpen: false, previewing: false }),
    { thinking: true, composed: false });
  // Speech alone is handled by the sway, not the ponder.
  assert.deepEqual(
    tentacleBlocks({ blocked: true, speaking: true, thinking: true, askOpen: false, previewing: false }),
    { thinking: true, composed: false });
  // Nothing blocked: no composed either way.
  assert.deepEqual(
    tentacleBlocks({ blocked: false, speaking: false, thinking: true, askOpen: false, previewing: false }),
    { thinking: true, composed: false });
});

test("while she thinks the tails keep a slow wave, even though idle is blocked (#225)", () => {
  const wave = new TentacleWave();
  // main.js never sends thinking while an ask or a morph preview is up, but a
  // streaming reply (the remaining composed block) still lets the wave play.
  const rows = trace(wave, "active", TENTACLE_WAVE.ease * 6, { thinking: true, composed: true });
  assert.ok(TENTACLE_WAVE.thinkingGain > 0 && TENTACLE_WAVE.thinkingGain <= TENTACLE_WAVE.stateGain.idle);
  assert.ok(Math.abs(rows.at(-1)[0] - TENTACLE_WAVE.thinkingGain) < 0.01, `settles at ${rows.at(-1)[0]}`);
  for (let i = 1; i < rows.length; i += 1) assert.ok(Math.abs(rows[i][0] - rows[i - 1][0]) < 0.05, `frame ${i} jumped`);
  const done = trace(wave, "active", TENTACLE_WAVE.ease * 6, { composed: true });
  assert.ok(done[0][0] > 0.9 * TENTACLE_WAVE.thinkingGain, "eases out rather than snapping");
  assert.equal(done.at(-1)[0], 0, "and settles when thinking ends");
});

test("the thinking wave runs at its own pace, and idle keeps the usual one (#225)", () => {
  assert.ok(TENTACLE_WAVE.thinkingTempo > 0 && TENTACLE_WAVE.thinkingTempo <= 1);
  const thinking = new TentacleWave();
  trace(thinking, "active", TENTACLE_WAVE.ease * 6, { thinking: true });
  const before = thinking.time;
  trace(thinking, "active", 1, { thinking: true });
  assert.ok(Math.abs(thinking.time - before - TENTACLE_WAVE.thinkingTempo) < 1e-6, `advanced ${thinking.time - before}`);
  const idle = new TentacleWave();
  trace(idle, "idle", TENTACLE_WAVE.ease * 6);
  const idleBefore = idle.time;
  trace(idle, "idle", 1);
  assert.ok(Math.abs(idle.time - idleBefore - 1) < 1e-6, "idle waves at the usual pace");
});

test("speech keeps its usual pace while she thinks (#225)", () => {
  const speaking = new TentacleWave();
  const rows = trace(speaking, "active", TENTACLE_WAVE.ease * 6, { thinking: true, speaking: true });
  assert.ok(Math.abs(rows.at(-1)[0] - Math.max(TENTACLE_WAVE.speakingGain, TENTACLE_WAVE.thinkingGain)) < 0.01);
  const before = speaking.time;
  trace(speaking, "active", 1, { thinking: true, speaking: true });
  assert.ok(Math.abs(speaking.time - before - 1) < 1e-6, "speech sways at the usual pace");
});

test("with the toggle off the tails stay still while she thinks (#225)", () => {
  const wave = new TentacleWave({ enabled: false });
  assert.ok(trace(wave, "active", 3, { thinking: true }).every(([gain]) => gain === 0));
});

test("the lift bends each link evenly, so the whole tail arcs by the lift", () => {
  const wave = new TentacleWave();
  wave.setMood("surprised");
  for (let i = 0; i < 25; i += 1) wave.update(1 / 60, "active");
  const total = Array.from({ length: LINKS }, (_, i) => wave.angles(0.7, i + 1, LINKS).pitch).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - wave.lift - TENTACLE_WAVE.restLift) < 1e-9);
  assert.equal(wave.angles(0.7, 9, LINKS).yaw, 0, "no side-to-side without the wave");
});

test("the tails rest raised by an even arc, so all four show in the bust shot", () => {
  // The user picked 1.7 rad from bust-camera grids: higher than 1.5, where only some tips showed.
  assert.ok(TENTACLE_WAVE.restLift > 1.5, `rest arc ${TENTACLE_WAVE.restLift}`);
  for (const wave of [new TentacleWave(), new TentacleWave({ enabled: false }), new TentacleWave({ amplitude: 0 })]) {
    run(wave, "active", 2);
    const pitches = Array.from({ length: LINKS }, (_, i) => wave.angles(0.7, i + 1, LINKS));
    assert.ok(pitches.every(({ yaw, pitch }) => yaw === 0 && Math.abs(pitch - REST) < 1e-12),
      "every link bends up by the same share, with the toggle off and at size 0 too");
  }
  const preview = new TentacleWave();
  preview.restLift = 0;
  assert.deepEqual(preview.angles(0.7, 9, LINKS), { yaw: 0, pitch: 0 }, "previews can change the rest arc");
});

test("reactions follow the size slider up to the default and no further, and stop at 0", () => {
  const sizes = [[0, 0], [0.2, 0.5], [0.4, 1], [2, 1]];
  for (const [size, scale] of sizes) {
    const wave = new TentacleWave({ amplitude: size });
    wave.setMood("surprised");
    for (let i = 0; i < 25; i += 1) wave.update(1 / 60, "active");
    const total = Array.from({ length: LINKS }, (_, i) => wave.angles(0.7, i + 1, LINKS).pitch).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - wave.lift * scale - TENTACLE_WAVE.restLift) < 1e-9, `size ${size}`);
  }
});

test("switching the toggle off eases a reaction out and ignores new moods", () => {
  const wave = new TentacleWave();
  wave.setMood("sleepy");
  trace(wave, "sleepy", 4);
  wave.setEnabled(false);
  const rows = lifts(trace(wave, "sleepy", 6));
  assert.ok(rows[0] < -0.3);
  assert.equal(rows.at(-1), 0);
  wave.setMood("surprised");
  assert.ok(lifts(trace(wave, "active", 2)).every((lift) => lift === 0));
});

// Playing tentacle actions from the Animation actions buttons (#164, #182).

test("each tentacle action has a button label and a length", () => {
  assert.deepEqual(Object.keys(TENTACLE_ACTIONS).sort(), ["droop", "perk", "sway", "wave"]);
  for (const [name, action] of Object.entries(TENTACLE_ACTIONS)) {
    assert.match(action.label, /^Tentacle /, name);
    assert.ok(action.duration > 0, name);
  }
});

test("playing the wave waves the tails while she is active, then they settle", () => {
  const wave = new TentacleWave();
  wave.play("wave");
  assert.equal(wave.playing, "wave");
  const rows = trace(wave, "active", TENTACLE_ACTIONS.wave.duration + TENTACLE_WAVE.ease * 5);
  const during = rows.slice(0, TENTACLE_ACTIONS.wave.duration * 60);
  assert.ok(Math.max(...during.map(([gain]) => gain)) > 0.95);
  assert.equal(wave.playing, null);
  assert.equal(rows.at(-1)[0], 0);
});

test("playing the sway waves them at the speaking size", () => {
  const wave = new TentacleWave();
  wave.play("sway");
  const rows = trace(wave, "active", TENTACLE_ACTIONS.sway.duration);
  assert.ok(Math.abs(rows.at(-30)[0] - TENTACLE_WAVE.speakingGain) < 0.02);
});

test("playing perk and droop shows those reactions and eases back", () => {
  const perk = new TentacleWave();
  perk.play("perk");
  const up = lifts(trace(perk, "active", TENTACLE_ACTIONS.perk.duration + 1));
  assert.ok(Math.abs(peak(up) - TENTACLE_REACTIONS.perk.lift) < 1e-6);
  assert.equal(up.at(-1), 0);
  const droop = new TentacleWave();
  droop.play("droop");
  const down = lifts(trace(droop, "active", TENTACLE_ACTIONS.droop.duration + 5));
  assert.ok(Math.abs(peak(down) - TENTACLE_REACTIONS.droop.lift) < 0.01);
  assert.equal(down.at(-1), 0);
  assert.equal(droop.playing, null);
});

test("the same button again stops the action, and another switches to it", () => {
  const wave = new TentacleWave();
  wave.toggle("wave");
  trace(wave, "active", 3);
  wave.toggle("wave");
  assert.equal(wave.playing, null);
  const rows = trace(wave, "active", TENTACLE_WAVE.ease * 5);
  assert.ok(rows[0][0] > 0.5, "stopping eases out");
  assert.equal(rows.at(-1)[0], 0);
  wave.toggle("wave");
  wave.toggle("droop");
  assert.equal(wave.playing, "droop");
  wave.stop();
  assert.equal(wave.playing, null);
  assert.throws(() => wave.play("dance"), /Unknown tentacle action/);
});

test("a played action still respects the toggle and composure", () => {
  const off = new TentacleWave({ enabled: false });
  off.play("wave");
  assert.ok(trace(off, "active", 3).every(([gain]) => gain === 0));
  const composed = new TentacleWave();
  composed.play("perk");
  assert.ok(trace(composed, "active", 2, { composed: true }).every(([, lift]) => lift === 0));
});

const PMX = new URL("../../yidhari-mmd/伊德海莉.pmx", import.meta.url);
const PARSER = new URL("../../node_modules/three/examples/jsm/libs/mmdparser.module.js", import.meta.url);
const haveModel = existsSync(PMX) && existsSync(PARSER);

test("her real rig: four tails of 17 links, each hanging from Ctr_Tail_Root", { skip: !haveModel && "PMX or MMD parser absent" }, async () => {
  const { MMDParser } = await import(PARSER.href);
  const bytes = readFileSync(PMX);
  const data = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), true);
  const names = data.bones.map((bone) => bone.name);
  const chains = tailChains(names);
  assert.equal(chains.length, 4);
  for (const chain of chains) {
    assert.equal(chain.links.length, LINKS);
    assert.equal(names[data.bones[chain.links[0].index].parentIndex], "Ctr_Tail_Root");
    chain.links.slice(1).forEach((link, i) => assert.equal(data.bones[link.index].parentIndex, chain.links[i].index));
  }
});
