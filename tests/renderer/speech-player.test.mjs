import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer } from '../../renderer/speech-player.js';

function harness() {
  const connections = [];
  const sources = [];
  const newSource = () => {
    const source = { connect: n => connections.push(n), disconnect() {}, start(t) { this.started = t; }, stop() {} };
    sources.push(source);
    return source;
  };
  const context = {
    currentTime: 2, sampleRate: 48000, outputLatency: 0.01,
    resume: async () => {}, createBufferSource: newSource,
    createBuffer: (channels, length, sampleRate) => ({ numberOfChannels: channels, length, sampleRate,
      copyToChannel() {}, duration: length / sampleRate }), destination: 'raw-output',
  };
  const output = { connect: async () => 'protected-output' };
  const player = new SpeechPlayer({ morphTargetDictionary: {} }, {}, output);
  player.context = context;
  const clip = { buffer: { numberOfChannels: 1, length: 48000, sampleRate: 48000,
    duration: 1, getChannelData: () => new Float32Array(48000) }, visemes: [{start: 0, end: 1, shape: 'X'}] };
  return { player, sources, get source() { return sources[0]; }, context, clip, connections };
}

test('all speech uses the shared protected output and pads the limiter tail', async () => {
  const h = harness();
  assert.equal(await h.player.play(h.clip), true);
  assert.deepEqual(h.connections, ['protected-output']);
  assert.equal(h.source.buffer.length, 48240);
  assert.equal(h.clip.buffer.length, 48000, 'the original clip and visemes stay unchanged');
  assert.ok(Math.abs(h.player.audioTime() + 0.015) < 1e-9, 'account for output latency and lookahead');
  h.context.currentTime += 0.5;
  assert.ok(Math.abs(h.player.audioTime() - 0.485) < 1e-9);
});

test('stop while output setup is pending prevents late audio from starting', async () => {
  const h = harness();
  let ready;
  h.player.volume = { connect: () => new Promise(resolve => { ready = resolve; }) };
  const playing = h.player.play(h.clip);
  await Promise.resolve();
  h.player.stop();
  ready?.('protected-output');
  assert.equal(await playing, false);
  assert.equal(h.player.playing, false);
  assert.equal(h.sources.length, 0);
});

test('finished and stopped playback release their clip reference', async () => {
  for (const finish of [h => h.source.onended(), h => h.player.stop()]) {
    const h = harness();
    await h.player.play(h.clip);
    finish(h);
    assert.equal(h.player.playing, false);
    assert.equal(h.player.clip, null, 'only the dedicated replay slot retains finished live audio');
  }
});

test('replaying a retained clip creates fresh audio and restarts lip sync at zero', async () => {
  const h = harness();
  await h.player.play(h.clip);
  h.context.currentTime += 0.8;
  h.player.cueIndex = 10;
  h.source.onended();
  await h.player.play(h.clip);
  assert.equal(h.sources.length, 2);
  assert.notEqual(h.sources[0], h.sources[1]);
  assert.equal(h.player.clip.buffer, h.clip.buffer);
  assert.equal(h.player.cueIndex, 0);
  assert.equal(h.player.startTime, h.context.currentTime);
  assert.ok(Math.abs(h.player.audioTime() + 0.015) < 1e-9);
});

test('a stopped source ending late cannot release a newer playing clip', async () => {
  const h = harness();
  await h.player.play(h.clip);
  const oldSource = h.source;
  const latest = { ...h.clip, transcript: 'Latest speech' };
  await h.player.play(latest);
  oldSource.onended();
  assert.equal(h.player.playing, true);
  assert.equal(h.player.clip, latest);
});
