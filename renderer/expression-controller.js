import { Spring, TIMING } from "./smoothing.js";

/**
 * Resolve semantic expressions against a loaded PMX and ease their morphs.
 * The controller owns only morphs listed in its catalog; blink and future
 * speech morphs remain independent animation channels.
 * Each morph eases on a critically damped spring from its displayed value and
 * velocity, so an interrupted change carries on smoothly instead of resetting.
 */
export class ExpressionController {
  /**
   * @param {import("three").SkinnedMesh} mesh Loaded PMX mesh.
   * @param {Record<string, { morphs: Record<string, number> }>} catalog Mood definitions.
   */
  constructor(mesh, catalog) {
    this.mesh = mesh;
    this.catalog = catalog;
    this.activeExpression = "neutral";
    /** Preset neutral settles into instead of the bare mesh (#99), or null. */
    this.restingFace = null;
    this.restWeight = 1;
    this.missingMorphs = new Map();
    /** @type {Map<number, number>} Displayed weight per owned morph index. */
    this.weights = new Map();
    /** @type {Map<number, Spring>} */
    this.springs = new Map();
    this.targets = new Map();
    this.rate = TIMING.expression;
    this.looping = false;
    this.loopTimer = 0;
    this.loopInterval = 3;
    this.loopWeight = 1;
    this.loopQueue = [];
    this.loopPosition = 0;

    for (const [name, definition] of Object.entries(catalog)) {
      const missing = Object.keys(definition.morphs).filter(
        (morph) => mesh.morphTargetDictionary?.[morph] == null,
      );
      if (missing.length > 0) {
        this.missingMorphs.set(name, missing);
        continue;
      }
      for (const morph of Object.keys(definition.morphs)) {
        const index = mesh.morphTargetDictionary[morph];
        if (!this.weights.has(index)) {
          const initial = mesh.morphTargetInfluences[index] ?? 0;
          this.weights.set(index, initial);
          this.springs.set(index, new Spring(initial));
          this.targets.set(index, 0);
        }
      }
    }
  }

  /**
   * Check whether an expression can be used with this model.
   * @param {string} name Semantic expression name, or neutral.
   * @returns {boolean} Whether every required PMX morph is present.
   */
  isAvailable(name) {
    return name === "neutral" ||
      (Object.hasOwn(this.catalog, name) && !this.missingMorphs.has(name));
  }

  /**
   * List PMX morphs missing from an expression definition.
   * @param {string} name Semantic expression name.
   * @returns {string[]} Missing PMX morph names.
   */
  getMissingMorphs(name) {
    return this.missingMorphs.get(name) ?? [];
  }

  /**
   * Select one mood, fading all other catalogued mood morphs to zero.
   * Neutral clears the mood channel without touching blink or speech, then
   * settles into the resting face when one is set.
   * Manual selection stops any running loop.
   * @param {string} name Semantic expression name, or neutral.
   * @param {number} [weight=1] Mood intensity from 0 to 1.
   * @returns {boolean} Whether the expression was accepted.
   */
  setExpression(name, weight = 1) {
    if (!this.isAvailable(name) || !Number.isFinite(weight)) {
      return false;
    }
    this.stopLoop();
    this.applyExpression(name, weight);
    return true;
  }

  /**
   * Choose the preset that neutral settles into, or null for the bare mesh.
   * Neutral itself is still the one reset: a mood replaces the resting face
   * rather than stacking on it. An active mood is left alone.
   * @param {string | null} name Available non-neutral preset, or null.
   * @returns {boolean} Whether the resting face was accepted.
   */
  setRestingFace(name) {
    if (name !== null && (typeof name !== "string" || name === "neutral" || !this.isAvailable(name))) {
      return false;
    }
    this.restingFace = name;
    if (this.activeExpression === "neutral") {
      this.applyExpression("neutral", this.restWeight);
    }
    return true;
  }

  /**
   * Cycle through every available expression, holding each for a fixed time.
   * Includes each available catalog entry. Non-positive intervals are rejected.
   * @param {number} [intervalSeconds=3] Seconds each expression is held.
   * @param {number} [weight=1] Intensity for every loop step.
   * @returns {boolean} Whether the loop was started.
   */
  startLoop(intervalSeconds = 3, weight = 1) {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0 || !Number.isFinite(weight)) {
      return false;
    }
    this.loopQueue = Object.keys(this.catalog).filter((name) => this.isAvailable(name));
    if (this.loopQueue.length === 0) {
      return false;
    }
    this.looping = true;
    this.loopInterval = intervalSeconds;
    this.loopTimer = intervalSeconds;
    this.loopPosition = 0;
    this.loopWeight = weight;
    this.applyExpression(this.loopQueue[0], weight);
    return true;
  }

  /** Rescale the active mood and loop without stopping either.
   * @param {number} weight Intensity from 0 to 1.
   * @returns {boolean} Whether the value was accepted.
   */
  setIntensity(weight) {
    if (!Number.isFinite(weight)) return false;
    this.loopWeight = weight;
    this.applyExpression(this.activeExpression, weight);
    return true;
  }

  /** Stop cycling while retaining the current expression.
   * @returns {void}
   */
  stopLoop() {
    this.looping = false;
  }

  /**
   * Apply one mood without touching loop state; internal shared path.
   * @param {string} name Semantic expression name, or neutral.
   * @param {number} [weight=1] Mood intensity from 0 to 1.
   * @returns {void}
   */
  applyExpression(name, weight = 1) {
    for (const index of this.targets.keys()) {
      this.targets.set(index, 0);
    }
    const shown = name === "neutral" ? this.restingFace : name;
    if (name === "neutral") this.restWeight = weight;
    if (shown) {
      const intensity = Math.max(0, Math.min(weight, 1));
      for (const [morph, morphWeight] of Object.entries(this.catalog[shown].morphs)) {
        const index = this.mesh.morphTargetDictionary[morph];
        this.targets.set(index, intensity * morphWeight);
      }
    }
    this.activeExpression = name;
  }

  /**
   * Ease owned morphs toward their targets for the current animation frame.
   * When looping, advance to the next expression once the hold time elapses.
   * @param {number} delta Seconds elapsed since the previous frame.
   * @returns {void}
   */
  update(delta) {
    if (this.looping) {
      this.loopTimer -= Math.max(0, delta);
      if (this.loopTimer <= 0) {
        this.loopPosition = (this.loopPosition + 1) % this.loopQueue.length;
        this.loopTimer += this.loopInterval;
        this.applyExpression(this.loopQueue[this.loopPosition], this.loopWeight);
      }
    }
    for (const [index, spring] of this.springs) {
      const target = this.targets.get(index);
      spring.step(target, delta, this.rate);
      const next = spring.clamp(0, 1);
      this.weights.set(index, next);
      this.mesh.morphTargetInfluences[index] = next;
    }
  }
}
