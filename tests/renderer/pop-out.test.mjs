import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameLoop, PopOut, popupWindow } from "../../renderer/pop-out.js";

// A tiny DOM: just enough ChildNode/ParentNode behaviour to watch nodes move
// between the page and the floating window and come back to the same place.
class FakeNode {
  constructor(name) {
    this.name = name;
    this.parent = null;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  before(node) {
    const parent = this.parent;
    node.remove();
    parent.children.splice(parent.children.indexOf(this), 0, node);
    node.parent = parent;
  }

  replaceWith(node) {
    const parent = this.parent;
    node.remove();
    parent.children[parent.children.indexOf(this)] = node;
    node.parent = parent;
    this.parent = null;
  }

  cloneNode() {
    return new FakeNode(`${this.name} copy`);
  }
}

class FakeParent extends FakeNode {
  constructor(name) {
    super(name);
    this.children = [];
    const classes = new Set();
    this.classList = { add: (name) => classes.add(name), contains: (name) => classes.has(name) };
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      this.children.push(node);
      node.parent = this;
    }
  }

  names() {
    return this.children.map((node) => node.name);
  }
}

function fakeDocument(styleSheets = []) {
  return {
    head: new FakeParent("head"),
    body: new FakeParent("body"),
    styleSheets,
    createComment: (text) => new FakeNode(`<!--${text}-->`),
    createElement: (tag) => new FakeParent(tag),
  };
}

function fakeWindow(document = fakeDocument()) {
  const listeners = new Map();
  let nextFrame = 1;
  const frames = new Map();
  return {
    document,
    devicePixelRatio: 1,
    closed: false,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    dispatch(type) {
      const current = listeners.get(type) ?? [];
      listeners.delete(type); // every listener here is registered { once: true }
      for (const listener of current) listener({ type });
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      this.dispatch("pagehide"); // Chrome fires pagehide when a PiP window closes
    },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    pendingFrames: () => frames.size,
    runFrame(time = 0) {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(time);
    },
  };
}

function stage() {
  const styles = [
    { href: "http://127.0.0.1:8770/renderer/styles.css", cssRules: [{ cssText: "#view { display: block; }" }, { cssText: "[hidden] { display: none; }" }] },
    { href: "https://cdn.example/other.css", get cssRules() { throw new Error("SecurityError"); } },
  ];
  const host = fakeWindow(fakeDocument(styles));
  const main = new FakeParent("stage");
  const canvas = new FakeNode("canvas");
  const bubble = new FakeNode("bubble");
  const controls = new FakeNode("controls");
  main.append(canvas, bubble, controls);
  host.document.body.append(main);
  return { host, main, canvas, bubble, controls };
}

function api(pip = fakeWindow()) {
  const requests = [];
  return {
    pip,
    requests,
    requestWindow: async (options) => {
      requests.push(options);
      return pip;
    },
  };
}

test("frame loop runs the callback every frame on its window", () => {
  const view = fakeWindow();
  let frames = 0;
  const loop = new FrameLoop(() => { frames += 1; }, view);
  loop.start();
  view.runFrame();
  view.runFrame();
  assert.equal(frames, 2);
  assert.equal(view.pendingFrames(), 1, "each frame schedules the next");
});

test("frame loop moves to another window without a doubled or lost frame", () => {
  const main = fakeWindow();
  const pip = fakeWindow();
  let frames = 0;
  const loop = new FrameLoop(() => { frames += 1; }, main);
  loop.start();
  loop.use(pip);
  assert.equal(main.pendingFrames(), 0, "a hidden opener can no longer stall the avatar");
  assert.equal(pip.pendingFrames(), 1);
  pip.runFrame();
  assert.equal(frames, 1);
  assert.equal(loop.source, pip);
});

test("frame loop switching to the same window keeps a single pending frame", () => {
  const view = fakeWindow();
  const loop = new FrameLoop(() => {}, view);
  loop.start();
  loop.use(view);
  assert.equal(view.pendingFrames(), 1);
});

test("a stopped frame loop stays stopped when its window changes", () => {
  const main = fakeWindow();
  const pip = fakeWindow();
  const loop = new FrameLoop(() => {}, main);
  loop.start();
  loop.stop();
  loop.use(pip);
  assert.equal(main.pendingFrames(), 0);
  assert.equal(pip.pendingFrames(), 0);
});

test("without Document Picture-in-Picture the pop-out says so and moves nothing", async () => {
  const { host, main } = stage();
  const popOut = new PopOut({ api: undefined, host, nodes: [] });
  assert.equal(popOut.supported, false);
  await assert.rejects(popOut.open(), /Chrome or Edge/);
  assert.deepEqual(main.names(), ["canvas", "bubble", "controls"]);
});

test("opening moves the avatar into an always-on-top window with the page styles", async () => {
  const { host, main, canvas, bubble } = stage();
  const pipApi = api();
  const changes = [];
  const popOut = new PopOut({
    api: pipApi, host, nodes: [canvas, bubble], size: { width: 360, height: 480 },
    onChange: (view) => changes.push(view),
  });
  assert.equal(popOut.supported, true);
  const view = await popOut.open();
  assert.equal(view, pipApi.pip);
  assert.equal(popOut.window, view);
  assert.deepEqual(pipApi.requests, [{ width: 360, height: 480 }]);
  const [inline, linked] = view.document.head.children;
  assert.equal(inline.name, "style");
  assert.equal(inline.textContent, "#view { display: block; }\n[hidden] { display: none; }",
    "same-origin rules are copied inline so the first resize already sees them");
  assert.equal(linked.name, "link");
  assert.deepEqual([linked.rel, linked.href], ["stylesheet", "https://cdn.example/other.css"],
    "a sheet whose rules cannot be read is linked instead");
  assert.ok(view.document.body.classList.contains("pop-out"));
  assert.deepEqual(view.document.body.names(), ["canvas", "bubble"]);
  assert.deepEqual(main.names(), ["<!--pop-out-->", "<!--pop-out-->", "controls"],
    "markers hold the avatar's places in the page");
  assert.deepEqual(changes, [view]);
});

test("closing the floating window puts the avatar back exactly where it was", async () => {
  const { host, main, canvas, bubble } = stage();
  const pipApi = api();
  const changes = [];
  const popOut = new PopOut({ api: pipApi, host, nodes: [canvas, bubble], onChange: (v) => changes.push(v) });
  await popOut.open();
  pipApi.pip.dispatch("pagehide"); // the user closed it with the window's own button
  assert.deepEqual(main.names(), ["canvas", "bubble", "controls"]);
  assert.equal(popOut.window, null);
  assert.deepEqual(changes, [pipApi.pip, null]);
});

test("returning from the page restores once and closes the floating window", async () => {
  const { host, main, canvas, bubble } = stage();
  const pipApi = api();
  const changes = [];
  const popOut = new PopOut({ api: pipApi, host, nodes: [canvas, bubble], onChange: (v) => changes.push(v) });
  await popOut.open();
  popOut.close();
  assert.equal(pipApi.pip.closed, true);
  assert.deepEqual(main.names(), ["canvas", "bubble", "controls"]);
  assert.deepEqual(changes, [pipApi.pip, null], "the later pagehide does not restore twice");
  popOut.close();
  assert.equal(changes.length, 2, "closing again is harmless");
});

test("double-clicking pop out opens a single window", async () => {
  const { host, canvas } = stage();
  const pipApi = api();
  const popOut = new PopOut({ api: pipApi, host, nodes: [canvas] });
  const [first, second] = await Promise.all([popOut.open(), popOut.open()]);
  assert.equal(first, second);
  assert.equal(pipApi.requests.length, 1);
});

test("the avatar can pop out again after returning", async () => {
  const { host, main, canvas } = stage();
  let pip = fakeWindow();
  const popOut = new PopOut({ api: { requestWindow: async () => pip }, host, nodes: [canvas] });
  await popOut.open();
  popOut.close();
  pip = fakeWindow();
  const again = await popOut.open();
  assert.equal(again, pip);
  assert.deepEqual(again.document.body.names(), ["canvas"]);
  assert.deepEqual(main.names(), ["<!--pop-out-->", "bubble", "controls"]);
});

test("a refused window request leaves the avatar in the page", async () => {
  const { host, main, canvas } = stage();
  const popOut = new PopOut({
    api: { requestWindow: async () => { throw new Error("needs a user gesture"); } },
    host, nodes: [canvas],
  });
  await assert.rejects(popOut.open(), /user gesture/);
  assert.equal(popOut.window, null);
  assert.deepEqual(main.names(), ["canvas", "bubble", "controls"]);
});

// Firefox and other browsers without Document Picture-in-Picture fall back to
// an ordinary popup window from window.open() (issue #52 follow-up).

function hostWithPopups(popup) {
  const { host, main, canvas, bubble } = stage();
  const opened = [];
  host.open = (url, target, features) => {
    opened.push({ url, target, features });
    return popup;
  };
  host.document.title = "Yidhari";
  return { host, main, canvas, bubble, opened };
}

test("the popup opener asks for a sized popup window of the same page", async () => {
  const popup = fakeWindow();
  const { host, opened } = hostWithPopups(popup);
  const opener = popupWindow(host);
  assert.equal(opener.kind, "popup");
  const view = await opener.requestWindow({ width: 360, height: 480 });
  assert.equal(view, popup);
  assert.deepEqual(opened, [{ url: "", target: "_blank", features: "popup,width=360,height=480" }]);
  assert.equal(popup.document.title, "Yidhari");
});

test("a blocked popup explains how to allow it", async () => {
  const { host } = hostWithPopups(null);
  await assert.rejects(popupWindow(host).requestWindow({ width: 360, height: 480 }), /pop-ups/);
});

test("without Document Picture-in-Picture the avatar pops out into a popup window", async () => {
  const popup = fakeWindow();
  const { host, main, canvas } = hostWithPopups(popup);
  const popOut = new PopOut({ api: undefined, fallback: popupWindow(host), host, nodes: [canvas] });
  assert.equal(popOut.supported, true);
  assert.equal(popOut.kind, "popup", "the button can say it opens an ordinary window");
  const view = await popOut.open();
  assert.equal(view, popup);
  assert.equal(popOut.kind, "popup");
  assert.deepEqual(popup.document.body.names(), ["canvas"]);
  popup.dispatch("pagehide");
  assert.deepEqual(main.names(), ["canvas", "bubble", "controls"]);
});

test("when Picture-in-Picture refuses to open, the popup window is used instead", async () => {
  const popup = fakeWindow();
  const { host, canvas } = hostWithPopups(popup);
  const popOut = new PopOut({
    api: { requestWindow: async () => { throw new Error("Internal error: no window"); } },
    fallback: popupWindow(host), host, nodes: [canvas],
  });
  assert.equal(popOut.kind, "pip");
  assert.equal(await popOut.open(), popup);
  assert.equal(popOut.kind, "popup");
});

test("if both windows are refused the avatar stays and the last reason is given", async () => {
  const { host, main, canvas } = hostWithPopups(null);
  const popOut = new PopOut({
    api: { requestWindow: async () => { throw new Error("no window"); } },
    fallback: popupWindow(host), host, nodes: [canvas],
  });
  await assert.rejects(popOut.open(), /pop-ups/);
  assert.equal(popOut.window, null);
  assert.deepEqual(main.names(), ["canvas", "bubble", "controls"]);
});

test("closing the main page also closes a popup window", async () => {
  const popup = fakeWindow();
  const { host, canvas } = hostWithPopups(popup);
  const popOut = new PopOut({ api: undefined, fallback: popupWindow(host), host, nodes: [canvas] });
  await popOut.open();
  host.dispatch("pagehide");
  assert.equal(popup.closed, true, "a popup would otherwise outlive the page and keep the avatar");
  assert.equal(popOut.window, null);
});

test("the window size can be chosen per opening, e.g. with the side panel", async () => {
  const pipApi = api();
  const { host, canvas } = stage();
  const popOut = new PopOut({ api: pipApi, host, nodes: [canvas] });
  await popOut.open({ width: 756, height: 640 });
  assert.deepEqual(pipApi.requests, [{ width: 756, height: 640 }]);
});
