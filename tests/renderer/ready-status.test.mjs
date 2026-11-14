// The renderer's ready line counts moods and PMX morphs separately (#99).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readyStatus } from "../../renderer/ready-status.js";

test("both counts are labelled when every mood is available", () => {
  assert.equal(readyStatus({ moods: 50, morphs: 56 }), "Ready · 50 moods · 56 PMX morphs");
});

test("unavailable moods are counted out and listed with their missing morphs", () => {
  const unavailable = [["cry", ["涙"]], ["pout", ["ぷく", "頬"]]];
  assert.equal(
    readyStatus({ moods: 50, morphs: 56, unavailable }),
    "Ready · 48 of 50 moods · 56 PMX morphs · unavailable: cry: 涙; pout: ぷく, 頬",
  );
});

test("singular counts read naturally", () => {
  assert.equal(readyStatus({ moods: 1, morphs: 1 }), "Ready · 1 mood · 1 PMX morph");
  assert.equal(readyStatus({ moods: 1, morphs: 0, unavailable: [["happy", ["笑い"]]] }),
    "Ready · 0 of 1 mood · 0 PMX morphs · unavailable: happy: 笑い");
});
