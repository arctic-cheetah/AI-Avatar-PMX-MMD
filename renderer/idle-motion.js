// Idle motions for issue #71: glances, head tilts and sighs while idle, and a
// stretch with a slow yawn just before sleepy, then random sleep actions while sleepy. No DOM or Three.js imports, so node --test
// covers it (tests/renderer/idle-motion.test.mjs). main.js turns the pose into
// a gaze target and small bone rotations on top of the rest pose.
// See docs/idle-behaviours.md#idle-motions.

import { Spring } from "./smoothing.js";
import { IDLE_TIMING } from "./idle-behaviour.js";
import { ACTION_CATALOG } from "./speech-actions.js";

const DEG = Math.PI / 180;
/** The arm drift's weight while asleep or waking (#193). */
const SLEEPY_DRIFT = 0.6;

/** Timings in seconds, angles in radians, glance sizes as normalised gaze targets. */
export const IDLE_MOTION = Object.freeze({
  /** Quiet seconds before each motion, picked uniformly. */
  gap: Object.freeze([8, 20]),
  glance: Object.freeze({
    /** Slow, eased glances (#149): the user found the old 1.2-2.2 s ones darting. */
    duration: Object.freeze([2.2, 3.2]),
    rise: 0.9,
    x: Object.freeze([0.45, 0.75]),
    y: Object.freeze([-0.15, 0.15]),
  }),
  tilt: Object.freeze({ duration: Object.freeze([2, 3.5]), angle: 5 * DEG, rise: 0.6 }),
  sigh: Object.freeze({ inhale: 1.1, exhale: 1.7, chest: 2 * DEG, shoulders: 2.5 * DEG }),
  /** One or both shoulders lift and drop (#149). */
  shrug: Object.freeze({ duration: Object.freeze([2.4, 3.0]), angle: 12 * DEG, rise: 1.2 }),
  /** The dozing nod sleep action: head dips forward and lifts (#149). */
  nod: Object.freeze({ angle: 6 * DEG, rise: 1 }),
  stretch: Object.freeze({ rise: 1, back: 5 * DEG, headPitch: 7 * DEG, shoulders: 6 * DEG }),
  /** The yawn during the stretch: the user's mouth pick, opened slowly (#71). */
  yawn: Object.freeze({ open: 1.4, hold: 0.6, close: 1.0, morphs: Object.freeze({ "あ": 1, "お": 0.4 }) }),
  /** The hand under her chin as she yawns (#270): up over `rise`, then down with the yawn's close. */
  yawnHand: Object.freeze({ rise: 0.9 }),
  /**
   * A light sneeze (#149): keyframes in seconds and the value at each, eased
   * between them. Breathe in with the head back (0-0.9 s), snap forward with
   * the eyes shut, hold, then rest. headPitch: positive tips the head back.
   */
  sneeze: Object.freeze({
    keys: Object.freeze([0, 0.9, 1.05, 1.45, 2.3]),
    headPitch: Object.freeze([0, 4 * DEG, -6 * DEG, -5 * DEG, 0]),
    chest: Object.freeze([0, 1.5 * DEG, 0, 0, 0]),
    shoulders: Object.freeze([0, 1 * DEG, 3 * DEG, 2 * DEG, 0]),
    yawn: Object.freeze([0, 0.3, 0, 0, 0]),
    squint: Object.freeze([0, 0.5, 1, 0.9, 0]),
    /** Morphs the squint channel drives: eyes squeezed shut. */
    eyes: Object.freeze({ "まばたき": 1 }),
  }),
  /** Playful wink (#149 part 1): close, hold, open; a little smile and a tilt toward the eye. */
  wink: Object.freeze({
    keys: Object.freeze([0, 0.2, 1.0, 1.4]),
    close: Object.freeze([0, 1, 1, 0]),
    tilt: Object.freeze([0, 3 * DEG, 3 * DEG, 0]),
    mouthLift: Object.freeze([0, 0.5, 0.5, 0]),
  }),
  /** Look-around: the gaze drifts left, pauses, drifts right, pauses, then back. */
  lookAround: Object.freeze({
    keys: Object.freeze([0, 1.0, 1.8, 3.2, 4.0, 5.0]),
    x: Object.freeze([0, -0.6, -0.6, 0.6, 0.6, 0]),
    y: Object.freeze([0, 0.05, 0.05, 0, 0, 0]),
    rise: 0.8,
  }),
  /** A little shiver: a fast tremble, its size eased in and out. */
  shiver: Object.freeze({ angle: 0.6 * DEG, hz: 6, duration: 1.4, rise: 0.3 }),
  /** A hiccup: a quick hop of the chest and shoulders with wide eyes. */
  hiccup: Object.freeze({
    keys: Object.freeze([0, 0.12, 0.35, 1.0]),
    chest: Object.freeze([0, 2 * DEG, 0.5 * DEG, 0]),
    shoulders: Object.freeze([0, 3 * DEG, 1 * DEG, 0]),
    headPitch: Object.freeze([0, 2 * DEG, 0.5 * DEG, 0]),
    surprise: Object.freeze([0, 0.6, 0.3, 0]),
  }),
  /** Nodding off: droop slowly with heavy eyes, then jerk up wide awake. */
  noddingOff: Object.freeze({
    keys: Object.freeze([0, 2.4, 2.55, 2.85, 3.3, 4.6]),
    headPitch: Object.freeze([0, -6 * DEG, -6 * DEG, 3 * DEG, 2 * DEG, 0]),
    squint: Object.freeze([0, 0.6, 0.6, 0, 0, 0]),
    surprise: Object.freeze([0, 0, 0, 0.5, 0.3, 0]),
  }),
  /** Humming bob (#149 part 2): a head bob to a beat, a slower sway and a soft smile. */
  hum: Object.freeze({ duration: 4, rise: 0.8, pitch: 1.2 * DEG, roll: 1 * DEG, hz: 1.6, swayHz: 0.8, smile: 0.35 }),
  /** Contented smile: ease in, hold, ease out, the head tipped a touch forward. */
  contented: Object.freeze({
    keys: Object.freeze([0, 0.6, 2.4, 3.0]),
    smile: Object.freeze([0, 1, 1, 0]),
    headPitch: Object.freeze([0, -1 * DEG, -1 * DEG, 0]),
  }),
  /** Eyebrow raise: a curious "oh?" with a small tilt and the head back a touch. */
  browRaise: Object.freeze({
    keys: Object.freeze([0, 0.25, 1.2, 1.6]),
    browRaise: Object.freeze([0, 1, 1, 0]),
    tilt: Object.freeze([0, 2 * DEG, 2 * DEG, 0]),
    headPitch: Object.freeze([0, 1 * DEG, 1 * DEG, 0]),
  }),
  /** Deep breath: a slower, fuller sigh; the eyes relax on the way out. */
  deepBreath: Object.freeze({
    keys: Object.freeze([0, 2.0, 2.4, 4.8]),
    chest: Object.freeze([0, 2 * DEG, 2 * DEG, 0]),
    shoulders: Object.freeze([0, 4 * DEG, 4 * DEG, 0]),
    headPitch: Object.freeze([0, 1.5 * DEG, 1.5 * DEG, 0]),
    squint: Object.freeze([0, 0, 0.35, 0]),
    exhale: Object.freeze([0, 0.15, 0.35, 0]),
  }),
  /** The sigh's breathing mouth: a little open breathing in, more breathing out. */
  sighMouth: Object.freeze({ in: 0.15, out: 0.35, open: 0.3 }),
  /** Sniffle (#149 part 3): two quick sniffs, the head tipping up each time. */
  sniffle: Object.freeze({
    keys: Object.freeze([0, 0.18, 0.4, 0.62, 0.84, 1.6]),
    headPitch: Object.freeze([0, 1.5 * DEG, 0, 1.5 * DEG, 0, 0]),
    chest: Object.freeze([0, 0.8 * DEG, 0, 0.8 * DEG, 0, 0]),
    squint: Object.freeze([0, 0.25, 0.05, 0.25, 0.05, 0]),
  }),
  /**
   * Neck roll: one slow, even circle of the head. It starts a quarter turn in
   * (phase), so back, both sides and forward all come at full size inside the
   * ease: about 3.3 degrees each way on the head bone (the user, 14 Nov 2026).
   */
  neckRoll: Object.freeze({ duration: 5, rise: 0.6, pitch: 5.5 * DEG, roll: 4 * DEG, phase: -Math.PI / 4 }),
  /** Weight shift: lean to one side and hold; the head tilts back to stay level. */
  weightShift: Object.freeze({ duration: Object.freeze([4.5, 5.5]), rise: 1.2, lean: 3 * DEG, head: 0.5 }),
  /** Shy look-away: eyes and head drop to one side with a shy giggle. */
  shy: Object.freeze({ duration: 3.5, rise: 0.9, x: 0.5, y: 0.45, headPitch: 3 * DEG, tilt: 2 * DEG }),
  /**
   * Arm drift (#193): always on while idle, not an action. Sizes in radians;
   * each channel mixes two sine waves (periods in seconds, weights in `mix`)
   * that never line up, and the right of the screen runs `rightScale` slower
   * on its own phases. `out` and `elbow` only go one way, so the arms never
   * press into the body or bend past straight. `levels` is the drift's
   * weight per idle state; `rate` is its spring.
   */
  armDrift: Object.freeze({
    sway: 2.5 * DEG,
    /** The arms sway out up to `out` and back in past rest up to `in` (the user, 15 Nov 2026). */
    out: 2 * DEG,
    in: 1.5 * DEG,
    elbow: 4 * DEG,
    /** The wrist replays the elbow's wave this many seconds later (natural hands, #199). */
    wrist: 3 * DEG,
    wristLag: 1.2,
    /** The forearm rolls on its twist bone; the finger curl is per joint, scaled like the rest curl. */
    forearm: 4 * DEG,
    curl: 3 * DEG,
    /** Each finger replays the index finger's curl this much later than the one before it. */
    rippleLag: 0.35,
    /** The fingers fan apart and close (finger sway, the user, 15 Nov 2026). */
    spread: 2.5 * DEG,
    periods: Object.freeze({
      sway: Object.freeze([23, 37]),
      out: Object.freeze([29, 47]),
      elbow: Object.freeze([19, 31]),
      forearm: Object.freeze([21, 39]),
      curl: Object.freeze([13, 29]),
      spread: Object.freeze([11, 23]),
    }),
    mix: Object.freeze([0.6, 0.4]),
    rightScale: 1.13,
    sleepy: SLEEPY_DRIFT,
    levels: Object.freeze({ idle: 1, stretching: 1, sleepy: SLEEPY_DRIFT, waking: SLEEPY_DRIFT }),
    rate: 2,
  }),
  /** Spring rate for every angle, so interrupted motions ease back. */
  rate: 8,
  /** The eyes close faster than bones move, so a sneeze's squint keeps up. */
  squintRate: 30,
});

const ANGLES = ["tilt", "chest", "shoulders", "shoulderLeft", "shoulderRight", "back", "headPitch", "shiver", "hum", "lean",
  "yawn", "yawnHand", "squint", "winkLeft", "winkRight", "mouthLift", "surprise", "smile", "browRaise", "shy", "exhale"];

/**
 * Face channels (#149): an action writes a 0-1 weight per channel, and the
 * renderer adds these morphs on top of the mood. Winks are named by the side
 * of the screen, checked in a grid of the model: ウィンク右 closes the eye on
 * the left of the screen.
 */
export const FACE_MORPHS = Object.freeze({
  yawn: IDLE_MOTION.yawn.morphs,
  squint: IDLE_MOTION.sneeze.eyes,
  winkLeft: Object.freeze({ "ウィンク右": 1 }),
  winkRight: Object.freeze({ "ウィンク": 1 }),
  mouthLift: Object.freeze({ "口角上げ": 1 }),
  surprise: Object.freeze({ "びっくり": 1 }),
  /** Soft smiling eyes (the user's pick B, #149 part 2). */
  smile: Object.freeze({ "笑い": 0.5, "にこり": 0.6, "口角上げ": 0.6 }),
  /** A curious eyebrow raise (the user's pick G). */
  browRaise: Object.freeze({ "上": 0.8, "びっくり": 0.3 }),
  /** A shy giggle (the user's pick C, #149 part 3); the model has no blush morph. */
  shy: Object.freeze({ "笑い": 0.35, "困る": 0.4 }),
  /** Breathing mouth for the sigh and the deep breath (the user's idea: お). */
  exhale: Object.freeze({ "お": 1 }),
});
const LIMITS = Object.freeze({
  tilt: [-IDLE_MOTION.tilt.angle, IDLE_MOTION.tilt.angle],
  chest: [0, IDLE_MOTION.sigh.chest],
  shoulders: [0, Math.max(IDLE_MOTION.sigh.shoulders, IDLE_MOTION.stretch.shoulders)],
  shoulderLeft: [0, IDLE_MOTION.shrug.angle],
  shoulderRight: [0, IDLE_MOTION.shrug.angle],
  back: [0, IDLE_MOTION.stretch.back],
  headPitch: [-IDLE_MOTION.nod.angle, IDLE_MOTION.stretch.headPitch],
  yawn: [0, 1],
  yawnHand: [0, 1],
  squint: [0, 1],
  winkLeft: [0, 1],
  winkRight: [0, 1],
  mouthLift: [0, 1],
  surprise: [0, 1],
  shiver: [0, IDLE_MOTION.shiver.angle],
  hum: [0, 1],
  smile: [0, 1],
  browRaise: [0, 1],
  shy: [0, 1],
  exhale: [0, 1],
  lean: [-IDLE_MOTION.weightShift.lean, IDLE_MOTION.weightShift.lean],
});

/** Arm drift parts and the IDLE_MOTION.armDrift size each one uses (#193). */
/** Fingers by screen-independent name, and how many ripple steps each curls after the index finger. */
const RIPPLE = Object.freeze({ Thumb: 0, Index: 0, Middle: 1, Ring: 2, Little: 3 });
const ARM_PARTS = Object.freeze({
  armSway: "sway", armOut: "out", elbow: "elbow", wrist: "wrist", forearm: "forearm",
  ...Object.fromEntries(Object.keys(RIPPLE).map((finger) => [`curl${finger}`, "curl"])),
  spread: "spread",
});
const ONE_WAY = new Set(["elbow"]);
/** Parts without their own wave: the wrist replays the elbow's, `wristLag` seconds later. */
const FOLLOWS = Object.freeze({ wrist: "elbow" });

/** The twenty-two arm drift angles, named by screen side like the shrugs. */
export const ARM_CHANNELS = Object.freeze(Object.keys(ARM_PARTS).flatMap((part) => [`${part}Left`, `${part}Right`]));

/**
 * The arm drift angles at `clock` seconds, scaled by `amount` (0-1).
 * A two-wave mix per channel stays within ±1, so each angle stays within its size.
 * @param {number} clock Seconds of motion so far.
 * @param {number} amount The drift's eased weight.
 * @returns {Record<string, number>} Radians per ARM_CHANNELS name.
 */
export function armDriftAngles(clock, amount) {
  const drift = IDLE_MOTION.armDrift;
  const [a, b] = drift.mix;
  const keys = Object.values(ARM_PARTS);
  // One part's raw wave (-1..1) on one side; each part has its own phases.
  const waveOf = (key, right, time) => {
    const [first, second] = drift.periods[key];
    const scale = right ? drift.rightScale : 1;
    const phase = 1.3 * keys.indexOf(key) + (right ? 2.4 : 0);
    return a * Math.sin((2 * Math.PI * time) / (first * scale) + phase)
      + b * Math.sin((2 * Math.PI * time) / (second * scale) + 1.7 * phase + 0.9);
  };
  const angles = {};
  for (const [part, key] of Object.entries(ARM_PARTS)) {
    for (const [side, right] of [["Left", false], ["Right", true]]) {
      if (!(amount > 0)) {
        angles[part + side] = 0;
        continue;
      }
      const ripple = RIPPLE[part.slice(4)] ?? 0;
      const wave = FOLLOWS[key]
        ? waveOf(FOLLOWS[key], right, clock - drift.wristLag)
        : waveOf(key, right, ripple ? clock - ripple * drift.rippleLag : clock);
      const size = drift[key] * amount;
      if (key === "out") {
        // From `in` toward the body to `out` away from it.
        angles[part + side] = amount * (-drift.in + (drift.in + drift.out) * (0.5 + 0.5 * wave));
      } else {
        angles[part + side] = ONE_WAY.has(key) ? size * (0.5 + 0.5 * wave) : size * wave;
      }
    }
  }
  return angles;
}

export const ARM_DRIFT_KEY = "yidhari.arm-drift";

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const within = ([min, max], r) => min + (max - min) * r;

/**
 * Authored envelope: ease in over `rise`, hold at 1, ease out over `rise`.
 * Short durations shrink the ramps so the curve stays symmetric.
 * @param {number} t Seconds since the motion began.
 * @param {number} duration Total seconds.
 * @param {number} rise Ramp seconds at each end.
 * @returns {number} Weight from 0 to 1.
 */
export function bump(t, duration, rise) {
  if (!(t > 0) || !(t < duration)) return 0;
  const ramp = Math.min(rise, duration / 2);
  return smoothstep(t / ramp) * smoothstep((duration - t) / ramp);
}

/** Breath in over `inhale`, out over `exhale`. */
function sighCurve(t) {
  const { inhale, exhale } = IDLE_MOTION.sigh;
  if (!(t > 0) || t >= inhale + exhale) return 0;
  return t < inhale ? smoothstep(t / inhale) : 1 - smoothstep((t - inhale) / exhale);
}

/** Yawn: open slowly, hold, close; 0 outside its length. */
function yawnCurve(t) {
  const { open, hold, close } = IDLE_MOTION.yawn;
  if (!(t > 0) || t >= open + hold + close) return 0;
  if (t < open) return smoothstep(t / open);
  if (t < open + hold) return 1;
  return 1 - smoothstep((t - open - hold) / close);
}

/** The hand under her chin: up before the mouth is wide, held, down as it closes. */
function yawnHandCurve(t) {
  const { open, hold, close } = IDLE_MOTION.yawn;
  if (!(t > 0) || t >= open + hold + close) return 0;
  if (t < open + hold) return smoothstep(t / IDLE_MOTION.yawnHand.rise);
  return 1 - smoothstep((t - open - hold) / close);
}

/** The stretch with its yawn; also the step into sleepy. */
function stretchYawn(t, target) {
  const { rise, back, headPitch, shoulders } = IDLE_MOTION.stretch;
  const weight = bump(t, IDLE_TIMING.stretch, rise);
  target.back = weight * back;
  target.headPitch = weight * headPitch;
  target.shoulders = weight * shoulders;
  target.yawn = yawnCurve(t);
  target.yawnHand = yawnHandCurve(t);
}

/** A head tilt; sign 1 leans toward the left of the screen. */
const tilt = (sign) => ({
  create: (random) => ({ duration: within(IDLE_MOTION.tilt.duration, random()) }),
  apply: (motion, target) => {
    target.tilt = sign * IDLE_MOTION.tilt.angle * bump(motion.t, motion.duration, IDLE_MOTION.tilt.rise);
    return null;
  },
});

/** One or both shoulders (left/right of the screen) lift and drop. */
const shrug = (left, right) => ({
  create: (random) => ({ duration: within(IDLE_MOTION.shrug.duration, random()) }),
  apply: (motion, target) => {
    const lift = IDLE_MOTION.shrug.angle * bump(motion.t, motion.duration, IDLE_MOTION.shrug.rise);
    if (left) target.shoulderLeft = lift;
    if (right) target.shoulderRight = lift;
    return null;
  },
});

const NOD = 3.2;

/** A playful wink by screen side: close one eye, smile a little, tilt toward it. */
const wink = (eye, sign) => ({
  create: () => ({ duration: IDLE_MOTION.wink.keys.at(-1) }),
  apply: (motion, target) => {
    const { wink: w } = IDLE_MOTION;
    target[eye] = keyed(motion.t, w.keys, w.close);
    target.tilt = sign * keyed(motion.t, w.keys, w.tilt);
    target.mouthLift = keyed(motion.t, w.keys, w.mouthLift);
    return null;
  },
});

/** The value of keyframed `values` at `t`, eased between keys; 0 outside. */
function keyed(t, keys, values) {
  if (!(t > 0) || t >= keys.at(-1)) return 0;
  let i = 1;
  while (keys[i] <= t) i += 1;
  const f = smoothstep((t - keys[i - 1]) / (keys[i] - keys[i - 1]));
  return values[i - 1] + (values[i] - values[i - 1]) * f;
}

/** Write every keyed channel of `spec` (all but `keys`) into `target`. */
function keyedPose(t, spec, target) {
  for (const [key, values] of Object.entries(spec)) {
    if (key !== "keys") target[key] = keyed(t, spec.keys, values);
  }
  return null;
}

/** The sigh's fixed chance (the user, 14 Nov 2026): new actions never take from it. */
const SIGH_SHARE = 0.15;

/**
 * Every action she may do (#149), while awake and idle and while asleep,
 * picked by weight among the ticked ones. The sigh is fixed at 15 %; every
 * other action has a relative `share` of the rest (glance 1, stretch-and-yawn
 * 3, shrugs and the sneeze 1/2). Shrugs stay rare: equal chances made them
 * too common. create(random) draws the action's
 * own parameters, including its duration; apply(motion, target) writes pose
 * targets for motion.t seconds in, and returns a glance target or null.
 * To add one: an entry here with a share, an ACTION_LABELS entry and a test.
 */
const ACTION_TABLE = {
  glance: Object.freeze({
    share: 1,
    create: (random) => {
      const dir = random() < 0.5 ? -1 : 1;
      const duration = within(IDLE_MOTION.glance.duration, random());
      return { duration, x: dir * within(IDLE_MOTION.glance.x, random()), y: within(IDLE_MOTION.glance.y, random()) };
    },
    // The gaze blends toward the glance by this weight, so it drifts out and back.
    apply: (motion) => ({ x: motion.x, y: motion.y, weight: bump(motion.t, motion.duration, IDLE_MOTION.glance.rise) }),
  }),
  "tilt-left": Object.freeze({ share: 1, ...tilt(1) }),
  "tilt-right": Object.freeze({ share: 1, ...tilt(-1) }),
  "shrug-left": Object.freeze({ share: 0.5, ...shrug(true, false) }),
  "shrug-right": Object.freeze({ share: 0.5, ...shrug(false, true) }),
  "shrug-both": Object.freeze({ share: 0.5, ...shrug(true, true) }),
  sigh: Object.freeze({
    fixed: SIGH_SHARE,
    create: () => ({ duration: IDLE_MOTION.sigh.inhale + IDLE_MOTION.sigh.exhale }),
    apply: (motion, target) => {
      const breath = sighCurve(motion.t);
      target.chest = breath * IDLE_MOTION.sigh.chest;
      target.shoulders = breath * IDLE_MOTION.sigh.shoulders;
      const { inhale, exhale } = IDLE_MOTION.sigh;
      const mouth = IDLE_MOTION.sighMouth;
      target.exhale = keyed(motion.t, [0, inhale, inhale + mouth.open, inhale + exhale], [0, mouth.in, mouth.out, 0]);
      return null;
    },
  }),
  "stretch-yawn": Object.freeze({
    share: 3,
    create: () => ({ duration: IDLE_TIMING.stretch }),
    apply: (motion, target) => {
      stretchYawn(motion.t, target);
      return null;
    },
  }),
  nod: Object.freeze({
    share: 1,
    create: () => ({ duration: NOD }),
    apply: (motion, target) => {
      target.headPitch = -IDLE_MOTION.nod.angle * bump(motion.t, NOD, IDLE_MOTION.nod.rise);
      return null;
    },
  }),
  sneeze: Object.freeze({
    share: 0.5,
    create: () => ({ duration: IDLE_MOTION.sneeze.keys.at(-1) }),
    apply: (motion, target) => {
      const { sneeze } = IDLE_MOTION;
      for (const key of ["headPitch", "chest", "shoulders", "yawn", "squint"]) {
        target[key] = keyed(motion.t, sneeze.keys, sneeze[key]);
      }
      return null;
    },
    quick: true,
  }),
  "wink-left": Object.freeze({ share: 0.5, ...wink("winkLeft", 1) }),
  "wink-right": Object.freeze({ share: 0.5, ...wink("winkRight", -1) }),
  "look-around": Object.freeze({
    share: 1,
    create: () => ({ duration: IDLE_MOTION.lookAround.keys.at(-1) }),
    apply: (motion) => {
      const { lookAround } = IDLE_MOTION;
      return {
        x: keyed(motion.t, lookAround.keys, lookAround.x),
        y: keyed(motion.t, lookAround.keys, lookAround.y),
        weight: bump(motion.t, motion.duration, lookAround.rise),
      };
    },
  }),
  shiver: Object.freeze({
    share: 0.5,
    quick: true,
    create: () => ({ duration: IDLE_MOTION.shiver.duration }),
    apply: (motion, target) => {
      const { shiver } = IDLE_MOTION;
      target.shiver = shiver.angle * bump(motion.t, shiver.duration, shiver.rise);
      return null;
    },
  }),
  hiccup: Object.freeze({
    share: 0.5,
    quick: true,
    create: () => ({ duration: IDLE_MOTION.hiccup.keys.at(-1) }),
    apply: (motion, target) => keyedPose(motion.t, IDLE_MOTION.hiccup, target),
  }),
  "nodding-off": Object.freeze({
    share: 1,
    quick: true,
    create: () => ({ duration: IDLE_MOTION.noddingOff.keys.at(-1) }),
    apply: (motion, target) => keyedPose(motion.t, IDLE_MOTION.noddingOff, target),
  }),
  "humming-bob": Object.freeze({
    share: 1,
    create: () => ({ duration: IDLE_MOTION.hum.duration }),
    apply: (motion, target) => {
      const { hum } = IDLE_MOTION;
      const amount = bump(motion.t, hum.duration, hum.rise);
      target.hum = amount;
      target.smile = hum.smile * amount;
      return null;
    },
  }),
  "contented-smile": Object.freeze({
    share: 1,
    create: () => ({ duration: IDLE_MOTION.contented.keys.at(-1) }),
    apply: (motion, target) => keyedPose(motion.t, IDLE_MOTION.contented, target),
  }),
  "eyebrow-raise": Object.freeze({
    share: 0.5,
    create: () => ({ duration: IDLE_MOTION.browRaise.keys.at(-1) }),
    apply: (motion, target) => keyedPose(motion.t, IDLE_MOTION.browRaise, target),
  }),
  "deep-breath": Object.freeze({
    share: 1,
    create: () => ({ duration: IDLE_MOTION.deepBreath.keys.at(-1) }),
    apply: (motion, target) => keyedPose(motion.t, IDLE_MOTION.deepBreath, target),
  }),
  sniffle: Object.freeze({
    share: 0.5,
    quick: true,
    create: () => ({ duration: IDLE_MOTION.sniffle.keys.at(-1) }),
    apply: (motion, target) => keyedPose(motion.t, IDLE_MOTION.sniffle, target),
  }),
  "neck-roll": Object.freeze({
    share: 0.5,
    create: () => ({ duration: IDLE_MOTION.neckRoll.duration }),
    apply: (motion, target) => {
      const { neckRoll } = IDLE_MOTION;
      const amount = bump(motion.t, neckRoll.duration, neckRoll.rise);
      const angle = (2 * Math.PI * motion.t) / neckRoll.duration + neckRoll.phase;
      target.headPitch = amount * neckRoll.pitch * Math.sin(angle);
      target.tilt = amount * neckRoll.roll * Math.cos(angle);
      return null;
    },
  }),
  "weight-shift": Object.freeze({
    share: 1,
    create: (random) => {
      const dir = random() < 0.5 ? -1 : 1;
      return { dir, duration: within(IDLE_MOTION.weightShift.duration, random()) };
    },
    apply: (motion, target) => {
      const { weightShift } = IDLE_MOTION;
      const lean = motion.dir * weightShift.lean * bump(motion.t, motion.duration, weightShift.rise);
      target.lean = lean;
      target.tilt = -weightShift.head * lean;
      return null;
    },
  }),
  "shy-look-away": Object.freeze({
    share: 0.5,
    create: (random) => ({ dir: random() < 0.5 ? -1 : 1, duration: IDLE_MOTION.shy.duration }),
    apply: (motion, target) => {
      const { shy } = IDLE_MOTION;
      const amount = bump(motion.t, shy.duration, shy.rise);
      target.shy = amount;
      target.headPitch = -shy.headPitch * amount;
      target.tilt = motion.dir * shy.tilt * amount;
      return { x: motion.dir * shy.x, y: shy.y, weight: amount };
    },
  }),
};

const SHARED = Object.values(ACTION_TABLE).reduce((sum, action) => sum + (action.share ?? 0), 0);

/**
 * Every action she may do, with its chance as `weight`: a fixed action keeps
 * its own, and the rest split what is left by their relative `share`.
 */
export const ACTIONS = Object.freeze(Object.fromEntries(Object.entries(ACTION_TABLE).map(([name, action]) => [
  name,
  Object.freeze({ ...action, weight: action.fixed ?? (1 - SIGH_SHARE) * (action.share / SHARED) }),
])));

/** Panel labels for the action checkboxes (#149), from the shared catalog (#269, actions.json). */
export const ACTION_LABELS = Object.freeze(Object.fromEntries(Object.entries(ACTION_CATALOG)
  .filter(([, entry]) => (entry.layer ?? "body") === "body")
  .map(([name, entry]) => [name, entry.label])));

export const ACTIONS_KEY = "yidhari.actions";

/**
 * Turns the idle state into one small action at a time: every 8-20 s while
 * idle, and on every sleep action interval while asleep.
 * update() returns `{ glance, tilt, chest, shoulders, shoulderLeft, shoulderRight, back, headPitch, yawn, yawnHand }`:
 * glance is a normalised gaze target or null, yawn is a 0-1 weight for
 * IDLE_MOTION.yawn.morphs, yawnHand is the 0-1 weight of the hand under her
 * chin (#270), and the rest are radians.
 */
export class IdleMotion {
  /** @param {{ random?: () => number }} [options] Random source in [0, 1). */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    /** @type {null | { kind: string, t: number, duration: number }} The action playing while idle. */
    this.current = null;
    this.gapLeft = null;
    /** The action picked for the current sleepy interval, its name, and the interval. */
    this.sleepMotion = null;
    this.sleepAction = null;
    this.sleepCycle = null;
    /** Actions that may be picked, in ACTIONS order. */
    this.actions = Object.keys(ACTIONS);
    /** @type {Map<string, { share: number, duration: number }>} Picked like actions; main.js plays them (#49). */
    this.external = new Map();
    /** @type {null | { kind: string, t: number, duration: number, source: string }} The action played from a panel button (#164) or speech (#269). */
    this.manual = null;
    this.springs = Object.fromEntries(ANGLES.map((key) => [key, new Spring(0)]));
    /** Seconds of motion so far; the shiver's wave and the arm drift run on it. */
    this.clock = 0;
    /** Whether the arms drift while idle and asleep (#193). */
    this.armDriftEnabled = true;
    this.driftSpring = new Spring(0);
  }

  /** @param {boolean} enabled Turn the arm drift on or off; it eases either way. */
  setArmDrift(enabled) {
    this.armDriftEnabled = Boolean(enabled);
  }

  /**
   * @param {number} delta Seconds since the previous frame; invalid values count as 0.
   * @param {string} state IdleController state.
   * @param {number} stateTime Seconds in that state.
   * @param {number} [sleepActionEvery=0] While sleepy, do a random action this often (s); 0 = never.
   * @returns {{glance:{x:number,y:number}|null,tilt:number,chest:number,shoulders:number,shoulderLeft:number,shoulderRight:number,back:number,headPitch:number,yawn:number,yawnHand:number}}
   */
  update(delta, state, stateTime, sleepActionEvery = 0) {
    const dt = Number.isFinite(delta) && delta > 0 ? delta : 0;
    const target = Object.fromEntries(ANGLES.map((key) => [key, 0]));
    let glance = null;
    if (this.manual) {
      // The stretch into sleepy and waking up have their own motion.
      this.manual.t += dt;
      if (state === "stretching" || state === "waking" || this.manual.t >= this.manual.duration) this.manual = null;
    }
    if (state === "idle" && this.manual) {
      // The manual action takes the auto action's place; a fresh gap follows it.
      this.current = null;
      this.gapLeft = null;
    } else if (state === "idle") {
      this.gapLeft ??= this.#gap();
      if (this.current) {
        this.current.t += dt;
        if (this.current.t >= this.current.duration) {
          this.current = null;
          this.gapLeft = this.#gap();
        }
      } else {
        this.gapLeft -= dt;
        if (this.gapLeft <= 0) {
          this.current = this.#pick();
          if (!this.current) this.gapLeft = this.#gap(); // nothing ticked: stay still
        }
      }
      if (this.current && !this.current.external) glance = ACTIONS[this.current.kind].apply(this.current, target);
    } else {
      this.current = null;
      this.gapLeft = null;
      if (state === "stretching") stretchYawn(stateTime, target);
      if (state === "sleepy" && sleepActionEvery > 0 && stateTime >= sleepActionEvery) {
        // A random action at the start of every interval while sleepy.
        const cycle = Math.floor(stateTime / sleepActionEvery);
        if (cycle !== this.sleepCycle) {
          this.sleepCycle = cycle;
          this.sleepMotion = this.#pick();
          this.sleepAction = this.sleepMotion?.kind ?? null;
        }
        const motion = this.sleepMotion;
        if (motion) {
          motion.t = stateTime - cycle * sleepActionEvery;
          if (motion.t < motion.duration && !motion.external) glance = ACTIONS[motion.kind].apply(motion, target);
        }
      } else if (state !== "sleepy") {
        this.sleepMotion = null;
        this.sleepAction = null;
        this.sleepCycle = null;
      }
    }
    if (this.manual) {
      // It replaces whatever idle or sleep would show, through the same springs.
      for (const key of ANGLES) target[key] = 0;
      glance = ACTIONS[this.manual.kind].apply(this.manual, target);
    }
    this.clock += dt;
    const pose = { glance };
    for (const key of ANGLES) {
      const spring = this.springs[key];
      // Eyes and mouth corners move quicker than bones; the yawn keeps its slow, tuned ease.
      spring.step(target[key], dt, Object.hasOwn(FACE_MORPHS, key) && key !== "yawn" ? IDLE_MOTION.squintRate : IDLE_MOTION.rate);
      spring.clamp(...LIMITS[key]);
      pose[key] = spring.settle(target[key], 1e-6);
    }
    // The shiver's size is eased by its spring; its fast wave is added here, after it.
    pose.shiverWave = pose.shiver * Math.sin(2 * Math.PI * IDLE_MOTION.shiver.hz * this.clock);
    // The humming bob's beat and sway, sized by its spring-eased amount, likewise.
    const { hum } = IDLE_MOTION;
    pose.bobPitch = pose.hum * hum.pitch * Math.sin(2 * Math.PI * hum.hz * this.clock);
    pose.bobRoll = pose.hum * hum.roll * Math.sin(2 * Math.PI * hum.swayHz * this.clock);
    // The arm drift (#193) eases with the state and settles exactly to 0 when active.
    const { armDrift } = IDLE_MOTION;
    const level = this.armDriftEnabled ? (armDrift.levels[state] ?? 0) : 0;
    this.driftSpring.step(level, dt, armDrift.rate);
    this.driftSpring.clamp(0, 1);
    pose.armDrift = this.driftSpring.settle(level, 1e-5);
    Object.assign(pose, armDriftAngles(this.clock, pose.armDrift));
    return pose;
  }

  /**
   * Choose which actions may be picked, awake or asleep; unknown names are ignored.
   * @param {Iterable<string>} names
   * @returns {void}
   */
  setActions(names) {
    const chosen = new Set(names);
    this.actions = Object.keys(ACTIONS).filter((name) => chosen.has(name));
  }

  /**
   * Actions played outside IdleMotion, such as Blender poses (#49): picked by
   * weight with the ticked actions, but they move nothing here.
   * @param {Record<string, { share?: number, duration: number }>} actions Replaces the previous set.
   * @returns {void}
   */
  setExternalActions(actions) {
    this.external = new Map(Object.entries(actions)
      .filter(([name]) => !Object.hasOwn(ACTIONS, name))
      .map(([name, { share = 1, duration }]) => [name, { share, duration }]));
  }

  /**
   * @param {string} name An external action.
   * @returns {number} Its chance on the same scale as ACTIONS weights.
   */
  externalWeight(name) {
    const action = this.external.get(name);
    return action ? (1 - SIGH_SHARE) * (action.share / SHARED) : 0;
  }

  /** The external action playing now, idle or asleep, or null. */
  get externalPlaying() {
    for (const motion of [this.current, this.sleepMotion]) {
      if (motion?.external && motion.t < motion.duration) return motion.kind;
    }
    return null;
  }

  /** The name of the action playing from a button or speech, or null. */
  get playing() {
    return this.manual?.kind ?? null;
  }

  /** Who started it: "user" (a button), "speech" or "agent" (#269), or null. */
  get playingSource() {
    return this.manual?.source ?? null;
  }

  /**
   * Play one action now, once, whatever is ticked (#164). It does not wake her.
   * @param {string} name An ACTIONS key; anything else is ignored.
   * @param {"user" | "speech" | "agent"} [source] Who started it (#269).
   * @returns {boolean} Whether it started.
   */
  play(name, source = "user") {
    if (typeof name !== "string" || !Object.hasOwn(ACTIONS, name)) return false;
    this.manual = { kind: name, t: 0, source, ...ACTIONS[name].create(this.random) };
    this.current = null;
    return true;
  }

  /**
   * A panel button press: the same action again stops it, another one switches.
   * @param {string} name
   * @returns {"playing"|"stopped"|null} null for an unknown name.
   */
  toggle(name) {
    if (typeof name !== "string" || !Object.hasOwn(ACTIONS, name)) return null;
    if (this.manual?.kind === name) {
      this.stop();
      return "stopped";
    }
    this.play(name);
    return "playing";
  }

  /** Stop the button's action; the springs ease her back. */
  stop() {
    this.manual = null;
  }

  #gap() {
    return within(IDLE_MOTION.gap, this.random());
  }

  /** A new instance of a ticked action, by weight; null when nothing is ticked. */
  #pick() {
    const names = [...this.actions, ...this.external.keys()];
    if (names.length === 0) return null;
    // Ticked actions keep their relative chances.
    const weight = (name) => ACTIONS[name]?.weight ?? this.externalWeight(name);
    const total = names.reduce((sum, name) => sum + weight(name), 0);
    const roll = this.random() * total;
    let kind = names.at(-1);
    let reach = 0;
    for (const name of names) {
      reach += weight(name);
      if (roll < reach) {
        kind = name;
        break;
      }
    }
    const external = this.external.get(kind);
    if (external) return { kind, t: 0, duration: external.duration, external: true };
    return { kind, t: 0, ...ACTIONS[kind].create(this.random) };
  }
}

/**
 * Bind the panel's Arm drift tick (#193): on by default, saved as "0"/"1".
 * @param {IdleMotion} motion
 * @param {{ checked: boolean, addEventListener(type: string, fn: () => void): void } | null} box
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindArmDriftSetting(motion, box, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  let enabled = true;
  try {
    enabled = local?.getItem(ARM_DRIFT_KEY) !== "0";
  } catch { /* Blocked: on. */ }
  motion.setArmDrift(enabled);
  if (!box) return;
  box.checked = enabled;
  box.addEventListener("change", () => {
    motion.setArmDrift(box.checked);
    try {
      local?.setItem(ARM_DRIFT_KEY, box.checked ? "1" : "0");
    } catch { /* Session-only. */ }
  });
}

/**
 * Why the Animation actions buttons cannot play now, or null when they can (#164).
 * @param {{ loaded: boolean, idleEnabled: boolean, blocked: boolean, held: boolean, state: string }} status
 * @returns {string|null}
 */
export function manualPlayBlocked({ loaded, idleEnabled, blocked, held, state }) {
  if (!loaded) return "Waiting for the model";
  if (!idleEnabled) return "Turn on Idle behaviours to play actions";
  if (blocked) return "Busy: speech, thinking, an ask or a preview";
  if (held) return "A pose is held for a preview";
  if (state === "stretching") return "Stretching into sleepy";
  if (state === "waking") return "Waking up";
  return null;
}

/**
 * Bind the panel's action checkboxes (#149): all ticked by default, the
 * choice saved as a JSON list of names when storage allows.
 * @param {IdleMotion} motion
 * @param {Record<string, { checked: boolean, addEventListener(type: string, fn: () => void): void }>} boxes By action name.
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindActionSettings(motion, boxes, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
  } catch { /* Storage access itself can throw. */ }
  const names = Object.keys(ACTIONS);
  let chosen = names;
  try {
    const saved = JSON.parse(local?.getItem(ACTIONS_KEY) ?? "null");
    if (Array.isArray(saved)) chosen = saved;
  } catch { /* Missing, blocked or corrupt: all of them. */ }
  motion.setActions(chosen);
  for (const [name, box] of Object.entries(boxes)) {
    if (!box) continue;
    box.checked = motion.actions.includes(name);
    box.addEventListener("change", () => {
      motion.setActions(names.filter((action) => (boxes[action] ? boxes[action].checked : motion.actions.includes(action))));
      try {
        local?.setItem(ACTIONS_KEY, JSON.stringify(motion.actions));
      } catch { /* Session-only. */ }
    });
  }
}
