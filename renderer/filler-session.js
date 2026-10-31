/** Keep an optional filler ahead of the real answer in the existing audio queue. */
export class FillerSession {
  #pending = null;

  reset() {
    this.#pending = null;
  }

  /** A filler announced before the answer is reserved; late fillers are ignored. */
  reserve(id) {
    if (this.#pending !== null) return false;
    this.#pending = id;
    return true;
  }

  /** Prepend only a filler announced before this reply's first real clip. */
  takeForAnswer() {
    const id = this.#pending;
    this.#pending = null;
    return id;
  }
}
