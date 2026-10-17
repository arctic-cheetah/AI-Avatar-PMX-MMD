// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSpeechSession } from "../../renderer/speech-session.js";

test("relaxes only after a spoken response has finished and gone idle", () => {
  const session = new LiveSpeechSession();
  session.clipQueued();
  assert.equal(session.shouldRelax(true), false, "response still streaming");
  session.responseFinished();
  assert.equal(session.shouldRelax(false), false, "a clip is still playing or queued");
  assert.equal(session.shouldRelax(true), true);
});

test("does not relax a response that never spoke (text-only mode, sample test)", () => {
  const session = new LiveSpeechSession();
  session.responseFinished();
  assert.equal(session.shouldRelax(true), false);
});

test("relaxes once per response, and a new response starts fresh", () => {
  const session = new LiveSpeechSession();
  session.clipQueued();
  session.responseFinished();
  session.relaxed();
  assert.equal(session.shouldRelax(true), false, "already relaxed");
  session.reset();
  assert.equal(session.shouldRelax(true), false, "new response has not finished");
  session.clipQueued();
  session.responseFinished();
  assert.equal(session.shouldRelax(true), true);
});

test("the last clip ending before the response finishes waits for the finish", () => {
  const session = new LiveSpeechSession();
  session.clipQueued();
  assert.equal(session.shouldRelax(true), false, "LLM may still send more sentences");
  session.responseFinished();
  assert.equal(session.shouldRelax(true), true);
});
