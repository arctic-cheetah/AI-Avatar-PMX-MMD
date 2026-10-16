# Shared expression catalog

[expressions.json](../renderer/expressions.json) is the source of truth for 46
presets. Each entry contains `description` and `morphs`; neutral has an empty map.
Names and original weights were preserved from the recovered catalog. Descriptions
were restored from the conversation and describe intended use, not visual proof.

[expression-catalog.js](../renderer/expression-catalog.js) fetches and validates
the JSON before renderer startup. Names are lowercase kebab-case, descriptions
are nonempty, and morph weights must be finite numbers in 0–1. Load failures
appear in the page status; hover over a preset for its description.

The test bench's **Copy as catalog JSON** exports a JSON object. Fill in the TODO
usage descriptions and merge its entries into the existing catalog; do not
replace the entire catalog with the export. JSON has no comments or trailing
commas. Reload after editing.

The backend should read the same JSON relative to its source path and generate
its tag allowlist and LLM prompt from names/descriptions. No morph details belong
in the LLM prompt. The recovered Python scaffold does not do this yet; see
[Restoration status](./restoration-status.md).
