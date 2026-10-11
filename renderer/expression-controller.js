/**
 * Resolve semantic expressions against a loaded PMX and ease their morphs.
 * The controller owns only morphs listed in its catalog; blink and future
 * speech morphs remain independent animation channels.
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
    this.missingMorphs = new Map();
    this.weights = new Map();
    this.targets = new Map();

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
          this.weights.set(index, mesh.morphTargetInfluences[index] ?? 0);
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
   * Neutral clears the mood channel without touching blink or speech.
   * @param {string} name Semantic expression name, or neutral.
   * @param {number} [weight=1] Mood intensity from 0 to 1.
   * @returns {boolean} Whether the expression was accepted.
   */
  setExpression(name, weight = 1) {
    if (!this.isAvailable(name) || !Number.isFinite(weight)) {
      return false;
    }

    for (const index of this.targets.keys()) {
      this.targets.set(index, 0);
    }
    if (name !== "neutral") {
      const intensity = Math.max(0, Math.min(weight, 1));
      for (const [morph, morphWeight] of Object.entries(this.catalog[name].morphs)) {
        const index = this.mesh.morphTargetDictionary[morph];
        this.targets.set(index, intensity * morphWeight);
      }
    }
    this.activeExpression = name;
    return true;
  }

  /**
   * Ease owned morphs toward their targets for the current animation frame.
   * @param {number} delta Seconds elapsed since the previous frame.
   * @returns {void}
   */
  update(delta) {
    const blend = 1 - Math.exp(-10 * Math.max(0, delta));
    for (const [index, current] of this.weights) {
      const target = this.targets.get(index);
      const next = current + (target - current) * blend;
      this.weights.set(index, next);
      this.mesh.morphTargetInfluences[index] = next;
    }
  }
}
