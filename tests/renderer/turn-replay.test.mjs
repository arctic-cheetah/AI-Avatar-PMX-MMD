// #152: replay any spoken chat bubble from the turn's clips on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TURN_ID, turnFile, parseManifest, fetchTurn, MAX_TURN_CLIPS } from "../../renderer/turn-replay.js";

const CATALOG = { neutral: {}, happy: {}, thinking: {} };
const TURN = "0123456789abcdef";
const clip = (n, expression = "happy") => ({ id: n.toString(16).padStart(16, "0"), expression, weight: 0.8, text: `Line ${n}.` });

test("turn files are built only from a valid turn and clip ID", () => {
  assert.equal(turnFile(TURN, "turn.json"), `/assets/private/speech/turns/${TURN}/turn.json`);
  assert.equal(turnFile(TURN, `${"1".repeat(16)}.wav`), `/assets/private/speech/turns/${TURN}/${"1".repeat(16)}.wav`);
  assert.equal(turnFile(TURN, `${"1".repeat(16)}.visemes.json`), `/assets/private/speech/turns/${TURN}/${"1".repeat(16)}.visemes.json`);
  for (const bad of ["../etc/passwd", "ABCDEF0123456789", "abc", "", null]) {
    assert.throws(() => turnFile(bad, "turn.json"), undefined, String(bad));
  }
  for (const name of ["../x.wav", "x.wav", `${"1".repeat(16)}.mp3`, "turn.json/../x"]) {
    assert.throws(() => turnFile(TURN, name), undefined, name);
  }
  assert.ok(TURN_ID.test(TURN));
});

test("a manifest keeps its clips in order with their own moods", () => {
  const clips = parseManifest({ version: 1, clips: [clip(1, "happy"), clip(2, "thinking")] }, CATALOG);
  assert.deepEqual(clips, [clip(1, "happy"), clip(2, "thinking")]);
});

test("a manifest's weights are clamped and bad clips are dropped", () => {
  const clips = parseManifest({ version: 1, clips: [
    { ...clip(1), weight: 7 },
    { ...clip(2), id: "../../x" },
    { ...clip(3), expression: "toString" },
    { ...clip(4), text: 5 },
    { ...clip(5), weight: Number.NaN },
    clip(6),
  ] }, CATALOG);
  assert.deepEqual(clips.map((item) => [item.id, item.weight]), [[clip(1).id, 1], [clip(6).id, 0.8]]);
});

test("a manifest with an unknown version or shape is rejected", () => {
  for (const bad of [null, [], { version: 2, clips: [] }, { version: 1 }, { version: 1, clips: {} }]) {
    assert.throws(() => parseManifest(bad, CATALOG), undefined, JSON.stringify(bad));
  }
});

test("a manifest keeps at most MAX_TURN_CLIPS clips", () => {
  const many = Array.from({ length: MAX_TURN_CLIPS + 5 }, (_, n) => clip(n + 1));
  assert.equal(parseManifest({ version: 1, clips: many }, CATALOG).length, MAX_TURN_CLIPS);
});

function fakeFetch(responses) {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const reply = responses[url];
    if (reply === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => reply };
  };
  return { urls, fetchFn };
}

test("a turn that was pruned is too old to replay", async () => {
  const { fetchFn } = fakeFetch({});
  assert.deepEqual(await fetchTurn(TURN, { fetchFn, catalog: CATALOG }), { status: "gone", clips: [] });
});

test("a turn with no clips has nothing to replay", async () => {
  const { fetchFn } = fakeFetch({ [turnFile(TURN, "turn.json")]: { version: 1, clips: [] } });
  assert.deepEqual(await fetchTurn(TURN, { fetchFn, catalog: CATALOG }), { status: "empty", clips: [] });
});

test("a kept turn returns its clips without caching the request", async () => {
  const { urls, fetchFn } = fakeFetch({ [turnFile(TURN, "turn.json")]: { version: 1, clips: [clip(1), clip(2)] } });
  const result = await fetchTurn(TURN, { fetchFn, catalog: CATALOG });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.clips, [clip(1), clip(2)]);
  assert.deepEqual(urls, [turnFile(TURN, "turn.json")]);
});

test("a server error is an error, not a pruned turn", async () => {
  const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(fetchTurn(TURN, { fetchFn, catalog: CATALOG }));
});
