# Hair, tail and accessory physics (#37)

Her PMX already ships a full MMD physics rig, so the plan is to run that rig
(three.js `MMDPhysics` on Ammo.js), not to add our own soft-body code. #37
splits the work into tickets, one PR each:

| Ticket | Part | Status |
|---|---|---|
| #113 | What drives the "coat"? | Done: there is no coat. The coat-like parts are the 尾 tails, which are 98% physics-driven ([evidence on #37](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/37#issuecomment-6838454936)) |
| #117 | Body-group filter | Done (#160) |
| #114 | Load Ammo, run `MMDPhysics`, physics toggles | This document |
| #156–#159 | Puffy-sleeve physics as a load-time rig overlay | Planned |
| #116 | Profile on Strix Halo, fix jitter, check `delta` | Planned |
| #115 | Raise the sway amplitudes | Planned, last |

## The rig

- 314 rigid bodies: 43 **kinematic** (type 0, they follow their bone) and
  271 **dynamic** (type 1 physics, type 2 physics + bone position).
- 363 joints. Each dynamic chain hangs from a kinematic body (`頭`, `下半身`,
  `胸`, the arm and foot bodies) through its joints.

## Body groups (#117)

`MMDPhysics` can't switch bodies on or off once it is built. So
`renderer/physics-groups.js` filters the parsed `rigidBodies` and
`constraints` **before** construction, and a group change rebuilds physics.

Groups are matched by body name, and the weight bodies (`…錘`) belong to the
group of their chain:

| Group | Bodies (name pattern) | Count | Default |
|---|---|---|---|
| `hair` | `Ctr_[BFLRT]_Hair…` | 80 | on |
| `hat` | `Ctr_Hat…` | 12 | on |
| `tails` | `…Tail…` (`左/右Tail1–2`, `Ctr_Tail_Root`) | 69 | on |
| `bag` | `Ctr_Bag…` | 25 | on |
| `chains` | `Skn_[BF]_Chain…`, `Ctr_Badge…`, `Skn_B_Daizi…` | 23 | on |
| `butterflies` | `…Butterfly…` (the ribbon bows on the arms) | 24 | off |
| `footRings` | `…FootRing…` | 16 | off |
| `chest` | `左/右胸上`, `左/右胸下` | 6 | off, own toggle |
| `hips` | `左/右尻…`, `左/右ひざ2…`, `左/右足2…` (hip and thigh softness) | 16 | off, own toggle |

The defaults keep what reads from the usual bust framing, and they spend the
CPU budget there (the Strix Halo also runs the LLM). #116 will confirm them
with frame times. **Chest and hips are separate toggles** that can each be
switched on alone (decided on 13 November 2026).

### Filter rules

1. **Kinematic bodies are always kept.** They anchor the chains and also
   act as colliders.
2. A dynamic body in a disabled group is dropped, along with **every joint
   that touches it**. A cross-group joint goes too (hair ↔ hat has four),
   while a body that is still anchored elsewhere stays.
3. **Orphans are dropped and reported.** A kept dynamic body with no
   remaining joint path to a kinematic body would fall away under gravity.
   The bag hangs only from the chains, so `bag` without `chains` drops all
   25 bag bodies and lists them in `orphaned`.
4. **An unknown dynamic body is `other` and is always kept**, so a new rig
   part (such as the sleeve overlay from #158) is never lost silently. It
   gets its own group when it lands.
5. Joint body indices are **remapped** to the bodies' new positions. A joint
   with an out-of-range index is dropped, so it never reaches Ammo.
6. The input params are not mutated, so a rebuild can always filter the
   original set again.

A dropped bone that had a type-1 body simply follows its parent bone, the
same as with physics off.

## Running physics (#114)

### Loading Ammo

`MMDPhysics` needs a global `Ammo`. `renderer/ammo-loader.js` loads
`examples/jsm/libs/ammo.wasm.js` from the same three@0.170.0 CDN path as the
import map (it finds `ammo.wasm.wasm` next to itself), calls the `Ammo()`
factory and publishes the result as `globalThis.Ammo`. That's about 1 MB more
to download.

- **It loads once**, and the download **starts with the PMX load**, so it is
  usually ready before the model is. The download only starts when physics
  is on.
- **On a cold start the model stays hidden** until physics has settled, has
  failed or is switched off, for at most 5 s. Otherwise the tails would
  visibly drop from the bind pose when Ammo arrives (about 1.7 s after the
  model on a first visit; with Ammo cached, physics is ready within one
  frame of the model).
- A failed load rejects with the URL, and the next enable retries. While
  physics is unavailable, the toggle shows the error and the rest of the
  avatar keeps working.

### Body parameters

Physics is built from the **loader's** body and joint params
(`mesh.geometry.userData.MMD`), not the raw parsed PMX. `MMDLoader` makes them
bone-relative and, like MMD, turns a physics+bone (type 2) body into type 1
when it is jointed to its parent bone's dynamic body. Type 2 there makes the
chain fight its parent and **vibrate**. On her rig that changes 40 bodies: most
of the hair chains, five hat bodies, the badge and a strap. #114 first built
from the raw PMX, which skipped this fix, and the hair buzzed at frame rate
while she stood still.

### The physics layer

`renderer/physics-layer.js` owns the lifecycle. It is a pure module, so Node
tests cover it with a fake build.

| Event | What happens |
|---|---|
| Enable (first time) | build from the filtered groups → `reset()` → `warmup()` → per-frame updates |
| Disable | per-frame updates stop, and every physics-driven bone goes **back to its rest pose** |
| Enable again | reuses the build: `reset()` → `warmup()` |
| Group change while on | restore bones → dispose the old build → rebuild → `reset()` → `warmup()` |
| Group change while off | the old build is dropped; the next enable rebuilds |
| Overlapping changes | only the newest build runs; older ones are disposed when they finish |
| Build fails | status `error`, no updates; the next enable retries |

- **No second accumulator.** `update(delta)` passes the frame's clamped
  `delta` (`frameDelta()` in `smoothing.js`) straight to `MMDPhysics`, which
  already uses a fixed step (`unitStep` 1/65, `maxStepNum` 3). #116 checks
  large deltas, such as a tab coming back from the background.
- **Warm-up.** `warmup(PHYSICS_WARMUP_CYCLES)` runs after `restArms()` and
  the gaze, sway and idle setup, so the chest and hair don't snap when the
  arms lower. It also hides the tails' drop: in the bind pose they stick
  straight out behind her (#113), and the warm-up lets them settle under
  gravity before the first simulated frame is drawn.
- **Rebuilds share one Ammo world.** `MMDPhysics` has no `dispose()`, so
  disposing removes the old rigid bodies and joints from the shared world.
  Rebuilding never creates another world, so toggling doesn't leak worlds.
- **Disposing frees the old build's Ammo memory.** Ammo objects live on the
  wasm heap, and JavaScript's garbage collector never frees them. Removing
  bodies from the world is not enough: every chest or hip toggle would leak
  the bodies, motion states, shapes, construction infos, joints and the old
  `ResourceManager`'s pooled temporaries. `MMDPhysics` doesn't keep every one
  of them (the construction infos and the box shapes' size vectors are
  dropped), so `trackAmmo()` in `ammo-release.js` swaps in recording
  constructors for those classes while `new MMDPhysics(...)` runs, then puts
  the originals back. On dispose, `releaseAmmo()` removes the joints, then
  the bodies, then calls `Ammo.destroy` once on each recorded object and
  each pooled temporary. The world's own parts (dispatcher, broadphase,
  solver) are never recorded, so the shared world survives. Destroying the
  gravity vector made with the world is safe, since `setGravity` copies it.

### The spiral curl: one moving root, a rigid spiral

The little spiral curl at the front (`Ctr_F_Hair_012` → `013` → `014` → `015`
→ `016`, plus the branch `018`) buzzed at frame rate and clipped when every
link was on physics. A still root with its tips on physics fixed the buzz, but
the tips settled 0.06 units away from where they were drawn and **bent the
spiral out of shape**.

Since 14 November 2026, **only `012` keeps physics**. `RIGID_STRANDS` (`013`,
`014`, `015`, `016`, `018`) lose their rigid bodies, together with their
`…錘` weights and joints (10 bodies), so those bones simply follow `012`: the
spiral swings as **one rigid piece** and keeps its drawn shape. Its weights
aren't changed, apart from the 40 % blend that the rest of the hair has too.

Earlier versions tried making the whole curl static (weights pinned and bodies
dropped), and giving `012` and `013` kinematic bodies with the tips on physics.

Measured in the browser (head frame, 6 s settled):

| | Offset from drawn | Standing still | Swaying |
|---|---|---|---|
| Curl root `012` | 0.011 | 0.004 units/s | 0.004 units/s |
| Spiral (`013`–`018`) | **0.020** (was 0.061 with its tips on physics) | 0.013 units/s | 0.011 units/s |

Spiral shape: pairwise distances between its vertices change by 0.0015 units
on average (0.038 at most, at blended edges), so it keeps its drawn shape.
(Before the equal-share fix below; see *Stiffened hair*.)

The strand over the brow (`Ctr_F_Hair_09` → `010`, strand D) was static for a
while too. Once the loader-params fix had calmed the buzz, it went back to
physics with the 40 % blend below (14 November 2026), so it moves with the
fringe around it instead of the fringe passing through it.

Measured in the browser (vertex motion in the head's frame, 6 s settled):

| | D offset | Tips offset | Standing still: D / tips | Swaying: D / tips |
|---|---|---|---|---|
| D static | 0.006 | 0.039 | 0.002 / 0.012 units/s | 0.003 / 0.013 units/s |
| D on physics, 40 % blend | 0.037 | 0.035 | **0.14 / 0.11** units/s | 0.09 / 0.013 units/s |

D and its neighbours now settle together, but putting D's bodies back brings
a **standing-still buzz** of about 5 Hz (range 0.011–0.014 units) to the front
fringe. Things checked:

- Dropping the locked cross joints (`Ctr_F_Hair_09横`, `012横`): no change.
- Turning off D's collisions, or every fringe body's: no change.
- Physics step 1/60: no change. **Step 1/120** (2 substeps per frame): range
  down to 0.003 (D 0.05, tips 0.07 units/s), at twice the physics cost, which
  #116 has to measure on the Strix Halo.

The 5 Hz rate matches the beat between 60 fps frames and the default 1/65 s
physics step.

### Stiffened hair: blending its weights

With strand D static, the rest of the fringe settles 0.04–0.09 units away
from where it was drawn, and so it clips through D. Stiffening it **inside the
solver** made things worse (browser probe, standing still, after the
loader-params fix):

| Change to the fringe's joints/bodies | Standing-still buzz | Offset from drawn |
|---|---|---|
| None (PMX: ±20° limits, no springs) | ~0.001 units/s | tips 0.09, base 0.04 |
| Limits ×0.25 (±5°) | up to **0.61** units/s | tips 0.17 |
| Rotation springs 500 | up to **1.45** units/s | tips 0.08 |
| Gravity ×0.25 | up to 0.02 units/s | tips **0.16** (floats further) |

Tight limits and stiff springs make the solver fight itself, and lighter
gravity lets the strands drift further. So the fringe is stiffened **on the
skinning side** instead. `blendWeights` keeps `HAIR_FOLLOW` of each
vertex's weight on its moving fringe bone and gives the rest to the nearest
still ancestor (`Ctr_F_Hair_01`, or `頭` for `Ctr_F_HairB_01`). The strands
then show that share of their physics motion and offset, while the solver is
unchanged.

**Every vertex gets the same share** (fixed 14 November 2026). Skinning allows
four influences per vertex, and 1,021 hair vertices already use all four.
Earlier, the 218 that couldn't take the still-bone share kept full physics
while their neighbours moved at 40 %, which **creased the fringe's side
profile**. Now:

1. **A twin of the target counts as the target.** `sameMotionAs()` treats a
   plain `Ctr_` bone with no body as moving exactly like its parent (for
   example `Ctr_F_Hair_01` ≡ `頭`), so the share goes onto whichever of them
   the vertex already has.
2. **A vertex whose four slots all move** (one strand's chain, 166 vertices)
   folds its smallest moving influence into its largest one, which frees a
   slot for the still bone. That changes the vertex by a fraction of its
   smallest weight, between neighbouring bones of the same chain.
3. Only bones that physics moves are blended. Plain bones such as
   `Ctr_F_Hair_01` are left alone.

A vertex is still skipped only if it has no moving pair to fold and no free or
twin slot.

In the browser no hair vertex is skipped any more, and the side profile with
physics on matches physics off again: the creased fringe edge and the spiral's
jagged outline from the 40 % blend are gone.

Stiffened strands: **all of her hair** except the static curl, i.e. every
`Ctr_[BFLRT]_Hair…` bone apart from the `…錘` weights (`stiffStrands()`).
It started with the front fringe and was extended to the side, back and top
hair on 14 November 2026, after the fringe stopped oscillating with it. The
share is `HAIR_FOLLOW` (was `FRINGE_FOLLOW`).

With all hair blended (browser, head frame, 6 s settled):

| Strands | Offset from drawn | Standing still | Swaying |
|---|---|---|---|
| Side locks (`L/R_HairA`) | 0.054 (was 0.28–0.38) | 0.005 units/s | 0.016 units/s (was 0.08–0.09) |
| Back hair (`B_Hair`, `L/R_HairB`, `L_HairC`) | 0.068 | 0.012 units/s | 0.023 units/s |
| Fringe tips / brow strand D | 0.040 / 0.030 | 0.004 units/s | 0.015 / 0.013 units/s |
| Side strand `Ctr_F_HairB_01` | 0.027 | 0.063 units/s | 0.082 units/s |

(Before the equal-share fix in this section.)
The face capture showed no seam. `Ctr_F_HairB_01` is the one strand that still
buzzes a little.

`HAIR_FOLLOW` is **0.4**, chosen from these browser measurements (vertex
motion in the head's frame, sway on, offset 3 s after physics starts):

| Follow | Offset: tips / base | Swaying: tips / base |
|---|---|---|
| 1 (unchanged) | 0.081 / 0.041 | 0.031 / 0.018 units/s |
| 0.6 | 0.051 / 0.028 | 0.018 / 0.012 units/s |
| **0.4** | **0.039 / 0.022** | **0.013 / 0.009 units/s** |
| 0.25 | 0.024 / 0.016 | 0.009 / 0.007 units/s |

At 0.4 the fringe stays within about half its old offset of strand D and
still moves visibly with the sway.

### Physics step rate

MMDPhysics steps the world in fixed slices (`unitStep`). At the PMX default of
1/65 s, a 60 fps display gets one step per frame and an extra one every 12th
frame, and that 5 Hz beat shows up as jitter. A **Physics steps** slider sets
the rate from **65 to 120 steps per second**, defaulting to **120**, and it is
stored in `yidhari.physics.rate`. `physicsStep()` turns the rate into
`unitStep` and a `maxStepNum` that still catches up about 46 ms per frame (3
steps at 65, 6 at 120). The layer applies it to a running build at once,
without a rebuild, and to every new build before its warm-up.

Measured over three fresh loads each (vertex motion in the head's frame):

| | 1/65 | 1/120 |
|---|---|---|
| Strand D standing still | 0.115–0.119 units/s (range 0.012) | 0.028–0.060 units/s (range 0.002–0.004) |
| Strand D swaying | 0.080–0.083 units/s | 0.011–0.013 units/s |
| Swing size (range) | 0.021–0.024 | 0.021–0.022 (unchanged) |
| Back hair standing still | 0.002–0.003 units/s | 0.021–0.025 units/s (range 0.001) |
| `physics.update` median / p95 | 1.6 / 2.1 ms | 1.8 / 2.4 ms |

So the swings keep their size and speed; only the jitter on top of them
shrinks. Rates that divide evenly into the display rate (120 at 60 fps) step
the same number of times every frame. In-between rates such as 90 alternate
one and two steps per frame, so they can still beat a little.

### Frame order

```
thinking pose → gaze → sway → idle motion → mesh.updateMatrixWorld() → physics.update(delta) → render
```

Physics runs **after idle motion** (decided on 13 November 2026), so the
hair and tails react to the stretch, the shrugs and sleep as well as to the
sway. The morph layers (expressions, speech, audition) don't touch bones,
so their place in the frame doesn't matter to physics.

### Toggles

| Toggle | Key | Default |
|---|---|---|
| Physics · 物理 | `yidhari.physics` | on |
| Chest physics · 胸 | `yidhari.physics.chest` | off |
| Hip physics · 腰 | `yidhari.physics.hips` | off |
| Physics steps (65–120 /s) | `yidhari.physics.rate` | 120 |

The main toggle is the kill-switch. The chest and hip toggles change their
groups independently (a change rebuilds), and they keep their choice while
physics is off. `bindStoredToggle` takes `defaultOn: false` for these.

## Tests

`tests/renderer/physics-groups.test.mjs` covers classification, the
defaults, joint removal and remapping, orphan pruning, the independent chest
and hip groups, and non-mutation. A real-model test parses
`yidhari-mmd/伊德海莉.pmx` with three's `MMDParser`, checks every dynamic
body's group count, and checks that the defaults leave no orphans. It is
skipped when the PMX or `node_modules/three` is absent.

`tests/renderer/physics-layer.test.mjs` covers the lifecycle table above with
a fake build, `ammo-loader.test.mjs` covers the one-time script load and its
errors, and `stored-toggle.test.mjs` covers default-off toggles.

`tests/renderer/ammo-release.test.mjs` checks with a fake Ammo that tracking
records only the per-build classes and always restores the constructors,
and that release frees each object once, joints before bodies. A real-Ammo
test loads three's `ammo.wasm.js` in Node, rebuilds a three-body chain 200
times in one shared world, and measures where a fresh 4 KiB block lands.
That address climbs over 100 KB without release and stays flat with it. It
is skipped when `node_modules/three` is absent.
