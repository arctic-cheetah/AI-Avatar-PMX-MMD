// A tiny DOM for renderer tests: elements, text nodes and an HTML serialiser.
// innerHTML / outerHTML / insertAdjacentHTML throw, so a test fails if the code
// under test ever parses a string as HTML.

const VOID = new Set(["br", "hr", "img", "input"]);

function escapeText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return escapeText(text).replace(/"/g, "&quot;");
}

class FakeText {
  constructor(document, data) {
    this.nodeType = 3;
    this.ownerDocument = document;
    this.data = String(data);
    this.parentElement = null;
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeElement {
  constructor(document, tag) {
    this.nodeType = 1;
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.placeholder = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    const self = this;
    this.classList = {
      add(...names) { for (const name of names) if (!self.classNames().includes(name)) self.className = [...self.classNames(), name].join(" "); },
      remove(...names) { self.className = self.classNames().filter((name) => !names.includes(name)).join(" "); },
      contains(name) { return self.classNames().includes(name); },
      toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : Boolean(force);
        if (on) this.add(name); else this.remove(name);
        return on;
      },
    };
  }
  classNames() { return (this.attributes.get("class") ?? "").split(/\s+/).filter(Boolean); }
  get className() { return this.attributes.get("class") ?? ""; }
  set className(value) { this.attributes.set("class", String(value)); }
  get href() { return this.attributes.get("href") ?? ""; }
  set href(value) { this.attributes.set("href", String(value)); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(this.ownerDocument, node) : node;
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(node) { this.append(node); return node; }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error("Node is not a child");
    this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(...(String(value) === "" ? [] : [String(value)])); }
  get innerHTML() { return this.children.map(serialize).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be assigned"); }
  set outerHTML(_) { throw new Error("outerHTML must not be assigned"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML must not be used"); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  emit(type) { for (const listener of this.listeners[type] ?? []) listener(); }
  removeEventListener() {}
  setPointerCapture() {}
  focus() {}
  getBoundingClientRect() { return { height: 0, width: 0 }; }
  /** Every element below this one, depth first. */
  descendants() {
    return this.children.flatMap((child) => (child.nodeType === 1 ? [child, ...child.descendants()] : []));
  }
  querySelectorAll(tag) { return this.descendants().filter((element) => element.localName === tag); }
  querySelector(tag) { return this.querySelectorAll(tag)[0] ?? null; }
}

export function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  const attrs = [...node.attributes].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.children.map(serialize).join("")}</${node.localName}>`;
}

export function createDocument() {
  const document = {
    createElement: (tag) => new FakeElement(document, tag),
    createTextNode: (data) => new FakeText(document, data),
    createDocumentFragment: () => new FakeElement(document, "#fragment"),
  };
  return document;
}

/**
 * Install a fake document whose querySelector returns one element per selector,
 * and a fake WebSocket that remembers the last instance. Restored after the test.
 */
export function installPage(t) {
  const previousDocument = globalThis.document;
  const previousSocket = globalThis.WebSocket;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousSocket;
  });
  const document = createDocument();
  const nodes = new Map();
  document.querySelector = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, document.createElement("div"));
    return nodes.get(selector);
  };
  globalThis.document = document;
  const previousStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ maxHeight: "320px" });
  t.after(() => {
    if (previousStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousStyle;
  });
  const page = { document, nodes, socket: null, sent: [] };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      page.socket = this;
      this.readyState = 1;
    }
    send(frame) { page.sent.push(frame); }
  };
  page.receive = (event) => page.socket.onmessage({ data: JSON.stringify(event) });
  page.log = () => nodes.get("#chat-log");
  return page;
}
