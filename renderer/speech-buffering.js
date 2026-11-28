/**
 * Speech buffering (#278): when the bridge announces ready clips. The choice
 * is kept in localStorage and sent to the bridge whenever the page connects;
 * no stored choice (null) means the bridge's --speech-buffering launch flag.
 * See docs/speech-buffering.md.
 */

export const BUFFERING_KEY = 'yidhari.speech-buffering';
export const BUFFERING_MODES = ['stream', 'full', 'adaptive'];
const LABELS = { stream: 'Stream', full: 'Wait for full reply', adaptive: 'Adaptive' };

/** @param {unknown} mode @returns {string | null} A known mode, else null. */
function known(mode) {
  return BUFFERING_MODES.includes(mode) ? mode : null;
}

/** The renderer → bridge settings frame; null asks for the launch flag's mode. */
export function settingsFrame(mode) {
  return JSON.stringify({ type: 'settings', speechBuffering: known(mode) });
}

/** The stored mode, or null when none (or an unknown one) is stored or storage throws. */
export function storedBuffering(local) {
  try {
    local ??= globalThis.localStorage;
    return known(local?.getItem(BUFFERING_KEY));
  } catch {
    return null;
  }
}

/** @param {string} mode @returns {string} The panel's name for a mode. */
export function bufferingLabel(mode) {
  return LABELS[mode] ?? mode;
}

/**
 * Bind the select ('' is the launch default): start from storage, then save and
 * report each change. The starting mode is sent when the bridge connects.
 * @param {{ value: string, addEventListener(type: string, fn: () => void): void } | null} select
 * @param {(mode: string | null) => void} onChange
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindBufferingSelect(select, onChange, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Session-only. */ }
  if (!select) return;
  select.value = storedBuffering(local) ?? '';
  select.addEventListener('change', () => {
    const mode = known(select.value);
    try {
      if (mode) local?.setItem(BUFFERING_KEY, mode);
      else local?.removeItem(BUFFERING_KEY);
    } catch { /* Session-only. */ }
    onChange(mode);
  });
}
