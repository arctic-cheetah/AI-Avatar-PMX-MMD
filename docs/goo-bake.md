# Baking the Goo shader inputs (#250)

The three.js port of Dillongoo's Goo shaders (#249) needs data that only exists
in Blender: the game textures, which game material each PMX material uses, the
shader's settings, and the `Col` vertex colours. `tools/goo-bake/bake.py`
reads these from `assets/Blender/Yidhari_V1.3_PMX.blend` and writes them to
`assets/private/goo/`. `renderer/serve.py` already serves that folder on
localhost, and `renderer/goo-assets.js` checks the files against the PMX before
the renderer uses them. For how the V1.3 file was made, see
[Goo shaders on the PMX](goo-shaders-on-pmx.md).

> 🛡️ The output contains game textures from a CC BY-NC-ND 4.0 reference. It
> stays in the gitignored `assets/private/`. Re-bake it locally; never commit it.

## Run it

Run it with Goo Engine 4.4.3 so the `ZZZB` node groups load as saved:

```bash
~/build_linux_goo44/bin/blender -b assets/Blender/Yidhari_V1.3_PMX.blend \
  --python tools/goo-bake/bake.py -- assets/private/goo
```

Then check the result against the PMX the renderer loads:

```bash
node --test tests/renderer/goo-assets.test.mjs
```

The last test, "the private bake lines up with the private PMX", runs only when
`yidhari-mmd/伊德海莉.pmx` and `assets/private/goo/manifest.json` exist. Point
it elsewhere with `YIDHARI_PMX` and `GOO_ASSETS_DIR`. Re-bake whenever the V1.3
file changes; the manifest records the source file's SHA-256 so a stale bake
can be spotted.

## Output

| File | Contents |
| --- | --- |
| `manifest.json` | Format version (1), source file and SHA-256, Blender version, PMX vertex count, PMX material names in PMX order, and the SHA-256 of every other file |
| `material-map.json` | One entry per PMX material, in PMX order: the PMX name, the game material (or `null` and `hidden: true` for the `髮+` shell), and its texture files by role (`diffuse`, `a`, `m`, `normal`, `faceLightmap`, `matcap2`, `matcap3`) |
| `params.json` | For each game material, every input of its `Zenless Zone Zero Braincells [Shader]` node: a constant (number or RGBA), or where it comes from (`texture`, `attribute`, or `computed` when it is the result of other nodes) |
| `col.bin` | The `Col` colour attribute: 4 bytes (RGBA) per PMX vertex, in PMX vertex order |
| `textures/*.png` | The game textures the materials use, written from the packed images |

The output does not include a bake date, so baking the same `.blend` twice
gives identical files.

## Why per-vertex colours and PMX order are safe

Checked on 22 November 2026 against the V1.3 file and Three's `MMDParser`:

| Check | Result |
| --- | --- |
| Vertex count | PMX 39,251, Blender mesh `伊德海莉_mesh` 39,251 |
| Vertex order | Position N in Blender equals PMX vertex N converted as (x, −z, y) × 0.08, for all 39,251 vertices (largest difference 9.5 × 10⁻⁸) |
| UVs | Blender `UVMap` equals the PMX UV with V flipped, for every vertex (largest difference 0) |
| Faces and materials | 40,830 faces in both; 20 PMX materials in the same order as the Blender slots |
| `Col` per corner | Stored per corner (`BYTE_COLOR`), but every corner of a vertex has the same value: 0 vertices disagree |
| three.js | `MMDLoader` builds its geometry by walking the PMX vertices in file order, so vertex N on the GPU is PMX vertex N |

So the per-corner `Col` can be stored once per vertex without losing
anything, and the renderer can add it as a vertex attribute directly. If a
later edit makes corners disagree, the bake stops with an error instead of
picking one.
