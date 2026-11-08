/**
 * Resting face setting (#99): which calm preset neutral settles into.
 * The checkbox is on by default; turning it off rests on the bare mesh,
 * which smiles slightly. The choice persists in localStorage when it can.
 */
export const RESTING_FACE_KEY = 'yidhari.resting-face';
export const DEFAULT_RESTING_FACE = 'calm';

/**
 * Bind the resting-face checkbox to an expression controller.
 * @param {{ setRestingFace(name: string | null): boolean }} expressions Expression controller.
 * @param {{ checked: boolean, addEventListener(type: string, fn: () => void): void } | null} toggle Checkbox.
 * @param {{ local?: Storage, name?: string }} [options] Storage and preset to rest in.
 * @returns {void}
 */
export function bindRestingFaceToggle(expressions, toggle, { local, name = DEFAULT_RESTING_FACE } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw; the setting is then session-only. */ }
  let enabled = true;
  try { enabled = local?.getItem(RESTING_FACE_KEY) !== '0'; } catch { /* Default on. */ }
  const apply = (on) => expressions.setRestingFace(on ? name : null);
  apply(enabled);
  if (!toggle) return;
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    apply(toggle.checked);
    try { local?.setItem(RESTING_FACE_KEY, toggle.checked ? '1' : '0'); } catch { /* Session-only. */ }
  });
}
