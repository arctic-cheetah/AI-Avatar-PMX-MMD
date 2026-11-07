import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer } from '../../renderer/speech-player.js';

function harness() {
  const connections = [];
  const source = { connect: n => connections.push(n), disconnect() {}, start(t) { this.started = t; }, stop() {} };
  const context = {
    currentTime: 2, sampleRate: 48000, outputLatency: 0.01,
    resume: async () => {}, createBufferSource: () => source,
    createBuffer: (channels, length, sampleRate) => ({ numberOfChannels: channels, length, sampleRate,
      copyToChannel() {}, duration: length / sampleRate }), destination: 'raw-output',
  };
  const output = { connect: async () => 'protected-output' };
  const player = new SpeechPlayer({ morphTargetDictionary: {} }, {}, output);
  player.context = context;
  const clip = { buffer: { numberOfChannels: 1, length: 48000, sampleRate: 48000,
    duration: 1, getChannelData: () => new Float32Array(48000) }, visemes: [{start: 0, end: 1, shape: 'X'}] };
  return { player, source, context, clip, connections };
}

test('all speech uses the shared protected output and pads the limiter tail', async () => {
  const h = harness();
  await h.player.play(h.clip);
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
  await playing;
  assert.equal(h.player.playing, false);
  assert.equal(h.source.started, undefined);
});
