# Emotion code structure

The restored renderer separates semantic presets, animation, and authoring:

- [expressions.json](../renderer/expressions.json): 46 mood names, intended-use
  descriptions and PMX weights. Neutral clears the mood.
- [expression-catalog.js](../renderer/expression-catalog.js): asynchronous loader
  and validation; no duplicated preset data.
- [expression-controller.js](../renderer/expression-controller.js): resolves
  morphs, tracks missing dependencies, eases one mood, cycles presets with a
  retained intensity, and rescales intensity without stopping the loop.
- [main.js](../renderer/main.js): model/camera/rendering, generated controls,
  blinking/winks, and common expression entry point.
- [morph-audition.js](../renderer/morph-audition.js) and
  [audition-panel.js](../renderer/audition-panel.js): manual slider layer, sweep,
  local candidate storage and JSON export. These are not LLM controls.
- [bridge-client.js](../renderer/bridge-client.js): validates localhost WebSocket
  events, dispatches through the same controller, and displays text safely.

The Python bridge has not been restored in this docs/renderer pass. It previously
read the JSON, parsed split tags, and streamed semantic events. See
[Restoration status](./restoration-status.md).

## Adding an expression

Preview individual morphs and combinations, save a candidate, then export JSON.
Fill in its description and merge it into the shared catalog. Preview transitions
from neutral, from another mood and back to neutral. A missing required morph
disables the preset. Check blink and future speech compatibility before promotion.

Each frame clears influences, then applies blink, winks, mood and additive manual
weights. Shared morph ownership is a known limitation: `super-angry` overlaps
blink and several presets overlap speech mouth controls. The planned facial
compositor will resolve these explicitly. Preset existence does not establish
visual compatibility or speech readiness.
