# Posing Yidhari in Blender (#50)

How to load Yidhari's PMX into Blender so poses can be authored there and
exported as MMD pose (VPD) and motion (VMD) files. This covers the toolchain
and the import (#238). Calibration, baking, export and the hand-off to the
renderer (#239–#243) are added as those tickets land. The renderer cannot load
VPD or VMD files yet; that is #49.

## Toolchain

Checked on 21 November 2026:

| Tool | Version | Source |
| --- | --- | --- |
| Blender | 4.5.16 LTS | Snap `blender`, channel `4.5lts/stable` (classic confinement) |
| MMD Tools | 4.5.14 (needs Blender 4.2 or later) | Blender ▸ Edit ▸ Preferences ▸ Get Extensions ▸ search "mmd tools" ([extensions.blender.org](https://extensions.blender.org/add-ons/mmd-tools/)) |
| Blender MCP (optional) | `mcp-for-blender`, add-on 2.0 | [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp); the agent's helper, not part of the workflow |

Use an LTS Blender that MMD Tools lists as supported. Blender 5.2 LTS exists, but
MMD Tools support for 5.x was not confirmed when this was written.

**Goo Engine** is the anime-focused Blender fork used for the shader reference
(#219, #235). It is based on Blender 4.1, which is older than MMD Tools v4
supports, and its builds are Windows-only. Pose in stock Blender. Whether MMD
Tools works in Goo Engine is still to be tried.

## Import the model

1. Start Blender and pick **File ▸ New ▸ General**. Delete the default cube,
   camera and light.
2. Pick **File ▸ Import ▸ MikuMikuDance Model (.pmd, .pmx)**.
3. Choose `yidhari-mmd/伊德海莉.pmx`. Leave out `武器.pmx`, which is the weapon.
4. Keep **Scale 0.08** (the default) and the other default options.
5. Click **Import**.

The script equivalent is
`bpy.ops.mmd_tools.import_model(filepath=…, scale=0.08)`.

The import creates a root empty `伊德海莉` holding the armature `伊德海莉_arm`
and the meshes. She stands about 2 Blender units tall, in the PMX bind pose,
with arms out to the sides. This bind pose is the reference that VPD and VMD
rotations are measured from. It is not the renderer's resting pose, which
lowers and relaxes the arms at runtime (see [Relaxed rest pose](rest-pose.md)).

### Rules while posing

- Pose in **Pose Mode** (select the armature, then Ctrl+Tab) and only rotate
  bones.
- Never use **Apply ▸ Pose as Rest Pose**. It changes the bind pose, and every
  export after that is measured from the wrong reference.
- Save the working file as `assets/private/blender/yidhari-pose.blend`.
  `assets/private/` is gitignored, so the model, its textures and any `.blend`
  that contains them stay private. Saving there also makes Blender store the
  texture paths relative to the repository (`//../../../yidhari-mmd/…`), so
  they still resolve if the repository folder moves.

## Bone names

MMD Tools renames bones that have a side, Blender style, and keeps the original
name for export:

| Blender bone name | MMD name (`pose_bone.mmd_bone.name_j`) |
| --- | --- |
| `腕.L` | `左腕` |
| `ひじ.L` | `左ひじ` |
| `手首.L` | `左手首` |
| `人指２.L` | `左人指２` |
| `親指０.L` | `左親指０` |
| `目.R` | `右目` |

Centre bones keep their names (`頭`, `首`, `上半身`, `上半身2`, `グルーブ`).
Fullwidth digits (`０１２３`) survive the import. The renderer and the VPD and
VMD files use the MMD name, so scripts must look bones up by `name_j`, not by
the Blender name.

The armature has 459 bones:

| Kind | Count | Notes |
| --- | --- | --- |
| PMX bones | 397 | The same count Three's `MMDParser` reads from the file. 34 have grant (append) rotation, and 4 have IK. |
| MMD Tools helpers | 62 | `_dummy_…` and `_shadow_…` (31 each). They drive grant and IK inside Blender, have no MMD name, and are not exported. |

### Bones the renderer uses

Checked against the live import with the Blender MCP. Every bone the renderer
looks up by name exists, under its MMD name:

| Renderer code | Bones |
| --- | --- |
| `main.js` | `頭`, `首`, `上半身`, `上半身2`, `左腕`/`右腕`, `左ひじ`/`右ひじ`, `左目`/`右目` |
| `body-sway.js` | `グルーブ`, `上半身`, `上半身2` |
| `shoulder-lift.js` | `左肩`/`右肩`, `左腕`/`右腕` |
| `rest-pose.js` | `腕`, `ひじ`, `手首`, `中指１`, `足`, `ひざ` on each side, plus the finger joints |
| `thinking-rig.js`, `hand-drift-rig.js` | `手首`, `手捩`, `人指１`, `中指１`, `小指１` on each side, plus the finger joints |
| `tentacle-motion.js` | Chains `左Tail1_n`, `右Tail1_n`, `左Tail2_n`, `右Tail2_n` (68 links) |
| `weight-pins.js` | 81 `Ctr_…_Hair…` bones, 39 of them `…錘` weight bones |

Finger joints are `１–３` for 人指, 中指, 薬指 and 小指, and `０–２` for the
thumb (親指). The finger patterns in `thinking-rig.js` and `hand-drift-rig.js`
also allow `親指３` and `０` on the other fingers. Those bones do not exist in
this model, so those patterns simply do not match them.
