# Shared expression catalog

[expressions.json](../renderer/expressions.json) is the source of truth for 50
presets. Each entry contains `description` and `morphs`, plus optional `aliases`
and `ease`;
neutral has an empty map. Original weights were preserved from the recovered
catalog. Descriptions were restored from the conversation and describe intended
use, not visual proof.

[expression-catalog.js](../renderer/expression-catalog.js) fetches and validates
the JSON before renderer startup. Names are lowercase kebab-case, descriptions
are nonempty, and morph weights must be finite numbers in 0–1. `aliases`, when
present, is a list of lowercase kebab-case names; no alias may repeat or match a
preset name. `ease`, when present, is the preset's own spring rate in 1/s
(above 0, at most 60). The renderer uses it while that preset is shown, instead
of the usual mood rate of 14, so a face can drift in slowly. The next preset
uses its own rate, so leaving a slow face is not slow. Only `sleepy` sets one
(3, so her eyelids droop over about 1.6 s, #71). The bridge ignores it. Load failures appear
in the page status; hover over a preset for its description.

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
(`[sad-v2]` becomes `sorrowful`), the bridge's own `set_expression` LLM
tool, the agent socket's `say` mood and `set_mood` name, and agent-host hooks. The bridge maps each alias to its new
name as the name arrives, so the renderer, prosody and speech only ever see new
names. Prompts and MCP tool schemas list only the new names, so models learn
them. An MCP client that sends an old name gets refused by the enum and should
re-read its tool list after restarting. Unknown names are still dropped (tags)
or refused (agent tools) as before.

To rename a preset, move its entry to the new key and add the old key to
`aliases`. Never delete an alias that has been public.

## Retuned presets (#99 step 2)

Changes are based on before/after captures. Private-model images stay local in
`assets/private/issue-99/`. Only the morph weights changed: names, descriptions
and the number of presets did not.

| Preset | Before | After | Why |
| --- | --- | --- | --- |
| `thinking` | `じと目` 1 | `じと目` 0.25, `眼角下` 0.4, `上左` 0.6, `口左` 1, `口角下げ` 0.3 | The full half-lid looked the same as `unimpressed`. Softer lids, one raised brow and a mouth pulled to the side read as thoughtful. |
| `sorrowful` | `悲しむ`, `真面目`, `困る`, `口角下げ` all 1 | `悲しむ` 1, `困る` 0.6, `口角下げ` 0.7 | Both sad brows at full weight pushed the brows through the bangs. One brow at a moderate weight keeps the sorrow without the clipping. |
| `rueful` | Same stack as above + `にやり２` 1 | `悲しむ` 0.6, `困る` 0.5, `にやり２` 0.8, `じと目` 0.25 | The smirk was lost under the sad stack. Now the crooked smile shows clearly. |
| `disappointed` | Same stack + `じと目` 1 | `じと目` 0.55, `悲しむ` 0.45, `真面目` 0.5, `口角下げ` 0.75 | A flat, deflated look with no brow clipping. |
| `exasperated` | Same stack + `じと目` 1, `口横狭め` 1, `怒り` 0.2 | `じと目` 0.75, `上左` 0.65, `口横狭め` 0.6, `口角下げ` 0.5, `怒り` 0.15 | Heavy lids and a tight mouth; it no longer looks the same as `disappointed`. |
| `furious` | Unchanged | Unchanged | Its `まばたき` 0.3 deliberately sharpens the glare. Eyelid morphs are kept unless a better eyelid shape replaces them. |

`cry` still stacks both sad brows. It's meant to be the extreme end, so it was
left for a later review.

Checks (renderer, mocked bridge, sway and cursor gaze off, auto-blink on):

- **Intensity:** at 0.25, 0.5 and 1 each preset scales smoothly with no new
  clipping.
- **Transitions:** neutral → mood → another mood → neutral, including rapid
  400 ms switches, leaves no morph above 0.01 after neutral. The largest
  change in a single frame is about 0.07.
- **`furious` + auto-blink:** `まばたき` stays at 0.3 or above between blinks
  and reaches 1 at each blink.
- **Speaking:** the Play-sample lip-sync keeps its full viseme range
  (`あ` ≈ 0.9, `う` ≈ 0.75) in `thinking`, `sorrowful` and `rueful`, while the
  mood's own mouth shape holds. In `thinking` the mouth talks slightly to one
  side, which is intended.

## Calm presets and the resting face (#99 step 3)

The bare mesh already smiles a little, so a plain `[neutral]` looked slightly
gleeful. Four calm presets tone that down. None of them borrows from another
mood such as `worried` or `unimpressed`:

| Preset | Morphs | Looks | Use it for |
| --- | --- | --- | --- |
| `serene` | `口角下げ` 0.3 | The built-in smile, just softened | Gently at ease and content |
| `composed` | `口角下げ` 0.35, `じと目` 0.15 | Calm, lids slightly relaxed | Calm and collected, in control |
| `attentive` | `口角下げ` 0.3, `下眼上` 0.2, `真面目` 0.2 | Quietly focused eyes | Listening closely to the user |
| `calm` | `口角下げ` 0.45, `眼角下` 0.25 | The calmest, softest face | Plain calm; also the default resting face |

**One neutral, one resting face.** `[neutral]` is still the only reset tag:
it clears every mood and its catalog entry stays empty. What changed is what
the face settles into afterwards. Once a mood clears (`[neutral]`, the end of a
reply, a bridge reset), the face eases into the **resting face**,
`calm` by default, instead of the bare mesh. There are deliberately not two
"neutral" tags, since a model would choose between them inconsistently; the
other calm faces are ordinary moods it can pick on purpose.

- **A mood replaces the resting face** rather than stacking on it, so `happy`
  does not keep `calm`'s lowered mouth corners. It returns when the mood clears.
- **The setting:** the renderer's *Calm resting face* checkbox, under
  Independent channels, is on by default and remembered in `localStorage`
  (`yidhari.resting-face`). Untick it to rest on the bare mesh again.
- **Renderer only.** The bridge, prompts and prosody still see `neutral`; the
  calm presets use neutral prosody. An agent's `set_mood` rest mood (#27) still
  takes priority after speech.
- **Authoring on the bare mesh:** *Edit in sliders*, a sweep, loading a
  candidate and `__yidhariPreview.hold()` turn the resting face off (and untick
  the box) without saving, so the sliders and comparison grids show only their
  own morphs. A reload restores the saved setting. Moving a slider by hand
  leaves it alone, because sliders add on top of every channel.
