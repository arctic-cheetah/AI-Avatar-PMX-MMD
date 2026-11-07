import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LastSpeechReplay } from '../../renderer/speech-replay.js';

function entry(text = 'Hello again!', turn = 1) {
  return {
    clip: { buffer: { duration: 2, length: 96000, numberOfChannels: 1 },
      visemes: [{ start: 0, end: 2, shape: 'B' }], transcript: text },
    expression: 'happy', weight: 0.7, text, turn,
  };
}

test('retains every clip of one spoken turn, in order, sharing audio and lip sync', () => {
  const replay = new LastSpeechReplay();
  assert.deepEqual(replay.entries, []);
  const first = entry('I feel present.');
  const second = entry('Before this face, I was only words.');
  second.expression = 'soft-smile';
  second.weight = 0.4;
  assert.equal(replay.remember(first), true);
  assert.equal(replay.remember(second), true);
  assert.equal(replay.entries.length, 2);
  assert.equal(replay.entries[0].clip.buffer, first.clip.buffer);
  assert.equal(replay.entries[0].clip.visemes, first.clip.visemes);
  assert.equal(replay.entries[1].text, second.text);
  assert.equal(replay.entries[1].expression, 'soft-smile');
  assert.equal(replay.entries[1].weight, 0.4);
  assert.equal(replay.partial, false);
});

test('a later turn replaces the previous turn instead of appending forever', () => {
  const replay = new LastSpeechReplay();
  replay.remember(entry('First turn.', 1));
  replay.remember(entry('Still the first turn.', 1));
  const next = entry('A new say.', 2);
  assert.equal(replay.remember(next), true);
  assert.equal(replay.entries.length, 1);
  assert.equal(replay.entries[0].clip.buffer, next.clip.buffer);
  assert.equal(replay.turn, 2);
});

test('new chat clears replay without touching the conversation or audio source', () => {
  const replay = new LastSpeechReplay();
  const kept = entry();
  replay.remember(kept);
  replay.remember(entry('Second sentence.'));
  replay.clear();
  assert.deepEqual(replay.entries, []);
  assert.equal(replay.expired, false);
  assert.equal(replay.partial, false);
  assert.equal(kept.clip.buffer.duration, 2);
});

test('an oversized later clip keeps the start of the turn', () => {
  for (const oversize of [
    e => { e.clip.buffer.duration = 119; },
    e => { e.clip.buffer.length = 8 * 1024 * 1024; },
    e => { e.clip.visemes = new Array(20000); },
  ]) {
    const replay = new LastSpeechReplay();
    const first = entry('Keep me.');
    replay.remember(first);
    const latest = entry('Too big to append.');
    oversize(latest);
    assert.equal(replay.remember(latest), false);
    assert.equal(replay.entries.length, 1);
    assert.equal(replay.entries[0].text, 'Keep me.');
    assert.equal(replay.partial, true);
    assert.equal(replay.expired, false);
  }
});

test('an oversized first clip of a new turn expires replay instead of keeping the old turn', () => {
  const replay = new LastSpeechReplay();
  replay.remember(entry('Previous turn.', 1));
  const huge = entry('Too long to start.', 2);
  huge.clip.buffer.duration = 121;
  assert.equal(replay.remember(huge), false);
  assert.deepEqual(replay.entries, []);
  assert.equal(replay.expired, true);
  assert.equal(replay.remember(entry('A later sentence of that turn.', 2)), true);
  assert.equal(replay.expired, false, 'a later fitting clip of the same turn restores replay');
  assert.equal(replay.entries[0].text, 'A later sentence of that turn.');
});

test('replay bounds both displayed text and the retained transcript', () => {
  const replay = new LastSpeechReplay();
  const latest = entry('a'.repeat(3000));
  assert.equal(replay.remember(latest), true);
  assert.equal(replay.entries[0].text.length, 2000);
  assert.equal(replay.entries[0].clip.transcript.length, 2000);
  assert.equal(latest.clip.transcript.length, 3000, 'does not mutate the live clip');
});

test('retention counts every audio channel and accepts a turn exactly at the limits', () => {
  const replay = new LastSpeechReplay();
  const latest = entry();
  latest.clip.buffer = { duration: 120, length: 4 * 1024 * 1024, numberOfChannels: 2 };
  assert.equal(replay.remember(latest), true, 'exactly 32 MiB and 120 seconds');
  const extra = entry('One more byte.');
  extra.clip.buffer = { duration: 0, length: 1, numberOfChannels: 1 };
  assert.equal(replay.remember(extra), false, 'the turn total counts every channel');
  assert.equal(replay.partial, true);
  assert.equal(replay.entries.length, 1);
  replay.clear();
  assert.equal(replay.expired, false);
  assert.equal(replay.partial, false);
});

test('replay queue items keep turn order and are marked so playback does not retain them again', async () => {
  const { replayQueueItems } = await import('../../renderer/speech-replay.js');
  const replay = new LastSpeechReplay();
  replay.remember(entry('One.', 4));
  replay.remember(entry('Two.', 4));
  const queued = replayQueueItems(replay.entries);
  assert.equal(queued.length, 2);
  assert.equal(queued[0].text, 'One.');
  assert.equal(queued[1].expression, 'happy');
  assert.equal(queued[0].replay, true);
  assert.equal(queued[1].replay, true);
  assert.equal(queued[0].turn, undefined, 'replay does not open a new live turn');
});
