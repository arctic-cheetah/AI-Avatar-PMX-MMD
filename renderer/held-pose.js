// Held VPD poses (#49): hold a pose authored in Blender (#261) on top of the
// other bone layers. See docs/held-poses.md.
import * as THREE from "three";
import { MMDParser } from "three/addons/libs/mmdparser.module.js";
import { PoseEase } from "./smoothing.js";

const MAGIC = "Vocaloid Pose Data file";
const MORPH_BLOCK = /Morph\d+\{([^\r\n]*)\r?\n([^}]*)\}[^\r\n]*(?:\r?\n)?/g;

/**
 * Read a VPD file. three.js r170's parser rejects Morph blocks, so they are
 * cut out and read here; the bones go through MMDParser with the same
 * left-to-right conversion MMDLoader.loadVPD uses.
 * @param {string} text The decoded (Shift-JIS) file.
 * @returns {{ bones: { name: string, translation: number[], quaternion: number[] }[],
 *   morphs: { name: string, weight: number }[] }}
 */
export function readVpd(text) {
  if (!text.startsWith(MAGIC)) throw new Error("not a VPD pose file");
  const morphs = [];
  const bonesOnly = text.replace(MORPH_BLOCK, (_, name, body) => {
    morphs.push({ name: name.trim(), weight: Number.parseFloat(body.split(";")[0]) });
    return "";
  });
  try {
    return { bones: new MMDParser.Parser().parseVpd(bonesOnly, true).bones, morphs };
  } catch (error) {
    throw new Error(`not a VPD pose file (${error})`);
  }
}

/**
 * Pose names from serve.py's directory listing of the poses folder.
 * @param {string} html
 * @returns {string[]}
 */
export function poseFileNames(html) {
  const names = [...html.matchAll(/href="([^"/]+)\.vpd"/gi)].map((m) => decodeURIComponent(m[1]));
  return [...new Set(names)].sort();
}

export const POSE_ACTIONS_KEY = "yidhari.poseActions";

/** Japanese forms the Blender add-on writes for characters Shift-JIS lacks (#261): 歯上 → 齿上, 右結1_2 → 右结1_2. */
const SJIS_ALIASES = Object.freeze({ "歯": "齿", "結": "结" });

/**
 * The model's own name for a name read from a VPD.
 * @param {string} name
 * @param {(name: string) => boolean} has Whether the model has a name.
 * @returns {string}
 */
export function modelName(name, has) {
  if (has(name)) return name;
  const aliased = [...name].map((ch) => SJIS_ALIASES[ch] ?? ch).join("");
  return has(aliased) ? aliased : name;
}
export const POSE_EASE_KEY = "yidhari.poseEase";
export const POSE_EASE_DEFAULT = 1;

/**
 * Bind the pose ease slider: seconds for the Blender poses and the thinking
 * pose to ease in or out, saved per browser.
 * @param {{ value: string, min: string, max: string, addEventListener(type: string, fn: () => void): void }} input
 * @param {{ textContent: string } | null} output
 * @param {(seconds: number) => void} apply
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function bindPoseEase(input, output, apply, { local } = {}) {
  const clamp = (value) => {
    const seconds = Number.parseFloat(value);
    if (!Number.isFinite(seconds)) return POSE_EASE_DEFAULT;
    return Math.min(Number(input.max) || 3, Math.max(Number(input.min) || 0.3, seconds));
  };
  let seconds = POSE_EASE_DEFAULT;
  try {
    local ??= globalThis.localStorage;
    const saved = local?.getItem(POSE_EASE_KEY);
    if (saved != null) seconds = clamp(saved);
  } catch { /* Blocked: the default. */ }
  const show = () => {
    input.value = String(seconds);
    if (output) output.textContent = `${seconds.toFixed(1)} s`;
    apply(seconds);
  };
  show();
  input.addEventListener("input", () => {
    seconds = clamp(input.value);
    try {
      local?.setItem(POSE_EASE_KEY, String(seconds));
    } catch { /* Session-only. */ }
    show();
  });
}

/**
 * Which poses may be picked as idle actions. New poses default to on; the
 * user's unticks are kept per browser.
 * @param {string[]} names
 * @param {{ local?: Storage }} [options]
 * @returns {Record<string, boolean>}
 */
export function poseActionTicks(names, { local } = {}) {
  let saved = {};
  try {
    local ??= globalThis.localStorage;
    const parsed = JSON.parse(local?.getItem(POSE_ACTIONS_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
  } catch { /* Missing, blocked or corrupt: all on. */ }
  return Object.fromEntries(names.map((name) => [name, saved[name] !== false]));
}

/**
 * Remember one pose's tick.
 * @param {string} name
 * @param {boolean} ticked
 * @param {{ local?: Storage }} [options]
 * @returns {void}
 */
export function savePoseActionTick(name, ticked, { local } = {}) {
  try {
    local ??= globalThis.localStorage;
    const saved = JSON.parse(local?.getItem(POSE_ACTIONS_KEY) ?? "{}") ?? {};
    saved[name] = Boolean(ticked);
    local?.setItem(POSE_ACTIONS_KEY, JSON.stringify(saved));
  } catch { /* Session-only. */ }
}

/**
 * Whether an idle pick may start a pose now (review on #263): never over a
 * pose the user started (a button play or a ?pose= hold), and never the pose
 * already showing, where a toggle would stop it.
 * @param {{ picked: string | null, playing: boolean, name?: string | null, startedBy?: "user" | "url" | "idle" | null }} state
 * @returns {boolean}
 */
export function idleMayPlay({ picked, playing, name = null, startedBy = null }) {
  if (!picked) return false;
  if (!playing) return true;
  return startedBy === "idle" && name !== picked;
}

/** Holds one VPD pose and eases it in and out. */
export class HeldPose {
  /**
   * Record the bind pose. Call before restArms() changes the arms.
   * @param {THREE.Object3D & { skeleton: THREE.Skeleton, morphTargetDictionary?: Record<string, number>,
   *   morphTargetInfluences?: number[] }} mesh
   * @param {{ easeSeconds?: number, morphPanels?: Record<string, number> }} [options]
   *   morphPanels: PMX panel per morph name (1 brow, 2 eye, 3 mouth); a pose owns the panels it sets.
   */
  constructor(mesh, { easeSeconds = 1, morphPanels = {} } = {}) {
    this.mesh = mesh;
    this.ease = new PoseEase(easeSeconds);
    this.bind = new Map(mesh.skeleton.bones.map((bone) => [bone, {
      quaternion: bone.quaternion.clone(),
      position: bone.position.clone(),
    }]));
    this.morphPanels = morphPanels;
    /** @type {Map<THREE.Bone, { quaternion: THREE.Quaternion, position: THREE.Vector3 }>} The pose's bone targets. */
    this.targets = new Map();
    /** @type {Map<THREE.Bone, { base: object | null, written: object | null }>} Every bone the layer has touched. */
    this.entries = new Map();
    this.morphs = [];
    /** Morph indices of the face panels the pose owns. */
    this.owned = [];
    /** A crossfade from the pose shown when another was loaded while held. */
    this.fade = null;
    this.name = null;
    this.holding = false;
    this.remaining = Infinity;
    /** A weight set from outside (drive), or null to follow the ease. */
    this.driven = null;
  }

  /**
   * Make a pose the one to hold. The weight carries over.
   * @param {string} name
   * @param {ReturnType<typeof readVpd>} vpd
   * @returns {{ bones: number, missing: string[] }}
   */
  load(name, vpd) {
    const missing = [];
    const targets = new Map();
    const skeleton = this.mesh.skeleton;
    for (const { name: written, quaternion, translation } of vpd.bones) {
      const boneName = modelName(written, (name) => Boolean(skeleton.getBoneByName(name)));
      const bone = skeleton.getBoneByName(boneName);
      const bind = bone && this.bind.get(bone);
      if (!bind) {
        missing.push(boneName);
        continue;
      }
      targets.set(bone, {
        quaternion: bind.quaternion.clone().multiply(new THREE.Quaternion().fromArray(quaternion).normalize()),
        position: bind.position.clone().add(new THREE.Vector3().fromArray(translation)),
      });
    }
    const dictionary = this.mesh.morphTargetDictionary ?? {};
    const morphs = [];
    for (const { name: written, weight } of vpd.morphs) {
      const morphName = modelName(written, (name) => dictionary[name] !== undefined);
      const index = dictionary[morphName];
      if (index === undefined) missing.push(morphName);
      else morphs.push({ index, weight, name: morphName });
    }
    if (this.weight > 0) {
      // Crossfade from what is shown now: the bones as last written, the pose's face as it was.
      const from = new Map();
      for (const bone of new Set([...this.entries.keys(), ...targets.keys()])) {
        from.set(bone, { quaternion: bone.quaternion.clone(), position: bone.position.clone() });
      }
      const ease = new PoseEase(this.easeSeconds);
      ease.setTarget(1);
      this.fade = { ease, from, morphs: this.morphs, owned: this.owned };
    } else {
      this.restore();
      this.fade = null;
    }
    this.name = name;
    this.targets = targets;
    this.morphs = morphs;
    this.owned = this.#ownedIndices(morphs);
    return { bones: targets.size, missing };
  }

  /** @param {{ name: string }[]} morphs @returns {number[]} Morphs in the panels these set, but the blink. */
  #ownedIndices(morphs) {
    const panels = new Set(morphs.map(({ name }) => this.morphPanels[name]).filter((panel) => panel >= 1 && panel <= 3));
    const dictionary = this.mesh.morphTargetDictionary ?? {};
    return Object.entries(this.morphPanels)
      .filter(([name, panel]) => panels.has(panel) && name !== "まばたき" && dictionary[name] !== undefined)
      .map(([name]) => dictionary[name]);
  }

  /** @returns {number} Seconds for a full ease in or out. */
  get easeSeconds() {
    return this.ease.duration;
  }

  /** @param {number} seconds Used from the next transition. */
  set easeSeconds(seconds) {
    this.ease.duration = seconds;
  }

  /** @param {boolean} on Ease toward the pose and keep it (true), or ease away. */
  hold(on) {
    this.holding = on;
    this.remaining = Infinity;
    this.ease.setTarget(on ? 1 : 0);
  }

  /**
   * Play the pose once, like an animation action: ease in, keep it for
   * `holdSeconds`, then ease out on its own.
   * @param {number} holdSeconds
   */
  play(holdSeconds) {
    this.holding = true;
    this.remaining = holdSeconds;
    this.ease.setTarget(1);
  }

  /** Ease out now. */
  stop() {
    this.holding = false;
    this.ease.setTarget(0);
  }

  /** @returns {boolean} Whether the pose is held or still easing. */
  get playing() {
    return this.holding || this.ease.value > 0;
  }

  /**
   * The shared pose ease (smoothing.js PoseEase): smootherstep from rest, and
   * a smooth turn when interrupted (the user found 0.4 s smoothstep too quick).
   * @returns {number} 0 (free) to 1 (fully held).
   */
  get weight() {
    return this.driven ?? this.ease.value;
  }

  /**
   * Set the weight from another layer instead of the ease, such as the yawn's
   * hand (#270). Call every frame before apply().
   * @param {number} weight 0 (free) to 1 (fully held); invalid values count as 0.
   */
  drive(weight) {
    this.driven = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
  }

  /** @param {number} delta Seconds since the last frame. */
  update(delta) {
    let rest = Number.isFinite(delta) && delta > 0 ? delta : 0;
    // First: the hold timing below returns early while the pose plays.
    if (this.fade) this.fade.ease.update(rest);
    if (this.holding && this.remaining !== Infinity) {
      const easing = Math.min(rest, this.ease.timeLeft);
      this.ease.update(easing);
      rest -= easing;
      if (this.ease.timeLeft > 0) return;
      const kept = Math.min(rest, this.remaining);
      this.remaining -= kept;
      rest -= kept;
      if (this.remaining > 0) return;
      this.stop();
    }
    this.ease.update(rest);
  }

  /**
   * Turn the held bones toward the pose. Run after the other bone layers.
   * Each bone eases from its base: what a layer wrote this frame, or, for a
   * bone no layer rewrites (口左, fingers), what it was before the pose took
   * it. During a crossfade the result blends from what was shown. At weight
   * 0, with no crossfade, the base is put back and the bone is let go.
   */
  apply() {
    const weight = this.weight;
    const fade = this.fade;
    const mix = fade ? fade.ease.value : 1;
    const bones = new Set([...this.entries.keys(), ...this.targets.keys(), ...(fade ? fade.from.keys() : [])]);
    for (const bone of bones) {
      let entry = this.entries.get(bone);
      if (!entry) this.entries.set(bone, (entry = { base: null, written: null }));
      const untouched = entry.written
        && bone.quaternion.equals(entry.written.quaternion) && bone.position.equals(entry.written.position);
      if (!untouched) entry.base = { quaternion: bone.quaternion.clone(), position: bone.position.clone() };
      const target = this.targets.get(bone);
      if (weight === 0 && !fade) {
        if (entry.written) this.release(bone, entry);
        this.entries.delete(bone);
        continue;
      }
      const q = entry.base.quaternion.clone();
      const v = entry.base.position.clone();
      if (target) {
        q.slerp(target.quaternion, weight);
        v.lerp(target.position, weight);
      }
      const from = fade?.from.get(bone);
      if (from) {
        q.copy(from.quaternion.clone().slerp(q, mix));
        v.copy(from.position.clone().lerp(v, mix));
      }
      bone.quaternion.copy(q);
      bone.position.copy(v);
      entry.written = { quaternion: q, position: v };
      if (!target && !fade && weight > 0) {
        // A bone the new pose does not hold, after the crossfade: it is back at its base, so let it go.
        this.release(bone, entry);
        this.entries.delete(bone);
      }
    }
    if (fade && fade.ease.value >= 1) this.fade = null;
  }

  /** Put every bone the pose still holds back to its base. */
  restore() {
    for (const [bone, entry] of this.entries) {
      const { written } = entry;
      if (written && bone.quaternion.equals(written.quaternion) && bone.position.equals(written.position)) {
        this.release(bone, entry);
      }
    }
    this.entries.clear();
  }

  /** @param {THREE.Bone} bone @param {{ base: { quaternion: THREE.Quaternion, position: THREE.Vector3 } }} entry */
  release(bone, entry) {
    bone.quaternion.copy(entry.base.quaternion);
    bone.position.copy(entry.base.position);
    entry.written = null;
  }

  /**
   * Set the pose's face. Run right after the mood (expressions) and before
   * speech, winks and the blink, so lip sync still moves the mouth. In the
   * panels the pose sets (brow, eye or mouth) it owns the face: the mood's
   * other morphs there fade out as the pose fades in, and the pose's own
   * morphs blend to their values. Without panel data, it only raises its
   * morphs. During a crossfade the result blends from the previous pose's face.
   */
  applyMorphs() {
    const influences = this.mesh.morphTargetInfluences;
    const weight = this.weight;
    if (!influences || (weight === 0 && !this.fade)) return;
    const fade = this.fade;
    if (!fade) {
      this.#face(influences, this.morphs, this.owned, weight);
      return;
    }
    const before = Array.from(influences);
    this.#face(before, fade.morphs, fade.owned, weight);
    this.#face(influences, this.morphs, this.owned, weight);
    const mix = fade.ease.value;
    for (let i = 0; i < influences.length; i += 1) influences[i] = before[i] + (influences[i] - before[i]) * mix;
  }

  /** Apply one pose's face to `influences` at `weight`. */
  #face(influences, morphs, owned, weight) {
    if (weight === 0) return;
    if (owned.length === 0) {
      for (const { index, weight: target } of morphs) influences[index] = Math.max(influences[index], target * weight);
      return;
    }
    const pose = new Map(morphs.map(({ index, weight: target }) => [index, target]));
    for (const index of new Set([...owned, ...pose.keys()])) {
      const target = pose.get(index) ?? 0;
      influences[index] += (target - influences[index]) * weight;
    }
  }
}
