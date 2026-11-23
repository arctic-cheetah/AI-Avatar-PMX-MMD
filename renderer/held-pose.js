// Held VPD poses (#49): hold a pose authored in Blender (#261) on top of the
// other bone layers. See docs/held-poses.md.
import * as THREE from "three";
import { MMDParser } from "three/addons/libs/mmdparser.module.js";

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

/** Holds one VPD pose and eases it in and out. */
export class HeldPose {
  /**
   * Record the bind pose. Call before restArms() changes the arms.
   * @param {THREE.Object3D & { skeleton: THREE.Skeleton, morphTargetDictionary?: Record<string, number>,
   *   morphTargetInfluences?: number[] }} mesh
   * @param {{ easeSeconds?: number }} [options]
   */
  constructor(mesh, { easeSeconds = 0.4 } = {}) {
    this.mesh = mesh;
    this.easeSeconds = easeSeconds;
    this.bind = new Map(mesh.skeleton.bones.map((bone) => [bone, {
      quaternion: bone.quaternion.clone(),
      position: bone.position.clone(),
    }]));
    this.targets = [];
    this.morphs = [];
    this.name = null;
    this.holding = false;
    this.progress = 0;
    this.remaining = Infinity;
  }

  /**
   * Make a pose the one to hold. The weight carries over.
   * @param {string} name
   * @param {ReturnType<typeof readVpd>} vpd
   * @returns {{ bones: number, missing: string[] }}
   */
  load(name, vpd) {
    this.restore();
    const missing = [];
    const targets = [];
    for (const { name: boneName, quaternion, translation } of vpd.bones) {
      const bone = this.mesh.skeleton.getBoneByName(boneName);
      const bind = bone && this.bind.get(bone);
      if (!bind) {
        missing.push(boneName);
        continue;
      }
      targets.push({
        bone,
        base: null,
        written: null,
        quaternion: bind.quaternion.clone().multiply(new THREE.Quaternion().fromArray(quaternion).normalize()),
        position: bind.position.clone().add(new THREE.Vector3().fromArray(translation)),
      });
    }
    const dictionary = this.mesh.morphTargetDictionary ?? {};
    const morphs = [];
    for (const { name: morphName, weight } of vpd.morphs) {
      const index = dictionary[morphName];
      if (index === undefined) missing.push(morphName);
      else morphs.push({ index, weight });
    }
    this.name = name;
    this.targets = targets;
    this.morphs = morphs;
    return { bones: targets.length, missing };
  }

  /** @param {boolean} on Ease toward the pose and keep it (true), or ease away. */
  hold(on) {
    this.holding = on;
    this.remaining = Infinity;
  }

  /**
   * Play the pose once, like an animation action: ease in, keep it for
   * `holdSeconds`, then ease out on its own.
   * @param {number} holdSeconds
   */
  play(holdSeconds) {
    this.holding = true;
    this.remaining = holdSeconds;
  }

  /** Ease out now. */
  stop() {
    this.holding = false;
  }

  /** @returns {boolean} Whether the pose is held or still easing. */
  get playing() {
    return this.holding || this.progress > 0;
  }

  /** @returns {number} 0 (free) to 1 (fully held), eased. */
  get weight() {
    const p = this.progress;
    return p * p * (3 - 2 * p);
  }

  /** @param {number} delta Seconds since the last frame. */
  update(delta) {
    let rest = delta;
    if (this.holding) {
      const easing = Math.min(rest, (1 - this.progress) * this.easeSeconds);
      this.progress = this.easeSeconds > 0 ? Math.min(1, this.progress + easing / this.easeSeconds) : 1;
      rest -= easing;
      if (this.progress < 1) return;
      const kept = Math.min(rest, this.remaining);
      this.remaining -= kept;
      rest -= kept;
      if (this.remaining > 0) return;
      this.holding = false;
    }
    const step = this.easeSeconds > 0 ? rest / this.easeSeconds : 1;
    this.progress = Math.max(0, this.progress - step);
  }

  /**
   * Turn the held bones toward the pose. Run after the other bone layers.
   * Each bone eases from its base: what a layer wrote this frame, or, for a
   * bone no layer rewrites (口左, fingers), what it was before the pose took
   * it. At weight 0 the base is put back and the bone is let go.
   */
  apply() {
    const weight = this.weight;
    for (const target of this.targets) {
      const { bone } = target;
      const untouched = target.written
        && bone.quaternion.equals(target.written.quaternion) && bone.position.equals(target.written.position);
      if (!untouched) target.base = { quaternion: bone.quaternion.clone(), position: bone.position.clone() };
      if (weight === 0) {
        if (target.written) this.release(target);
        continue;
      }
      bone.quaternion.copy(target.base.quaternion).slerp(target.quaternion, weight);
      bone.position.copy(target.base.position).lerp(target.position, weight);
      target.written = { quaternion: bone.quaternion.clone(), position: bone.position.clone() };
    }
  }

  /** Put every bone the pose still holds back to its base. */
  restore() {
    for (const target of this.targets) {
      const { bone, written } = target;
      if (written && bone.quaternion.equals(written.quaternion) && bone.position.equals(written.position)) {
        this.release(target);
      }
    }
  }

  /** @param {{ bone: THREE.Bone, base: { quaternion: THREE.Quaternion, position: THREE.Vector3 } }} target */
  release(target) {
    target.bone.quaternion.copy(target.base.quaternion);
    target.bone.position.copy(target.base.position);
    target.written = null;
  }

  /** Raise the pose's morphs. Run after the expression, speech and blink layers. */
  applyMorphs() {
    const weight = this.weight;
    const influences = this.mesh.morphTargetInfluences;
    if (weight === 0 || !influences) return;
    for (const { index, weight: target } of this.morphs) {
      influences[index] = Math.max(influences[index], target * weight);
    }
  }
}
