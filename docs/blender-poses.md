# Posing Yidhari in Blender (#50)

How to load Yidhari's PMX into Blender so poses can be authored there and
exported as MMD pose (VPD) and motion (VMD) files. This covers the toolchain
and the import (#238). Calibration, baking, export and the hand-off to the
renderer (#239–#243) are added as those tickets land. The renderer cannot load
VPD or VMD files yet; that is #49.

## Toolchain

Stock Blender and Goo Engine are kept on the **same Blender version (4.4.3)**.
They then share one settings folder (`~/.config/blender/4.4/`), so MMD Tools
and the MCP add-on are installed once, and the same `.blend` opens safely in
both. Set up on 21 November 2026:

| Tool | Version | Source |
| --- | --- | --- |
| Blender | 4.4.3 | `blender-4.4.3-linux-x64.tar.xz` from [download.blender.org](https://download.blender.org/release/Blender4.4/), SHA-256 checked, unpacked to `~/Applications/blender-4.4.3-linux-x64/` |
| Goo Engine | 4.4.3, branch `goo-engine-v4.4-release` (`d281a65ebe2`) | Built from [dillongoostudios/goo-engine](https://github.com/dillongoostudios/goo-engine) in a separate worktree (`~/goo-engine-44`) into `~/build_linux_goo44/` |
| MMD Tools | 4.5.14 (needs Blender 4.2 or later) | Blender ▸ Edit ▸ Preferences ▸ Get Extensions ▸ search "mmd tools" ([extensions.blender.org](https://extensions.blender.org/add-ons/mmd-tools/)) |
| Blender MCP (optional) | `mcp-for-blender`, add-on 2.0 | [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp); the agent's helper, not part of the workflow. Telemetry off, local connections only |

**Goo Engine 4.4 on AMD needs a one-line shader fix.** Unpatched, every
render with Goo's engine segfaulted. The cause was a shader compile error:
`eevee_legacy_maxz_downlevel`, `effect_minmaxz_frag.glsl:60: 'gl_FragColor'
undeclared`. That line only compiles on AMD and Intel OpenGL (`GPU_ATI` /
`GPU_INTEL`), which is why NVIDIA users don't see it. Its create-info declares
the output as `fragColor`, and Goo commit `2e3ae2da759` renamed the write to
the undeclared `gl_FragColor`. The local fix in `~/goo-engine-44` is:

```diff
-  gl_FragColor = vec4(val);
+  fragColor = vec4(val);
```

After rebuilding, a headless Goo render of `yidhari-pose.blend` completes
(480×480, MMD Tools and the MCP add-on loaded, 459 bones). Two non-fatal
`GL_INVALID_VALUE in glTexStorage3D(… < 1)` messages remain. Re-apply the fix
whenever the worktree is updated, until it is fixed upstream.

Blender 4.4 is not an LTS release. It is used because Goo Engine has no stable
4.5 release yet. When Goo publishes one, move both to that version together.

Blender keeps settings per major.minor version. A new 4.4 setup cannot import
settings from 4.5, which is newer, so the add-ons were copied from
`~/.config/blender/4.5/` and enabled again. `userpref.blend` was not copied.

### Goo Engine 4.5 trial

The first attempt built Goo Engine from `blender-v4.5-testing` (commit
`178b4ba83a5`), alongside stock Blender 4.5.16 LTS (snap). MMD Tools imported
the PMX fine (459 bones, 397 with MMD names), but Goo's renderer crashed:

| Check | Result |
| --- | --- |
| Opening a `.blend` saved by stock 4.5.16 | **Crashes.** It warns "File written by newer Blender binary (405.92)", then crashes in EEVEE material compilation (`GPU_pass_shader_get`) |
| Rendering with Goo's engine (`BLENDER_EEVEE`) | **Crashes, and reproducibly.** In a headless render of a fresh import, `gooengine::Instance::init` makes a zero-size texture (`GL_INVALID_VALUE in glTexStorage2D`), then segfaults on a missing view in `EEVEE_temporal_sampling_create_view` |

The cause is the branch, not the GPU. `blender-v4.5-testing` is Goo's
unfinished port of its engine to Blender 4.5. Recent commits remove features
one by one ("Remove Light Cache", "Remove AO", "LookDev Spheres (View
Broken)"), and `gooengine_engine.cc` still prints debug lines ("GOT DATA",
"inititgi stuff"). `blender-v4.5-release` is plain upstream Blender 4.5.10
with no Goo engine. The 4.5 files are kept as `yidhari-pose-4.5.blend` for
reference; do not open them in 4.4.

### Running both

- Pose and export in stock Blender. Use Goo Engine for the look (#219, #235).
- Only one Blender can run the MCP server on port 9876. The second one logs
  "already in use; auto-start skipped".
- To find out why a crash happens, run Blender with `--debug-gpu` and read the
  GL errors printed just before the crash. The backtrace in
  `/tmp/<file>.crash.txt` can be resolved to function names with
  `addr2line -f -C -e <blender binary> <address>`. To reproduce a crash
  without the GUI, use
  `blender -b --factory-startup --debug-gpu --addons bl_ext.blender_org.mmd_tools --python <script>`,
  where the script imports the PMX, sets `scene.render.engine` and calls
  `bpy.ops.render.render()`.

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

## Yidhari Poses add-on (#261)

A small Blender add-on that keeps VPD poses as one-click poses, with their
morphs, and saves poses back to VPD. It lives in
`tools/yidhari-poses/yidhari_poses/` and needs MMD Tools.

### Install

Copy the package into the shared 4.4 add-on folder and enable it:

```bash
cp -r tools/yidhari-poses/yidhari_poses ~/.config/blender/4.4/scripts/addons/
```

Then in Blender (stock or Goo Engine 4.4.3): Edit ▸ Preferences ▸ Add-ons,
search "Yidhari Poses" and tick it. Re-copy after updating the code.

### Use

Select the model's armature (`伊德海莉_arm`). The **Yidhari Poses** tab in the
3D viewport sidebar (N) has:

| Button | What it does |
| --- | --- |
| **Import Folder** | Reads every `*.vpd` in a folder (default `assets/private/poses/`). Each file becomes a pose named after the file, replacing a pose of the same name. Bones and morphs the model lacks are listed in a warning. The current pose is not changed. |
| Pose list → **Apply** | Sets the pose's bones and morphs in one click. Bones the pose does not include return to the bind pose, so poses do not mix. Morphs set by the previously applied pose are cleared, and other morphs are left alone. |
| **Save as VPD** | Writes the current pose to a VPD file: every bone that is not in its bind pose, or only the selected bones, plus every morph above zero. |
| **Reset** | Puts every bone back in the bind pose and clears the morphs the last applied pose set. |

Each pose is an action marked as an asset, so it also appears in the Pose
Library and the Asset Browser. The Pose Library's own apply only sets bones,
so use **Apply** in the Yidhari Poses tab when a pose has morphs, such as a
wink.

### How it stores a pose

- **Bones:** one keyframe per bone (location and quaternion), on frame 1 of
  an action named after the VPD. The VPD values are converted with MMD Tools'
  `BoneConverter`, the same conversion `mmd_tools.import_vpd` uses, at scale
  0.08 on import and 12.5 on save.
- **Morphs:** a JSON object of weights in the action's `yidhari_morphs`
  custom property, for example `{"ウィンク右": 1.0}`. Morphs are the model's
  shape keys, which MMD Tools names after the PMX morphs.
- **Names:** bones are matched by their MMD name (`mmd_bone.name_j`, such as
  `右人指１`), not the Blender name (`人指１.R`), so VPDs from other tools load.
- **Files:** VPDs are Shift-JIS with CRLF line ends, as MMD writes them.
  Saving refuses a bone or morph name that Shift-JIS cannot hold, so nothing
  is written with a replacement character.

Poses and VPDs of the private model stay in the gitignored `assets/private/`.

### Reading these VPDs in the renderer (#49)

three.js r170's `MMDParser.parseVpd` (used by `MMDLoader.loadVPD`) is
stricter than MMD:

- It only accepts numbers written as `-?digits.digits`. The add-on writes six
  decimals, as MMD does, so values never appear as `1.5e-05`.
- It **rejects any `Morph` block** with "the file seems not vpd file." A pose
  with morphs, such as `wink-v-sign.vpd`, must have its `MorphN{…}` blocks
  removed before parsing, for example with
  `text.replace(/Morph\d+\{[^}]*\}\r?\n?/g, "")`. Its morph weights then go
  through the renderer's expression and morph pipeline. With the blocks
  removed, `wink-v-sign.vpd` parses to its 18 bones.

### First pose: wink + V-sign

`assets/private/poses/wink-v-sign.vpd` holds `ウィンク右` = 1 and 18 right-arm
bones: `右腕`, `右ひじ`, `右手首`, and the finger joints. The right hand is raised
beside the face with the palm toward the viewer. Index and middle fingers are
straight and spread; the ring and little fingers and the thumb are curled.
Head and neck are untouched. It was posed from a script on
`yidhari-pose.blend`: each bone was aimed in armature space and the result was
saved with the add-on. Checks:

- Importing, applying and saving it again gives the same 18 bones, with the
  largest difference 4.2e-07, and the same morph.
- three.js parses its bones once the morph block is removed (see above).
- A labelled grid (neutral vs pose; front, three-quarter and side) is at
  `assets/private/poses/grids/wink-v-sign.png`.

### Tests

```bash
.venv/bin/python -m unittest tests.test_yidhari_poses tests.test_yidhari_poses_blender -v
```

`test_yidhari_poses` checks the VPD format without Blender.
`test_yidhari_poses_blender` runs `tests/blender/yidhari_poses_case.py` inside
Blender on a synthetic rig. Applied poses must match MMD Tools' own VPD
import, and saving must write the same VPD back. It uses `YIDHARI_BLENDER`,
the stock 4.4.3 tarball or `blender` on the PATH, and is skipped when none is
found.
