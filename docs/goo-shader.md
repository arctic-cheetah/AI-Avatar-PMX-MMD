# The Goo shader in three.js (#249)

How the renderer's **Game shaders** mode reproduces Dillongoo's
`Zenless Zone Zero Braincells [Shader]` node group (ZZZB) from
`Yidhari_V1.3_PMX.blend`. The inputs come from the bake
([Baking the Goo shader inputs](goo-bake.md)); the GLSL lives in
`renderer/goo-material.js` and the per-frame maths in `renderer/goo-frame.js`.

| Part | Ticket | What |
| --- | --- | --- |
| Core | #252 | Cel light steps, shadow and shallow tint by material ID, sun colour, indirect colour, fake SSS, edge highlight, face lightmap shadow, nose line, dynamic face highlight, normal maps |
| Extras | #253 | Matcaps, hair and body highlights, rim light (approximated), and the `Set Depth` check |
| Finish | #254 | Outline hull and colours, light controls, live part switches, frame cost, final comparison |

## How the port was made

The node graph was not copied by eye. A script dumped every node, socket value
and link of ZZZB and its sub-groups from the `.blend`, then printed each output
as one line per node, in order (`n_Mix_011 = Mix<MIX>(n_Group_016, n_Mix_012,
n_Mix_003)`). The GLSL follows those lines and keeps the Blender node names in
comments, so a line can be checked against the graph. Sub-groups that only
decide things once per frame (`faceLogic`, `[Light Facing Forward]`, `Face
Facing Forward`) run in JavaScript instead, and reach the shader as uniforms.
`idSwitcher` was evaluated numerically: with the default `matID1`–`matID5`
inputs (1–5) it is the identity, so the material ID is simply the band of
`_M.r` below.

Blender's Mix node rules apply throughout: `MIX` is `mix(A, B, f)`, `MULTIPLY`
is `mix(A, A·B, f)`, `ADD` is `A + f·B` and `SCREEN` is
`mix(A, 1 − (1 − A)(1 − B), f)`. The `smoothstep` group is the usual
`t²(3 − 2t)` with `t` clamped to 0–1.

## Material ID (shadow colour bands)

The red channel of the `_M` map picks one of five colour sets
(`[ZZZB] matIDs`):

| `_M.r` | ID | Shadow, Shallow, Local Indirect colour |
| --- | --- | --- |
| ≤ 0.21 | 4 | `Shadow Color4`, `Shallow Color4` … |
| 0.21–0.43 | 5 | … `5` |
| 0.43–0.56 | 1 | `Shadow Color`, `Shallow Color` … |
| 0.56–0.79 | 2 | … `2` |
| > 0.79 | 3 | … `3` |

The face and eyes have no `_M` map; their node holds the constant 0.8, which
is ID 3. The hair and hat `_M` maps are tagged sRGB in Blender, so the
thresholds apply to the decoded (linear) value; the bake records each
texture's colour space and the renderer loads it the same way.

## Body shading (`Enable Face Shading` = 0)

With `L` the light direction, `N` the normal (with the normal map, blue fixed
to 1 as in `[Fix Blue Channel]`) and `V` the direction to the camera:

```text
S4  = smoothstep(pos,       pos + soft,       N·L)   shallow edge
S5  = smoothstep(pos − 0.5, pos − 0.5 + soft, N·L)   deep shadow edge
S16 = smoothstep(pos − 0.4, pos − 0.4 + soft, N·L)
shadow  = ShadowColor[id]  · multiplier
shallow = ShallowColor[id] · multiplier
dark    = mix(shadow, shadow · shallow, 0.5)
mid     = mix(dark, shallow, fade)                     fade = 1 unless Shadow Fade Strength > 0
lit     = mix(mid, Sun, clamp(S4 + 1 − S5))
light   = mix(dark, lit, S16)
light   = mix(light, Transition · multiplier, Col.a)   body/face transition areas
sss     = mix(mix(1, SSSRamp(S4), SSS), 1, S4), then 1 where Col.a = 1
colour  = base · mix(mix(Indirect[id] · light, 1, 0.666), light, sss)
```

`base` is the game diffuse after the edge highlight:
`screen(D, D · edge · shadow)` with
`edge = (1 − N·V)¹⁰ · S4 · (1 − clamp(0.5 − Lz′))`. `Lz′` is the Z of the
camera's back vector rotated by the Main Light rotation (the
`[Light Facing Forward]` frame), computed per frame.

Hair's `Color Attribute Alpha` input is a constant 0, not the `Col` alpha;
the renderer keeps that difference per material.

## Face shading (`Enable Face Shading` = 1)

The face ignores `N·L`. Its shadow comes from `Female_Face_Lightmap.png`, a
signed-distance map whose red channel says how far round the face the light
must come before a pixel is lit:

```text
range  = pow(min((dot(L_xy, F_xy) + 1) / 2, 0.999), 0.421875)     faceLogic, per frame
lit    = smoothstep(1 − range^3.14 + pos − soft, 1 − range^3.14 + pos, lightmap(uv′).r)
light  = mix(mix(Shallow3, Shadow3, lit) · multiplier, Sun, lit)
light  = mix(light, Transition · multiplier, 1 − lightmap(uv′).a)
```

`L_xy` and `F_xy` are the light and head-forward directions flattened onto the
ground (Blender's XY plane). `uv′` is the UV with `u` mirrored when the light
comes from her right (`dot(L_xy, headRight_xy) > 0`), because the
lightmap only stores one side. The nose line (diffuse alpha, faded by
`Face Facing Forward`) and the dynamic highlight (lightmap blue) follow the
`[Process Diffuse]` frame.

## Matcaps, highlights and rim (#253)

These run in ZZZB order: the matcap changes the diffuse before shading, and the
highlights and rim are added after it.

### Matcaps (`Enable MatCap Effect` = 1: body, hat, tails)

`[ZZZB] MatCaps` gives each material ID a matcap colour and a mode. The
`_matcaps` entry in `params.json` (the inputs of that node, baked per
material) sets them:

| ID | Matcap | Mode |
| --- | --- | --- |
| 1, 4, 5 | constant white | multiply (no change) |
| 2 | `Eff_Matcap_116.png` | add |
| 3 | `Eff_Matcap_115.png` | add |

The matcap is sampled at the view-space normal (normal map included),
`uv = n.xy · 0.5 + 0.5` (`matCap Mapping`: World→Camera, then ×0.5 + 0.5). Then:

```text
multiply: D′ = D · M                         add: D′ = D + D · M
D = mix(D, D′, _M.b)
```

### Hair highlight (`Enable Hair Highlight Mask` = 1)

Only where `Col.b · 10 > 0.05` (the hair mask in the vertex colours):

```text
spread = (N·L · 0.5 + 0.5)^Spread Power          (2.5)
band   = smoothstep(clamp(1 − spread − 0.3) + 0.5, clamp(1 − spread + 0.5), _M.b)
colour = mix(colour, screen(colour, colour · band · spread · 1.314), Intensity)   (0.75)
```

### Body highlight (where matcaps are on)

`h = (smoothstep(0, 1, _M.b) · N·H)^10`, with `H` the half vector between the
light and the view. `h · 3.14 + ramp(h)` times the colour is added, and a
second ramp darkens it where `_M.b` is low. On the hair, the hair mask skips
it.

### Rim light (`Enable Rim Lighting` = 1)

**Approximation.** Goo's `rimLighting` uses its screen-space `Curvature`
node (`Scene Rim`), which needs the depth buffer. The renderer uses a fresnel
term instead: `rim = (1 − N·V)^4`, through the same ramp as Blender
(0 below 0.25, 1 above 0.3), times `clamp(N·L)^5` and the normal map's red
channel mask (`smoothstep(0.25, 0.3, R)`):

```text
colour += screen(colour · Rim Light Color Multiplier, Rim Light Additional Color) · rim
```

With the default front light, the rim is faint, as in Blender: it shows on the
edges that face the light.

### Face over the fringe (`Set Depth`)

No code is needed. In the face and eyes materials, `Set Depth` pulls the
face's depth 0.075 towards the camera, then shows the colour already on
screen wherever something is in front (`Intensity` 1, and the `Eyes` colour
attribute does not exist). Hair in front of the face therefore stays hair,
and the result looks the same as ordinary depth testing. The existing
see-through brows (#99) keep the brows readable under the fringe.

## Outlines (#254)

Goo draws outlines with the `[ZZZB] Outlines V0.8` geometry nodes: a copy of
the mesh with flipped faces, pushed out along the normals and tagged
`outline = 1`. The ZZZB shader then gives those faces the outline colour. The
renderer does the same with an **outline hull**: a second skinned mesh that
shares the PMX geometry, skeleton and live morph weights, drawn with back
faces only (`createOutlineHull`). It replaces three's `OutlineEffect` for
Goo materials, so their MMD outlines are switched off.

```text
width  = Col.r · 0.01 · mix(0.125, 0.375, clamp(distance_to_camera − 0.75))   Blender metres
offset = normal · width                                                       ÷ 0.08 for PMX units
colour = shaded · OutlineColor[id] → mix(c, c · 0.25, f)
```

`Outline Color` (ID 1) is screened with 0.75 grey first, as in
`[Adjust Colors To Match Some Stuff]`. `f` is 1, except on ID 2, where it is
`1 − smoothstep(0.25, 0.5, Col.g)` (`[Fix Outline Discoloration]`). The
hidden shell, the eye-shadow tint and materials added after load have no
outline.

## Light controls and live switches (#254)

Under **Game shaders** in *Independent channels*:

| Control | What it does |
| --- | --- |
| Light: **Fixed** | Blender's Main Light, turned by **yaw** (round her, degrees) and **pitch** (up, degrees). Yaw 0 / pitch 0 is the V1.3 scene. |
| Light: **Follow camera** | The light points from the camera at her, so she is lit from the viewer's side when you orbit |
| **Cel lighting** | Off: the game diffuse without any lighting |
| **Face shadow** | Off: the face is fully lit |
| **Matcaps**, **Highlights**, **Rim light**, **Edge + SSS** | Each part on or off |
| **Outlines** | Shows or hides the outline hull |

The switches are uniform values shared by every Goo material, so flipping one
is instant and never recompiles a shader. The light Euler feeds both the
`N·L` direction and the per-frame `faceLogic` and `[Light Facing Forward]`
terms, so the face shadow follows it. All choices are remembered in this
browser (`yidhari.gooParts.*`, `yidhari.gooLight`).

## Per-frame inputs

`renderer/goo-frame.js` works in Blender's world space: three.js
`(x, y, z)` is Blender `(x, −z, y)`, so the face's forward (Blender −Y) is
three.js +Z.

| Input | Source |
| --- | --- |
| Light direction | `+Z` rotated by the Main Light's XYZ Euler from `scene.json` (90° about X: straight at her face) |
| Head forward / up | The Head Controller's rest vectors from `scene.json` (`(0, −0.5, 0)` and `(0, 0, 0.5)`, not normalised, as in Blender), turned by how far the `頭` bone has rotated from its bind pose |
| Camera forward / back | The three.js camera, converted to Blender axes |

The light is fixed in the world by default, like the Blender scene; see
[Light controls and live switches](#light-controls-and-live-switches-254).

## Known differences from Blender

- **Cast shadows** (`ShaderInfo`) and **screen-space shadows** are Goo-only.
  The renderer treats every pixel as not in a cast shadow, which is what the
  graph does where nothing occludes the light.
- **Colour management:** Blender renders with the `Standard` view and the
  `Medium High Contrast` look. The renderer outputs plain sRGB, so contrast is
  a little lower.
- The B-spline SSS ramps are baked as 33-sample tables and read with linear
  interpolation.
- **Rim light:** a fresnel approximation of Goo's screen-space `Scene Rim`
  (see above).
