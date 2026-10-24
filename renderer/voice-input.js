/**
 * Voice input: record from the microphone, transcribe locally, hand back text.
 *
 * Audio stays in the browser until one POST /stt to the renderer's own server,
 * which runs a local Whisper worker and returns only the transcript. Nothing is
 * stored, and no audio goes over the bridge WebSocket; the transcript then
 * takes the same path as typed chat.
 */
export const MAX_RECORD_SECONDS = 30;
export const MIN_RECORD_MS = 400;
const MAX_TRANSCRIPT = 2000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** Collapse whitespace; return '' when nothing speakable (no letter or digit) is left. */
export function cleanTranscript(text) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPT);
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}

/** POST a recording to the local STT endpoint; resolves to the raw transcript. */
export async function requestTranscript(blob, fetchImpl = fetch) {
  const response = await fetchImpl('/stt', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  let body = {};
  try { body = await response.json(); } catch { /* keep the status-based message */ }
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `speech-to-text failed (HTTP ${response.status})`);
  }
  return typeof body?.text === 'string' ? body.text : '';
}

export function pickMimeType(isSupported) {
  return MIME_TYPES.find((type) => isSupported(type)) ?? '';
}

export function voiceSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
}

/** Ask for the microphone with the browser's echo cancellation, so her own voice is not picked up. */
export function browserMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/** Wrap MediaRecorder as { start(), stop(): Promise<Blob>, cancel() }; stopping releases the mic. */
export function browserRecorder(stream) {
  const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  const release = () => { for (const track of stream.getTracks()) track.stop(); };
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  return {
    start: () => recorder.start(),
    stop: () => new Promise((resolve) => {
      recorder.onstop = () => { release(); resolve(new Blob(chunks, { type: recorder.mimeType || mimeType })); };
      recorder.stop();
    }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== 'inactive') recorder.stop(); else release();
    },
  };
}

function microphoneError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission denied · allow it in the address bar, or keep typing';
    case 'NotFoundError':
      return 'No microphone found · you can still type';
    default:
      return 'Microphone unavailable · you can still type';
  }
}

/**
 * Click-to-record state machine: idle → recording → transcribing → idle.
 * Dependencies are injected so it runs without a browser in tests.
 */
export class VoiceInput {
  constructor({
    openMicrophone = browserMicrophone,
    createRecorder = browserRecorder,
    transcribe = requestTranscript,
    onTranscript,
    onStatus = () => {},
    onState = () => {},
    now = () => performance.now(),
    // Wrapped: browsers throw "Illegal invocation" when setTimeout is called as this.setTimer().
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (id) => clearTimeout(id),
  }) {
    Object.assign(this, { openMicrophone, createRecorder, transcribe, onTranscript, onStatus, onState, now, setTimer, clearTimer });
    this.state = 'idle';
    this.recorder = null;
    this.timer = null;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  /** The mic button: start when idle (and the chat can send), stop and transcribe when recording. */
  async toggle(canStart = true) {
    if (this.state === 'recording') return this.stop();
    if (this.state === 'idle' && canStart) return this.start();
  }

  async start() {
    this.setState('starting');
    let stream;
    try {
      stream = await this.openMicrophone();
    } catch (error) {
      this.onStatus(microphoneError(error));
      this.setState('idle');
      return;
    }
    if (this.state !== 'starting') {
      // Cancelled while the permission prompt was open.
      for (const track of stream.getTracks?.() ?? []) track.stop();
      return;
    }
    this.recorder = this.createRecorder(stream);
    this.recorder.start();
    this.startedAt = this.now();
    this.timer = this.setTimer(() => this.stop(), MAX_RECORD_SECONDS * 1000);
    this.setState('recording');
    this.onStatus('🎙️ Recording… click the mic again to send');
  }

  async stop() {
    if (this.state !== 'recording') return;
    this.clearTimer(this.timer);
    const recorder = this.recorder;
    this.recorder = null;
    this.setState('transcribing');
    const blob = await recorder.stop();
    if (this.now() - this.startedAt < MIN_RECORD_MS || !blob.size) {
      this.onStatus('Recording too short · try again or type');
      this.setState('idle');
      return;
    }
    this.onStatus('Transcribing…');
    let text;
    try {
      text = cleanTranscript(await this.transcribe(blob));
    } catch (error) {
      this.onStatus(`Voice input failed · ${error?.message || 'unknown error'}`);
      this.setState('idle');
      return;
    }
    this.setState('idle');
    if (!text) {
      this.onStatus("I didn't catch that · try again or type");
      return;
    }
    this.onTranscript(text);
  }

  /** Drop any recording in progress without transcribing it (e.g. the bridge disconnected). */
  cancel() {
    if (this.state === 'recording') {
      this.clearTimer(this.timer);
      this.recorder.cancel();
      this.recorder = null;
    }
    if (this.state === 'recording' || this.state === 'starting') this.setState('idle');
  }
}
