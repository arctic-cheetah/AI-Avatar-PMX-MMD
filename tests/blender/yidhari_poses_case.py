"""Blender-side round trip for the Yidhari Poses add-on (#261).

Run inside Blender by `tests/test_yidhari_poses_blender.py`:

    blender -b --factory-startup --addons bl_ext.blender_org.mmd_tools \
        --python tests/blender/yidhari_poses_case.py

It builds a small synthetic rig (no private model): an armature whose bones
carry MMD names, with bone rolls and a parent chain, and a mesh with shape keys
named like PMX morphs. MMD Tools' own VPD importer is the reference for how VPD
values become Blender bone transforms.
"""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

import bpy
from mathutils import Matrix, Quaternion

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "yidhari-poses"))

import yidhari_poses  # noqa: E402
from yidhari_poses import poses  # noqa: E402
from yidhari_poses.vpd_lib import VpdBone, VpdMorph, VpdPose, format_vpd, parse_vpd  # noqa: E402

BONES = (
    # Blender name, MMD name, head, tail, roll (radians), parent
    ("センター", "センター", (0, 0, 0.5), (0, 0, 0.9), 0.0, None),
    ("腕.R", "右腕", (-0.2, 0.0, 1.4), (-0.5, 0.05, 1.2), 0.4, "センター"),
    ("人指１.R", "右人指１", (-0.5, 0.05, 1.2), (-0.56, 0.08, 1.17), -0.7, "腕.R"),
    ("人指２.R", "右人指２", (-0.56, 0.08, 1.17), (-0.6, 0.1, 1.15), -0.7, "人指１.R"),
    ("齿上", "齿上", (0, -0.05, 1.6), (0, -0.08, 1.6), 0.0, "センター"),
)
MORPHS = ("ウィンク右", "あ")

FIXTURE = VpdPose(
    model="test.osm",
    bones=(
        VpdBone("センター", (0.5, -1.0, 2.0), (0.0, 0.0, 0.0, 1.0)),
        VpdBone("右腕", (0.0, 0.0, 0.0), (0.1, 0.2, -0.15, 0.9618)),
        VpdBone("右人指１", (0.0, 0.0, 0.0), (0.0, 0.0, 0.258819, 0.965926)),
    ),
    morphs=(VpdMorph("ウィンク右", 1.0),),
)


def build_rig() -> tuple[bpy.types.Object, bpy.types.Object]:
    for collection in (bpy.data.objects, bpy.data.armatures, bpy.data.meshes, bpy.data.actions):
        for item in list(collection):
            collection.remove(item)
    data = bpy.data.armatures.new("TestArm")
    arm = bpy.data.objects.new("TestArm", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, _, head, tail, roll, parent in BONES:
        bone = data.edit_bones.new(name)
        bone.head, bone.tail, bone.roll = head, tail, roll
        if parent:
            bone.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    for name, mmd_name, *_ in BONES:
        pose_bone = arm.pose.bones[name]
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.mmd_bone.name_j = mmd_name

    mesh = bpy.data.meshes.new("TestMesh")
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
    body = bpy.data.objects.new("TestMesh", mesh)
    bpy.context.scene.collection.objects.link(body)
    body.parent = arm
    body.shape_key_add(name="Basis")
    for name in MORPHS:
        body.shape_key_add(name=name)
    return arm, body


def write(directory: Path, name: str, pose: VpdPose) -> Path:
    path = directory / f"{name}.vpd"
    path.write_bytes(format_vpd(pose))
    return path


def matrices(arm: bpy.types.Object) -> dict[str, Matrix]:
    return {b.name: b.matrix_basis.copy() for b in arm.pose.bones}


def morph(body: bpy.types.Object, name: str) -> float:
    return body.data.shape_keys.key_blocks[name].value


class PosesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.arm, self.body = build_rig()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def assertMatricesClose(self, got: dict[str, Matrix], want: dict[str, Matrix]) -> None:
        for name, matrix in want.items():
            for row_got, row_want in zip(got[name], matrix):
                for a, b in zip(row_got, row_want):
                    self.assertAlmostEqual(a, b, places=5, msg=name)

    def test_import_makes_a_pose_asset_named_after_the_file(self) -> None:
        result = poses.import_pose(self.arm, write(self.dir, "wink-v-sign", FIXTURE))
        action = result.action
        self.assertEqual(action.name, "wink-v-sign")
        self.assertIsNotNone(action.asset_data)
        self.assertIn(action, poses.list_poses())
        self.assertEqual(poses.pose_morphs(action), {"ウィンク右": 1.0})

    def test_importing_the_same_file_again_replaces_the_pose(self) -> None:
        path = write(self.dir, "wink-v-sign", FIXTURE)
        poses.import_pose(self.arm, path)
        changed = VpdPose(FIXTURE.model, FIXTURE.bones[:1], (VpdMorph("あ", 0.5),))
        path.write_bytes(format_vpd(changed))
        result = poses.import_pose(self.arm, path)
        self.assertEqual([a.name for a in poses.list_poses()], ["wink-v-sign"])
        self.assertEqual(poses.pose_morphs(result.action), {"あ": 0.5})

    def test_import_leaves_the_current_pose_alone(self) -> None:
        before = matrices(self.arm)
        poses.import_pose(self.arm, write(self.dir, "p", FIXTURE))
        self.assertMatricesClose(matrices(self.arm), before)
        self.assertEqual(morph(self.body, "ウィンク右"), 0.0)

    def test_import_reports_bones_and_morphs_the_rig_lacks(self) -> None:
        pose = VpdPose("t.osm", FIXTURE.bones + (VpdBone("左足", (0, 0, 0), (0, 0, 0, 1)),),
                       FIXTURE.morphs + (VpdMorph("笑い", 1.0),))
        result = poses.import_pose(self.arm, write(self.dir, "p", pose))
        self.assertEqual(result.missing_bones, ["左足"])
        self.assertEqual(result.missing_morphs, ["笑い"])

    def test_apply_matches_mmd_tools_own_vpd_import(self) -> None:
        path = write(self.dir, "p", FIXTURE)
        poses.apply_pose(self.arm, poses.import_pose(self.arm, path).action)
        ours = matrices(self.arm)

        for bone in self.arm.pose.bones:
            bone.matrix_basis = Matrix.Identity(4)
        bpy.ops.object.select_all(action="DESELECT")
        self.arm.select_set(True)
        bpy.context.view_layer.objects.active = self.arm
        # The operator reads `directory` + `files`, not `filepath`.
        bpy.ops.mmd_tools.import_vpd(directory=str(path.parent), files=[{"name": path.name}],
                                     scale=0.08, bone_mapper="PMX")
        self.assertMatricesClose(ours, matrices(self.arm))
        self.assertNotEqual(ours["腕.R"], Matrix.Identity(4))

    def test_apply_sets_the_pose_morphs_and_leaves_others(self) -> None:
        self.body.data.shape_keys.key_blocks["あ"].value = 0.3
        poses.apply_pose(self.arm, poses.import_pose(self.arm, write(self.dir, "p", FIXTURE)).action)
        self.assertEqual(morph(self.body, "ウィンク右"), 1.0)
        self.assertAlmostEqual(morph(self.body, "あ"), 0.3, places=6)

    def test_apply_replaces_the_previous_pose(self) -> None:
        first = poses.import_pose(self.arm, write(self.dir, "first", FIXTURE)).action
        only_finger = VpdPose("t.osm", FIXTURE.bones[2:], ())
        second = poses.import_pose(self.arm, write(self.dir, "second", only_finger)).action
        poses.apply_pose(self.arm, first)
        poses.apply_pose(self.arm, second)
        self.assertEqual(self.arm.pose.bones["腕.R"].matrix_basis, Matrix.Identity(4))
        self.assertEqual(morph(self.body, "ウィンク右"), 0.0)
        self.assertNotEqual(self.arm.pose.bones["人指１.R"].matrix_basis, Matrix.Identity(4))

    def test_reset_clears_bones_and_only_the_pose_morphs(self) -> None:
        self.body.data.shape_keys.key_blocks["あ"].value = 0.3
        poses.apply_pose(self.arm, poses.import_pose(self.arm, write(self.dir, "p", FIXTURE)).action)
        poses.reset_pose(self.arm)
        for bone in self.arm.pose.bones:
            self.assertEqual(bone.matrix_basis, Matrix.Identity(4), bone.name)
        self.assertEqual(morph(self.body, "ウィンク右"), 0.0)
        self.assertAlmostEqual(morph(self.body, "あ"), 0.3, places=6)

    def test_save_round_trips_bones_and_morphs(self) -> None:
        poses.apply_pose(self.arm, poses.import_pose(self.arm, write(self.dir, "p", FIXTURE)).action)
        out = self.dir / "out.vpd"
        self.assertEqual(poses.save_vpd(self.arm, out, selected_only=False).skipped, [])
        saved = parse_vpd(out.read_bytes())
        want = {b.name: b for b in FIXTURE.bones}
        # 右人指２ is at rest but below the posed 右腕, so it is saved too.
        want["右人指２"] = VpdBone("右人指２", (0.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0))
        self.assertEqual({b.name for b in saved.bones}, set(want))
        for bone in saved.bones:
            for a, b in zip(bone.location, want[bone.name].location):
                self.assertAlmostEqual(a, b, places=4, msg=bone.name)
            got = Quaternion((bone.rotation[3], *bone.rotation[:3]))
            exp = Quaternion((want[bone.name].rotation[3], *want[bone.name].rotation[:3])).normalized()
            self.assertAlmostEqual(abs(got.dot(exp)), 1.0, places=5, msg=bone.name)
        self.assertEqual(saved.morphs, (VpdMorph("ウィンク右", 1.0),))

    def test_save_skips_bones_shift_jis_cannot_name_and_says_so(self) -> None:
        poses.apply_pose(self.arm, poses.import_pose(self.arm, write(self.dir, "p", FIXTURE)).action)
        self.arm.pose.bones["齿上"].location = (0.0, 0.0, -0.001)
        out = self.dir / "out.vpd"
        result = poses.save_vpd(self.arm, out, selected_only=False)
        self.assertEqual(result.skipped, ["齿上"])
        names = [b.name for b in parse_vpd(out.read_bytes()).bones]
        self.assertNotIn("齿上", names)
        self.assertIn("右腕", names)

    def test_save_leaves_a_lowered_arm_out_when_only_a_finger_is_posed(self) -> None:
        only_finger = VpdPose("t.osm", FIXTURE.bones[2:], ())
        poses.apply_pose(self.arm, poses.import_pose(self.arm, write(self.dir, "f", only_finger)).action)
        out = self.dir / "out.vpd"
        poses.save_vpd(self.arm, out, selected_only=False)
        self.assertEqual(sorted(b.name for b in parse_vpd(out.read_bytes()).bones), ["右人指１", "右人指２"])

    def test_save_selected_only_writes_just_those_bones(self) -> None:
        poses.apply_pose(self.arm, poses.import_pose(self.arm, write(self.dir, "p", FIXTURE)).action)
        for bone in self.arm.data.bones:
            bone.select = bone.name == "人指１.R"
        out = self.dir / "out.vpd"
        poses.save_vpd(self.arm, out, selected_only=True)
        self.assertEqual([b.name for b in parse_vpd(out.read_bytes()).bones], ["右人指１"])


def main() -> int:
    yidhari_poses.register()
    try:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(PosesTest)
        result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(suite)
    finally:
        yidhari_poses.unregister()
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    import os
    os._exit(code)
