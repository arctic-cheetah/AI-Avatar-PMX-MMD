/** Time-of-day greeting (#72): a fixed phrase for the local hour, no LLM, nothing leaves the machine. */

export const GREETING_ENABLED_KEY = 'yidhari.greeting-enabled';
export const GREETING_SHOWN_KEY = 'yidhari.greeting-shown';

/** Small fixed phrase list; the mood fits the phrase and must exist in expressions.json. */
export const GREETINGS = {
  morning: [
    { text: 'Good morning! Ready for today?', mood: 'soft-smile', weight: 0.9 },
    { text: 'Good morning! Lovely to see you — ready for today?', mood: 'happy', weight: 0.8 },
  ],
  afternoon: [
    { text: "Good afternoon! How's your day going?", mood: 'happy', weight: 0.8 },
    { text: 'Good afternoon! Hope your day is going gently.', mood: 'soft-smile', weight: 0.8 },
  ],
  evening: [
    { text: 'Good evening! How was your day?', mood: 'soft-smile', weight: 0.9 },
    { text: 'Good evening! Time to wind down a little, perhaps?', mood: 'tender', weight: 0.8 },
  ],
  late: [
    { text: "You're up late — don't forget to rest 😉", mood: 'sleepy', weight: 0.7 },
    { text: "It's late — please don't forget to rest 😉", mood: 'tender', weight: 0.8 },
  ],
};

/** @param {unknown} hour @returns {'morning'|'afternoon'|'evening'|'late'|null} */
export function bucketForHour(hour) {
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'late';
}

/** Pick one fixed phrase for the date's local hour; deterministic within a day. */
export function greetingForDate(date) {
  const bucket = bucketForHour(date.getHours());
  if (!bucket) return null;
  const phrases = GREETINGS[bucket];
  return { bucket, ...phrases[date.getDate() % phrases.length] };
}

/**
 * Once-per-session gate. The shown flag lives in sessionStorage (a reload in
 * the same tab stays silent; a new session greets again), the on/off switch in
 * localStorage. Blocked storage falls back to memory, so the rule still holds.
 */
export class GreetingGate {
  constructor({ session, local } = {}) {
    this.session = session;
    this.local = local;
    this.memoryShown = false;
    this.memoryEnabled = null;
    try {
      this.session ??= globalThis.sessionStorage;
      this.local ??= globalThis.localStorage;
    } catch { /* Storage access itself can throw; memory fallback applies. */ }
  }

  get enabled() {
    if (this.memoryEnabled !== null) return this.memoryEnabled;
    try { return this.local?.getItem(GREETING_ENABLED_KEY) !== '0'; } catch { return true; }
  }

  setEnabled(value) {
    this.memoryEnabled = Boolean(value);
    try { this.local?.setItem(GREETING_ENABLED_KEY, value ? '1' : '0'); } catch { /* Session-only switch. */ }
  }

  get shown() {
    if (this.memoryShown) return true;
    try { return this.session?.getItem(GREETING_SHOWN_KEY) === '1'; } catch { return false; }
  }

  /** Return the greeting once per session when enabled, otherwise null. */
  claim(date = new Date()) {
    if (!this.enabled || this.shown) return null;
    const greeting = greetingForDate(date);
    if (!greeting) return null;
    this.memoryShown = true;
    try { this.session?.setItem(GREETING_SHOWN_KEY, '1'); } catch { /* Memory flag above still applies. */ }
    return greeting;
  }
}

/** Bind the opt-out checkbox; returns the gate so callers can claim the greeting. */
export function bindGreetingToggle(gate, toggle) {
  if (!toggle) return gate;
  toggle.checked = gate.enabled;
  toggle.addEventListener('change', () => gate.setEnabled(toggle.checked));
  return gate;
}
