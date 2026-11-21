# Sitting-on-tails pose on the PMX (#247)

#247 brings the original pose from Dillongoo's `Yidhari_V1.2.blend` (Yidhari
sitting cross-legged on her tails) to our PMX, **without the hammer**. It
follows #245 (see [goo-shaders-on-pmx.md](goo-shaders-on-pmx.md)).

**Result:**

- The PMX skeleton in `assets/private/blender/Yidhari_V1.4_PMX.blend` holds the pose, and it still renders with the Goo shaders.
- The pose is exported to `assets/private/sit-pose-247/yidhari-sit-on-tails.vpd`: 254 bones and 7 morphs.
- Loaded onto the unposed `assets/Blender/Yidhari_V1.3_PMX.blend`, that VPD reproduces the fit with the same per-region errors (table below).

> 🛡️ The pose is derived from a CC BY-NC-ND 4.0 file. The VPD, the V1.4
> `.blend` and the grids stay in `assets/private/`.

## Why fitting, not bone mapping

The two rigs don't line up:

- The reference is a Rigify rig with 1,011 bones. 76 controls are posed, directly on the pose bones at frame 0; there is no action, NLA strip or pose asset.
- The PMX tails are 4 chains of 17 bones each. The game's are 4 chains of 9 (`U_`/`D_Tail_01–09`).
- The PMX legs and arms deform through D-bones and twist bones.

The **mesh** is shared, though (#245): the UVs are identical, and the rest-pose
offset is +0.0486 m in Z. So the pose is fitted to the reference's *deformed
mesh* instead of being copied bone by bone.

## Method (`tools/pose-fit/`)

Each script prints its own numbers. `WORK` is a scratch folder for the `.npz`
files, and `TOOLS` points at `tools/pose-fit`.

| Step | Script | Where | What it does |
| --- | --- | --- | --- |
| 1 | `ref_targets.py` | `blender -b Yidhari_V1.2.blend --python ref_targets.py -- out.npz` (Goo, background) | Turns off the Goo geometry-node modifiers, which make the evaluated mesh empty, then saves the posed and rest world positions plus the UV0 loops of `Body`, `Tentacles`, `Hair`, `Face`, `Chain` and `Necklace`. The hammer meshes are never read. |
| 2 | `map_targets.py` | live Blender, V1.4 open | Maps each PMX vertex to a game vertex. Each PMX loop's UV is matched to a game UV0 in the same game material (within 1 texel), with rest-position distance breaking ties on mirrored islands, and each vertex takes the majority vote. Result: **38,135 of 39,251** vertices get a target. |
| 3 | `fit_pose.py` | live | See [Fitting](#fitting). |
| 4 | `finish_ik.py` | live | Puts `足ＩＫ` at the knee tail and `つま先ＩＫ` at the ankle tail, then unmutes IK. The legs evaluate the same with IK on, so the VPD holds under MMD's IK. |
| 5 | `morph_fit.py` | live | Solves bounded least squares (weights 0–1) for curated PMX morphs. The residual is the head-local face residual after the bone fit. |
| 6 | `eval_fit.py` | live | Reports the per-region vertex error against the targets. |
| 7 | `shots.py`, `grid.py` | live / any Python with Pillow | Renders the labelled comparison tiles and grids. |

### Fitting

`fit_pose.py` works in five stages:

1. **Assign vertices to controlling bones.** The weights of the constrained deform bones are folded into the bone that drives them:
   - `足D`→`足`, `ひざD`→`ひざ`, `足首D`/`足首補助`→`足首`;
   - `腕捩*`→`腕`, `手捩*`/`ひじ補助*`→`ひじ`, `手首補助`→`手首`.

   Twist bones stay at rest.
2. **Fit each bone.** A robust weighted Kabsch fit (rigid rotation plus translation) is solved from PMX rest to the targets, using the vertices the bone dominates. The weight threshold steps down (0.85 → 0.5 → 0.25) so sparse bones still get a fit, and residuals over 3× the median are dropped for three rounds. **215 bones** are fitted, including 37 of the 69 tail bones; the others carry no weights.
3. **Set the centre.** `センター` gets the translation that puts the head of `下半身` at its fitted position. Every other bone is rotation-only, as in MMD.
4. **Pose the hierarchy.** Bones are set parents first. Each bone gets its fitted rotation, or its nearest fitted ancestor's. Then it is swung to aim at its chain child's fitted head, which fixes drift along the tails and hair.
5. **Refine.** A fixed-pivot Kabsch fit about each bone's *actual* posed head. It is kept only if the predicted error of that bone's whole subtree goes down. Judging only the bone's own vertices made the head worse (2 → 7 mm) through its parents.

IK, damped-track and limit-rotation constraints are muted while fitting.

## Results

Vertex error after the VPD round trip, onto the unposed V1.3:

| Region | Vertices | Median | p90 |
| --- | --- | --- | --- |
| Hair / hat | 7,944 | 1.9 mm | 3.0 mm |
| Head / face (with morphs) | 6,380 | 2.0 mm | 3.2 mm |
| Torso | 3,769 | 4.9 mm | 9.9 mm |
| Accessories (chains, bag, ribbons) | 5,257 | 4.8 mm | 62 mm |
| Fingers | 1,981 | 5.5 mm | 27 mm |
| Tails | 1,844 | 12.1 mm | 23 mm |
| Arms | 5,008 | 14.9 mm | 24 mm |
| Legs | 5,952 | 20.5 mm | 25 mm |
| **All** | 38,135 | **4.3 mm** | 23 mm |

What drives the larger errors:

- **Legs and arms.** The PMX joints are not where the game rig's joints are. A rotation-only pose about a different pivot leaves an error that grows down the limb, for example 9 → 18 → 23 mm from thigh to foot. Fixing that would need translated limb bones, which MMD doesn't allow on these bones.
- **Max errors** (about 0.6 m): a few hundred mis-mapped vertices from mirrored UV islands. The robust fit already ignores them.
- **Accessories p90.** The physics chains (front and back chains, the bag) hang differently in the reference.

**Face morphs** (`ウィンク`, `口*`): the fitted weights are below.

| Morph | Fitted | Kept in V1.4 |
| --- | --- | --- |
| ウィンク | 0.83 | 0.83 |
| ウィンク２ | 0.19 | 0.19 |
| 口下 | 0.26 | 0.26 |
| 口右 | 0.25 | 0.25 |
| い | 0.22 | **0** |
| 口左 | 0.12 | 0.12 |
| 口上 | 0.10 | 0.10 |

With these weights, the face residual drops from 4.6 mm to 1.6 mm RMS.

**`い` is set to 0 by hand.** At 0.22 it parts the lips just enough for the upper
teeth to show over the bottom lip, which in the side view looks like she is
biting her lip. Lip close-ups (`assets/private/sit-pose-247/grid_lips.png`)
compare the reference, the fitted weights, `い` off and `い`+`口下` off. With
`い` at 0 the side profile matches the reference. Turning off `口下` changes
almost nothing.

The face error stays at 2.0 mm median and 3.1 mm p90.

The reference's own keys are `Fac_Eye_L_Wink` 1.0 and `Fac_Mth_*` at
0.18–0.82. The PMX morph set doesn't match them one to one.

**🚫 Hammer.** `Hammer` and `Hammer Rig` are left out of both the targets and
the renders. This pose has no grip: the left hand points up, and the right
hand rests near the lap. So the fitted fingers are kept as they are.

**Manual edits after the fit.** The user posed the fingers of both hands by hand,
so they don't clip, and gave the right hand a V-sign. From then on, the arm and
finger errors against the reference are larger on purpose. The exported VPD
holds the edited hands.

## Body-part hide masks (V1.4)

One mesh can't be split into Outliner collections without breaking the MMD
morphs, weights and PMX export. Instead, V1.4 has eight viewport-only **Mask**
modifiers on `伊德海莉_mesh`:

- `Hide: Tails`
- `Hide: Legs`
- `Hide: Hair & hat`
- `Hide: Left arm`
- `Hide: Right arm`
- `Hide: Accessories`
- `Hide: Torso`
- `Hide: Head`

Where they sit and how they work:

- They come right after `mmd_armature` and before the Goo modifiers.
- In the Outliner, expand `伊德海莉_mesh ▸ Modifiers` and click a mask's 👁 to hide that part. Several masks can be on at once.
- All of them start off, and their render toggle is off, so renders, the pose and the VPD are unchanged.

Each mask uses a `focus_*` vertex group, with weight 1 on the vertices that its
dominant bone puts in that region. The region split matches `eval_fit.py`, with
the fingers counted in their arm.

> ⚠️ **Before a PMX export,** delete the `focus_*` vertex groups and the
> `Hide:` modifiers. Otherwise the extra groups go into the export.

## Comparison grids (private)

The grids are `assets/private/sit-pose-247/grid_{face,bust,full}.png`. The rows
are PMX + Goo with the fitted pose (V1.4) and the posed reference without the
hammer. The columns are front, three-quarter and side, through an 85 mm
perspective camera.

- **Face:** the wink and the slight smile match, and so do the head tilt and the hair.
- **Bust:** the pointing left hand, the shoulders and the chest match. The PMX waist medallion is a PMX-only accessory, and the neck tassel hangs differently because it is a physics chain.
- **Full body:** the crossed legs, the shoes and all four tails match. The tail tips curl slightly less on the PMX.

## Gotchas

- **The Head Controller made mmd_tools drop the VPD morphs.** In V1.3, `[Yidhari] Head Controller` is bone-parented to the armature. mmd_tools' `Model.firstMesh()` then returns it instead of `伊德海莉_mesh`, so `export_vpd` wrote **0 morphs**. In V1.4 the controller has no parent and follows `頭` through a Child Of constraint, with the inverse set at the current pose. Apply the same fix to V1.3 before exporting VPDs from it.
- **VPD is Shift-JIS.** 14 bone names can't be encoded and are written as `?`, so MMD and mmd_tools skip them on import:
  - the teeth `齿上`/`齿下`;
  - the ribbon knots `左/右结1–3_1/2`.

  They use the simplified-Chinese characters 齿 and 结. Their rotations are small, so the face error is the same after the round trip.
- **`import_vpd` needs `directory` and `files`.** With only `filepath`, the operator returns `FINISHED` but imports nothing. It also keyframes the current frame, so call `frame_set` before you evaluate the result.
- **Background Goo with `--factory-startup` doesn't load mmd_tools.** Enable it with `addon_utils.enable("bl_ext.blender_org.mmd_tools")`.

## Not done

- Playing the VPD in the three.js renderer (a later ticket).
- Leg and arm pivot offsets (rotation-only limits).
- Encoding-safe names for the 14 `?` bones.
