/**
 * Browser adapter for expressions.json, also readable directly by Python.
 * Descriptions document intended usage; preview presets to judge their look.
 * @typedef {{description: string, morphs: Record<string, number>}} Expression
 */
/** @returns {Promise<Record<string, Expression>>} Validated mood presets. */
export async function loadExpressionCatalog() {
  const response = await fetch(new URL('./expressions.json', import.meta.url));
  if (!response.ok) throw new Error(`Expression catalog request failed (${response.status}).`);
  const catalog = await response.json();
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(catalog) || !Object.hasOwn(catalog, 'neutral')) throw new Error('Expression catalog must contain neutral.');
  for (const [name, preset] of Object.entries(catalog)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !isObject(preset) || typeof preset.description !== 'string' || !preset.description.trim() || !isObject(preset.morphs)) throw new Error(`Invalid expression definition: ${name}`);
    for (const [morph, weight] of Object.entries(preset.morphs)) {
      if (!morph.trim() || !Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error(`Invalid morph weight: ${name}`);
    }
    if (name === 'neutral' && Object.keys(preset.morphs).length) throw new Error('Neutral must have an empty morph map.');
  }
  return catalog;
}
