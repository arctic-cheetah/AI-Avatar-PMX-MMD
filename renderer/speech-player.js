/**
 * Play a saved speech clip and drive mouth morphs from its viseme track.
 *
 * Timing follows the audio clock (what the speakers are outputting), never
 * wall time, so the mouth stays on the sound. The track comes from
 * controller/speech_align.py; the LLM never supplies timings.
 *
 * Speech owns articulation: while speaking it blends every speech morph from
 * the mood's value toward its own shape, so closed-lip shapes really close
 * the mouth. During pauses (X) and after the clip it hands the mouth back.
 */

/** Rhubarb rounds times to 10 ms. */
const TOLERANCE = 0.011;
/** Show each shape slightly before its sound, as real mouths do. */
const LOOKAHEAD = 0.02;
/** Shape easing rate per second: about 28 ms to close most of the gap. */
const SHAPE_RATE = 35;
/** Lip closures (A) are short; snap faster so they survive dropped frames. */
const CLOSURE_RATE = 80;
/** Rate for handing the mouth between speech and mood. */
const ENVELOPE_RATE = 18;

/**
 * @typedef {{ description: string, morphs: Record<string, number> }} SpeechShape
 * @typedef {{ start: number, end: number, shape: string }} Viseme
 * @typedef {{ buffer: AudioBuffer, visemes: Viseme[], transcript: string | null }} SpeechClip
 */

/** @returns {Promise<Record<string, SpeechShape>>} Validated speech shapes. */
export async function loadSpeechShapes() {
  const response = await fetch(new URL("./speech-shapes.json", import.meta.url));
  if (!response.ok) throw new Error(`Speech shape request failed (${response.status}).`);
  const shapes = await response.json();
  for (const name of "ABCDEFGHX") {
    const shape = shapes?.[name];
    if (!shape || typeof shape.description !== "string" || typeof shape.morphs !== "object" || shape.morphs === null) {
      throw new Error(`Invalid speech shape: ${name}`);
    }
    for (const weight of Object.values(shape.morphs)) {
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error(`Invalid weight in speech shape: ${name}`);
    }
  }
  return shapes;
}

export class SpeechPlayer {
  /**
   * @param {import("three").SkinnedMesh} mesh Loaded PMX mesh.
   * @param {Record<string, SpeechShape>} shapes Speech shape catalog.
   */
  constructor(mesh, shapes) {
    this.mesh = mesh;
    this.shapes = shapes;
    /** @type {Map<string, { index: number, weight: number }>} Speech-owned morphs by PMX name. */
    this.morphs = new Map();
    /** @type {string[]} */
    this.missingMorphs = [];
    for (const shape of Object.values(shapes)) {
      for (const morph of Object.keys(shape.morphs)) {
        const index = mesh.morphTargetDictionary?.[morph];
        if (index == null) {
          if (!this.missingMorphs.includes(morph)) this.missingMorphs.push(morph);
        } else {
          this.morphs.set(morph, { index, weight: 0 });
        }
      }
    }
    this.envelope = 0;
    /** @type {AudioContext | null} */
    this.context = null;
    /** @type {AudioBufferSourceNode | null} */
    this.source = null;
    /** @type {SpeechClip | null} */
    this.clip = null;
    this.startTime = 0;
    this.cueIndex = 0;
    /** @type {(() => void) | null} */
    this.onEnded = null;
  }

  get playing() {
    return this.source !== null;
  }

  /** @returns {AudioContext} Shared audio context, created on first use. */
  audioContext() {
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    return this.context;
  }

  /**
   * Fetch, decode and validate one clip and its viseme track.
   * @param {string} audioUrl Final converted WAV.
   * @param {string} trackUrl Matching .visemes.json.
   * @returns {Promise<SpeechClip>} Clip ready to play.
   */
  async load(audioUrl, trackUrl) {
    const [audioResponse, trackResponse] = await Promise.all([fetch(audioUrl), fetch(trackUrl)]);
    if (!audioResponse.ok || !trackResponse.ok) throw new Error("Speech sample not found. Run controller/speech_align.py first.");
    const [audio, track] = await Promise.all([audioResponse.arrayBuffer(), trackResponse.json()]);
    const buffer = await this.audioContext().decodeAudioData(audio);
    if (!Number.isFinite(track?.duration) || Math.abs(track.duration - buffer.duration) > 0.05) {
      throw new Error("Viseme track does not match the audio duration. Re-run the aligner.");
    }
    const visemes = track.visemes;
    if (!Array.isArray(visemes) || visemes.length === 0) throw new Error("Viseme track is empty.");
    let previousEnd = 0;
    for (const cue of visemes) {
      if (!Object.hasOwn(this.shapes, cue?.shape) || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < previousEnd - TOLERANCE || cue.end <= cue.start || cue.end > buffer.duration + TOLERANCE) {
        throw new Error("Viseme track has an invalid cue.");
      }
      previousEnd = cue.end;
    }
    return { buffer, visemes, transcript: typeof track.transcript === "string" ? track.transcript : null };
  }

  /**
   * Start a clip from the beginning, replacing any clip already playing.
   * @param {SpeechClip} clip Loaded clip.
   * @returns {Promise<void>}
   */
  async play(clip) {
    this.stop();
    const context = this.audioContext();
    await context.resume();
    const source = context.createBufferSource();
    source.buffer = clip.buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.source === source) {
        this.source = null;
        this.onEnded?.();
      }
    };
    this.clip = clip;
    this.cueIndex = 0;
    this.startTime = context.currentTime;
    this.source = source;
    source.start(this.startTime);
  }

  /** Stop audio and release the mouth back to the mood. */
  stop() {
    const source = this.source;
    this.source = null;
    source?.stop();
  }

  /**
   * Seconds into the clip that the speakers are outputting now.
   * @returns {number} Audio-relative time.
   */
  audioTime() {
    const context = this.context;
    const output = context.getOutputTimestamp?.().contextTime;
    const heard = Number.isFinite(output) && output > 0
      ? output
      : context.currentTime - (context.outputLatency || context.baseLatency || 0);
    return heard - this.startTime;
  }

  /**
   * Find the cue at an audio-relative time; cues are ordered, so scan forward.
   * @param {number} time Seconds into the clip.
   * @returns {Viseme | null} Active cue, if any.
   */
  cueAt(time) {
    const visemes = this.clip.visemes;
    if (time < visemes[this.cueIndex].start) this.cueIndex = 0;
    while (this.cueIndex < visemes.length - 1 && time >= visemes[this.cueIndex].end) this.cueIndex += 1;
    const cue = visemes[this.cueIndex];
    return time >= cue.start && time < cue.end ? cue : null;
  }

  /**
   * Ease speech morphs toward the current shape and blend them over the mood.
   * Call after the mood channel has written its morphs for this frame.
   * @param {number} delta Seconds elapsed since the previous frame.
   * @returns {void}
   */
  update(delta) {
    const step = Math.max(0, delta);
    const cue = this.playing ? this.cueAt(this.audioTime() + LOOKAHEAD) : null;
    const speaking = cue !== null && cue.shape !== "X";
    const targets = speaking ? this.shapes[cue.shape].morphs : {};
    const shapeBlend = 1 - Math.exp(-(cue?.shape === "A" ? CLOSURE_RATE : SHAPE_RATE) * step);
    this.envelope += ((speaking ? 1 : 0) - this.envelope) * (1 - Math.exp(-ENVELOPE_RATE * step));
    const influences = this.mesh.morphTargetInfluences;
    for (const [name, morph] of this.morphs) {
      morph.weight += ((targets[name] ?? 0) - morph.weight) * shapeBlend;
      influences[morph.index] = influences[morph.index] * (1 - this.envelope) + morph.weight * this.envelope;
    }
  }
}
