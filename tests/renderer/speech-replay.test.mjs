import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LastSpeechReplay } from '../../renderer/speech-replay.js';

function entry(text = 'Hello again!') {
  return {
    clip: { buffer: { duration: 2, length: 96000, numberOfChannels: 1 },
      visemes: [{ start: 0, end: 2, shape: 'B' }], transcript: text },
    expression: 'happy', weight: 0.7, text,
  };
}

test('retains only the latest spoken clip, sharing its audio and lip-sync track', () => {
  const replay = new LastSpeechReplay();
  assert.equal(replay.entry, null);
  const first = entry();
  replay.remember(first);
  assert.equal(replay.entry.clip.buffer, first.clip.buffer);
  assert.equal(replay.entry.clip.visemes, first.clip.visemes);
  const latest = entry('The latest sentence.');
  replay.remember(latest);
  assert.equal(replay.entry.clip.buffer, latest.clip.buffer);
  assert.equal(replay.entry.text, latest.text);
  assert.equal(replay.entry.expression, 'happy');
  assert.equal(replay.entry.weight, 0.7);
});

test('new chat clears replay without touching the conversation or audio source', () => {
  const replay = new LastSpeechReplay();
  replay.remember(entry());
  replay.clear();
  assert.equal(replay.entry, null);
});

test('oversized latest clips expire replay instead of retaining an older sentence', () => {
  for (const oversize of [
    e => { e.clip.buffer.duration = 121; },
    e => { e.clip.buffer.length = 9 * 1024 * 1024; },
    e => { e.clip.visemes = new Array(20001); },
  ]) {
    const replay = new LastSpeechReplay();
    replay.remember(entry());
    const latest = entry();
    oversize(latest);
    assert.equal(replay.remember(latest), false);
    assert.equal(replay.entry, null);
    assert.equal(replay.expired, true);
    replay.remember(entry());
    assert.equal(replay.expired, false, 'a later normal clip restores replay');
  }
});

test('replay bounds both displayed text and the retained transcript', () => {
  const replay = new LastSpeechReplay();
  const latest = entry('a'.repeat(3000));
  assert.equal(replay.remember(latest), true);
  assert.equal(replay.entry.text.length, 2000);
  assert.equal(replay.entry.clip.transcript.length, 2000);
  assert.equal(latest.clip.transcript.length, 3000, 'does not mutate the live clip');
});

test('retention counts every audio channel and accepts clips exactly at the limits', () => {
  const replay = new LastSpeechReplay();
  const latest = entry();
  latest.clip.buffer = { duration: 120, length: 4 * 1024 * 1024, numberOfChannels: 2 };
  assert.equal(replay.remember(latest), true, 'exactly 32 MiB');
  latest.clip.buffer.numberOfChannels = 3;
  assert.equal(replay.remember(latest), false, 'all channels count toward the memory bound');
  replay.clear();
  assert.equal(replay.expired, false);
});
