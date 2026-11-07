/**
 * One renderer-local replay turn. It shares the decoded audio rather than
 * copying it, and never depends on bridge files surviving cleanup/reconnects.
 * A turn is one chat reply or one agent say, report, or ask.
 */
const MAX_SECONDS = 120;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_VISEMES = 20000;
const MAX_TEXT = 2000;

function clipBytes(clip) {
  return clip.buffer.length * clip.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

export class LastSpeechReplay {
  /** @type {{ clip: import('./speech-player.js').SpeechClip, expression: string, weight: number, text: string }[]} */
  entries = [];
  /** @type {number | null} */
  turn = null;
  expired = false;
  partial = false;

  clear() {
    this.entries = [];
    this.turn = null;
    this.expired = false;
    this.partial = false;
  }

  /**
   * Retain a clip that started successfully. The same turn appends; a new turn
   * replaces the previous one. A clip that does not fit is not stored.
   * @param {{ clip: import('./speech-player.js').SpeechClip, expression: string, weight: number, text: string, turn: number }} item
   * @returns {boolean} Whether this clip was retained.
   */
  remember({ clip, expression, weight, text, turn }) {
    const same = this.turn === turn && this.entries.length > 0;
    const base = same ? this.entries : [];
    const duration = base.reduce((sum, item) => sum + item.clip.buffer.duration, 0) + clip.buffer.duration;
    const bytes = base.reduce((sum, item) => sum + clipBytes(item.clip), 0) + clipBytes(clip);
    const visemes = base.reduce((sum, item) => sum + item.clip.visemes.length, 0) + clip.visemes.length;
    if (duration > MAX_SECONDS || bytes > MAX_BYTES || visemes > MAX_VISEMES) {
      if (!same) {
        this.entries = [];
        this.turn = turn;
        this.expired = true;
        this.partial = false;
      } else {
        this.partial = true;
      }
      return false;
    }
    const stored = {
      clip: {
        buffer: clip.buffer,
        visemes: clip.visemes,
        transcript: clip.transcript?.slice(0, MAX_TEXT) ?? null,
      },
      expression,
      weight,
      text: text.slice(0, MAX_TEXT),
    };
    if (!same) {
      this.entries = [stored];
      this.turn = turn;
      this.expired = false;
      this.partial = false;
    } else {
      this.entries.push(stored);
    }
    return true;
  }
}

/**
 * Queue a retained turn for the existing speech lane without stamping a new live turn.
 * @param {{ clip: import('./speech-player.js').SpeechClip, expression: string, weight: number, text: string }[]} entries
 * @returns {{ clip: Promise<import('./speech-player.js').SpeechClip>, expression: string, weight: number, text: string, replay: true }[]}
 */
export function replayQueueItems(entries) {
  return entries.map(({ clip, expression, weight, text }) => ({
    clip: Promise.resolve(clip),
    expression,
    weight,
    text,
    replay: true,
  }));
}
