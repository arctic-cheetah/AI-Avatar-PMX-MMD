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
| #182 | Tentacle wave on top of the tails' physics | Idle wave: [below](#tentacle-wave-182); reactions planned |

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

The tentacle wave (#182) wraps the physics step; see
[Frame order with the wave](#frame-order-with-the-wave).

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
| Tentacle wave · 触手 | `yidhari.tentacles` | on |
| Wave size (0–2) | `yidhari.tentacles.size` | 0.4 |

The main toggle is the kill-switch. The chest and hip toggles change their
groups independently (a change rebuilds), and they keep their choice while
physics is off. `bindStoredToggle` takes `defaultOn: false` for these.

## Tentacle wave (#182)

While she idles, a slow wave travels along her four tails, from the root to
the tip, with each tail out of step with the others. Physics still owns the
tails: the wave is added **on top of the pose physics gives them**, after the
physics step, and taken off again before the next one.

### The spike: why not kinematic roots

The plan was the fringe's first technique: give the first links kinematic
bodies, drive them, and let physics carry the motion down the chain. Her rig
rules that out:

- `Ctr_Tail_Root` **does** have a body (dynamic, 150,756 mass). It hangs from
  `下半身` on the only free joint of the tails: X −30° to +4°, Z −20° to 0°.
- **Every other tail joint is locked** (all rotation and translation limits
  are 0, no springs). Each 17-link tail is one rigid piece, so physics only
  swings all four tails together about that root. A wave can't travel along
  them inside the solver.
- After the warm-up the tails rest 3.5° below their bind pose, and their links
  bend less than 1° against each other.

So driving kinematic roots would only turn the tails into rigid, bone-driven
pieces. Unlocking the chain joints would mean the stiff joints and springs
that made the fringe fight itself (see *Stiffened hair*), with mass ratios of
87,343 : 0.1 along each tail.

Two routes were measured in the browser (the spike's code is not merged):

1. **Kinematic roots:** `Ctr_Tail_Root` and each `…Tail…_1` made kinematic,
   the first links swung by the wave.
2. **Overlay after physics:** physics unchanged; each link's bone gets a small
   rotation after `physics.update()`, which is taken off before the next step.

Measured over 6 s at 60 fps, vertex motion in the `下半身` frame, after 10 s
settled. *Jitter* is the mean second difference per frame. *Buzz* is the
largest distance from a 15-frame moving average, which a smooth wave barely
shows and a frame-rate buzz does. *Swing* is how far a vertex travels:

| Tips (links 14–17) | Speed | Jitter | Buzz | Swing |
|---|---|---|---|---|
| Physics, standing still | 0 | 0 | 0 | 0 |
| Overlay, wave off, standing still | 0 | 0 | 0 | 0 |
| Overlay, wave 0.25, standing still | 0.54 units/s | 0.0005 | 0.011 | 1.25 |
| Overlay, wave 0.5, standing still | 1.07 units/s | 0.0008 | 0.005 | 2.48 |
| Physics, swaying | 0.11 units/s | 0.0012 | 0.003 | 0.20 |
| Overlay, wave 0.25, swaying | 0.54 units/s | 0.0009 | 0.004 | 1.27 |
| Overlay, wave 0.5, swaying | 1.07 units/s | 0.0011 | 0.006 | 2.51 |
| Kinematic roots, wave off, standing still | 0 | 0 | 0 | 0 |
| Kinematic roots, wave sized to match 0.25 | 0.55 units/s | 0.0009 | 0.007 | 1.26 |
| Kinematic roots, large wave | 3.8 units/s | 0.0063 | **0.18** | 8.8 |

- **The overlay adds no buzz.** With the wave off it matches physics exactly.
  With it on, buzz stays at 0.003–0.011 units, below the fringe's 5 Hz buzz
  (0.011–0.014, *The spiral curl*), and jitter stays at the physics level.
  The small buzz values come from uneven frame times, not from the solver.
- **Clearance doesn't change:** the closest tail vertex stays 0.096–0.098
  units from her body (legs, hips, skirt) with the wave off, at 0.25 and at
  0.5.
- **The warm-up is unchanged:** after the model is shown, the tail tips still
  drift 0.05–0.08 units as they finish settling, the same with and without
  the overlay.
- Kinematic roots stay clean only at small sizes. They lose the tails' own
  physics swing, and they follow `上半身` instead of hanging from `下半身`. At
  larger swings the locked dynamic links lag the driven link and buzz (0.18).

### How the wave is built

`renderer/tentacle-motion.js` is pure (no DOM or Three.js), so Node tests
cover it:

- `tailChains(boneNames)` finds the four `[左右]Tail[12]_1…17` chains and gives
  each its own phase.
- `waveAngles(t, phase, k, count, amplitude)` returns a yaw (side to side) and
  a smaller pitch (up and down, a quarter period ahead) for link `k`. Each
  link bends at most `amplitude / 6 × k / count`, so the tip moves most and
  the root link hardly at all. The phase lags 0.35 rad per link, so the wave
  travels toward the tip. Summed along a tail, the bend stays under
  1.5 × `amplitude`.
- `TentacleWave` eases a gain toward the idle state's size with a critically
  damped spring (about 1.5 s, no overshoot): active and waking 0, idle and
  stretching 1, sleepy 0.5. The toggle eases it out and back in the same way,
  so nothing snaps.

`TENTACLE_WAVE` holds the sizes: amplitude **0.4** (picked by eye from the
grids below on 15 November 2026), a 5 s period, travel 0.35 rad per link,
lift 0.5. The spike measured 0.25 and 0.5 on either side of it, and both
stayed clean.

### Wave size slider

The **Wave size** slider under the toggle sets the amplitude from **0 to 2**
in steps of 0.05 (the user, 16 November 2026: "I love all of them"). It is
saved as `yidhari.tentacles.size`. `tentacleSize()` clamps and snaps the
value, and anything unreadable falls back to 0.4. While the tails wave, a new
size eases in with the same spring as the gain, so a dragged slider never
jumps. While they are still, it applies at once. At 0 the tails settle
exactly still. The toggle stays as the quick on/off.

The range was checked before the slider went in. These are the spike's
overlay numbers, standing still, tips, 6 s. The last three columns are the
closest a tail came to her body, her other tails and the floor over a full
cycle (every 5th tail vertex, 20 moments):

| Size | Tip speed | Jitter | Buzz | Swing | Body | Other tail | Floor (y) |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 | 0.098 | 1.53 | 5.27 |
| 0.4 | 0.86 units/s | 0.0006 | 0.004 | 2.0 | 0.097 | 1.42 | 4.88 |
| 0.6 | 1.29 units/s | 0.0010 | 0.006 | 3.0 | 0.097 | | |
| 0.8 | 1.68 units/s | 0.0014 | 0.008 | 3.9 | 0.096 | | |
| 1.0 | 2.07 units/s | 0.0018 | 0.010 | 4.8 | 0.096 | 1.31 | 4.34 |
| 1.5 | | | | | 0.094 | 1.12 | 3.96 |
| 2.0 | | | | | 0.093 | 0.86 | 3.66 |

- Buzz and jitter grow with the tips' speed, as a smooth wave's do. At 1.0
  the buzz is still below the fringe's (0.011–0.014).
- No size brings a tail closer to her body: 0.093 is where the tails meet
  her hips. The tails come closer to each other but never touch, and they
  stay well above the floor.
- **By eye:** from 1.5 up the curl turns bold. At 2.0 the near tail sweeps
  across her legs in the three-quarter back view, passing in front of them,
  and the tips hook sharply. It's lively rather than calm, so the default
  stays 0.4.

### Reactions

Her tails answer her mood, on top of the wave and with the same overlay, so
physics still owns them:

| Reaction | Moods | Shape | Size (total arc) |
|---|---|---|---|
| **Perk** | surprised, shocked, gasp, scared | Up in 0.35 s, hold 0.4 s, down over 1.2 s | +0.5 rad |
| **Lift** | happy, joyful, excited, grin, lovestruck | Up in 0.8 s, hold 1.2 s, down over 1.6 s | +0.3 rad |
| **Droop** | sleepy, sad, sorrowful, disappointed, cry | Eases down, held while the mood lasts, eases back | −0.35 rad |
| **Sway** | while she speaks | The wave at 0.35 of its size | |

- A reaction fires when the mood **changes** to one of its moods. The same
  mood again does nothing. The lift is spread evenly over the 17 links, so
  each tail arcs up or down as one curve.
- **Composed:** while idle is blocked by anything other than speech
  (thinking, an open ask, a streaming reply, a morph preview), the wave, sway
  and reactions all ease out, and new moods are ignored. While she speaks,
  only the sway plays, and her moods still react.
- Reactions follow the **size slider** up to the default: full size at 0.4
  and above, half at 0.2, none at 0. The toggle eases them out like the wave.
- A reaction stopped part-way (composure, the toggle, the Stop button) hands
  its current lift to the droop spring, so it eases back instead of snapping.

### Playing them from Animation actions

The **Animation actions · 仕草再生** section (#164) has four more buttons:
**Tentacle wave** (10 s of the full wave), **Tentacle perk**, **Tentacle droop**
(held 4 s) and **Tentacle sway** (8 s at the speaking size). They work like
the body actions: the same button again stops the action and eases back,
another button switches, and they are gated the same way, as well as when the
**Tentacle wave** toggle is off. A tentacle action plays alongside a body
action, since they move different bones.

### Frame order with the wave

```
… idle motion → take the wave off the tails → mesh.updateMatrixWorld() → physics.update(delta)
  → note the tails' physics pose → add the wave → render
```

Taking the wave off before the step matters: `MMDPhysics` works out each
bone's new rotation from its current local rotation, so a wave left on would
feed into the next physics pose. Before a rebuild's `reset()` the wave is
taken off too and the mesh's matrices are refreshed, because `reset()` places
the bodies from `bone.matrixWorld`, which still holds the last drawn wave. With physics off,
the wave is added to the tails' rest pose instead.

Speech, a streaming reply, an open ask and real thinking block idle, so the
idle state returns to active and the wave eases out. The reactions from #182
(lift, droop, the sway while speaking) are planned separately.

### Checked in the browser

With *Idle after* at 5 s, sway and gaze off, vertex motion in the `下半身`
frame over 6 s (tips, links 14–17), measured at the earlier 0.25 default:

| | Speed | Jitter | Buzz | Swing |
|---|---|---|---|---|
| Idle, wave on (0.25) | 0.55 units/s | 0.0005 | 0.003 | 1.25 |
| Idle, wave toggled off | 0 | 0 | 0 | 0 |
| Idle, wave on, after physics off → on | 0.55 units/s | 0.0004 | 0.003 | 1.25 |

- The gain rises 0 → 0.5 in about 0.45 s and reaches 0.99 by 1.6 s. It eases
  out the same way when the toggle goes off, or when real thinking blocks idle
  and she returns to active.
- With physics off, the wave plays on the tails' rest pose. When physics comes
  back, it builds without errors and the wave carries on.
- **Not from the wave:** after a body-group rebuild (switching chest physics
  on), the tails keep a faint buzz on `master` too (tips 0.07 units/s, jitter
  0.0024, swing 0.002), and on this branch with the wave on or off (0.11 units/s, jitter
  0.0034, swing 0.004). A fresh load or a physics off → on doesn't show it.
  This one belongs to #116.

### Grids

Labelled grids and GIFs (front, three-quarter front, three-quarter back,
back × wave off / 0.15 / 0.25 / 0.4 / 0.6 / 0.8 / 1.0 / 1.5 / 2.0) are kept under
`assets/private/tails-182/` (gitignored, since the model is private).

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

`tests/renderer/tentacle-motion.test.mjs` covers the wave's bounds, its
travel from root to tip, the per-tail phases, the easing with the idle
states and the toggle, and her real rig's four 17-link tails (skipped without
the PMX).
