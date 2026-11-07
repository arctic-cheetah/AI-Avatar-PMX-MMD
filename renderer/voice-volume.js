export const VOLUME_KEY = 'yidhari.voice-volume-db';
export const MIN_VOLUME_DB = -24;
export const MAX_VOLUME_DB = 18;

export function clampVolumeDb(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_VOLUME_DB, Math.min(MAX_VOLUME_DB, value)) : 0;
}

/** One listening level for sample, chat, fillers and all MCP speech. */
export class VoiceVolume {
  constructor(storage) {
    this.db = 0;
    this.storage = storage;
    this.node = null;
    this.context = null;
    this.connecting = null;
    try {
      this.storage ??= globalThis.localStorage;
      const saved = this.storage?.getItem(VOLUME_KEY);
      this.db = clampVolumeDb(saved === null || saved?.trim() === '' ? 0 : Number(saved));
    } catch { /* Private browsing/storage denial must not disable playback. */ }
  }

  setDb(value) {
    this.db = clampVolumeDb(value);
    try { this.storage?.setItem(VOLUME_KEY, String(this.db)); } catch { /* Session-only setting. */ }
    if (this.node) {
      const gain = this.node.parameters.get('gain');
      gain.cancelAndHoldAtTime(this.context.currentTime);
      gain.setTargetAtTime(10 ** (this.db / 20), this.context.currentTime, 0.015);
    }
  }

  /** Build once, sharing the pending promise across overlapping clip loads. */
  async connect(context, createNode = ctx => new AudioWorkletNode(ctx, 'voice-volume', {
    outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  })) {
    if (this.node) return this.node;
    if (!this.connecting) {
      this.connecting = (async () => {
        if (!context.audioWorklet) throw new Error('Voice playback requires AudioWorklet. Open the renderer on localhost in a current browser.');
        await context.audioWorklet.addModule(new URL('./voice-volume-worklet.js', import.meta.url));
        const node = createNode(context);
        node.parameters.get('gain').value = 10 ** (this.db / 20);
        node.connect(context.destination);
        this.context = context;
        this.node = node;
        return node;
      })();
    }
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  resetLimiter() { this.node?.port.postMessage('reset'); }
}

/** Bind the accessible range and reset button; also works before audio starts. */
export function bindVoiceVolume(volume, { input, output, reset }) {
  const update = () => {
    input.value = String(volume.db);
    const label = `${volume.db > 0 ? '+' : ''}${volume.db} dB`;
    output.value = label;
    input.setAttribute('aria-valuetext', `${label}${volume.db === 0 ? ', baseline' : ''}`);
  };
  input.min = String(MIN_VOLUME_DB);
  input.max = String(MAX_VOLUME_DB);
  input.addEventListener('input', () => { volume.setDb(Number(input.value)); update(); });
  reset.addEventListener('click', () => { volume.setDb(0); update(); });
  update();
}
