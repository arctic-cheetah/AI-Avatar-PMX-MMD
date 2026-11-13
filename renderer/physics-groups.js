/**
 * Physics body groups (#117). MMDPhysics can't switch bodies on or off once it
 * is built, so the parsed rigid bodies and joints are filtered before
 * construction. See docs/physics.md.
 *
 * Pure module: no DOM or Three.js imports, so `node --test` covers it.
 */

/** Rigid body type 0 follows its bone; types 1 and 2 are simulated. */
const KINEMATIC = 0;

/**
 * Groups in display order. Patterns match the body name; a chain's weight
 * bodies (…錘) share its prefix, so they fall into the same group.
 * @type {ReadonlyArray<Readonly<{id: string, label: string, pattern: RegExp, enabledByDefault: boolean}>>}
 */
export const PHYSICS_GROUPS = Object.freeze([
  // The fringe sags onto her eyes under the PMX's own joints, so it follows
  // its bones unless switched on (see docs/physics.md).
  { id: "fringe", label: "Fringe", pattern: /^Ctr_F_Hair/, enabledByDefault: false },
  { id: "hair", label: "Hair", pattern: /^Ctr_[BLRT]_Hair/, enabledByDefault: true },
  { id: "hat", label: "Hat", pattern: /^Ctr_Hat/, enabledByDefault: true },
  { id: "tails", label: "Tails", pattern: /Tail/, enabledByDefault: true },
  { id: "bag", label: "Bag", pattern: /^Ctr_Bag/, enabledByDefault: true },
  { id: "chains", label: "Chains and badge", pattern: /^(Skn_[BF]_Chain|Ctr_Badge|Skn_B_Daizi)/, enabledByDefault: true },
  { id: "butterflies", label: "Butterflies", pattern: /Butterfly/, enabledByDefault: false },
  { id: "footRings", label: "Foot rings", pattern: /FootRing/, enabledByDefault: false },
  { id: "chest", label: "Chest", pattern: /^[左右]胸[上下]/, enabledByDefault: false },
  { id: "hips", label: "Hips", pattern: /^[左右](尻|ひざ2|足2)/, enabledByDefault: false },
].map((group) => Object.freeze(group)));

/**
 * @param {{name: string, type: number}} body Parsed rigid body params.
 * @returns {string | null} Group id, "other" for an unknown dynamic body, or
 *   null for a kinematic body (always kept).
 */
export function classifyBody(body) {
  if (body.type === KINEMATIC) return null;
  return PHYSICS_GROUPS.find((group) => group.pattern.test(body.name))?.id ?? "other";
}

/** @returns {Set<string>} The ids of the groups that are on by default. */
export function defaultPhysicsGroups() {
  return new Set(PHYSICS_GROUPS.filter((group) => group.enabledByDefault).map((group) => group.id));
}

/**
 * Keep kinematic bodies, unknown dynamic bodies and the enabled groups. Drop
 * every joint touching a dropped body, then drop dynamic bodies left with no
 * joint path to a kinematic body (they would fall away), and remap the
 * joints' body indices. The inputs are not mutated.
 * @template {{name: string, type: number}} B
 * @template {{rigidBodyIndex1: number, rigidBodyIndex2: number}} C
 * @param {B[]} rigidBodies Parsed rigid body params.
 * @param {C[]} constraints Parsed joint params.
 * @param {Iterable<string>} enabledGroups Group ids to simulate.
 * @returns {{rigidBodies: B[], constraints: C[], bodyIndex: Int32Array, orphaned: string[]}}
 *   bodyIndex maps each original body index to its new one, or -1.
 */
export function filterPhysics(rigidBodies, constraints, enabledGroups) {
  const enabled = new Set(enabledGroups);
  const keep = rigidBodies.map((body) => {
    const group = classifyBody(body);
    return group === null || group === "other" || enabled.has(group);
  });
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < rigidBodies.length;
  const joined = (c) => valid(c.rigidBodyIndex1) && valid(c.rigidBodyIndex2)
    && keep[c.rigidBodyIndex1] && keep[c.rigidBodyIndex2];

  // Walk the kept joints out from every kinematic body.
  const neighbours = rigidBodies.map(() => []);
  for (const c of constraints) {
    if (!joined(c)) continue;
    neighbours[c.rigidBodyIndex1].push(c.rigidBodyIndex2);
    neighbours[c.rigidBodyIndex2].push(c.rigidBodyIndex1);
  }
  const anchored = rigidBodies.map((body) => body.type === KINEMATIC);
  const stack = anchored.flatMap((isAnchor, i) => (isAnchor ? [i] : []));
  while (stack.length) {
    for (const next of neighbours[stack.pop()]) {
      if (keep[next] && !anchored[next]) {
        anchored[next] = true;
        stack.push(next);
      }
    }
  }
  const orphaned = [];
  rigidBodies.forEach((body, i) => {
    if (keep[i] && !anchored[i]) {
      keep[i] = false;
      orphaned.push(body.name);
    }
  });

  const bodyIndex = new Int32Array(rigidBodies.length).fill(-1);
  const keptBodies = [];
  rigidBodies.forEach((body, i) => {
    if (keep[i]) bodyIndex[i] = keptBodies.push(body) - 1;
  });
  const keptConstraints = constraints.filter(joined).map((c) => ({
    ...c,
    rigidBodyIndex1: bodyIndex[c.rigidBodyIndex1],
    rigidBodyIndex2: bodyIndex[c.rigidBodyIndex2],
  }));
  return { rigidBodies: keptBodies, constraints: keptConstraints, bodyIndex, orphaned };
}
