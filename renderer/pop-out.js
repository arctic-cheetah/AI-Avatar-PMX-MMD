// Pop Yidhari out into an always-on-top floating window (issue #52).
//
// Uses the Document Picture-in-Picture API, or a window.open() popup where
// that is missing (Firefox) or refused (Electron). The page's nodes are
// moved, not copied, so the page keeps its single bridge connection,
// AudioContext and WebGL context. See docs/pop-out-window.md.

const UNSUPPORTED =
  "Pop out needs Chrome or Edge 116+ (Document Picture-in-Picture).";
const BLOCKED =
  "The browser blocked the pop-out window. Allow pop-ups for this page and try again.";

/**
 * Open an ordinary popup window of this page, for browsers without Document
 * Picture-in-Picture. It is not kept on top; the window manager can pin it.
 * @param {Window} host The main page's window.
 * @returns {{ kind: "popup", requestWindow(size: { width: number, height: number }): Promise<Window> }}
 */
export function popupWindow(host) {
  return {
    kind: "popup",
    async requestWindow({ width, height }) {
      // A blank same-origin window, so the page can move its nodes into it.
      const view = host.open("", "_blank", `popup,width=${width},height=${height}`);
      if (!view) throw new Error(BLOCKED);
      view.document.title = host.document.title;
      return view;
    },
  };
}

/**
 * Copy the page's styles into the floating window. Readable (same-origin)
 * rules are copied inline so they apply at once: a cloned <link> loads
 * later, and the first resize would measure an unstyled canvas.
 * @param {Document} from The main page.
 * @param {Document} to The floating window's document.
 * @returns {void}
 */
function copyStyles(from, to) {
  for (const sheet of from.styleSheets) {
    try {
      const style = to.createElement("style");
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      to.head.append(style);
    } catch {
      if (!sheet.href) continue;
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      to.head.append(link);
    }
  }
}

/**
 * requestAnimationFrame on a window that can change, so the render loop can
 * follow the canvas into the floating window. Browsers pause frames in a
 * hidden tab; the floating window keeps its own.
 */
export class FrameLoop {
  /**
   * @param {(time: number) => void} callback Runs once per frame.
   * @param {Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">} source Window that schedules frames.
   */
  constructor(callback, source = globalThis) {
    this.callback = callback;
    this.source = source;
    this.running = false;
    this.frame = 0;
    this.tick = (time) => {
      this.frame = this.source.requestAnimationFrame(this.tick);
      this.callback(time);
    };
  }

  /** @returns {void} */
  start() {
    if (this.running) return;
    this.running = true;
    this.frame = this.source.requestAnimationFrame(this.tick);
  }

  /** @returns {void} */
  stop() {
    if (!this.running) return;
    this.running = false;
    this.source.cancelAnimationFrame(this.frame);
  }

  /**
   * Schedule future frames on another window.
   * @param {Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">} source
   * @returns {void}
   */
  use(source) {
    if (source === this.source) return;
    const running = this.running;
    this.stop();
    this.source = source;
    if (running) this.start();
  }
}

/**
 * Move a few page nodes into a floating window and back. A comment marker
 * holds each node's place, so it returns exactly there.
 */
export class PopOut {
  /**
   * @param {object} options
   * @param {{ requestWindow(options: { width: number, height: number }): Promise<Window> } | undefined} options.api
   *   `window.documentPictureInPicture`, or undefined where unsupported.
   * @param {{ kind?: string, requestWindow(options: { width: number, height: number }): Promise<Window> }} [options.fallback]
   *   Used when `api` is missing or refuses, e.g. `popupWindow(window)`.
   * @param {Window} options.host The main page's window.
   * @param {Node[]} options.nodes Nodes to move, in order.
   * @param {{ width: number, height: number }} [options.size] Requested window size.
   * @param {(view: Window | null) => void} [options.onChange] Called with the floating window, then null on return.
   */
  constructor({ api, fallback, host, nodes, size = { width: 360, height: 480 }, onChange = () => {} }) {
    this.api = typeof api?.requestWindow === "function" ? api : undefined;
    this.fallback = fallback;
    this.host = host;
    this.nodes = nodes;
    this.size = size;
    this.onChange = onChange;
    /** @type {Window | null} */
    this.window = null;
    /** @type {Promise<Window> | null} */
    this.opening = null;
    /** @type {[Node, Node][]} */
    this.markers = [];
    /** Which window the next or current pop-out uses: "pip" or "popup". */
    this.kind = this.api ? "pip" : fallback?.kind ?? "popup";
    // A popup would outlive the page and keep the avatar; close it with the page.
    host.addEventListener("pagehide", () => this.close());
  }

  /** @returns {boolean} Whether this browser can pop out at all. */
  get supported() {
    return Boolean(this.api || this.fallback);
  }

  /** @returns {string} Why pop out is unavailable. */
  static get unsupportedReason() {
    return UNSUPPORTED;
  }

  /**
   * Open the floating window (must run from a click) and move the nodes in.
   * @param {{ width: number, height: number }} [size] Window size for this opening.
   * @returns {Promise<Window>}
   */
  open(size = this.size) {
    if (!this.supported) return Promise.reject(new Error(UNSUPPORTED));
    if (this.window) return Promise.resolve(this.window);
    this.opening ??= this.#open(size).finally(() => { this.opening = null; });
    return this.opening;
  }

  /**
   * @param {{ width: number, height: number }} size
   * @returns {Promise<Window>}
   */
  async #request(size) {
    if (this.api) {
      try {
        const view = await this.api.requestWindow({ ...size });
        this.kind = "pip";
        return view;
      } catch (error) {
        if (!this.fallback) throw error;
      }
    }
    const view = await this.fallback.requestWindow({ ...size });
    this.kind = this.fallback.kind ?? "popup";
    return view;
  }

  async #open(size) {
    const view = await this.#request(size);
    const { document } = view;
    copyStyles(this.host.document, document);
    document.body.classList.add("pop-out");
    for (const node of this.nodes) {
      const marker = this.host.document.createComment("pop-out");
      node.before(marker);
      document.body.append(node);
      this.markers.push([marker, node]);
    }
    this.window = view;
    // Fires for Return, the window's own close button, and the page closing.
    view.addEventListener("pagehide", () => this.restore(view), { once: true });
    this.onChange(view);
    return view;
  }

  /**
   * Put the nodes back and close the floating window.
   * @returns {void}
   */
  close() {
    const view = this.window;
    if (!view) return;
    this.restore(view);
    view.close();
  }

  /**
   * @param {Window} view The window being closed.
   * @returns {void}
   */
  restore(view) {
    if (this.window !== view) return;
    for (const [marker, node] of this.markers) marker.replaceWith(node);
    this.markers = [];
    this.window = null;
    this.onChange(null);
  }
}
