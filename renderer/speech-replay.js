/**
 * One renderer-local replay slot. It shares the decoded audio rather than
 * copying it, and never depends on bridge files surviving cleanup/reconnects.
 */
export class LastSpeechReplay {
  /** @type {{ clip: import('./speech-player.js').SpeechClip, expression: string, weight: number, text: string } | null} */
  entry = null;
  expired = false;

  clear() {
    this.entry = null;
    this.expired = false;
  }

  /** Retain only actual live speech that started successfully, never filler or samples. */
  remember({ clip, expression, weight, text }) {
    this.clear();
    // Bound audio to 120 seconds / 32 MiB of float PCM, plus track and text.
    const bytes = clip.buffer.length * clip.buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (clip.buffer.duration > 120 || bytes > 32 * 1024 * 1024 || clip.visemes.length > 20000) {
      this.expired = true;
      return false;
    }
    this.entry = {
      clip: { buffer: clip.buffer, visemes: clip.visemes, transcript: clip.transcript?.slice(0, 2000) ?? null },
      expression, weight, text: text.slice(0, 2000),
    };
    return true;
  }
}
