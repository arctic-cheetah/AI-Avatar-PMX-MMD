// Free the Ammo memory a MMDPhysics build allocates (#114).
//
// Ammo objects live on the wasm heap, so the garbage collector never frees
// them. MMDPhysics has no dispose() and drops some of its objects (the
// construction infos, the box shapes' size vectors), so we record them as
// they are made and destroy them when the build is disposed.

/**
 * Classes MMDPhysics makes per body, joint and temporary. The world's own
 * parts (dispatcher, broadphase, solver, configuration) are left out, so the
 * shared world is never freed.
 */
export const TRACKED_AMMO_CLASSES = Object.freeze([
  "btRigidBody",
  "btDefaultMotionState",
  "btRigidBodyConstructionInfo",
  "btSphereShape",
  "btBoxShape",
  "btCapsuleShape",
  "btGeneric6DofSpringConstraint",
  "btTransform",
  "btVector3",
  "btQuaternion",
]);

/**
 * @typedef {object} AmmoAllocation
 * @property {string} type Ammo class name.
 * @property {object} object The Ammo object.
 */

/**
 * Run `create` while recording every tracked Ammo object it makes. The real
 * constructors are always put back, even when `create` throws.
 * @template T
 * @param {object} Ammo The Ammo module.
 * @param {() => T} create Synchronous build, such as `new MMDPhysics(...)`.
 * @returns {{ result: T, allocations: AmmoAllocation[] }}
 */
export function trackAmmo(Ammo, create) {
  const allocations = [];
  const originals = new Map();
  for (const type of TRACKED_AMMO_CLASSES) {
    const Original = Ammo[type];
    if (typeof Original !== "function") continue;
    originals.set(type, Original);
    Ammo[type] = function (...args) {
      const object = new Original(...args);
      allocations.push({ type, object });
      return object;
    };
  }
  try {
    return { result: create(), allocations };
  } finally {
    for (const [type, Original] of originals) Ammo[type] = Original;
  }
}

/**
 * Detach a build from the shared world and free its Ammo objects: joints
 * first, then bodies, then everything else. Each object is destroyed once.
 * @param {object} Ammo The Ammo module.
 * @param {object} world The shared btDiscreteDynamicsWorld.
 * @param {AmmoAllocation[]} allocations From `trackAmmo`.
 * @param {object[]} [pooled] Temporaries the build's ResourceManager still
 *   holds, including ones it made after construction.
 * @returns {void}
 */
export function releaseAmmo(Ammo, world, allocations, pooled = []) {
  const freed = new Set();
  const free = (object) => {
    if (freed.has(object)) return;
    freed.add(object);
    Ammo.destroy(object);
  };
  for (const { type, object } of allocations) {
    if (type !== "btGeneric6DofSpringConstraint") continue;
    world.removeConstraint(object);
    free(object);
  }
  for (const { type, object } of allocations) {
    if (type !== "btRigidBody") continue;
    world.removeRigidBody(object);
    free(object);
  }
  for (const { object } of allocations) free(object);
  for (const object of pooled) free(object);
}
