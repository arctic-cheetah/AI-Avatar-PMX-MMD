/**
 * The renderer's ready line (#99): mood presets and PMX morphs are different
 * counts, so label both. Moods are catalog presets (including neutral); PMX
 * morphs are the vertex morphs in the loaded model.
 * @param {{ moods: number, morphs: number, unavailable?: [string, string[]][] }} counts
 *   Catalog size, mesh morph count, and each unavailable preset with its missing morphs.
 * @returns {string} Status text.
 */
export function readyStatus({ moods, morphs, unavailable = [] }) {
  const plural = (count, word) => `${word}${count === 1 ? '' : 's'}`;
  const shown = unavailable.length > 0 ? `${moods - unavailable.length} of ${moods}` : `${moods}`;
  const parts = [`Ready · ${shown} ${plural(moods, 'mood')}`, `${morphs} PMX ${plural(morphs, 'morph')}`];
  if (unavailable.length > 0) {
    parts.push(`unavailable: ${unavailable.map(([name, missing]) => `${name}: ${missing.join(', ')}`).join('; ')}`);
  }
  return parts.join(' · ');
}
