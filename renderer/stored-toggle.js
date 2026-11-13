/**
 * Bind a checkbox whose on/off choice persists in localStorage when it can.
 * Storage access can throw (private mode, blocked site data); the choice then
 * lasts for the session only.
 * @param {{ checked: boolean, addEventListener(type: string, fn: () => void): void } | null} toggle Checkbox.
 * @param {string} key localStorage key; '0' means off, anything else on.
 * @param {(on: boolean) => void} apply Called with the starting state and on every change.
 * @param {{ local?: Storage, defaultOn?: boolean }} [options] Storage to use instead of
 *   localStorage, and the state when nothing is stored (on unless false).
 * @returns {void}
 */
export function bindStoredToggle(toggle, key, apply, { local, defaultOn = true } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  let enabled = defaultOn;
  try {
    const stored = local?.getItem(key);
    if (stored != null) enabled = stored !== '0';
  } catch { /* Keep the default. */ }
  apply(enabled);
  if (!toggle) return;
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    apply(toggle.checked);
    try { local?.setItem(key, toggle.checked ? '1' : '0'); } catch { /* Session-only. */ }
  });
}
