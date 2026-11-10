/** Stable IDs keep saved choices independent of visible heading text. */
const SECTIONS = [
  ["chat", "Chat"],
  ["speech", "Speech test"],
  ["presets", "Mood presets"],
  ["channels", "Independent channels"],
  ["audition", "Morph audition"],
  ["candidates", "Candidates"],
];

export const COLLAPSIBLE_PANEL_KEY = "yidhari.panelSections";

/**
 * Read the saved disclosure states. Every section is closed for a new or
 * unreadable session; only explicit boolean values are restored.
 * @param {{ local?: Storage }} [options]
 * @returns {{ id: string, title: string, open: boolean }[]}
 */
export function readPanelSections({ local } = {}) {
  try { local ??= globalThis.localStorage; } catch { /* Session-only. */ }
  let saved = {};
  try {
    const value = JSON.parse(local?.getItem(COLLAPSIBLE_PANEL_KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) saved = value;
  } catch { /* A corrupt or unavailable preference must not stop the page. */ }
  return SECTIONS.map(([id, title]) => ({ id, title, open: saved[id] === true }));
}

/**
 * Turn the existing panel sections into native, keyboard-accessible disclosures.
 * Their original controls move intact into the body, so model setup, sockets,
 * speech and pop-out moves continue to operate on the same nodes.
 * @param {HTMLElement | null} panel
 * @param {{ local?: Storage }} [options]
 * @returns {HTMLDetailsElement[]} The disclosures in their stable section order.
 */
export function installCollapsiblePanel(panel, { local } = {}) {
  if (!panel) return [];
  try { local ??= globalThis.localStorage; } catch { /* Session-only. */ }
  const states = readPanelSections({ local });
  const byTitle = new Map(states.map((state) => [state.title, state]));
  const document = panel.ownerDocument;
  const installed = [];
  for (const section of [...panel.children]) {
    if (section.localName !== "section") continue;
    const heading = [...section.children].find((child) => child.localName === "h2");
    const state = byTitle.get(heading?.textContent.trim());
    if (!state) continue;
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
      const current = Object.fromEntries(installed.map((item) => [item.dataset.panelSection, item.open]));
      try { local?.setItem(COLLAPSIBLE_PANEL_KEY, JSON.stringify(current)); } catch { /* Session-only. */ }
    });
  }
  return installed;
}
