# Shared expression catalog

[expressions.json](../renderer/expressions.json) is the source of truth for 46
presets. Each entry contains `description` and `morphs`, plus optional `aliases`;
neutral has an empty map. Original weights were preserved from the recovered
catalog. Descriptions were restored from the conversation and describe intended
use, not visual proof.

[expression-catalog.js](../renderer/expression-catalog.js) fetches and validates
the JSON before renderer startup. Names are lowercase kebab-case, descriptions
are nonempty, and morph weights must be finite numbers in 0–1. `aliases`, when
present, is a list of lowercase kebab-case names; no alias may repeat or match a
preset name. Load failures appear in the page status; hover over a preset for
its description.

The test bench's **Copy as catalog JSON** exports a JSON object. Fill in the TODO
usage descriptions and merge its entries into the existing catalog; do not
replace the entire catalog with the export. JSON has no comments or trailing
commas. Reload after editing.

The backend should read the same JSON relative to its source path and generate
its tag allowlist and LLM prompt from names/descriptions. No morph details belong
in the LLM prompt. The recovered Python scaffold does not do this yet; see
[Restoration status](./restoration-status.md).

## Renamed moods and aliases

Some recovered names described how a preset was built, or were informal, rather
than what the face shows. Issue #99 renamed them. Each old name stays as an alias
of its new preset:

| Old tag | New tag | Why | Use it for |
| --- | --- | --- | --- |
| `sad-v2` | `sorrowful` | "v2" was a version label, not an emotion | Deep, open sorrow with brows and mouth, beyond quiet `sad` |
| `sad-sceptical` | `rueful` | Fixes the clash with `skeptical`'s spelling and names the blend | Wry, regretful sadness mixed with doubt |
| `wtf-dude` | `exasperated` | Too informal for prompts and logs | Fed-up disbelief at something absurd |
| `super-angry` | `furious` | Plain intensity word | Peak anger. Its `まばたき` 0.3 narrows the glare on purpose and combines with the idle blink |

How they differ from similar moods:

- **`sad` → `sorrowful` → `cry`** get stronger in that order: eyes only, then
  eyes, brows and mouth, then near tears.
- **`rueful`** is sad, with a crooked smile. **`skeptical`** doubts a claim
  without any sadness.
- **`exasperated`** is worn-out disbelief. **`annoyed`** is milder irritation,
  and **`unimpressed`** is flat, with no disbelief.
- **`angry` → `furious`**: use `furious` rarely, for real outrage.

Aliases work wherever a mood name comes in: inline tags in LLM or agent text
(`[sad-v2]` becomes `sorrowful`), the agent socket's `say` mood and
`set_mood` name, and agent-host hooks. The bridge maps each alias to its new
name as the name arrives, so the renderer, prosody and speech only ever see new
names. Prompts and MCP tool schemas list only the new names, so models learn
them. An MCP client that sends an old name gets refused by the enum and should
re-read its tool list after restarting. Unknown names are still dropped (tags)
or refused (agent tools) as before.

To rename a preset, move its entry to the new key and add the old key to
`aliases`. Never delete an alias that has been public.
