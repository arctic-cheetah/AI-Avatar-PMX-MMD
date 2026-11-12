# Hair, tail and accessory physics (#37)

Her PMX already ships a full MMD physics rig, so the plan is to run that rig
(three.js `MMDPhysics` on Ammo.js), not to add our own soft-body code. #37
splits the work into tickets, one PR each:

| Ticket | Part | Status |
|---|---|---|
| #113 | What drives the "coat"? | Done: there is no coat. The coat-like parts are the 尾 tails, which are 98% physics-driven ([evidence on #37](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/37#issuecomment-6838454936)) |
| #117 | Body-group filter | This document |
| #114 | Load Ammo, run `MMDPhysics`, physics toggle | Planned |
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

## Tests

`tests/renderer/physics-groups.test.mjs` covers classification, the
defaults, joint removal and remapping, orphan pruning, the independent chest
and hip groups, and non-mutation. A real-model test parses
`yidhari-mmd/伊德海莉.pmx` with three's `MMDParser`, checks every dynamic
body's group count, and checks that the defaults leave no orphans. It is
skipped when the PMX or `node_modules/three` is absent.
