import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSIBLE_PANEL_KEY,
  readPanelSections,
  installCollapsiblePanel,
} from "../../renderer/collapsible-panel.js";
import { createDocument } from "./fake-dom.mjs";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function detailsOf(panel, id) {
  return panel.querySelectorAll("details").find((item) => item.dataset.panelSection === id);
}

function fakePanel(document) {
  const panel = document.createElement("aside");
  for (const [id, title] of readPanelSections({ local: storage() }).map(({ id, title }) => [id, title])) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const control = document.createElement("button");
    control.id = `${id}-control`;
    section.append(heading, control);
    panel.append(section);
  }
  // The production helper uses these standard operations; the shared tiny DOM
  // intentionally implements only the subset needed by its existing tests.
  panel.replaceChildren = function (...children) { this.children = children; };
  return panel;
}

test("all six shipped panel sections start collapsed", () => {
  const states = readPanelSections({ local: storage() });
  assert.deepEqual(states.map(({ id }) => id), [
    "chat", "speech", "presets", "channels", "audition", "candidates",
  ]);
  assert.ok(states.every(({ open }) => open === false));
});

test("a saved mix of open and closed sections is restored by stable ID", () => {
  const local = storage({
    [COLLAPSIBLE_PANEL_KEY]: JSON.stringify({ chat: true, presets: true, candidates: true }),
  });
  assert.deepEqual(readPanelSections({ local }).map(({ open }) => open), [
    true, false, true, false, false, true,
  ]);
});

test("missing, malformed and wrong-shaped saved values use closed defaults", () => {
  for (const value of ["{broken", "null", "[]", JSON.stringify({ chat: "yes", unknown: true })]) {
    const states = readPanelSections({ local: storage({ [COLLAPSIBLE_PANEL_KEY]: value }) });
    assert.ok(states.every(({ open }) => open === false), value);
    assert.ok(states.every(({ title }) => typeof title === "string" && title.length > 0));
  }
});

test("blocked storage still allows collapsing and expanding for the session", () => {
  const local = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const document = createDocument();
  const panel = document.createElement("aside");
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = "Chat";
  section.append(heading, document.createElement("button"));
  panel.append(section);
  panel.replaceChildren = function (...children) { this.children = children; };
  section.replaceChildren = function (...children) { this.children = children; };
  installCollapsiblePanel(panel, { local });
  const details = detailsOf(panel, "chat");
  assert.equal(details.open, false);
  details.open = true;
  details.emit("toggle");
  assert.equal(details.open, true);
  assert.equal(details.children[0].textContent, "Chat");
});

test("installing keeps existing controls, makes native disclosures and persists each toggle", () => {
  const document = createDocument();
  const panel = fakePanel(document);
  const local = storage({ [COLLAPSIBLE_PANEL_KEY]: JSON.stringify({ presets: true }) });
  const installed = installCollapsiblePanel(panel, { local });
  assert.equal(installed.length, 6);
  const details = panel.querySelectorAll("details");
  assert.equal(details.length, 6);
  assert.ok(details.every((item) => item.open === (item.dataset.panelSection === "presets")));
  assert.ok(details.every((item) => item.children[0].localName === "summary"));
  assert.equal(panel.querySelectorAll("button").length, 6, "existing controls are moved, not cloned");
  const chat = detailsOf(panel, "chat");
  chat.open = true;
  chat.emit("toggle");
  assert.deepEqual(JSON.parse(local.values.get(COLLAPSIBLE_PANEL_KEY)), {
    chat: true, speech: false, presets: true, channels: false, audition: false, candidates: false,
  });
  const moved = document.createElement("div");
  moved.append(panel);
  assert.equal(chat.open, true, "moving the panel does not reconstruct disclosures");
  assert.equal(detailsOf(panel, "chat"), chat);
});

test("default browser storage is bound for writes as well as reads", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const local = storage();
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const document = createDocument();
  const panel = fakePanel(document);
  installCollapsiblePanel(panel);
  const chat = detailsOf(panel, "chat");
  chat.open = true;
  chat.emit("toggle");
  assert.equal(JSON.parse(local.values.get(COLLAPSIBLE_PANEL_KEY)).chat, true);
});
