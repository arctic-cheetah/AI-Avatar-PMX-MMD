import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeakLimiter, LOOKAHEAD_SECONDS, PEAK_CEILING } from '../../renderer/voice-limiter.js';
import { VoiceVolume, clampVolumeDb, VOLUME_KEY } from '../../renderer/voice-volume.js';

function render(channels, gain = 1, rate = 48000) {
  const limiter = new PeakLimiter(rate, channels.length);
  const length = channels[0].length + limiter.delayFrames;
  const input = channels.map(c => Float32Array.from([...c, ...new Float32Array(limiter.delayFrames)]));
  const output = channels.map(() => new Float32Array(length));
  // Exercise state across render quanta, including a short final quantum.
  for (let start = 0; start < length; start += 128) {
    limiter.process(input.map(c => c.subarray(start, start + 128)),
      output.map(c => c.subarray(start, start + 128)), [gain]);
  }
  return { output, delay: limiter.delayFrames };
}

test('baseline is sample-transparent below the ceiling, with exactly the documented delay', () => {
  const source = Float32Array.from({length: 2000}, (_, i) => 0.3 * Math.sin(i * 0.1));
  const {output, delay} = render([source]);
  assert.equal(delay, Math.ceil(48000 * LOOKAHEAD_SECONDS));
  assert.deepEqual(output[0].slice(0, delay), new Float32Array(delay));
  assert.deepEqual(output[0].slice(delay), source);
});

test('quiet speech gets the requested boost; silence stays zero', () => {
  const source = Float32Array.from({length: 2000}, (_, i) => i < 500 ? 0 : 0.025 * Math.sin(i));
  const {output, delay} = render([source], 4);
  assert.deepEqual(output[0].slice(delay), source.map(s => s * 4));
});

test('loud bursts and isolated peaks stay below the ceiling at maximum boost at multiple rates', () => {
  for (const rate of [24000, 44100, 48000, 96000]) {
    const source = Float32Array.from({length: 12000}, (_, i) => i % 1700 < 400 ? Math.sin(i * 0.08) : 0.02);
    source[127] = -1;
    source[source.length - 1] = 1;
    const {output} = render([source], 10 ** (18 / 20), rate);
    assert.ok(output[0].every(s => Number.isFinite(s) && Math.abs(s) <= PEAK_CEILING + 1e-6));
    assert.ok(Math.max(...output[0]) > PEAK_CEILING * 0.9);
  }
});

test('limiting links channels to preserve stereo balance', () => {
  const left = Float32Array.from({length: 3000}, (_, i) => Math.sin(i * 0.2));
  const right = left.map(s => s * 0.25);
  const {output} = render([left, right], 4);
  output[0].forEach((s, i) => assert.equal(output[1][i], s * 0.25));
});

test('lookahead eases gain before a transient and releases afterwards', () => {
  const source = new Float32Array(12000).fill(0.1);
  source[2000] = 1;
  const {output, delay} = render([source], 2);
  const before = output[0].slice(2000, 2000 + delay);
  assert.ok(before.at(-1) < before[0] * 0.6);
  assert.ok(Math.max(...before.map((s, i) => i ? Math.abs(s - before[i - 1]) : 0)) < 0.002);
  assert.ok(output[0].at(-1) > before.at(-1) * 1.8);
});

test('volume values are bounded and invalid settings reset to baseline', () => {
  assert.equal(clampVolumeDb(100), 18);
  assert.equal(clampVolumeDb(-100), -24);
  for (const value of [NaN, Infinity, null, '', 'oops']) assert.equal(clampVolumeDb(value), 0);
});

function storage(value = null) {
  const saved = new Map(value === null ? [] : [[VOLUME_KEY, value]]);
  return { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) };
}

test('volume persists, restores and resets; blocked storage remains usable', () => {
  const saved = storage('6');
  const volume = new VoiceVolume(saved);
  assert.equal(volume.db, 6);
  volume.setDb(12);
  assert.equal(new VoiceVolume(saved).db, 12);
  volume.setDb(0);
  assert.equal(new VoiceVolume(saved).db, 0);
  const blocked = new VoiceVolume({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  blocked.setDb(6);
  assert.equal(blocked.db, 6);
});

test('live changes smoothly retarget the audio parameter without creating a new context', async () => {
  const events = [];
  const param = {
    value: 1,
    cancelAndHoldAtTime: t => events.push(['hold', t]),
    setTargetAtTime: (...args) => events.push(['target', ...args]),
  };
  const node = { parameters: new Map([['gain', param]]), connect: d => events.push(['connect', d]) };
  const context = { currentTime: 10, destination: 'speakers', audioWorklet: { addModule: async () => events.push(['module']) } };
  const volume = new VoiceVolume(storage('6'));
  await volume.connect(context, () => node);
  assert.ok(Math.abs(param.value - 10 ** (6 / 20)) < 1e-6);
  volume.setDb(12);
  assert.deepEqual(events.at(-2), ['hold', 10]);
  assert.deepEqual(events.at(-1), ['target', 10 ** (12 / 20), 10, 0.015]);
  assert.equal(await volume.connect(context, () => { throw Error('duplicate graph'); }), node);
});

test('overlapping connects load one worklet; module failure is reported and can be retried', async () => {
  const volume = new VoiceVolume(storage());
  let modules = 0;
  const context = { destination: {}, audioWorklet: { addModule: async () => { modules++; } } };
  const node = { parameters: new Map([['gain', { value: 1 }]]), connect() {} };
  const [first, second] = await Promise.all([volume.connect(context, () => node), volume.connect(context, () => node)]);
  assert.equal(first, second);
  assert.equal(modules, 1);
  const retry = new VoiceVolume(storage());
  context.audioWorklet.addModule = async () => { throw Error('worklet unavailable'); };
  await assert.rejects(retry.connect(context, () => node), /worklet unavailable/);
  assert.equal(retry.node, null, 'there is no unsafe direct-output fallback');
  context.audioWorklet.addModule = async () => {};
  assert.equal(await retry.connect(context, () => node), node);
});

test('reset clears queued sound and gain reduction before the next clip', () => {
  const limiter = new PeakLimiter(48000, 1);
  limiter.process([new Float32Array(128).fill(1)], [new Float32Array(128)], [4]);
  limiter.reset();
  const output = [new Float32Array(256)];
  limiter.process([new Float32Array(256)], output, [4]);
  assert.ok(output[0].every(s => s === 0));
  assert.equal(limiter.envelope, 1);
});
