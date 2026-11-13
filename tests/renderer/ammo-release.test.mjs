// Run with: node --test tests/renderer/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { TRACKED_AMMO_CLASSES, releaseAmmo, trackAmmo } from "../../renderer/ammo-release.js";

/** A fake Ammo whose classes log construction and whose destroy logs frees. */
function fakeAmmo() {
  const log = [];
  const Ammo = { destroy: (object) => log.push(["destroy", object.label]) };
  for (const name of [...TRACKED_AMMO_CLASSES, "btDiscreteDynamicsWorld"]) {
    Ammo[name] = class {
      constructor(label = name) { this.label = label; }
    };
  }
  const world = {
    removeConstraint: (c) => log.push(["removeConstraint", c.label]),
    removeRigidBody: (b) => log.push(["removeRigidBody", b.label]),
  };
  return { Ammo, world, log };
}

test("trackAmmo records every tracked object made while building, then restores the classes", () => {
  const { Ammo } = fakeAmmo();
  const original = Ammo.btRigidBody;
  const { result, allocations } = trackAmmo(Ammo, () => {
    new Ammo.btBoxShape("shape");
    new Ammo.btRigidBody("body");
    new Ammo.btDiscreteDynamicsWorld("world");
    return "built";
  });
  assert.equal(result, "built");
  assert.deepEqual(allocations.map(({ type, object }) => [type, object.label]),
    [["btBoxShape", "shape"], ["btRigidBody", "body"]]);
  assert.equal(Ammo.btRigidBody, original);
});

test("trackAmmo restores the classes when the build throws", () => {
  const { Ammo } = fakeAmmo();
  const original = Ammo.btTransform;
  assert.throws(() => trackAmmo(Ammo, () => { throw new Error("bad joint"); }), /bad joint/);
  assert.equal(Ammo.btTransform, original);
});

test("releaseAmmo detaches joints, then bodies, then frees each object exactly once", () => {
  const { Ammo, world, log } = fakeAmmo();
  const { allocations } = trackAmmo(Ammo, () => {
    new Ammo.btDefaultMotionState("state");
    new Ammo.btRigidBody("bodyA");
    new Ammo.btRigidBody("bodyB");
    new Ammo.btGeneric6DofSpringConstraint("joint");
  });
  const temp = new Ammo.btTransform("pooled-before");
  allocations.push({ type: "btTransform", object: temp });
  const later = new Ammo.btVector3("pooled-later");
  releaseAmmo(Ammo, world, allocations, [temp, later]);
  assert.deepEqual(log, [
    ["removeConstraint", "joint"],
    ["destroy", "joint"],
    ["removeRigidBody", "bodyA"],
    ["destroy", "bodyA"],
    ["removeRigidBody", "bodyB"],
    ["destroy", "bodyB"],
    ["destroy", "state"],
    ["destroy", "pooled-before"],
    ["destroy", "pooled-later"],
  ]);
});

// Real Ammo and MMDPhysics, from the same three@0.170.0 the page pins.
const THREE_DIR = new URL("../../node_modules/three/", import.meta.url);
const AMMO_JS = new URL("examples/jsm/libs/ammo.wasm.js", THREE_DIR);
const AMMO_WASM = new URL("examples/jsm/libs/ammo.wasm.wasm", THREE_DIR);
const haveAmmo = existsSync(fileURLToPath(AMMO_JS)) && existsSync(fileURLToPath(AMMO_WASM));

/** Load the Emscripten build in Node; it is a classic script, not an ES module. */
async function loadRealAmmo() {
  const module = { exports: {} };
  const path = fileURLToPath(AMMO_JS);
  new Function("module", "exports", "require", "__filename", "__dirname", readFileSync(path, "utf8"))(
    module, module.exports, createRequire(path), path, fileURLToPath(new URL(".", AMMO_JS)));
  return module.exports({ wasmBinary: readFileSync(AMMO_WASM) });
}

/** A three-bone chain with a body per bone and a joint between neighbours. */
async function chainRig() {
  const THREE = await import("three");
  const bones = [0, 1, 2].map((i) => {
    const bone = new THREE.Bone();
    bone.position.set(0, i === 0 ? 10 : -1, 0);
    return bone;
  });
  bones[0].add(bones[1]);
  bones[1].add(bones[2]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  const body = (boneIndex, type) => ({
    boneIndex, type, shapeType: boneIndex % 3, width: 0.2, height: 0.5, depth: 0.2,
    position: [0, 10 - boneIndex, 0], rotation: [0, 0, 0], weight: 1, friction: 0.5,
    restitution: 0, positionDamping: 0.5, rotationDamping: 0.5, groupIndex: 0, groupTarget: 0xffff,
  });
  const joint = (a, b) => ({
    rigidBodyIndex1: a, rigidBodyIndex2: b, position: [0, 9.5 - a, 0], rotation: [0, 0, 0],
    translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0],
    rotationLimitation1: [-0.5, -0.5, -0.5], rotationLimitation2: [0.5, 0.5, 0.5],
    springPosition: [0, 0, 0], springRotation: [0, 0, 0],
  });
  return { mesh, bodies: [body(0, 0), body(1, 1), body(2, 1)], joints: [joint(0, 1), joint(1, 2)] };
}

/** The address a fresh 4 KiB block lands at: it climbs only while memory leaks. */
function heapTop(Ammo) {
  const pointer = Ammo._malloc(4096);
  Ammo._free(pointer);
  return pointer;
}

test("real Ammo: rebuilding MMDPhysics in a shared world leaks without release, and stays flat with it",
  { skip: !haveAmmo && "three's ammo.wasm absent (run npm install)" }, async () => {
    const Ammo = await loadRealAmmo();
    globalThis.Ammo = Ammo;
    try {
      const { MMDPhysics } = await import("three/addons/animation/MMDPhysics.js");
      const { mesh, bodies, joints } = await chainRig();
      let world = null;
      /** Build, step, and dispose `cycles` times; returns how far the heap top moved. */
      const rebuild = (cycles, release) => {
        const start = heapTop(Ammo);
        for (let i = 0; i < cycles; i++) {
          const { result: physics, allocations } = trackAmmo(Ammo, () =>
            new MMDPhysics(mesh, bodies, joints, world ? { world } : {}));
          world = physics.world;
          physics.warmup(5);
          physics.update(1 / 60);
          if (release) {
            const pooled = [...physics.manager.transforms, ...physics.manager.quaternions,
              ...physics.manager.vector3s];
            releaseAmmo(Ammo, world, allocations, pooled);
          } else {
            for (const { constraint } of physics.constraints) world.removeConstraint(constraint);
            for (const { body } of physics.bodies) world.removeRigidBody(body);
          }
        }
        return heapTop(Ammo) - start;
      };
      rebuild(20, true); // let the shared world and the allocator settle first
      const released = rebuild(200, true);
      const leaked = rebuild(200, false);
      assert.equal(world.getNumCollisionObjects(), 0, "every body left the shared world");
      assert.ok(leaked > 100_000, `the probe sees the old leak (${leaked} bytes over 200 rebuilds)`);
      assert.ok(released < 8_192, `release keeps the heap flat (${released} bytes over 200 rebuilds)`);
    } finally {
      delete globalThis.Ammo;
    }
  });
