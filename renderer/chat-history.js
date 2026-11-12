/**
 * The visible chat log, kept in localStorage so a refresh or a closed tab can
 * rebuild it (#105, #154). Display only: nothing here is sent back to the bridge
 * or the model. Storage can be blocked or full; then the chat simply isn't saved.
 *
 * Every tab of this profile shares the one saved log. Each write first reads the
 * latest copy, so two tabs add to it instead of overwriting each other, and a
 * New chat in one tab is not undone by another. Entries carry a short random id
 * so a spoken turn can be attached to the right one later (#152).
 */

export const CHAT_LOG_KEY = 'yidhari.chat-log.v1';
export const MAX_ENTRIES = 200;
export const MAX_CHARS = 1_000_000;

const WHO = new Set(['you', 'yidhari', 'agent', 'tool']);
const AGENT_KIND = new Set(['say', 'ask', 'report']);
const REPORT_STATUS = new Set(['progress', 'done', 'error']);
const TURN_ID = /^[0-9a-f]{16}$/;
const ENTRY_ID = /^[0-9a-f]{12}$/;

function newId() {
  const bytes = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Storage access itself can throw (blocked site data); then there is none. */
function storageOf(name) {
  try { return globalThis[name]; } catch { return undefined; }
}

/**
 * @typedef {{ who: 'you'|'yidhari'|'agent'|'tool', text: string, source?: string,
 *   kind?: 'say'|'ask'|'report', status?: 'progress'|'done'|'error', interrupted?: true,
 *   turn?: string, id?: string }} ChatEntry turn names the spoken turn kept on disk for
 *   replay (#152); id is internal, for attaching that turn, and is not returned by load().
 */

/** A copy of a well-formed entry with only the known fields, or null. */
function clean(entry) {
  if (!entry || typeof entry !== 'object' || !WHO.has(entry.who) || typeof entry.text !== 'string') return null;
  const out = { who: entry.who, text: entry.text };
  out.id = typeof entry.id === 'string' && ENTRY_ID.test(entry.id) ? entry.id : newId();
  if (entry.who === 'agent') {
    if (typeof entry.source !== 'string' || !AGENT_KIND.has(entry.kind)) return null;
    if (entry.kind === 'report' && !REPORT_STATUS.has(entry.status)) return null;
    out.kind = entry.kind;
    out.source = entry.source;
    if (entry.kind === 'report') out.status = entry.status;
  }
  if (entry.interrupted === true) out.interrupted = true;
  if ((entry.who === 'yidhari' || entry.who === 'agent') && typeof entry.turn === 'string' && TURN_ID.test(entry.turn)) {
    out.turn = entry.turn;
  }
  return out;
}

export class ChatHistory {
  /**
   * storage defaults to localStorage. legacy (default sessionStorage, null for
   * none) is where earlier versions kept the log; it is moved over once.
   * @param {{ storage?: Storage, legacy?: Storage | null, key?: string, maxEntries?: number, maxChars?: number }} [options]
   */
  constructor({ storage, legacy, key = CHAT_LOG_KEY, maxEntries = MAX_ENTRIES, maxChars = MAX_CHARS } = {}) {
    this.storage = storage ?? storageOf('localStorage');
    this.legacy = legacy === undefined ? storageOf('sessionStorage') : legacy;
    if (this.legacy === this.storage) this.legacy = null;
    this.key = key;
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
    /** @type {ChatEntry[]} */
    this.entries = [];
  }

  /**
   * The saved log as stored now: entries, damaged, and whether it could be read
   * at all (readable is false when storage is blocked).
   */
  read() {
    let raw = null;
    try { raw = this.storage?.getItem(this.key) ?? null; } catch { return { entries: [], damaged: false, readable: false }; }
    if (raw === null) return { entries: [], damaged: false, readable: true };
    let saved;
    try { saved = JSON.parse(raw); } catch { return { entries: [], damaged: true, readable: true }; }
    const list = saved?.version === 1 && Array.isArray(saved.entries) ? saved.entries : null;
    if (!list) return { entries: [], damaged: true, readable: true };
    const entries = list.map(clean).filter(Boolean);
    return { entries, damaged: entries.length !== list.length, readable: true };
  }

  /** Move a log saved by an earlier version (sessionStorage) over, once. */
  migrate() {
    try {
      if (!this.storage || !this.legacy || this.storage.getItem(this.key) !== null) return;
      const raw = this.legacy.getItem(this.key);
      if (raw === null) return;
      this.storage.setItem(this.key, raw);
      this.legacy.removeItem(this.key);
    } catch { /* Blocked or full: leave the old copy where it is. */ }
  }

  /** Read the saved log. damaged is true when some or all of it could not be read. */
  load() {
    this.migrate();
    const { entries, damaged } = this.read();
    this.entries = entries;
    this.trim();
    return { entries: this.entries.map(({ id, ...entry }) => entry), damaged };
  }

  /** Pick up what other tabs saved (or cleared) since this tab last wrote. */
  sync() {
    const latest = this.read();
    // Damaged or blocked: keep this tab's copy, and the next save writes over it.
    if (latest.readable && !latest.damaged) this.entries = latest.entries;
  }

  /** Append an entry and save; false if it was invalid or storage refused it. */
  add(entry) {
    const cleaned = clean(entry);
    if (!cleaned) return false;
    this.sync();
    this.entries.push(cleaned);
    this.trim();
    return this.save();
  }

  /** Save a spoken turn on the entry with this id (#152); false if it is gone. */
  setTurn(id, turn) {
    if (typeof turn !== 'string' || !TURN_ID.test(turn)) return false;
    this.sync();
    const entry = this.entries.find((item) => item.id === id);
    if (!entry || (entry.who !== 'yidhari' && entry.who !== 'agent')) return false;
    entry.turn = turn;
    return this.save();
  }

  /** The saved entry just added, so a later spoken turn can be attached to it (#152). */
  last() {
    return this.entries.at(-1) ?? null;
  }

  /** Forget the saved log (New chat). */
  clear() {
    this.entries = [];
    try {
      this.storage?.removeItem(this.key);
      return Boolean(this.storage);
    } catch { return false; }
  }

  /** Drop the oldest entries beyond the count and character limits. */
  trim() {
    let chars = this.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    while (this.entries.length > this.maxEntries || (chars > this.maxChars && this.entries.length > 0)) {
      chars -= this.entries.shift().text.length;
    }
  }

  /** Write the log; on a quota error, drop the older half and try once more. */
  save() {
    if (!this.storage) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.storage.setItem(this.key, JSON.stringify({ version: 1, entries: this.entries }));
        return true;
      } catch {
        if (attempt === 0) this.entries.splice(0, Math.ceil(this.entries.length / 2));
      }
    }
    return false;
  }
}
