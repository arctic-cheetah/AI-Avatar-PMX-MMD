/**
 * Manual morph audition layer for previewing raw PMX morphs and combinations.
 * Its weights are added on top of the mood, blink, and wink channels each
 * frame, so overlaps between channels stay visible while auditioning.
 */

/** PMX facial panel ids and their display labels, in display order. */
export const PANELS = [
  { id: 2, label: "Eye" },
  { id: 3, label: "Mouth" },
  { id: 1, label: "Brow" },
  { id: 4, label: "Other" },
  { id: 0, label: "System" },
];

/** Romaji readings, matching docs/pmx-morph-catalog.md. */
export const MORPH_ROMAJI = {
  "まばたき": "mabataki",
  "笑い": "warai",
  "ウィンク２": "uinku 2",
  "ウィンク２右": "uinku 2 migi",
  "ウィンク": "uinku",
  "ウィンク右": "uinku migi",
  "びっくり": "bikkuri",
  "びっくり左": "bikkuri hidari",
  "びっくり右": "bikkuri migi",
  "怒り目": "ikari me",
  "怒り目２": "ikari me 2",
  "じと目": "jito me",
  "下眼上": "shita gan ue",
  "眼角下": "gankaku shita",
  "悲しむ": "kanashimu",
  "あ": "a",
  "い": "i",
  "う": "u",
  "え": "e",
  "お": "o",
  "□": "shikaku",
  "ワ": "wa",
  "え２": "e 2",
  "い２": "i 2",
  "ワ２": "wa 2",
  "お２": "o 2",
  "にやり": "niyari",
  "にやり２": "niyari 2",
  "口角上げ": "koukaku age",
  "口角下げ": "koukaku sage",
  "口横広げ": "kuchi yoko hiroge",
  "口横狭め": "kuchi yoko seme",
  "口上": "kuchi ue",
  "口下": "kuchi shita",
  "口左": "kuchi hidari",
  "口右": "kuchi migi",
  "齿下": "ha shita",
  "齿上": "ha ue",
  "真面目": "majime",
  "困る": "komaru",
  "怒り": "ikari",
  "にこり": "nikori",
  "上": "ue",
  "下": "shita",
  "前": "mae",
  "怒り左": "ikari hidari",
  "怒り右": "ikari migi",
  "困る右": "komaru migi",
  "にこり左": "nikori hidari",
  "にこり右": "nikori migi",
  "上左": "ue hidari",
  "上右": "ue migi",
  "下左": "shita hidari",
  "下右": "shita migi",
  "前左": "mae hidari",
  "前右": "mae migi",
};

/**
 * @typedef {object} MorphInfo
 * @property {string} name PMX morph name.
 * @property {string} englishName English label stored in the PMX.
 * @property {string} romaji Reading from MORPH_ROMAJI, or an empty string.
 * @property {number} panel PMX panel id (1 brow, 2 eye, 3 mouth, 4 other).
 * @property {number} index Index into the mesh's morphTargetInfluences.
 */

/**
 * List every morph of the parsed PMX that the loaded mesh can drive.
 * @param {{ morphs: { name: string, englishName: string, panel: number }[] }} data Parsed PMX data.
 * @param {import("three").SkinnedMesh} mesh Mesh built from the same data.
 * @returns {MorphInfo[]} Morphs in PMX order.
 */
export function buildMorphInventory(data, mesh) {
  return data.morphs
    .map((morph) => ({
      name: morph.name,
      englishName: morph.englishName,
      romaji: MORPH_ROMAJI[morph.name] ?? "",
      panel: morph.panel,
      index: mesh.morphTargetDictionary?.[morph.name] ?? -1,
    }))
    .filter((morph) => morph.index >= 0);
}

/**
 * Clamp a morph weight to the 0–1 range used by every channel.
 * @param {number} weight Requested weight.
 * @returns {number} Clamped weight.
 */
function clampWeight(weight) {
  return Math.max(0, Math.min(weight, 1));
}

export class MorphAudition {
  /**
   * @param {import("three").SkinnedMesh} mesh Loaded PMX mesh.
   * @param {MorphInfo[]} inventory Morphs from buildMorphInventory.
   */
  constructor(mesh, inventory) {
    this.mesh = mesh;
    this.inventory = inventory;
    this.byName = new Map(inventory.map((morph) => [morph.name, morph]));
    /** @type {Map<string, number>} Non-zero manual weights by morph name. */
    this.weights = new Map();
    this.sweeping = false;
    this.sweepInterval = 1.5;
    this.sweepWeight = 1;
    this.sweepTimer = 0;
    this.sweepPosition = 0;
  }

  /**
   * Read one manual weight.
   * @param {string} name PMX morph name.
   * @returns {number} Manual weight, 0 when unset.
   */
  getWeight(name) {
    return this.weights.get(name) ?? 0;
  }

  /**
   * Set one manual weight. A weight of 0 removes the morph from the layer.
   * @param {string} name PMX morph name.
   * @param {number} weight Weight from 0 to 1.
   * @returns {boolean} Whether the morph exists and the weight was valid.
   */
  setWeight(name, weight) {
    if (!this.byName.has(name) || !Number.isFinite(weight)) {
      return false;
    }
    const clamped = clampWeight(weight);
    if (clamped === 0) {
      this.weights.delete(name);
    } else {
      this.weights.set(name, clamped);
    }
    return true;
  }

  /**
   * Replace every manual weight with a new combination.
   * @param {Record<string, number>} morphs PMX morph names and weights.
   * @returns {string[]} Morph names that this model does not have.
   */
  setWeights(morphs) {
    this.weights.clear();
    const missing = [];
    for (const [name, weight] of Object.entries(morphs)) {
      if (!this.setWeight(name, weight)) {
        missing.push(name);
      }
    }
    return missing;
  }

  /**
   * Clear every manual weight and stop sweeping.
   * @returns {void}
   */
  clear() {
    this.stopSweep();
    this.weights.clear();
  }

  /**
   * Snapshot the non-zero manual weights in PMX order, for saving or export.
   * @returns {Record<string, number>} PMX morph names and weights.
   */
  getActiveMorphs() {
    const active = {};
    for (const morph of this.inventory) {
      const weight = this.weights.get(morph.name);
      if (weight) {
        active[morph.name] = Math.round(weight * 100) / 100;
      }
    }
    return active;
  }

  /**
   * Step through every morph on its own, holding each for a fixed time.
   * @param {number} [intervalSeconds=1.5] Seconds each morph is held.
   * @param {number} [weight=1] Weight applied to the current morph.
   * @returns {boolean} Whether the sweep was started.
   */
  startSweep(intervalSeconds = 1.5, weight = 1) {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0 || this.inventory.length === 0) {
      return false;
    }
    this.sweeping = true;
    this.sweepInterval = intervalSeconds;
    this.sweepWeight = clampWeight(weight);
    this.sweepTimer = intervalSeconds;
    this.sweepPosition = 0;
    this.applySweep();
    return true;
  }

  /**
   * Stop sweeping. The current morph stays applied so it can be inspected.
   * @returns {void}
   */
  stopSweep() {
    this.sweeping = false;
  }

  /**
   * Name of the morph the sweep is currently showing.
   * @returns {string | null} PMX morph name, or null when not sweeping.
   */
  getSweepMorph() {
    return this.sweeping ? this.inventory[this.sweepPosition].name : null;
  }

  /**
   * Show only the sweep's current morph; internal shared path.
   * @returns {void}
   */
  applySweep() {
    this.weights.clear();
    this.setWeight(this.inventory[this.sweepPosition].name, this.sweepWeight);
  }

  /**
   * Advance the sweep once its hold time elapses.
   * @param {number} delta Seconds elapsed since the previous frame.
   * @returns {void}
   */
  update(delta) {
    if (!this.sweeping) {
      return;
    }
    this.sweepTimer -= Math.max(0, delta);
    if (this.sweepTimer <= 0) {
      this.sweepPosition = (this.sweepPosition + 1) % this.inventory.length;
      this.sweepTimer += this.sweepInterval;
      this.applySweep();
    }
  }

  /**
   * Add manual weights on top of what the other channels wrote this frame.
   * Call after mood, blink, and wink updates.
   * @returns {void}
   */
  apply() {
    const influences = this.mesh.morphTargetInfluences;
    for (const [name, weight] of this.weights) {
      const index = this.byName.get(name).index;
      influences[index] = Math.min(1, influences[index] + weight);
    }
  }
}
