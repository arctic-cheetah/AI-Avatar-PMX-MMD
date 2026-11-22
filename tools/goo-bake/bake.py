"""Bake the Goo shader inputs from Yidhari_V1.3_PMX.blend (#250, docs/goo-bake.md).

Run inside Goo Engine 4.4.3:
    blender -b assets/Blender/Yidhari_V1.3_PMX.blend --python tools/goo-bake/bake.py -- assets/private/goo
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake_lib import (  # noqa: E402
    build_manifest, dump_json, hash_files, pack_col, pmx_position, sample_indices, sha256_file,
)

MESH = "伊德海莉_mesh"
SHADER_GROUP = "Zenless Zone Zero Braincells [Shader]"
HIDDEN_PREFIX = "PMX Hidden"
# Shader input that an image feeds -> texture role in material-map.json.
TEXTURE_ROLES = {
    "Diffuse Map Color": "diffuse",
    "_A Map Color": "a",
    "_M Map Color": "m",
    "Normal Map Color": "normal",
    "Face Lightmap Color [Vector]": "faceLightmap",
    "Face Lightmap Color [noVector]": "faceLightmap",
    "MatCap Map Color2": "matcap2",
    "MatCap Map Color3": "matcap3",
}


def _json_prop(obj, key):
    """A custom property written by the #245 material swap (on the object or its mesh)."""
    value = obj.get(key)
    if value is None:
        value = obj.data.get(key)
    if value is None:
        raise SystemExit(f"{obj.name} has no custom property {key!r}; is this the V1.3 file?")
    return json.loads(value) if isinstance(value, str) else value.to_dict() if hasattr(value, "to_dict") else list(value)


def _const(value):
    if hasattr(value, "__len__"):
        return [round(float(v), 6) for v in value]
    if isinstance(value, bool):
        return value
    return round(float(value), 6)


def _image_name(node) -> str:
    return Path(node.image.name).name


def resolve(socket, groups=()):
    """A shader input as a constant, or where its value comes from."""
    if not socket.is_linked:
        return _const(socket.default_value) if hasattr(socket, "default_value") else None
    link = socket.links[0]
    node, out = link.from_node, link.from_socket
    if node.type == "REROUTE":
        return resolve(node.inputs[0], groups)
    if node.type == "TEX_IMAGE" and node.image:
        return {"texture": _image_name(node)}
    if node.type in {"ATTRIBUTE", "VERTEX_COLOR"}:
        return {"attribute": getattr(node, "attribute_name", None) or getattr(node, "layer_name", "")}
    if node.type in {"VALUE", "RGB"}:
        return _const(out.default_value)
    if node.type == "GROUP" and node.node_tree:
        output = next((n for n in node.node_tree.nodes if n.type == "GROUP_OUTPUT" and n.is_active_output), None)
        inner = output and next((s for s in output.inputs if s.identifier == out.identifier), None)
        if inner is not None:
            return resolve(inner, (*groups, node))
    if node.type == "GROUP_INPUT" and groups:
        outer = groups[-1]
        source = next((s for s in outer.inputs if s.identifier == out.identifier), None)
        if source is not None:
            return resolve(source, groups[:-1])
    return {"computed": node.bl_idname}


def shader_node(material):
    return next((n for n in material.node_tree.nodes
                 if n.type == "GROUP" and n.node_tree and n.node_tree.name.startswith(SHADER_GROUP)), None)


def transparent_tint(material):
    """The colour of a material that is only a Transparent BSDF (Eye Shadow), else None."""
    output = next((n for n in material.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    surface = output and output.inputs["Surface"]
    if surface is None or not surface.is_linked:
        return None
    node = surface.links[0].from_node
    if node.type != "BSDF_TRANSPARENT" or node.inputs["Color"].is_linked:
        return None
    return _const(node.inputs["Color"].default_value)


def textures_of(material) -> dict:
    found = {}
    for node in material.node_tree.nodes:
        if node.type != "TEX_IMAGE" or not node.image:
            continue
        for link in node.outputs[0].links:
            role = TEXTURE_ROLES.get(link.to_socket.name)
            if role:
                found.setdefault(role, node.image)
    return found


def write_image(image, folder: Path) -> str:
    name = Path(image.name).name
    target = folder / name
    if image.packed_file is not None:
        target.write_bytes(bytes(image.packed_file.data))
    else:
        shutil.copyfile(bpy.path.abspath(image.filepath), target)
    return name


def vertex_colours(mesh) -> list:
    """Col per vertex as the stored sRGB bytes (color_srgb), so nothing is re-quantised."""
    col = mesh.attributes.get("Col")
    if col is None:
        raise SystemExit("the mesh has no Col attribute")
    if col.domain == "POINT":
        return [tuple(value.color_srgb) for value in col.data]
    if col.domain != "CORNER":
        raise SystemExit(f"Col is on the {col.domain} domain; expected CORNER or POINT")
    colours = [None] * len(mesh.vertices)
    for loop, value in zip(mesh.loops, col.data):
        rgba = tuple(value.color_srgb)
        known = colours[loop.vertex_index]
        if known is None:
            colours[loop.vertex_index] = rgba
        elif max(abs(a - b) for a, b in zip(known, rgba)) > 0.5 / 255:
            raise SystemExit(f"Col differs between the corners of vertex {loop.vertex_index}; see docs/goo-bake.md")
    return colours


RAMP_SAMPLES = 33
LIGHT = "Main Light"
HEAD_CONTROLLER = "[Yidhari] Head Controller"
ARMATURE = "伊德海莉_arm"


def _vec(v) -> list:
    return [round(float(c), 6) for c in v]


def head_vectors_at_rest() -> dict:
    """Head Forward/Up minus Head Origin on the controller mesh, as [ZZZB] Vectors does, in the rest pose."""
    arm = bpy.data.objects[ARMATURE]
    saved = arm.data.pose_position
    arm.data.pose_position = "REST"
    try:
        bpy.context.view_layer.update()
        controller = bpy.data.objects[HEAD_CONTROLLER]
        points = {}
        for group in controller.vertex_groups:
            verts = [controller.matrix_world @ v.co for v in controller.data.vertices
                     if any(g.group == group.index and g.weight > 0 for g in v.groups)]
            if verts:
                points[group.name] = sum(verts, verts[0] * 0) / len(verts)
    finally:
        arm.data.pose_position = saved
        bpy.context.view_layer.update()
    origin = points["Head Origin"]
    return {"forward": _vec(points["Head Forward"] - origin), "up": _vec(points["Head Up"] - origin)}


def scene_values() -> dict:
    light = bpy.data.objects[LIGHT]
    group = bpy.data.node_groups[SHADER_GROUP]
    ramps = {}
    for node in group.nodes:
        if node.type == "VALTORGB":
            ramps[node.name] = {
                "frame": node.parent.label if node.parent else "",
                "samples": [round(node.color_ramp.evaluate(i / (RAMP_SAMPLES - 1))[0], 6) for i in range(RAMP_SAMPLES)],
            }
    return {
        "light": {"object": LIGHT, "eulerXYZ": _vec(light.matrix_world.to_euler("XYZ"))},
        "head": {"controller": HEAD_CONTROLLER, "bone": "頭", **head_vectors_at_rest()},
        "ramps": ramps,
    }


def main() -> None:
    if "--" not in sys.argv or sys.argv.index("--") + 1 >= len(sys.argv):
        raise SystemExit("usage: blender -b -y --disable-autoexec FILE.blend --python bake.py -- OUTPUT_DIR")
    out = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    (out / "textures").mkdir(parents=True, exist_ok=True)
    obj = bpy.data.objects[MESH]
    mesh = obj.data
    pmx_names = _json_prop(obj, "goo_original_materials")
    game_of = _json_prop(obj, "goo_material_map")
    slots = [slot.material for slot in obj.material_slots]
    if len(pmx_names) != len(slots):
        raise SystemExit(f"{len(pmx_names)} PMX material names for {len(slots)} slots")

    entries, params, images = [], {}, {}
    for pmx_name, material in zip(pmx_names, slots):
        hidden = material is None or material.name.startswith(HIDDEN_PREFIX)
        entry = {"pmx": pmx_name, "game": None if hidden else game_of.get(pmx_name), "hidden": hidden,
                 "shader": None, "textures": {}}
        if not hidden:
            for role, image in sorted(textures_of(material).items()):
                images[image.name] = image
                entry["textures"][role] = Path(image.name).name
                entry.setdefault("colorSpaces", {})[role] = image.colorspace_settings.name
            node = shader_node(material)
            tint = transparent_tint(material)
            if node is not None:
                entry["shader"] = "zzzb"
                entry["params"] = material.name
                if material.name not in params:
                    params[material.name] = {s.name: resolve(s) for s in node.inputs if s.type != "SHADER"}
            elif tint is not None:
                entry["shader"], entry["color"] = "transparent", tint
            else:
                entry["shader"] = "unsupported"
        entries.append(entry)

    written = []

    def write(name: str, data) -> None:
        path = out / name
        if isinstance(data, bytes):
            path.write_bytes(data)
        else:
            path.write_text(data, encoding="utf-8", newline="\n")
        written.append(path)

    for image in images.values():
        written.append(out / "textures" / write_image(image, out / "textures"))
    write("col.bin", pack_col(vertex_colours(mesh), len(mesh.vertices)))
    write("material-map.json", dump_json({"materials": entries}))
    write("params.json", dump_json(params))
    write("scene.json", dump_json(scene_values()))

    # Only what this run wrote: stale files from an earlier bake are not part of it.
    files = hash_files(written, out)
    samples = [{"index": i, "position": pmx_position(mesh.vertices[i].co)}
               for i in sample_indices(len(mesh.vertices))]
    source = Path(bpy.data.filepath)
    manifest = build_manifest(source=source.name, source_sha256=sha256_file(source),
                              blender=bpy.app.version_string, vertex_count=len(mesh.vertices),
                              materials=pmx_names, files=files, samples=samples)
    (out / "manifest.json").write_text(dump_json(manifest), encoding="utf-8", newline="\n")
    print(f"GOO_BAKE wrote {len(files) + 1} files to {out}: {len(mesh.vertices)} vertices, "
          f"{len(entries)} materials, {len(images)} textures")


main()
