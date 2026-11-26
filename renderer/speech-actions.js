/**
 * Animation actions while she speaks (#269). The bridge sends an action
 * reference with a speech clip, as a text-only action event, or from the
 * agent's play_action: a catalog action ("tilt-left", "tentacle-perk") or a
 * Blender pose ("pose:elated-fist"). See docs/speech-actions.md.
 */
import catalog from "./actions.json" with { type: "json" };

/** @typedef {{ label: string, description: string, speech: boolean, layer?: "body" | "tentacle", target?: string }} ActionEntry */

/** @type {Readonly<Record<string, ActionEntry>>} The shared catalog, also read by the bridge. */
export const ACTION_CATALOG = Object.freeze(catalog);
export const POSE_PREFIX = "pose:";
/** Seconds a pose is held while she speaks, unless its sidecar says otherwise. */
export const SPEECH_POSE_HOLD = 2;
const HOLD_RANGE = [0.5, 4];
/** localStorage key of the Gestures while speaking toggle. */
export const SPEECH_ACTIONS_KEY = "yidhari.speechActions";
// The bridge checks pose names with the upload rule; this only keeps paths and controls out.
const POSE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_-]{0,63}$/u;

/**
 * @param {unknown} ref An action reference from the bridge.
 * @param {Record<string, ActionEntry>} [actions]
 * @returns {{ layer: "body" | "tentacle" | "pose", name: string, ref: string } | null}
 */
export function parseActionRef(ref, actions = ACTION_CATALOG) {
  if (typeof ref !== "string" || ref.length > 300) return null;
  if (ref.startsWith(POSE_PREFIX)) {
    const name = ref.slice(POSE_PREFIX.length).normalize("NFC");
    return POSE_NAME.test(name) ? { layer: "pose", name, ref: POSE_PREFIX + name } : null;
  }
  if (!Object.hasOwn(actions, ref)) return null;
  const entry = actions[ref];
  if (entry.layer === "tentacle") return { layer: "tentacle", name: entry.target, ref };
  return { layer: "body", name: ref, ref };
}

/**
 * Why a speech or agent action cannot play now, or null when it can. Unlike
 * the panel buttons (manualPlayBlocked), speech does not block it.
 * @param {{ loaded: boolean, enabled: boolean, held: boolean, previewing: boolean, state: string }} status
 * @returns {string|null}
 */
export function speechActionBlocked({ loaded, enabled, held, previewing, state }) {
  if (!loaded) return "Waiting for the model";
  if (!enabled) return "Gestures while speaking is off";
  if (held) return "A pose is held for a preview";
  if (previewing) return "A morph preview is showing";
  if (state === "stretching") return "Stretching into sleepy";
  if (state === "waking") return "Waking up";
  return null;
}

/**
 * A speech pose never replaces a pose the user started from a button or ?pose=.
 * @param {{ playing: boolean, startedBy: string | null }} status
 * @returns {boolean}
 */
export function speechMayPlayPose({ playing, startedBy }) {
  return !playing || (startedBy !== "user" && startedBy !== "url");
}

/**
 * A pose sidecar's speech settings (`<name>.json`): speech on by default, the hold clamped.
 * @param {unknown} data Parsed JSON, or null when there is none.
 * @returns {{ speech: boolean, speechHold: number }}
 */
export function poseSpeechSettings(data) {
  const settings = data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  const hold = typeof settings.speechHold === "number" && Number.isFinite(settings.speechHold)
    ? Math.min(HOLD_RANGE[1], Math.max(HOLD_RANGE[0], settings.speechHold))
    : SPEECH_POSE_HOLD;
  return { speech: typeof settings.speech === "boolean" ? settings.speech : true, speechHold: hold };
}

/**
 * Bind the Gestures while speaking tick: on by default, saved as "0"/"1".
 * @param {{ checked: boolean, addEventListener(type: string, fn: () => void): void } | null} box
 * @param {(enabled: boolean) => void} onChange Called now and on every change.
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindSpeechActionsSetting(box, onChange, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  let enabled = true;
  try {
    enabled = local?.getItem(SPEECH_ACTIONS_KEY) !== "0";
  } catch { /* Blocked: on. */ }
  if (box) box.checked = enabled;
  onChange(enabled);
  box?.addEventListener("change", () => {
    onChange(box.checked);
    try {
      local?.setItem(SPEECH_ACTIONS_KEY, box.checked ? "1" : "0");
    } catch { /* Session-only. */ }
  });
}
