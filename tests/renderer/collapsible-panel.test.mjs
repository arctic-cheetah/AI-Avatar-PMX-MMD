import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSIBLE_PANEL_KEY,
  readPanelSections,
  installCollapsiblePanel,
} from "../../renderer/collapsible-panel.js";
import { createDocument } from "./fake-dom.mjs";
import { readFile } from "node:fs/promises";

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

function fakePanel(document, { saved = {}, renamed = false } = {}) {
  const panel = document.createElement("aside");
  for (const { id, title } of readPanelSections({ local: storage({ [COLLAPSIBLE_PANEL_KEY]: JSON.stringify(saved) }) })) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.id = `${id === "chat" ? "bridge" : id}-heading`;
    heading.textContent = renamed && id === "presets" ? "Expressions" : title;
    const control = document.createElement("button");
    control.id = `${id}-control`;
    section.append(heading, control);
    panel.append(section);
  }
  return panel;
}

test("Chat is permanently open; the seven secondary sections start collapsed", () => {
  const states = readPanelSections({ local: storage() });
  assert.deepEqual(states.map(({ id }) => id), [
    "chat", "speech", "presets", "channels", "actions", "action-play", "audition", "candidates",
  ]);
  assert.deepEqual(states.map(({ open }) => open), [true, false, false, false, false, false, false, false]);
  assert.ok(states.every(({ collapsible }, index) => collapsible === (index !== 0)));
});

test("a saved mix of secondary section states is restored, but Chat always stays open", () => {
  const local = storage({
    [COLLAPSIBLE_PANEL_KEY]: JSON.stringify({ chat: false, presets: true, candidates: true }),
  });
  assert.deepEqual(readPanelSections({ local }).map(({ open }) => open), [
    true, false, true, false, false, true,
  ]);
});

test("missing, malformed and wrong-shaped saved values keep Chat open and secondary sections closed", () => {
  for (const value of ["{broken", "null", "[]", JSON.stringify({ chat: false, presets: "yes", unknown: true })]) {
    const states = readPanelSections({ local: storage({ [COLLAPSIBLE_PANEL_KEY]: value }) });
    assert.deepEqual(states.map(({ open }) => open), [true, false, false, false, false, false], value);
    assert.ok(states.every(({ title }) => typeof title === "string" && title.length > 0));
  }
});

test("blocked storage leaves Chat open and secondary sections usable for the session", () => {
  const local = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const document = createDocument();
  const panel = fakePanel(document);
  installCollapsiblePanel(panel, { local });
  assert.equal(detailsOf(panel, "chat"), undefined, "Chat is not a disclosure");
  const speech = detailsOf(panel, "speech");
  assert.equal(speech.open, false);
  speech.open = true;
  speech.emit("toggle");
  assert.equal(speech.open, true);
});

test("Chat keeps its original visible subtree while secondary controls move intact", () => {
  const document = createDocument();
  const panel = fakePanel(document, { saved: { presets: true } });
  const chat = panel.children[0];
  const originalChatChildren = [...chat.children];
  const local = storage({ [COLLAPSIBLE_PANEL_KEY]: JSON.stringify({ presets: true }) });
  const installed = installCollapsiblePanel(panel, { local });
  assert.equal(installed.length, 7);
  assert.equal(chat.children.length, originalChatChildren.length);
  assert.ok(originalChatChildren.every((child) => chat.children.includes(child)), "Chat is not hidden or restructured");
  const details = panel.querySelectorAll("details");
  assert.equal(details.length, 7);
  assert.ok(details.every((item) => item.open === (item.dataset.panelSection === "presets")));
  assert.ok(details.every((item) => item.children[0].localName === "summary"));
  assert.equal(panel.querySelectorAll("button").length, 8, "existing controls are moved, not cloned");
  const speech = detailsOf(panel, "speech");
  speech.open = true;
  speech.emit("toggle");
  assert.deepEqual(JSON.parse(local.values.get(COLLAPSIBLE_PANEL_KEY)), {
    chat: true, speech: true, presets: true, channels: false, actions: false, "action-play": false,
    audition: false, candidates: false,
  });
  const moved = document.createElement("div");
  moved.append(panel);
  assert.equal(speech.open, true, "moving the panel does not reconstruct disclosures");
  assert.equal(detailsOf(panel, "speech"), speech);
});

test("stable heading IDs survive a visible-title rename", () => {
  const document = createDocument();
  const panel = fakePanel(document, { renamed: true });
  installCollapsiblePanel(panel, { local: storage() });
  assert.equal(panel.querySelectorAll("details").length, 5);
  assert.equal(detailsOf(panel, "presets").children[0].textContent, "Expressions");
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
  const speech = detailsOf(panel, "speech");
  speech.open = true;
  speech.emit("toggle");
  assert.equal(JSON.parse(local.values.get(COLLAPSIBLE_PANEL_KEY)).speech, true);
});

test("every top-level panel section in index.html is listed, so none is left uncollapsible", async () => {
  const html = await readFile(new URL("../../renderer/index.html", import.meta.url), "utf8");
  const panel = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  const headings = [...panel.matchAll(/<section aria-labelledby="([^"]+)">/g)].map((match) => match[1]);
  const listed = readPanelSections({ local: storage() }).map(({ headingId }) => headingId);
  assert.deepEqual(headings, listed, "same sections, in page order");
});

test("the Actions checklist has its own collapsible section, next to Animation actions", async () => {
  const html = await readFile(new URL("../../renderer/index.html", import.meta.url), "utf8");
  const section = html.slice(html.indexOf('<section aria-labelledby="actions-heading">'));
  const body = section.slice(0, section.indexOf("</section>"));
  assert.match(body, /id="actions"/, "the checklist lives in the Actions section");
  const channels = html.slice(html.indexOf('<section aria-labelledby="channels-heading">'));
  assert.doesNotMatch(channels.slice(0, channels.indexOf("</section>")), /id="actions"/, "no longer inside Independent channels");
});
