/** Linked-channel sample-peak limiter. No normalisation, makeup gain or noise gate. */
export const LOOKAHEAD_SECONDS = 0.005;
export const PEAK_CEILING = 10 ** (-1 / 20);
const RELEASE_SECONDS = 0.08;

export class PeakLimiter {
  constructor(sampleRate, channels = 2) {
    this.delayFrames = Math.ceil(sampleRate * LOOKAHEAD_SECONDS);
    this.size = this.delayFrames + 1;
    this.audio = Array.from({ length: channels }, () => new Float32Array(this.size));
    this.caps = new Float64Array(this.size).fill(1);
    this.release = 1 - Math.exp(-1 / (sampleRate * RELEASE_SECONDS));
    this.cursor = 0;
    this.envelope = 1;
  }

  reset() {
    for (const channel of this.audio) channel.fill(0);
    this.caps.fill(1);
    this.envelope = 1;
    this.cursor = 0;
  }

  process(input, output, gains) {
    for (let i = 0; i < output[0].length; i++) {
      const gain = gains.length === 1 ? gains[0] : gains[i];
      const incoming = (this.cursor + this.delayFrames) % this.size;
      let peak = 0;
      for (let c = 0; c < this.audio.length; c++) {
        const sample = (input[c]?.[i] ?? 0) * gain;
        this.audio[c][incoming] = sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      if (peak > PEAK_CEILING) {
        const target = PEAK_CEILING / peak;
        // Schedule a linear attack ending exactly when this peak leaves the
        // delay. Taking the minimum combines overlapping transient envelopes.
        for (let ahead = 0; ahead <= this.delayFrames; ahead++) {
          const slot = (this.cursor + ahead) % this.size;
          const cap = 1 + (target - 1) * ahead / this.delayFrames;
          this.caps[slot] = Math.min(this.caps[slot], cap);
        }
      }
      this.envelope = Math.min(this.caps[this.cursor], this.envelope + (1 - this.envelope) * this.release);
      for (let c = 0; c < output.length; c++) {
        output[c][i] = this.audio[c][this.cursor] * this.envelope;
      }
      this.caps[this.cursor] = 1;
      this.cursor = (this.cursor + 1) % this.size;
    }
  }
}
