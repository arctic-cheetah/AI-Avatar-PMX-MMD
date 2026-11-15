// Run with: node --test tests/renderer/*.test.mjs
// Tentacle wave (#182): a slow wave travels along her four tails while idle,
// layered on top of the physics pose, easing in and out with the idle states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  TENTACLE_SIZE_KEY, TENTACLE_WAVE, TENTACLE_WAVE_KEY, TentacleWave, bindTentacleSize, tailChains, tentacleSize, waveAngles,
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

test("while she is active the tails stay still", () => {
  const wave = new TentacleWave();
  assert.ok(run(wave, "active", 5).every((gain) => gain === 0));
  assert.deepEqual(wave.angles(0.7, 9, LINKS), { yaw: 0, pitch: 0 });
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
  assert.ok(Math.abs(scaled.pitch - full.pitch * wave.gain) < 1e-12);
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

test("the slider runs from 0 to 2 in steps of 0.05, starting at the picked 0.4", () => {
  assert.deepEqual(TENTACLE_WAVE.sizeRange, { min: 0, max: 2, step: 0.05 });
  assert.equal(TENTACLE_WAVE.amplitude, 0.4);
  assert.equal(TENTACLE_SIZE_KEY, "yidhari.tentacles.size");
});

test("tentacleSize clamps to the range, snaps to the step, and falls back to the default", () => {
  assert.equal(tentacleSize(-1), 0);
  assert.equal(tentacleSize(3), 2);
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
  assert.equal(wave.amplitudeTarget, 2);
  wave.setAmplitude("nonsense");
  assert.equal(wave.amplitudeTarget, 0.4);
});

test("size 0 settles the tails exactly still, even while idle", () => {
  const wave = new TentacleWave();
  run(wave, "idle", TENTACLE_WAVE.ease * 4);
  wave.setAmplitude(0);
  run(wave, "idle", TENTACLE_WAVE.ease * 6);
  assert.equal(wave.amplitude, 0);
  assert.deepEqual(wave.angles(0.7, 9, LINKS), { yaw: 0, pitch: 0 });
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
  assert.equal(wave.amplitudeTarget, 2);
  assert.equal(input.value, "2", "an out-of-range value is written back clamped");
  assert.equal(local.map.get(TENTACLE_SIZE_KEY), "2");
  assert.deepEqual(shown, [1.25, 2]);
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

test("bindTentacleSize without a slider still applies the stored size", () => {
  const wave = new TentacleWave();
  bindTentacleSize(wave, null, { local: fakeStorage({ [TENTACLE_SIZE_KEY]: "0.6" }) });
  assert.equal(wave.amplitudeTarget, 0.6);
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
