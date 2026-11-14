/** Stable heading IDs keep saved choices independent of visible heading text. */
const SECTIONS = [
  ["chat", "bridge-heading", "Chat", false],
  ["speech", "speech-heading", "Speech test", true],
  ["presets", "presets-heading", "Mood presets", true],
  ["channels", "channels-heading", "Independent channels", true],
  ["actions", "actions-heading", "Actions", true],
  ["action-play", "action-play-heading", "Animation actions", true],
  ["audition", "audition-heading", "Morph audition", true],
  ["candidates", "candidates-heading", "Candidates", true],
];

export const COLLAPSIBLE_PANEL_KEY = "yidhari.panelSections";

/**
 * Read the saved disclosure states. Chat is permanently visible; secondary
 * sections are closed for a new or unreadable session and restore explicit
 * saved values thereafter.
 * @param {{ local?: Storage }} [options]
 * @returns {{ id: string, headingId: string, title: string, open: boolean, collapsible: boolean }[]}
 */
export function readPanelSections({ local } = {}) {
  try { local ??= globalThis.localStorage; } catch { /* Session-only. */ }
  let saved = {};
  try {
    const value = JSON.parse(local?.getItem(COLLAPSIBLE_PANEL_KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) saved = value;
  } catch { /* A corrupt or unavailable preference must not stop the page. */ }
  return SECTIONS.map(([id, headingId, title, collapsible]) => ({
    id, headingId, title, collapsible, open: !collapsible || saved[id] === true,
  }));
}

/**
 * Turn the secondary panel sections into native, keyboard-accessible disclosures.
 * Chat remains untouched and visible so replies, floating chat and its saved
 * measurements never depend on a disclosure. Other original controls move intact
 * into the body, so model setup, sockets, speech and pop-out moves keep working.
 * @param {HTMLElement | null} panel
 * @param {{ local?: Storage }} [options]
 * @returns {HTMLDetailsElement[]} The disclosures in their stable section order.
 */
export function installCollapsiblePanel(panel, { local } = {}) {
  if (!panel) return [];
  try { local ??= globalThis.localStorage; } catch { /* Session-only. */ }
  const states = readPanelSections({ local });
  const byHeadingId = new Map(states.map((state) => [state.headingId, state]));
  const document = panel.ownerDocument;
  const installed = [];
  const current = Object.fromEntries(states.map((state) => [state.id, state.open]));
  for (const section of [...panel.children]) {
    if (section.localName !== "section") continue;
    const heading = [...section.children].find((child) => child.localName === "h2");
    const state = byHeadingId.get(heading?.id);
    if (!state) continue;
    if (!state.collapsible) {
      section.classList.add("panel-static");
      continue;
    }
    section.classList.add("panel-collapsible");
    const details = document.createElement("details");
    details.className = "panel-section";
    details.dataset.panelSection = state.id;
    const summary = document.createElement("summary");
    summary.append(heading);
    details.append(summary);
    const children = [...section.childNodes];
    for (const child of children) {
      section.removeChild(child);
      details.append(child);
    }
    section.replaceChildren(details);
    details.open = state.open;
    installed.push(details);
  }
  for (const details of installed) {
    details.addEventListener("toggle", () => {
      current[details.dataset.panelSection] = details.open;
      const next = JSON.stringify(current);
      try {
        if (local?.getItem(COLLAPSIBLE_PANEL_KEY) === next) return;
        local?.setItem(COLLAPSIBLE_PANEL_KEY, next);
      } catch { /* Session-only. */ }
    });
  }
  return installed;
}
