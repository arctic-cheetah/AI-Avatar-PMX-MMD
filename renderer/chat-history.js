/**
 * The visible chat log, kept in this tab's sessionStorage so a page refresh can
 * rebuild it (#105). Display only: nothing here is sent back to the bridge or
 * the model. Storage can be blocked or full; then the chat simply isn't saved.
 */

export const CHAT_LOG_KEY = 'yidhari.chat-log.v1';
export const MAX_ENTRIES = 200;
export const MAX_CHARS = 1_000_000;

const WHO = new Set(['you', 'yidhari', 'agent', 'tool']);
const AGENT_KIND = new Set(['say', 'ask', 'report']);
const REPORT_STATUS = new Set(['progress', 'done', 'error']);

/**
 * @typedef {{ who: 'you'|'yidhari'|'agent'|'tool', text: string, source?: string,
 *   kind?: 'say'|'ask'|'report', status?: 'progress'|'done'|'error', interrupted?: true }} ChatEntry
 */

/** A copy of a well-formed entry with only the known fields, or null. */
function clean(entry) {
  if (!entry || typeof entry !== 'object' || !WHO.has(entry.who) || typeof entry.text !== 'string') return null;
  const out = { who: entry.who, text: entry.text };
  if (entry.who === 'agent') {
    if (typeof entry.source !== 'string' || !AGENT_KIND.has(entry.kind)) return null;
    if (entry.kind === 'report' && !REPORT_STATUS.has(entry.status)) return null;
    out.kind = entry.kind;
    out.source = entry.source;
    if (entry.kind === 'report') out.status = entry.status;
  }
  if (entry.interrupted === true) out.interrupted = true;
  return out;
}

export class ChatHistory {
  /** @param {{ storage?: Storage, key?: string, maxEntries?: number, maxChars?: number }} [options] */
  constructor({ storage, key = CHAT_LOG_KEY, maxEntries = MAX_ENTRIES, maxChars = MAX_CHARS } = {}) {
    try {
      storage ??= globalThis.sessionStorage;
    } catch { /* Storage access itself can throw. */ }
    this.storage = storage;
    this.key = key;
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
    /** @type {ChatEntry[]} */
    this.entries = [];
  }

  /** Read the saved log. damaged is true when some or all of it could not be read. */
  load() {
    this.entries = [];
    let raw = null;
    try { raw = this.storage?.getItem(this.key) ?? null; } catch { /* Blocked: nothing to restore. */ }
    if (raw === null) return { entries: [], damaged: false };
    let saved;
    try { saved = JSON.parse(raw); } catch { return { entries: [], damaged: true }; }
    const list = saved?.version === 1 && Array.isArray(saved.entries) ? saved.entries : null;
    if (!list) return { entries: [], damaged: true };
    this.entries = list.map(clean).filter(Boolean);
    this.trim();
    return { entries: this.entries.map((entry) => ({ ...entry })), damaged: this.entries.length !== list.length };
  }

  /** Append an entry and save; false if it was invalid or storage refused it. */
  add(entry) {
    const cleaned = clean(entry);
    if (!cleaned) return false;
    this.entries.push(cleaned);
    this.trim();
    return this.save();
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
