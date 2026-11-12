/**
 * Replay any spoken chat bubble (#152). The bridge keeps each spoken turn on
 * disk under assets/private/speech/turns/<turn>/ with a turn.json manifest of
 * its clips. Paths are built here only from validated IDs, and the manifest is
 * fetched only when the user presses replay.
 */
export const TURN_ID = /^[0-9a-f]{16}$/;
const CLIP_ID = /^[0-9a-f]{16}$/;
const TURNS_DIR = '/assets/private/speech/turns/';
const CLIP_FILE = /^([0-9a-f]{16})\.(wav|visemes\.json)$/;
export const MANIFEST = 'turn.json';
export const MAX_TURN_CLIPS = 64;
const MAX_TEXT = 2000;

/** The URL of one file in a turn's folder: its manifest, or a clip's wav or visemes. */
export function turnFile(turn, name) {
  if (typeof turn !== 'string' || !TURN_ID.test(turn)) throw new Error('Invalid turn ID');
  if (name !== MANIFEST && !CLIP_FILE.test(name)) throw new Error('Invalid turn file');
  return `${TURNS_DIR}${turn}/${name}`;
}

/**
 * The manifest's clips, in order. Clips with a bad ID, unknown mood or bad
 * fields are dropped; weights are clamped to 0..1.
 * @returns {{ id: string, expression: string, weight: number, text: string }[]}
 */
export function parseManifest(data, catalog) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.clips)) {
    throw new Error('Invalid turn manifest');
  }
  const clips = [];
  for (const clip of data.clips) {
    if (clips.length >= MAX_TURN_CLIPS) break;
    if (!clip || typeof clip !== 'object' || typeof clip.id !== 'string' || !CLIP_ID.test(clip.id) ||
      typeof clip.expression !== 'string' || !Object.hasOwn(catalog, clip.expression) ||
      typeof clip.weight !== 'number' || !Number.isFinite(clip.weight) || typeof clip.text !== 'string') continue;
    clips.push({ id: clip.id, expression: clip.expression, weight: Math.max(0, Math.min(1, clip.weight)), text: clip.text.slice(0, MAX_TEXT) });
  }
  return clips;
}

/**
 * Fetch a turn's manifest. status is 'gone' when the bridge pruned the turn
 * (404), 'empty' when it has no clips, else 'ok'. Other failures throw.
 * @returns {Promise<{ status: 'ok'|'empty'|'gone', clips: ReturnType<typeof parseManifest> }>}
 */
export async function fetchTurn(turn, { fetchFn = globalThis.fetch, catalog }) {
  const response = await fetchFn(turnFile(turn, MANIFEST), { cache: 'no-store' });
  if (response.status === 404) return { status: 'gone', clips: [] };
  if (!response.ok) throw new Error(`Turn manifest failed: ${response.status}`);
  const clips = parseManifest(await response.json(), catalog);
  return { status: clips.length > 0 ? 'ok' : 'empty', clips };
}
