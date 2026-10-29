// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFrame, resetFrame, agentEvent } from "../../renderer/bridge-client.js";

test("typed and spoken prompts share one start frame; history lives in the bridge", () => {
  assert.deepEqual(JSON.parse(startFrame("another one")), { type: "start", prompt: "another one" });
  assert.deepEqual(JSON.parse(startFrame(null)), { type: "start" });
});

test("new chat sends a reset frame", () => {
  assert.deepEqual(JSON.parse(resetFrame()), { type: "reset" });
});

const CATALOG = { neutral: {}, happy: {}, thinking: {} };

test("agent say events keep the source and text for the chat log", () => {
  assert.deepEqual(agentEvent({ type: "agent", kind: "say", source: "Claude Code", text: "On it." }, CATALOG),
    { kind: "say", source: "Claude Code", text: "On it." });
});

test("agent mood events are checked against the catalog and clamped", () => {
  assert.deepEqual(agentEvent({ type: "agent", kind: "mood", source: "Agent", name: "thinking", weight: 3 }, CATALOG),
    { kind: "mood", source: "Agent", name: "thinking", weight: 1 });
  assert.throws(() => agentEvent({ type: "agent", kind: "mood", source: "Agent", name: "evil", weight: 1 }, CATALOG));
  assert.throws(() => agentEvent({ type: "agent", kind: "mood", source: "Agent", name: "toString", weight: 1 }, CATALOG));
});

test("malformed agent events are rejected", () => {
  for (const event of [
    { type: "agent", kind: "say", source: "Agent" },
    { type: "agent", kind: "say", source: 1, text: "x" },
    { type: "agent", kind: "shell", source: "Agent", text: "x" },
    { type: "agent", kind: "mood", source: "Agent", name: "happy", weight: NaN },
  ]) assert.throws(() => agentEvent(event, CATALOG));
});
