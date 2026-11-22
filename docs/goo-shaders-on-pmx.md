# Goo shaders on the PMX (`Yidhari_V1.3_PMX.blend`)

Research for #245, and Blender-side evidence for #235 Phase 0. The question was
whether Dillongoo's Goo Engine materials from the Open3DLab reference
`Yidhari_V1.2.blend` can be put on our PMX (`yidhari-mmd/伊德海莉.pmx`) inside
Goo Engine 4.4.3, keeping the PMX skeleton and MMD Tools data.

**Result: yes.** `assets/private/blender/Yidhari_V1.3_PMX.blend` renders the PMX
with the reference shaders in Goo Engine 4.4.3. Side by side, it matches the
reference closely (face, bust and full body).

> 🛡️ The reference is CC BY-NC-ND 4.0 and the PMX licence forbids commercial
> use. The `.blend`, the packed game textures and the comparison grids stay in
> the gitignored `assets/private/`. Never commit, upload or share them. This doc
> holds only notes and node names.

## Toolchain

| Item | Value |
| --- | --- |
| Blender | Goo Engine 4.4.3 (`goo-engine-v4.4-release` with the local AMD `fragColor` fix), via the Blender MCP |
| Input | `assets/private/blender/yidhari-pose.blend` (PMX import at scale 0.08, 459 bones). It was opened, then saved under the new name. The pose file itself is unchanged. |
| Reference | `~/Downloads/Yidhari_V1.2.blend` (read only, never saved) |
| Output | `assets/private/blender/Yidhari_V1.3_PMX.blend` (about 66 MB; game textures packed) |
| Grids | `assets/private/goo-pmx-245/grid_{face,bust,full}.png`, tiles in `tiles/`, scripts `shots.py` and `grid.py` |

## What was done

1. Opened the pose file in Goo, then saved it as `Yidhari_V1.3_PMX.blend`.
2. Appended these from the reference:
   - the materials `Yidhari MAT 1`, `Yidhari MAT 2`, `Yidhari Hair`, `Yidhari Face`, `Yidhari Eyes`, `Eye Shadow` and `Yidhari Tentacles`, which bring their shader node groups and packed textures with them;
   - the geometry node groups `[ZZZB] Vectors V0.8` and `[ZZZB] Outlines V0.8`;
   - the objects `Main Light`, `Sun` and `[Yidhari] Head Controller`;
   - the world `World.002`.

   Appending the Head Controller also pulls in the reference Rigify rig, because of the controller's Child Of constraint. The rig, its widgets and its UI script were deleted after the append.
3. Put the controls in a `Goo Controls` collection:
   - The Head Controller sits at the head of the PMX `頭` bone, with an identity rotation. It was first bone-parented to `頭`, and now follows it through a Child Of constraint (see the gotcha below).
   - `Sun` is parented to `Main Light`.
   - A perspective `Camera` (85 mm) is the outline camera.
4. Swapped the PMX material slots to the game materials (table below). The original MMD materials are kept with fake users. The mesh stores two custom properties:
   - `goo_original_materials`: the original slot order;
   - `goo_material_map`: the PMX → game mapping.
5. Created the colour attribute `Col` on the PMX mesh, copied from the game meshes by UV match (see [Attributes](#attributes-the-shader-reads)).
6. Added the modifiers `Goo Vectors` and `Goo Outlines` after `mmd_armature`, with the same settings as the reference.
7. Copied the reference render settings:
   - render engine `BLENDER_EEVEE`;
   - the EEVEE settings: SSR and refraction, GTAO, bloom and shadow cascade size;
   - view transform `Standard` with the `Medium High Contrast` look.

## Material mapping

| PMX material (faces) | PMX texture | Game material | Evidence: share of PMX UVs within 1 texel of that game material's UV0 |
| --- | --- | --- | --- |
| 颜, 颜2, 口线, 口舌, 齿 | 颜.png | `Yidhari Face` | 100% |
| 睫眉 (lashes/brows) | 颜.png | `Yidhari Eyes` | 90% Eyes, 9% Face (the game splits these faces between both) |
| 目, 目光 | 颜.png | `Yidhari Eyes` | 100% |
| 目影 | 颜.png | `Eye Shadow` | 100% |
| 体, 体2, 肌, 袜, 肌2, 饰 | 体.png / 肌.png | `Yidhari MAT 1` (Body_Map1) | 92–100% |
| 饰2 (258 faces) | 体.png + sp2.png | `Yidhari MAT 1` | 0%: its UVs are offset about 6 px. Mapped by its texture. |
| 帽 (hat) | 髮.png | `Yidhari MAT 2` (Body_Map2) | 100% |
| 髮 (hair) | 髮.png | `Yidhari Hair` | 99% |
| 尾 (tail/tentacles) | 尾.png | `Yidhari Tentacles` | 99% |
| 髮+ (sphere-map hair shell, a duplicate of 髮) | sp.png | `PMX Hidden (髮+ shell)`: Transparent BSDF | n/a. The Goo hair shader draws its own highlights, and the shell would z-fight. |

Game materials not used: `Yidhari Hammer` (the PMX has no hammer).

## UV result

The hypothesis holds: **the PMX keeps the game UV0 layout.**

The test was done in UV space, so it doesn't depend on pose. A KD-tree was built
over the game UV0 coordinates, and the nearest one was found for every PMX
`UVMap` loop. A texel is 1/2048.

- Face, eyes, mouth, teeth, hat: 100% exact (distance 0).
- Hair, tail, socks, `体2`, `肌2`, `饰`: 100% within 1 texel (median 0.0001–0.0002, from float rounding).
- `体` and `肌`: 93–94% within 1 texel. The remaining 5–7% are up to 19 texels away. Those are probably PMX-only edits.
- `饰2`: offset 5–9 texels. It is the only material that is not aligned.
- The UVs are not flipped; a V-flipped test matched 0–2%.

**UV layers.** The PMX has `UVMap` (active render), `UV1` and `UV2`. The game
meshes have `UV0` and `UV2`, plus `UV3` on the face. No image texture in the
appended materials has its vector input linked, and the shader's UV Map nodes
are blank. So everything samples the **active render UV**: `UVMap` on the PMX,
which matches `UV0`. The materials do not read `UV2` or `UV3`, so nothing had to
be filled in for them. The PMX `UV1`/`UV2` layers were not compared.

**Geometry.** The PMX face, hair and chains are the game meshes moved up
+0.0486 m in Z: after that shift, 99% of vertices are within 0.5 mm. The body
and tentacles match on the torso, but the arms, legs and tentacles are posed
differently in the rest pose, which is why the transfer works in UV space.

## Attributes the shader reads

| Attribute | Read by | Source in the reference | On the PMX (V1.3) |
| --- | --- | --- | --- |
| `lightDirection` (point, vector) | `Zenless Zone Zero Braincells [Shader]`, `faceLogic`, `dotCreation`, `screenspaceShadows` | `[ZZZB] Vectors V0.8` modifier: rotation of the `Main Light` object | Same modifier and object, appended |
| `headForward`, `headUp` | `Zenless…`, `faceLogic` | `[ZZZB] Vectors V0.8`: `Head Forward` / `Head Up` minus `Head Origin` vertex-group points on the Head Controller mesh | Same controller mesh, following `頭`. A head turn plus the `まばたき` blink morph rendered cleanly. |
| `outline` | `Zenless…` | `[ZZZB] Outlines V0.8` modifier (inverted hull, camera-scaled) | Same modifier, using our `Camera` |
| `Col` colour attribute (corner, byte) | All `Yidhari*` materials (`Color Attribute Color/Alpha` inputs), and the outline modifier's vertex-colour width | Game mesh vertex colours | **Missing on the PMX.** It was transferred from the game meshes per loop: for each loop, the nearest UV0 in the same game material was taken, with spatial distance breaking ties. 101,448 loops matched within 1 texel, and 4,014 used the nearest UV (mostly `体`/`肌` edits and `饰2`). The 5,676 `髮+` faces were set to white. |
| `Eyes` colour attribute | `Set Depth` group (blends the face/eyes over the hair) | **Missing in the reference too.** The node reads nothing, and the reference renders the same way. | Not added |
| Custom split normals | Face shading smoothness | Game `custom_normal` | The PMX keeps its own normals. No artefacts were seen in the grids. |

The drivers on `faceLogic` and `dotCreation` (`Vector Rotate` angle) have no
target object in the reference, so there was nothing to rewire.

## Node inventory for the three.js port (#235)

Shader node groups: `Zenless Zone Zero Braincells [Shader]`, `[ZZZB] Global
Attributes [Promeia]`, `[ZZZB] Global Attributes`, `[ZZZB] MatCaps`,
`[ZZZB] matIDs`, `Set Depth`, `setDepth`, `faceLogic`, `rimLighting`,
`screenspaceShadows`, `seethroughLogic`, `dotCreation`, `diagonalMapping`,
`idSwitcher`, `matCap Mapping`, `smoothstep`, `<=`. Geometry node groups:
`[ZZZB] Vectors V0.8`, `[ZZZB] Outlines V0.8`, `Vertex Name`.

| Node | Count | Status | Where |
| --- | --- | --- | --- |
| `ShaderNodeScreenspaceInfo` | 5 | **Goo-only** | `[ZZZB] Global Attributes [Promeia]`, `screenspaceShadows`, `seethroughLogic`, `Set Depth`, `setDepth` |
| `ShaderNodeSetDepth` | 2 | **Goo-only** | `Set Depth`, `setDepth` |
| `ShaderNodeShaderInfo` | 1 | **Goo-only** | `Zenless Zone Zero Braincells [Shader]` |
| `ShaderNodeShaderToRGB` | 2 | Standard, but EEVEE only (not Cycles) | `Zenless…`, `Set Depth` |
| Math, Vector Math, Mix, Mix Shader, Map Range, Clamp, ColorRamp, Separate/Combine Color/XYZ, Vector Rotate/Transform, Mapping, Invert, Hue/Saturation, RGB to BW, Value | about 500 | Standard | throughout |
| Image Texture, UV Map, Texture Coordinate, Normal Map, Color Attribute, Attribute | 8 / 2 / 1 / 1 / 2 / 10 | Standard | materials, `Zenless…` |
| Geometry, Camera Data, Object Info, Layer Weight, Curvature | 2 / 7 / 3 / 2 / 1 | Standard | throughout |
| Transparent BSDF | 2 | Standard | `Zenless…` |
| Geometry nodes (Object Info, Named Attribute, Sample Index, Delete Geometry, Set Position, Flip Faces, Merge by Distance, Set Material, Material Selection, Store Named Attribute, Switch, Geometry to Instance, Normal, Position) | – | Standard | `Vectors` and `Outlines` modifiers |

For the port, the three Goo-only nodes are the screen-space parts: the
screen-space shadow and see-through lookups, and the face/eyes depth push over
the hair. Everything else maps to ordinary shader maths, plus three
per-object uniforms (light direction, head forward and head up) and an
inverted-hull outline.

## Gotchas found

- **The render engine must be `BLENDER_EEVEE` (Goo's legacy EEVEE).** The pose file was saved by stock 4.4.3 with `BLENDER_EEVEE_NEXT`, an identifier Goo 4.4.3 does not list. In that state, everything that goes through `Set Depth` (face and eyes) rendered **solid black**. Bypassing `Set Depth` brought the face back, and switching the engine fixed it properly.
- **Use a perspective camera.** With an orthographic camera, `Set Depth` misplaces the face: it draws over the fringe as a flat mask, with a dark band across it, even in the reference.
- **The `look` tool cannot frame these meshes.** The evaluated mesh of objects with the outline modifier reports 0 vertices through the Python API, so auto-framing gets a 0 × 0 × 0 box. Final renders are fine. The grids use their own camera script instead.
- **The reference is posed with a wink.** For the grids, its rig was switched to Rest Position (in memory only, never saved). The wink is a shape key, so it remains.
- **The bone-parented Head Controller breaks VPD morph export.** mmd_tools' `firstMesh()` picks the controller instead of the PMX mesh, so `export_vpd` writes no morphs. Both V1.3 and V1.4 now use a Child Of constraint instead (`tools/pose-fit/fix_head_controller.py`); see [pmx-sit-pose.md](pmx-sit-pose.md#gotchas).
- The PMX default row was rendered in stock Blender 4.4.3 (EEVEE Next) from the untouched pose file. That file has no lights, so the row is dim. That is its real default state, not a regression.

## MMD Tools data after the swap

Checked in the V1.3 file:

- 459 bones (397 MMD bones plus 62 `_dummy_`/`_shadow_` helpers). Every MMD bone has a `name_j` value.
- 57 shape keys and 56 vertex morphs.
- `bpy.ops.mmd_tools.export_vpd` returned `FINISHED`. A test pose with `頭` rotated exported as `Bone0{頭 …}` in a Shift-JIS VPD.
- Mesh, UVs and skeleton are unchanged. The only additions are the `Col` attribute and the two modifiers.

## Comparison grids (private)

`assets/private/goo-pmx-245/grid_face.png`, `grid_bust.png` and
`grid_full.png`. The rows are:

1. PMX default (stock 4.4.3, EEVEE Next);
2. PMX + Goo (V1.3 in Goo 4.4.3);
3. the Open3DLab reference in rest pose.

The columns are front, three-quarter (35°) and side. All tiles use an 85 mm
perspective camera.

What the grids show:

- **Face:** V1.3 matches the reference: the same cream hair with dark streaks, face SDF shading, iris colours, nose and mouth lines, and outlines. The only difference is the reference's wink shape key.
- **Bust:** the clothing, matcap metal, chest pin and arm bands match. Two differences come from the PMX itself, not the shaders: the PMX has its waist medallion accessory, and its arms rest in a wider A-pose.
- **Full body:** the stockings, shoes and tentacle patterns match. The tentacles fan differently because the PMX rest pose differs.

## Not done (out of scope or follow-ups)

- The three.js port (#235) and the Goo screen-space effects (#219).
- Fixing the `饰2` UV offset or the 5–7% of `体`/`肌` loops that differ from the game UVs. The mesh was kept unchanged on purpose.
- An `Eyes` colour attribute for `Set Depth`. The reference doesn't have one either.
