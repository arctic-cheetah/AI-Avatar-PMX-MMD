// Every mood preset names only morphs that exist in Yidhari's PMX (#99).
// A typo would leave the mood unavailable in the renderer without any error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CATALOG = JSON.parse(await readFile(new URL("../../renderer/expressions.json", import.meta.url), "utf8"));
// The 56 vertex morphs of 伊德海莉.pmx (docs/pmx-morph-catalog.md).
const MODEL_MORPHS = new Set([
  "まばたき", "笑い", "ウィンク２", "ウィンク２右", "ウィンク", "ウィンク右", "びっくり", "びっくり左", "びっくり右",
  "怒り目", "怒り目２", "じと目", "下眼上", "眼角下", "悲しむ",
  "あ", "い", "う", "え", "お", "□", "ワ", "え２", "い２", "ワ２", "お２", "にやり", "にやり２", "口角上げ", "口角下げ",
  "口横広げ", "口横狭め", "口上", "口下", "口左", "口右", "齿下", "齿上",
  "真面目", "困る", "怒り", "にこり", "上", "下", "前", "怒り左", "怒り右", "困る右", "にこり左", "にこり右",
  "上左", "上右", "下左", "下右", "前左", "前右",
]);

test("the morph list matches the model's 56 vertex morphs", () => {
  assert.equal(MODEL_MORPHS.size, 56);
});

test("every mood preset uses only the model's morphs", () => {
  for (const [name, preset] of Object.entries(CATALOG)) {
    const unknown = Object.keys(preset.morphs).filter((morph) => !MODEL_MORPHS.has(morph));
    assert.deepEqual(unknown, [], name);
  }
});
