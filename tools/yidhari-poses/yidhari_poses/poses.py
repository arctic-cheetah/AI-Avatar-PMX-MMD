"""Blender side of Yidhari Poses (#261): VPD files ⇄ pose actions with morphs.

A pose is an action named after its VPD file, marked as an asset so it also
shows in the Pose Library. It holds one keyframe per bone on frame 1 and the
VPD's morph weights as JSON in its `yidhari_morphs` property. Bone values are
converted with MMD Tools' BoneConverter, the same conversion its own VPD
importer and exporter use.
"""

from __future__ import annotations

from dataclasses import dataclass
import importlib
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

from .vpd_lib import (
    VpdBone, VpdMorph, VpdPose, decode_morphs, encode_morphs, format_vpd, missing_names, parse_vpd,
    arm_chain_fill, pose_name, split_unwritable,
)

POSE_PROP = "yidhari_pose"
MORPH_PROP = "yidhari_morphs"
APPLIED_PROP = "yidhari_applied_morphs"
IMPORT_SCALE = 0.08  # MMD Tools' default PMX import scale
EXPORT_SCALE = 1.0 / IMPORT_SCALE
FRAME = 1


@dataclass
class PoseSave:
    pose: VpdPose
    skipped: list[str]


@dataclass
class PoseImport:
    action: bpy.types.Action
    missing_bones: list[str]
    missing_morphs: list[str]


def _bone_converter():
    for module in ("bl_ext.blender_org.mmd_tools.core.vmd.importer", "mmd_tools.core.vmd.importer"):
        try:
            return importlib.import_module(module).BoneConverter
        except ImportError:
            continue
    raise RuntimeError("Yidhari Poses needs MMD Tools: install and enable it first")


def _is_helper(pose_bone: bpy.types.PoseBone) -> bool:
    """MMD Tools' _dummy_/_shadow_ bones drive grants inside Blender only."""
    return getattr(pose_bone, "is_mmd_shadow_bone", False) or pose_bone.name.startswith(("_dummy_", "_shadow_"))


def mmd_bones(arm: bpy.types.Object) -> dict[str, bpy.types.PoseBone]:
    """Pose bones by MMD name (`右人指１`), falling back to the Blender name."""
    bones = {}
    for pose_bone in arm.pose.bones:
        if _is_helper(pose_bone):
            continue
        mmd = getattr(pose_bone, "mmd_bone", None)
        bones[(mmd.name_j if mmd and mmd.name_j else pose_bone.name)] = pose_bone
    return bones


def morph_meshes(arm: bpy.types.Object) -> list[bpy.types.Object]:
    """The model's meshes with shape keys: under the armature or its MMD root."""
    scope = [arm, *([arm.parent] if arm.parent else [])]
    seen, meshes = set(), []
    for owner in scope:
        for obj in owner.children_recursive:
            if obj.type == "MESH" and obj.data.shape_keys and obj.name not in seen:
                seen.add(obj.name)
                meshes.append(obj)
    return meshes


def morph_names(arm: bpy.types.Object) -> set[str]:
    names = set()
    for mesh in morph_meshes(arm):
        keys = mesh.data.shape_keys
        names.update(k.name for k in keys.key_blocks if k != keys.reference_key)
    return names


def list_poses() -> list[bpy.types.Action]:
    return sorted((a for a in bpy.data.actions if a.get(POSE_PROP)), key=lambda a: a.name)


def pose_morphs(action: bpy.types.Action) -> dict[str, float]:
    return decode_morphs(action.get(MORPH_PROP, ""))


def _set_morphs(arm: bpy.types.Object, weights: dict[str, float]) -> None:
    for mesh in morph_meshes(arm):
        blocks = mesh.data.shape_keys.key_blocks
        for name, weight in weights.items():
            if name in blocks:
                blocks[name].value = weight


def import_pose(arm: bpy.types.Object, path: str | Path, scale: float = IMPORT_SCALE) -> PoseImport:
    """Store a VPD file as a pose action. The current pose is not changed."""
    path = Path(path)
    pose = parse_vpd(path.read_bytes())
    bones = mmd_bones(arm)
    morphs_here = morph_names(arm)
    missing_bones, missing_morphs = missing_names(pose, set(bones), morphs_here)
    converter = _bone_converter()

    name = pose_name(path)
    action = bpy.data.actions.get(name)
    if action is None or not action.get(POSE_PROP):
        action = bpy.data.actions.new(name)
    for fcurve in list(action.fcurves):
        action.fcurves.remove(fcurve)
    action.id_root = "OBJECT"

    for vpd_bone in pose.bones:
        pose_bone = bones.get(vpd_bone.name)
        if pose_bone is None:
            continue
        convert = converter(pose_bone, scale)
        location = convert.convert_location(vpd_bone.location)
        rotation = convert.convert_rotation(vpd_bone.rotation)
        base = f'pose.bones["{bpy.utils.escape_identifier(pose_bone.name)}"]'
        for prop, values in (("location", location), ("rotation_quaternion", rotation)):
            for index, value in enumerate(values):
                fcurve = action.fcurves.new(f"{base}.{prop}", index=index, action_group=pose_bone.name)
                fcurve.keyframe_points.insert(FRAME, value)

    action[POSE_PROP] = True
    action[MORPH_PROP] = encode_morphs(m for m in pose.morphs if m.name in morphs_here)
    action.use_fake_user = True
    if action.asset_data is None:
        action.asset_mark()
    return PoseImport(action, missing_bones, missing_morphs)


def _clear_bones(arm: bpy.types.Object) -> None:
    for pose_bone in arm.pose.bones:
        if not _is_helper(pose_bone):
            pose_bone.matrix_basis = Matrix.Identity(4)


def _clear_applied_morphs(arm: bpy.types.Object) -> None:
    previous = decode_morphs(arm.get(APPLIED_PROP, ""))
    _set_morphs(arm, {name: 0.0 for name in previous})
    if APPLIED_PROP in arm:
        del arm[APPLIED_PROP]


def apply_pose(arm: bpy.types.Object, action: bpy.types.Action) -> None:
    """Set the pose's bones and morphs. Other bones return to the bind pose."""
    _clear_applied_morphs(arm)
    _clear_bones(arm)
    values: dict[str, dict[str, list[float]]] = {}
    for fcurve in action.fcurves:
        bone, _, prop = fcurve.data_path.rpartition(".")
        if not bone.startswith("pose.bones["):
            continue
        name = bone[len('pose.bones["'):-2].replace('\\"', '"').replace("\\\\", "\\")
        channel = values.setdefault(name, {"location": [0.0] * 3, "rotation_quaternion": [1.0, 0.0, 0.0, 0.0]})
        if prop in channel:
            channel[prop][fcurve.array_index] = fcurve.evaluate(FRAME)
    for name, channel in values.items():
        pose_bone = arm.pose.bones.get(name)
        if pose_bone is not None:
            rotation = Quaternion(channel["rotation_quaternion"]).normalized()
            pose_bone.matrix_basis = Matrix.Translation(Vector(channel["location"])) @ rotation.to_matrix().to_4x4()
    morphs = pose_morphs(action)
    _set_morphs(arm, morphs)
    arm[APPLIED_PROP] = encode_morphs(VpdMorph(n, w) for n, w in morphs.items())


def reset_pose(arm: bpy.types.Object) -> None:
    """Bind pose, and clear the morphs the last applied pose set."""
    _clear_applied_morphs(arm)
    _clear_bones(arm)


def _model_name(arm: bpy.types.Object) -> str:
    root = arm.parent
    mmd_root = getattr(root, "mmd_root", None) if root else None
    name = (mmd_root.name if mmd_root and mmd_root.name else None) or (root.name if root else arm.name)
    return f"{name}.osm"


def capture_pose(arm: bpy.types.Object, selected_only: bool, scale: float = EXPORT_SCALE) -> VpdPose:
    """The current pose as VPD values and morphs above zero.

    Saves the selected bones, or the posed ones plus the at-rest bones below
    a posed arm (vpd_lib.arm_chain_fill), so straight fingers stay straight
    in the renderer.
    """
    converter = _bone_converter()
    identity = Matrix.Identity(4)
    by_name = mmd_bones(arm)
    if selected_only:
        keep = {name for name, pose_bone in by_name.items() if pose_bone.bone.select}
    else:
        keep = {name for name, pose_bone in by_name.items() if pose_bone.matrix_basis != identity}
        keep |= set(arm_chain_fill(keep, set(by_name)))
    bones = []
    for name, pose_bone in by_name.items():
        if name not in keep:
            continue
        convert = converter(pose_bone, scale, invert=True)
        location = tuple(convert.convert_location(pose_bone.matrix_basis.to_translation()))
        w, x, y, z = pose_bone.matrix_basis.to_quaternion()
        w, x, y, z = convert.convert_rotation([x, y, z, w])
        bones.append(VpdBone(name, location, (x, y, z, w)))
    morphs: dict[str, float] = {}
    for mesh in morph_meshes(arm):
        keys = mesh.data.shape_keys
        for block in keys.key_blocks:
            if block != keys.reference_key and block.value > 0 and block.name not in morphs:
                morphs[block.name] = round(block.value, 6)
    return VpdPose(_model_name(arm), tuple(bones), tuple(VpdMorph(n, w) for n, w in morphs.items()))


def save_vpd(arm: bpy.types.Object, path: str | Path, selected_only: bool) -> PoseSave:
    """Write the current pose. Names Shift-JIS cannot hold are left out and listed."""
    pose, skipped = split_unwritable(capture_pose(arm, selected_only))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(format_vpd(pose))
    return PoseSave(pose, skipped)
