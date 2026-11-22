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
from bake_lib import build_manifest, dump_json, pack_col, sha256_file  # noqa: E402

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
    col = mesh.attributes.get("Col")
    if col is None:
        raise SystemExit("the mesh has no Col attribute")
    colours = [None] * len(mesh.vertices)
    for loop, value in zip(mesh.loops, col.data):
        rgba = tuple(value.color)
        known = colours[loop.vertex_index]
        if known is None:
            colours[loop.vertex_index] = rgba
        elif max(abs(a - b) for a, b in zip(known, rgba)) > 0.5 / 255:
            raise SystemExit(f"Col differs between the corners of vertex {loop.vertex_index}; see docs/goo-bake.md")
    return colours


def main() -> None:
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
            node = shader_node(material)
            tint = transparent_tint(material)
            if node is not None:
                entry["shader"] = "zzzb"
                if material.name not in params:
                    params[material.name] = {s.name: resolve(s) for s in node.inputs if s.type != "SHADER"}
            elif tint is not None:
                entry["shader"], entry["color"] = "transparent", tint
            else:
                entry["shader"] = "unsupported"
        entries.append(entry)

    for image in images.values():
        write_image(image, out / "textures")
    (out / "col.bin").write_bytes(pack_col(vertex_colours(mesh), len(mesh.vertices)))
    (out / "material-map.json").write_text(dump_json({"materials": entries}), encoding="utf-8")
    (out / "params.json").write_text(dump_json(params), encoding="utf-8")

    files = {p.relative_to(out).as_posix(): sha256_file(p)
             for p in sorted(out.rglob("*")) if p.is_file() and p.name != "manifest.json"}
    source = Path(bpy.data.filepath)
    manifest = build_manifest(source=source.name, source_sha256=sha256_file(source),
                              blender=bpy.app.version_string, vertex_count=len(mesh.vertices),
                              materials=pmx_names, files=files)
    (out / "manifest.json").write_text(dump_json(manifest), encoding="utf-8")
    print(f"GOO_BAKE wrote {len(files) + 1} files to {out}: {len(mesh.vertices)} vertices, "
          f"{len(entries)} materials, {len(images)} textures")


main()
