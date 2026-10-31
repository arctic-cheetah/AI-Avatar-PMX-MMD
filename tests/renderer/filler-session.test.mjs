// Run with: node --test tests/renderer/
import { test } from "node:test";
import assert from "node:assert/strict";
import { FillerSession } from "../../renderer/filler-session.js";

test("reserves one filler and inserts it ahead of the real answer", () => {
  const session = new FillerSession();
  assert.equal(session.reserve("0123456789abcdef"), true);
  assert.equal(session.reserve("fedcba9876543210"), false, "one filler per reply");
  assert.equal(session.takeForAnswer(), "0123456789abcdef");
  assert.equal(session.takeForAnswer(), null, "cannot repeat the same filler");
});

test("a new reply or cancellation clears any unused filler", () => {
  const session = new FillerSession();
  session.reserve("0123456789abcdef");
  session.reset();
  assert.equal(session.takeForAnswer(), null);
  assert.equal(session.reserve("fedcba9876543210"), true);
  assert.equal(session.takeForAnswer(), "fedcba9876543210");
});
