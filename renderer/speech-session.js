/**
 * Track one live response, to decide when the face should relax to neutral.
 *
 * Relax only after the bridge has finished the response, nothing is playing,
 * loading or queued, and the response actually spoke. The saved-sample test
 * never marks a response as spoken, so it keeps the mood chosen for comparison.
 */
export class LiveSpeechSession {
  constructor() {
    this.reset();
  }

  /** A new response started. It also clears any rest mood set by an agent. */
  reset() {
    this.spoke = false;
    this.finished = false;
    this.restMood = { name: 'neutral', weight: 1 };
  }

  /** A coding agent chose the mood to rest in after speech, instead of neutral (#27). */
  setRestMood(name, weight) {
    this.restMood = { name, weight };
  }

  /** The bridge announced a clip for this response. */
  clipQueued() {
    this.spoke = true;
  }

  /** The bridge sent end or error, or the connection closed. */
  responseFinished() {
    this.finished = true;
  }

  /**
   * @param {boolean} idle Whether no clip is playing, loading or queued.
   * @returns {boolean} Whether the face should return to neutral now.
   */
  shouldRelax(idle) {
    return this.finished && this.spoke && idle;
  }

  /** The face relaxed; do not relax again for this response. */
  relaxed() {
    this.spoke = false;
  }
}
