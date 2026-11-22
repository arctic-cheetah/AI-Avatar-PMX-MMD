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

Run it with Goo Engine 4.4.3 so the `ZZZB` node groups load as saved.
`--disable-autoexec` stops any Python embedded in the third-party-derived
`.blend` from running during the bake:

```bash
~/build_linux_goo44/bin/blender -b -y --disable-autoexec \
  assets/Blender/Yidhari_V1.3_PMX.blend --python tools/goo-bake/bake.py -- assets/private/goo
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
| `manifest.json` | Format version (1), source file and SHA-256, Blender version, `col.bin`'s colour space (`sRGB`), PMX vertex count, PMX material names in PMX order, 32 sampled vertex positions in PMX space (`pmx.samples`), and the SHA-256 of every file this run wrote |
| `material-map.json` | One entry per PMX material, in PMX order: the PMX name, the game material, the `params.json` key of a Goo material (`params`) (or `null` and `hidden: true` for the `髮+` shell), its `shader`, and its texture files by role (`diffuse`, `a`, `m`, `normal`, `faceLightmap`, `matcap2`, `matcap3`). `shader` is `"zzzb"` for the Goo shader (18 materials), or `"transparent"` with an RGBA `color` for `目影`. Eye Shadow is only a Transparent BSDF that darkens what is behind it by that colour. Anything else is `"unsupported"`, and the renderer rejects the bake |
| `params.json` | For each game material, every input of its `Zenless Zone Zero Braincells [Shader]` node: a constant (number or RGBA), or where it comes from (`texture`, `attribute`, or `computed` when it is the result of other nodes) |
| `col.bin` | The `Col` colour attribute: 4 bytes (RGBA) per PMX vertex, in PMX vertex order. RGB are the **sRGB-encoded bytes Blender stores** (`color_srgb`), so nothing is lost to re-quantising; the shader decodes them to linear, which is what Blender's Color Attribute node gives the material. Alpha is linear |
| `textures/*.png` | The game textures the materials use, written from the packed images |

The output does not include a bake date, so baking the same `.blend` twice
gives identical files. The manifest lists only the files this run wrote, so a
stale texture left in the folder from an earlier bake is not mistaken for
part of the bake.

At load, `validateGooAssets()` also compares the 32 sampled vertex positions
with the PMX (within 0.001 units). A PMX whose vertices were reordered or
moved, but whose count is unchanged, is rejected instead of drawn with the
wrong colours.

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

## The Game shaders toggle (#251)

The **Game shaders · ゲーム風** checkbox in *Independent channels* switches the
live avatar to the baked Goo inputs. It is **off by default** and remembered
(`localStorage` key `yidhari.gooShaders`). Nothing is fetched until it is
switched on.

Switching it on (`renderer/goo-material.js`):

1. Fetches `manifest.json`, `material-map.json`, `params.json` and `col.bin`
   from `/assets/private/goo/` once.
2. Checks them against the loaded PMX with `validateGooAssets()`, then loads
   every texture the materials use (`loadGooTextures()`) and **waits** for
   them, so the swap never shows untextured frames and a broken image is
   reported like any other missing file.
3. Builds one replacement material per PMX material, by kind:
   - `zzzb` (18 materials): a clone of the MMD material with the game diffuse
     (`textures.diffuse`) as its map. The texture is loaded like MMDLoader's
     own: `flipY = false`, sRGB. The rest of the Goo shader is ported in #252
     to #254; for now this proves that the material map, UVs, skinning and
     morphs line up.
   - `transparent` (`目影`): unlit, just the baked colour, multiplied into
     what is behind it (premultiplied multiply blending, no depth write),
     like the Blender Transparent BSDF.
   - hidden (the `髮+` shell): not drawn.
4. Adds the baked `Col` to the geometry as the normalised RGBA8 attribute
   `gooCol`, for the later shader pieces.

Materials added after the PMX loads, such as the see-through brow copy, keep
their own material. Switching off puts the original material objects back.

**Fallback.** If a file is missing, the bake does not match the PMX, or a
shader fails to compile while the game shaders are on, she goes back to
today's material. The checkbox is unticked and the stored choice is reset to
off. The status line under the checkbox says why, for example
"Game shaders unavailable: manifest.json: HTTP 404" or
"…: textures/Yidhari_Face_D.png: failed to load". A failure that arrives after
you switched off again is ignored. Re-bake, then switch it on again: a failure
forgets the earlier load, so the new bake is fetched.
