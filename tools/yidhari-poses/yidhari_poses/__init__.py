"""Yidhari Poses (#261): one-click VPD poses with morphs, saved back to VPD.

Install by copying this folder into `~/.config/blender/4.4/scripts/addons/`
and enabling "Yidhari Poses". Needs MMD Tools. See docs/blender-poses.md.
"""

from __future__ import annotations

from pathlib import Path
import tempfile

import bpy
from bpy.props import BoolProperty, StringProperty
from bpy_extras.io_utils import ExportHelper

from . import poses
from .vpd_lib import NameConflict, VpdError, describe_conflict, poses_folder

bl_info = {
    "name": "Yidhari Poses",
    "author": "arctic-cheetah",
    "version": (1, 0, 0),
    "blender": (4, 4, 0),
    "location": "3D Viewport ▸ Sidebar ▸ Yidhari Poses",
    "description": "Import VPD poses with morphs, apply them in one click and save them back to VPD",
    "category": "Animation",
}


def find_armature(context: bpy.types.Context) -> bpy.types.Object | None:
    """The armature of the active object: itself, its parent, or under an MMD root."""
    obj = context.active_object
    if obj is None:
        return None
    if obj.type == "ARMATURE":
        return obj
    if obj.parent and obj.parent.type == "ARMATURE":
        return obj.parent
    return next((c for c in obj.children_recursive if c.type == "ARMATURE"), None)


def default_folder() -> str:
    """The repository's `assets/poses/` (tracked in git), created if missing (vpd_lib.poses_folder)."""
    folder = poses_folder(Path(bpy.data.filepath) if bpy.data.filepath else None)
    return f"{folder}/" if folder else ""


def draw_name_conflicts(layout: bpy.types.UILayout, conflicts: list[NameConflict], *, select: bool = True) -> None:
    """A warning box for MMD names shared by more than one bone (#273); nothing when there are none."""
    if not conflicts:
        return
    box = layout.box()
    box.alert = True
    box.label(text="Shared MMD names: a VPD keeps one bone each", icon="ERROR")
    for conflict in conflicts:
        col = box.column(align=True)
        col.label(text=f"{conflict.name}: {', '.join(conflict.bones)}", icon="BONE_DATA")
        col.label(text=f"    saved from {conflict.saved}; left out: {', '.join(conflict.left_out)}")
        for bone, hint in conflict.hints:
            col.label(text=f"    fix? {bone}: {conflict.name} → {hint}", icon="LIGHT")
    if select:
        box.operator(YIDHARI_OT_select_name_conflicts.bl_idname, icon="RESTRICT_SELECT_OFF")


class _NeedsArmature:
    @classmethod
    def poll(cls, context):
        return find_armature(context) is not None


class YIDHARI_OT_import_folder(_NeedsArmature, bpy.types.Operator):
    """Store every VPD file in a folder as a pose (bones and morphs)"""

    bl_idname = "yidhari_poses.import_folder"
    bl_label = "Import Folder"
    bl_options = {"REGISTER", "UNDO"}

    directory: StringProperty(subtype="DIR_PATH")

    def invoke(self, context, event):
        self.directory = self.directory or default_folder()
        context.window_manager.fileselect_add(self)
        return {"RUNNING_MODAL"}

    def execute(self, context):
        arm = find_armature(context)
        files = sorted(Path(self.directory).glob("*.vpd"))
        if not files:
            self.report({"WARNING"}, f"No .vpd files in {self.directory}")
            return {"CANCELLED"}
        imported = 0
        for path in files:
            try:
                result = poses.import_pose(arm, path)
            except (VpdError, OSError) as error:
                self.report({"ERROR"}, f"{path.name}: {error}")
                continue
            imported += 1
            missing = result.missing_bones + result.missing_morphs
            if missing:
                self.report({"WARNING"}, f"{path.name}: not on this model: {', '.join(missing)}")
        self.report({"INFO"}, f"Imported {imported} of {len(files)} poses")
        return {"FINISHED"}


class YIDHARI_OT_apply_pose(_NeedsArmature, bpy.types.Operator):
    """Set this pose's bones and morphs"""

    bl_idname = "yidhari_poses.apply_pose"
    bl_label = "Apply Pose"
    bl_options = {"REGISTER", "UNDO"}

    pose: StringProperty()

    def execute(self, context):
        action = bpy.data.actions.get(self.pose)
        if action is None or not action.get(poses.POSE_PROP):
            self.report({"ERROR"}, f"No pose named {self.pose}")
            return {"CANCELLED"}
        poses.apply_pose(find_armature(context), action)
        return {"FINISHED"}


class YIDHARI_OT_reset(_NeedsArmature, bpy.types.Operator):
    """Bind pose for every bone, and clear the morphs the last applied pose set"""

    bl_idname = "yidhari_poses.reset"
    bl_label = "Reset"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        poses.reset_pose(find_armature(context))
        return {"FINISHED"}


class YIDHARI_OT_save_vpd(_NeedsArmature, ExportHelper, bpy.types.Operator):
    """Write the current pose (posed or selected bones, and morphs above zero) to a VPD file"""

    bl_idname = "yidhari_poses.save_vpd"
    bl_label = "Save as VPD"

    filename_ext = ".vpd"
    filter_glob: StringProperty(default="*.vpd", options={"HIDDEN"})
    selected_only: BoolProperty(name="Selected Bones Only", default=False)
    bake_mirrored_bones: BoolProperty(
        name="Bake Mirrored Bones",
        description="Export the visible rotations from Copy Rotation constraints between opposite bones on this rig",
        default=False,
    )

    def draw(self, context):
        arm = find_armature(context)
        if arm is not None:
            draw_name_conflicts(self.layout, poses.name_conflicts(arm), select=False)
        self.layout.prop(self, "selected_only")
        self.layout.prop(self, "bake_mirrored_bones")

    def invoke(self, context, event):
        if not self.filepath:
            self.filepath = default_folder() + "pose.vpd"
        return ExportHelper.invoke(self, context, event)

    def execute(self, context):
        try:
            saved = poses.save_vpd(
                find_armature(context), self.filepath, self.selected_only,
                bake_mirrored_bones=self.bake_mirrored_bones,
            )
        except (VpdError, OSError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        if saved.skipped:
            self.report({"WARNING"}, f"Left out (Shift-JIS cannot name them): {', '.join(saved.skipped)}")
        for conflict in saved.conflicts:
            self.report({"WARNING"}, describe_conflict(conflict))
        self.report({"INFO"}, f"Saved {len(saved.pose.bones)} bones and {len(saved.pose.morphs)} morphs")
        return {"FINISHED"}


class YIDHARI_OT_select_name_conflicts(_NeedsArmature, bpy.types.Operator):
    """Select the bones that share an MMD name, to fix them in MMD Bone Tools"""

    bl_idname = "yidhari_poses.select_name_conflicts"
    bl_label = "Select Conflicts"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        arm = find_armature(context)
        conflicts = poses.name_conflicts(arm)
        if not conflicts:
            self.report({"INFO"}, "No shared MMD names")
            return {"CANCELLED"}
        clashing = {bone for conflict in conflicts for bone in conflict.bones}
        for bone in arm.data.bones:
            bone.select = bone.name in clashing
        # The likely culprit (a side mismatch) first, so its MMD name is in view.
        first = next((bone for c in conflicts for bone, _ in c.hints), conflicts[0].bones[0])
        arm.data.bones.active = arm.data.bones[first]
        for conflict in conflicts:
            self.report({"WARNING"}, describe_conflict(conflict))
        return {"FINISHED"}


class YIDHARI_OT_thumbnail(_NeedsArmature, bpy.types.Operator):
    """Apply this pose and use the current 3D view as its thumbnail"""

    bl_idname = "yidhari_poses.thumbnail"
    bl_label = "Thumbnail"

    pose: StringProperty()

    @classmethod
    def poll(cls, context):
        return super().poll(context) and context.area is not None and context.area.type == "VIEW_3D"

    def execute(self, context):
        action = bpy.data.actions.get(self.pose)
        if action is None:
            return {"CANCELLED"}
        poses.apply_pose(find_armature(context), action)
        scene = context.scene
        old = scene.render.filepath, scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "thumb.png")
            try:
                scene.render.filepath = path
                scene.render.resolution_x = scene.render.resolution_y = 256
                scene.render.resolution_percentage = 100
                bpy.ops.render.opengl(write_still=True, view_context=True)
            finally:
                (scene.render.filepath, scene.render.resolution_x,
                 scene.render.resolution_y, scene.render.resolution_percentage) = old
            with context.temp_override(id=action):
                bpy.ops.ed.lib_id_load_custom_preview(filepath=path)
        return {"FINISHED"}


class VIEW3D_PT_yidhari_poses(bpy.types.Panel):
    bl_label = "Yidhari Poses"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Yidhari Poses"

    def draw(self, context):
        layout = self.layout
        arm = find_armature(context)
        if arm is None:
            layout.label(text="Select the model's armature", icon="INFO")
            return
        layout.label(text=arm.name, icon="ARMATURE_DATA")
        row = layout.row(align=True)
        row.operator(YIDHARI_OT_import_folder.bl_idname, icon="IMPORT")
        row.operator(YIDHARI_OT_save_vpd.bl_idname, icon="EXPORT")
        layout.operator(YIDHARI_OT_reset.bl_idname, icon="LOOP_BACK")
        draw_name_conflicts(layout, poses.name_conflicts(arm))
        box = layout.box()
        found = poses.list_poses()
        if not found:
            box.label(text="No poses yet: Import Folder")
        for action in found:
            row = box.row(align=True)
            # A flag is enough for the icon; no JSON decode on every redraw.
            has_morphs = action.get(poses.MORPH_PROP, "{}") not in ("", "{}")
            row.label(text=action.name, icon="SHAPEKEY_DATA" if has_morphs else "POSE_HLT")
            row.operator(YIDHARI_OT_apply_pose.bl_idname, text="Apply").pose = action.name
            row.operator(YIDHARI_OT_thumbnail.bl_idname, text="", icon="RESTRICT_RENDER_OFF").pose = action.name


CLASSES = (
    YIDHARI_OT_import_folder,
    YIDHARI_OT_apply_pose,
    YIDHARI_OT_reset,
    YIDHARI_OT_save_vpd,
    YIDHARI_OT_select_name_conflicts,
    YIDHARI_OT_thumbnail,
    VIEW3D_PT_yidhari_poses,
)


def register() -> None:
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
