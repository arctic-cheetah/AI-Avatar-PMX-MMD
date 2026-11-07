// Synthetic transition scenarios for issue #54. Shared by transitions.test.mjs
// (automated checks) and transition-trace.mjs (numbers for side-by-side review).
// No private PMX data: the face below is a stand-in with made-up morph names.
import { ExpressionController } from "../../renderer/expression-controller.js";
import { ThinkingPose } from "../../renderer/thinking-pose.js";
import { GazeController } from "../../renderer/gaze-tracking.js";
import { SWAY, SwayController, swayAnglesAt } from "../../renderer/body-sway.js";
import { SpeechPlayer } from "../../renderer/speech-player.js";

/** Normal and reduced frame rates every scenario is sampled at. */
export const FRAME_RATES = Object.freeze([60, 30, 15]);

/** Stand-in mood catalog. `shout` plays the role of an open-mouth mood shape. */
export const SYNTHETIC_CATALOG = Object.freeze({
  neutral: { morphs: {} },
  happy: { morphs: { smile: 1 } },
  sad: { morphs: { brow: 1, frown: 0.6 } },
  angry: { morphs: { brow: 0.5, glare: 1 } },
  thinking: { morphs: { squint: 1 } },
  yelling: { morphs: { glare: 0.8, shout: 1 } },
});

/** Stand-in speech shapes: `a` opens the jaw, A closes the lips, X rests. */
export const SYNTHETIC_SHAPES = Object.freeze({
  A: { description: "closed", morphs: {} },
  D: { description: "open", morphs: { a: 0.9 } },
  X: { description: "rest", morphs: {} },
});

const FACE_MORPHS = ["smile", "brow", "frown", "glare", "squint", "shout", "a"];

/** @returns {{ morphTargetDictionary: Record<string, number>, morphTargetInfluences: number[] }} */
export function syntheticFace(names = FACE_MORPHS) {
  return {
    morphTargetDictionary: Object.fromEntries(names.map((name, index) => [name, index])),
    morphTargetInfluences: names.map(() => 0),
  };
}

/**
 * Drive a subject frame by frame and collect channel values.
 * Events fire on the first frame whose start time reaches `at`; scenario times
 * are multiples of 1/15 s so every frame rate sees them at the same moment.
 * @returns {{ times: number[], series: Record<string, number[]>, changes: number[], fps: number }}
 */
export function runScenario(scenario, fps) {
  const dt = 1 / fps;
  const subject = scenario.create();
  const events = [...scenario.events].sort((a, b) => a.at - b.at);
  const series = {};
  const record = (values) => {
    for (const [name, value] of Object.entries(values)) (series[name] ??= []).push(value);
  };
  record(scenario.frame(subject, 0, 0));
  const times = [0];
  const changes = [];
  let next = 0;
  const frames = Math.round(scenario.duration * fps);
  for (let k = 1; k <= frames; k += 1) {
    const start = (k - 1) * dt;
    let changed = false;
    while (next < events.length && events[next].at <= start + 1e-9) {
      events[next].run(subject);
      next += 1;
      changed = true;
    }
    if (changed) changes.push(k);
    record(scenario.frame(subject, dt, k * dt));
    times.push(k * dt);
  }
  return { times, series, changes, fps };
}

/**
 * Smoothness metrics for each channel of one run.
 * - maxStep: largest change between two frames.
 * - peakVelocity: largest speed, units per second.
 * - maxVelocityJump: largest frame-to-frame change in speed, units per second.
 *   An exponential ease jumps straight to full speed when a target changes, and
 *   an interrupted ease reverses instantly; both show up here.
 */
export function measure(run) {
  const dt = 1 / run.fps;
  const result = {};
  for (const [name, values] of Object.entries(run.series)) {
    let maxStep = 0;
    let peakVelocity = 0;
    let maxVelocityJump = 0;
    let previousVelocity = 0;
    for (let i = 1; i < values.length; i += 1) {
      const step = values[i] - values[i - 1];
      const velocity = step / dt;
      maxStep = Math.max(maxStep, Math.abs(step));
      peakVelocity = Math.max(peakVelocity, Math.abs(velocity));
      maxVelocityJump = Math.max(maxVelocityJump, Math.abs(velocity - previousVelocity));
      previousVelocity = velocity;
    }
    result[name] = { maxStep, peakVelocity, maxVelocityJump, min: Math.min(...values), max: Math.max(...values) };
  }
  return result;
}

/** Value of one channel at a wall-clock time (nearest recorded frame). */
export function valueAt(run, channel, time) {
  const index = Math.round(time * run.fps);
  return run.series[channel][index];
}

/** One frame of the face, in the renderer's order: clear, mood, then speech. */
function faceFrame(face, expressions, speech) {
  return (delta) => {
    face.morphTargetInfluences.fill(0);
    expressions.update(delta);
    speech?.update(delta);
    const { morphTargetDictionary: dict, morphTargetInfluences: weights } = face;
    return Object.fromEntries(Object.entries(dict).map(([name, index]) => [name, weights[index]]));
  };
}

function moodSubject() {
  const face = syntheticFace();
  const expressions = new ExpressionController(face, SYNTHETIC_CATALOG);
  return { face, expressions, step: faceFrame(face, expressions) };
}

const mood = (name, weight = 1) => (subject) => subject.expressions.setExpression(name, weight);
const moodChannels = (subject, delta) => {
  const values = subject.step(delta);
  return { smile: values.smile, brow: values.brow, frown: values.frown, glare: values.glare };
};

/** Fake audio clock so the speech player follows the scenario's frame clock. */
function speakingSubject() {
  const face = syntheticFace();
  const expressions = new ExpressionController(face, SYNTHETIC_CATALOG);
  // `shout` stands in for the PMX's open-mouth mood shapes.
  const speech = new SpeechPlayer(face, SYNTHETIC_SHAPES, { connect: async () => null }, { yields: ["shout"] });
  const pose = new ThinkingPose();
  const clock = { now: 0 };
  speech.context = {
    get currentTime() { return clock.now; },
    getOutputTimestamp: () => ({ contextTime: clock.now }),
  };
  const subject = { face, expressions, speech, pose, clock, step: faceFrame(face, expressions, speech) };
  subject.startSpeech = (visemes) => {
    speech.source = { stop() {}, disconnect() {} };
    speech.clip = { visemes };
    speech.cueIndex = 0;
    speech.startTime = clock.now;
    speech.outputDelay = 0;
  };
  subject.endSpeech = () => {
    speech.source = null;
    speech.clip = null;
  };
  return subject;
}

const t = (frames15) => frames15 / 15;

/** Scenarios from the issue's reproduction list. */
export const SCENARIOS = Object.freeze([
  {
    name: "neutral → mood → neutral",
    duration: 2,
    create: moodSubject,
    events: [{ at: t(3), run: mood("happy") }, { at: t(15), run: mood("neutral") }],
    frame: moodChannels,
  },
  {
    name: "mood → different mood",
    duration: 2,
    create: () => {
      const subject = moodSubject();
      subject.expressions.setExpression("happy");
      for (let i = 0; i < 120; i += 1) subject.step(1 / 60);
      return subject;
    },
    events: [{ at: t(3), run: mood("sad") }],
    frame: moodChannels,
  },
  {
    name: "rapid interrupted moods",
    duration: 2,
    create: moodSubject,
    events: [
      { at: t(3), run: mood("happy") },
      { at: t(4), run: mood("sad") },
      { at: t(5), run: mood("angry") },
      { at: t(6), run: mood("neutral") },
      { at: t(7), run: mood("happy") },
    ],
    frame: moodChannels,
  },
  {
    name: "thinking pose enter, interrupted leave, re-enter",
    duration: 2.5,
    create: () => new ThinkingPose(),
    events: [
      { at: t(3), run: (pose) => pose.setActive(true) },
      { at: t(6), run: (pose) => pose.setActive(false) },
      { at: t(8), run: (pose) => pose.setActive(true) },
      { at: t(18), run: (pose) => pose.setActive(false) },
    ],
    frame: (pose, delta) => ({ pose: pose.update(delta) }),
  },
  {
    name: "gaze target jump and recentre",
    duration: 2,
    create: () => new GazeController(),
    events: [
      { at: t(3), run: (gaze) => gaze.setCursor({ x: 1, y: 0 }, true) },
      { at: t(6), run: (gaze) => gaze.setCursor({ x: 0, y: 0 }, true) },
      { at: t(8), run: (gaze) => gaze.setCursor({ x: 1, y: 0 }, true) },
      { at: t(15), run: (gaze) => gaze.setCursor({ x: 0, y: 0 }, false) },
    ],
    frame: (gaze, delta, now) => ({ gaze: gaze.update(delta, now * 1000).eyeYaw / 0.38 }),
  },
  {
    name: "sway stop at peak, then restart",
    duration: 6,
    create: () => new SwayController(),
    // Roll peaks at 1.5 s (a quarter of its 6 s period); stop just before it.
    events: [
      { at: t(22), run: (sway) => sway.setEnabled(false) },
      { at: t(60), run: (sway) => sway.setEnabled(true) },
    ],
    frame: (sway, delta, now) => {
      // Before #54 the controller had no fade, so its gain is just on/off.
      const gain = typeof sway.update === "function" ? sway.update(delta) : (sway.enabled ? 1 : 0);
      const angles = swayAnglesAt(now);
      const degrees = 180 / Math.PI;
      return {
        roll: angles.roll * gain * degrees,
        yaw: angles.yaw * gain * degrees,
        breath: angles.breath * gain * degrees,
      };
    },
  },
  {
    name: "thinking → speaking → idle",
    duration: 3,
    create: speakingSubject,
    events: [
      { at: t(0), run: (s) => { s.expressions.setExpression("thinking", 0.6); s.pose.setActive(true); } },
      {
        at: t(9),
        run: (s) => {
          s.expressions.setExpression("yelling");
          s.pose.setActive(false);
          s.startSpeech([
            { start: 0, end: 0.1, shape: "X" },
            { start: 0.1, end: 0.4, shape: "D" },
            { start: 0.4, end: 0.47, shape: "A" },
            { start: 0.47, end: 0.8, shape: "D" },
            { start: 0.8, end: 1, shape: "X" },
          ]);
        },
      },
      { at: t(24), run: (s) => s.endSpeech() },
      { at: t(33), run: (s) => s.expressions.setExpression("neutral") },
    ],
    frame: (s, delta, now) => {
      s.clock.now = now;
      const values = s.step(delta);
      return { squint: values.squint, glare: values.glare, shout: values.shout, a: values.a, pose: s.pose.update(delta) };
    },
  },
]);

/** Sway channel names, for callers that treat them separately (degrees). */
export const SWAY_CHANNELS = Object.freeze(Object.keys(SWAY));
