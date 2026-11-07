// Pop Yidhari out into an always-on-top floating window (issue #52).
//
// Uses the Document Picture-in-Picture API. The canvas is moved, not copied,
// so the page keeps its single bridge connection, AudioContext and WebGL
// context. See docs/pop-out-window.md.

const UNSUPPORTED =
  "Pop out needs Chrome or Edge 116+ (Document Picture-in-Picture).";

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
 * Move a few page nodes into a Document Picture-in-Picture window and back.
 * A comment marker holds each node's place, so it returns exactly there.
 */
export class PopOut {
  /**
   * @param {object} options
   * @param {{ requestWindow(options: { width: number, height: number }): Promise<Window> } | undefined} options.api
   *   `window.documentPictureInPicture`, or undefined where unsupported.
   * @param {Window} options.host The main page's window.
   * @param {Node[]} options.nodes Nodes to move, in order.
   * @param {{ width: number, height: number }} [options.size] Requested window size.
   * @param {(view: Window | null) => void} [options.onChange] Called with the floating window, then null on return.
   */
  constructor({ api, host, nodes, size = { width: 360, height: 480 }, onChange = () => {} }) {
    this.api = api;
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
  }

  /** @returns {boolean} Whether this browser can pop out at all. */
  get supported() {
    return typeof this.api?.requestWindow === "function";
  }

  /** @returns {string} Why pop out is unavailable. */
  static get unsupportedReason() {
    return UNSUPPORTED;
  }

  /**
   * Open the floating window (must run from a click) and move the nodes in.
   * @returns {Promise<Window>}
   */
  open() {
    if (!this.supported) return Promise.reject(new Error(UNSUPPORTED));
    if (this.window) return Promise.resolve(this.window);
    this.opening ??= this.#open().finally(() => { this.opening = null; });
    return this.opening;
  }

  async #open() {
    const view = await this.api.requestWindow({ ...this.size });
    const { document } = view;
    for (const sheet of this.host.document.querySelectorAll('link[rel="stylesheet"], style')) {
      document.head.append(sheet.cloneNode(true));
    }
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
