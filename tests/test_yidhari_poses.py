"""VPD reading and writing for the Yidhari Poses Blender add-on (#261).

The add-on's Blender side (`tools/yidhari-poses/yidhari_poses/__init__.py`)
needs bpy. Everything that decides the bytes of a VPD file, and what a pose
stores, lives in `vpd_lib.py`, so it can be tested without Blender. The
Blender round trip is in `test_yidhari_poses_blender.py`.
"""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "yidhari-poses" / "yidhari_poses"))

from vpd_lib import (  # noqa: E402
    VpdBone, VpdError, VpdMorph, VpdPose, decode_morphs, encode_morphs, format_vpd,
    arm_chain_fill, from_vpd_name, keep_morph, missing_names, parse_vpd, pose_name, poses_folder,
    split_unwritable, to_vpd_name,
)

SAMPLE = (
    "Vocaloid Pose Data file\r\n"
    "\r\n"
    "伊德海莉.osm;\t\t// 親ファイル名\r\n"
    "2;\t\t\t\t// 総ポーズボーン数\r\n"
    "\r\n"
    "Bone0{右人指２\r\n"
    "  0,0,0;\t\t\t\t// trans x,y,z\r\n"
    "  0.1,0.2,0.3,0.927;\t\t// Quaternion x,y,z,w\r\n"
    "}\r\n"
    "\r\n"
    "Bone1{センター\r\n"
    "  0.5,-1,2.25;\t\t\t\t// trans x,y,z\r\n"
    "  0,0,0,1;\t\t// Quaternion x,y,z,w\r\n"
    "}\r\n"
    "\r\n"
    "Morph0{ウィンク右\r\n"
    "  1.000000;\t\t\t\t// weight\r\n"
    "}\r\n"
    "\r\n"
).encode("cp932")


class ParseTest(unittest.TestCase):
    def test_reads_bones_and_morphs_from_shift_jis(self) -> None:
        pose = parse_vpd(SAMPLE)
        self.assertEqual(pose.model, "伊德海莉.osm")
        self.assertEqual(pose.bones, (
            VpdBone("右人指２", (0.0, 0.0, 0.0), (0.1, 0.2, 0.3, 0.927)),
            VpdBone("センター", (0.5, -1.0, 2.25), (0.0, 0.0, 0.0, 1.0)),
        ))
        self.assertEqual(pose.morphs, (VpdMorph("ウィンク右", 1.0),))

    def test_reads_a_file_without_morphs(self) -> None:
        text = SAMPLE.decode("cp932").split("Morph0")[0].encode("cp932")
        self.assertEqual(parse_vpd(text).morphs, ())

    def test_treats_an_all_zero_rotation_as_identity(self) -> None:
        text = SAMPLE.decode("cp932").replace("0,0,0,1;", "0,0,0,0;").encode("cp932")
        self.assertEqual(parse_vpd(text).bones[1].rotation, (0.0, 0.0, 0.0, 1.0))

    def test_refuses_a_file_that_is_not_a_vpd(self) -> None:
        with self.assertRaisesRegex(VpdError, "not a VPD file"):
            parse_vpd(b"Vocaloid Motion Data 0002\r\n")

    def test_refuses_a_bone_count_that_does_not_match(self) -> None:
        text = SAMPLE.decode("cp932").replace("2;\t\t\t\t//", "3;\t\t\t\t//").encode("cp932")
        with self.assertRaisesRegex(VpdError, "declares 3 bones but has 2"):
            parse_vpd(text)

    def test_names_the_bone_with_a_broken_rotation(self) -> None:
        text = SAMPLE.decode("cp932").replace("0.1,0.2,0.3,0.927;", "0.1,0.2,0.3;").encode("cp932")
        with self.assertRaisesRegex(VpdError, r"Bone0 \(右人指２\) rotation needs 4 numbers"):
            parse_vpd(text)

    def test_refuses_an_unclosed_bone(self) -> None:
        text = SAMPLE.decode("cp932").replace("}\r\n", "", 1).encode("cp932")
        with self.assertRaisesRegex(VpdError, r"Bone0 \(右人指２\) is not closed"):
            parse_vpd(text)


class FormatTest(unittest.TestCase):
    POSE = VpdPose(
        model="伊德海莉.osm",
        bones=(VpdBone("左人指１", (0.0, 0.0, 0.0), (0.0, 0.0, 0.258819, 0.965926)),),
        morphs=(VpdMorph("ウィンク右", 1.0), VpdMorph("あ", 0.25)),
    )

    def test_round_trips_through_parse(self) -> None:
        self.assertEqual(parse_vpd(format_vpd(self.POSE)), self.POSE)

    def test_writes_shift_jis_with_crlf_and_the_bone_count(self) -> None:
        data = format_vpd(self.POSE)
        text = data.decode("cp932")
        self.assertTrue(text.startswith("Vocaloid Pose Data file\r\n"))
        self.assertIn("1;\t\t\t\t// 総ポーズボーン数\r\n", text)
        self.assertNotIn("\n", text.replace("\r\n", ""))
        self.assertIn("左人指１".encode("cp932"), data)

    def test_writes_plain_decimals_that_three_js_can_read(self) -> None:
        # three.js MMDParser.parseVpd only accepts `-?digits.digits`, so no
        # exponents (1.5e-05) and no bare integers.
        pose = VpdPose("m.osm", (VpdBone("右腕", (1.5e-05, -2.0, 0.0), (1e-7, 0.0, -0.5, 0.866025)),), ())
        number = r"-?[0-9]+\.[0-9]+"
        text = format_vpd(pose).decode("cp932")
        self.assertRegex(text, rf"\n\s*{number}\s*,\s*{number}\s*,\s*{number}\s*;")
        self.assertRegex(text, rf"\n\s*{number}\s*,\s*{number}\s*,\s*{number}\s*,\s*{number}\s*;")
        self.assertNotRegex(text, r"[0-9]e-?[0-9]")
        self.assertIn("0.000015,-2.000000,0.000000;", text)

    def test_refuses_a_name_shift_jis_cannot_hold(self) -> None:
        pose = VpdPose("m.osm", (), (VpdMorph("wink😉", 1.0),))
        with self.assertRaisesRegex(VpdError, "cannot be written in Shift-JIS: wink😉"):
            format_vpd(pose)


class UnwritableNamesTest(unittest.TestCase):
    # The PMX is UTF-16; this model names its teeth 齿上/齿下 and its knots 结…
    # with simplified-Chinese characters Shift-JIS has no code for. They are
    # written with the Japanese forms 歯 and 結, and read back to the model's.
    def test_writes_simplified_teeth_and_knots_with_japanese_forms(self) -> None:
        self.assertEqual(to_vpd_name("齿下"), "歯下")
        self.assertEqual(to_vpd_name("右结1_2"), "右結1_2")
        self.assertEqual(to_vpd_name("右腕"), "右腕")

    def test_reads_them_back_to_the_model_names(self) -> None:
        model = {"齿下", "右结1_2", "あ"}
        self.assertEqual(from_vpd_name("歯下", model), "齿下")
        self.assertEqual(from_vpd_name("右結1_2", model), "右结1_2")
        self.assertEqual(from_vpd_name("あ", model), "あ")
        self.assertEqual(from_vpd_name("歯下", {"歯下"}), "歯下", "a model that uses 歯 keeps it")
        self.assertEqual(from_vpd_name("ない", model), "ない")

    def test_aliases_what_it_can_and_sets_aside_the_rest(self) -> None:
        pose = VpdPose(
            "m.osm",
            (VpdBone("首", (0, 0, 0), (0, 0, 0, 1)), VpdBone("齿上", (0, 0, 0), (0, 0, 0, 1))),
            (VpdMorph("齿下", -0.31), VpdMorph("wink😉", 1.0)),
        )
        kept, skipped = split_unwritable(pose)
        self.assertEqual([b.name for b in kept.bones], ["首", "歯上"])
        self.assertEqual([m.name for m in kept.morphs], ["歯下"])
        self.assertEqual(skipped, ["wink😉"])
        self.assertEqual(parse_vpd(format_vpd(kept)).morphs, (VpdMorph("歯下", -0.31),))


class KeepMorphTest(unittest.TestCase):
    # Only the teeth may go below 0 (the user, 25 Nov 2026): 齿下 −0.32 shows
    # them in the clap smile. Every other morph is saved above 0 only.
    def test_teeth_are_saved_when_negative(self) -> None:
        self.assertTrue(keep_morph("齿下", -0.31))
        self.assertTrue(keep_morph("齿上", -1.0))
        self.assertTrue(keep_morph("齿下", 0.5))
        self.assertFalse(keep_morph("齿下", 0.0))

    def test_the_japanese_teeth_forms_are_signed_too(self) -> None:
        # Review on #262: a model whose keys are already 歯下 (the form the
        # writer emits) would drop a negative teeth value.
        self.assertTrue(keep_morph("歯下", -0.31))
        self.assertTrue(keep_morph("歯上", -0.31))

    def test_other_morphs_are_saved_above_zero_only(self) -> None:
        self.assertTrue(keep_morph("あ", 0.2))
        self.assertFalse(keep_morph("あ", -0.2))
        self.assertFalse(keep_morph("あ", 0.0))

    def test_keeps_a_pose_that_is_all_writable(self) -> None:
        pose = VpdPose("m.osm", (VpdBone("首", (0, 0, 0), (0, 0, 0, 1)),), ())
        self.assertEqual(split_unwritable(pose), (pose, []))


class ArmChainFillTest(unittest.TestCase):
    """A posed arm also saves the bones below it that are still at rest.

    The renderer does not keep those at rest: its relaxed pose curls every
    finger and its hand drift turns 手捩, so straight fingers left out of a
    clap curled through the other hand (#261).
    """

    MODEL = {f"{side}{name}" for side in "左右" for name in (
        "肩", "腕", "腕捩", "ひじ", "手捩", "手首", "親指０", "親指１", "親指２", "人指１", "人指２", "人指３")} | {"首", "頭"}

    def test_a_posed_upper_arm_brings_everything_below_it(self) -> None:
        self.assertEqual(
            arm_chain_fill({"右腕", "首"}, self.MODEL),
            ["右腕捩", "右ひじ", "右手捩", "右手首", "右親指０", "右親指１", "右親指２", "右人指１", "右人指２", "右人指３"],
        )

    def test_bones_above_the_highest_posed_one_stay_out(self) -> None:
        # Saving 右腕 at rest would lift her lowered arm back to the T-pose.
        fill = arm_chain_fill({"右手首"}, self.MODEL)
        self.assertNotIn("右腕", fill)
        self.assertNotIn("右手捩", fill)
        self.assertEqual(fill[0], "右親指０")

    def test_one_posed_finger_brings_the_rest_of_that_hand(self) -> None:
        self.assertEqual(arm_chain_fill({"左人指２"}, self.MODEL),
                         ["左親指０", "左親指１", "左親指２", "左人指１", "左人指３"])

    def test_no_posed_arm_adds_nothing(self) -> None:
        self.assertEqual(arm_chain_fill({"首", "頭"}, self.MODEL), [])

    def test_only_bones_the_model_has_are_added(self) -> None:
        self.assertEqual(arm_chain_fill({"右手首"}, {"右手首", "右人指１"}), ["右人指１"])


class PosesFolderTest(unittest.TestCase):
    """Import Folder and Save as VPD default to the repository's assets/poses/.

    Review on #262: it was only used when the folder already existed, so a
    fresh checkout fell back to the .blend's own folder.
    """

    def setUp(self) -> None:
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_creates_assets_poses_next_to_the_nearest_assets_folder(self) -> None:
        (self.root / "assets" / "private" / "blender").mkdir(parents=True)
        blend = self.root / "assets" / "private" / "blender" / "pose.blend"
        folder = poses_folder(blend)
        self.assertEqual(folder, self.root / "assets" / "poses")
        self.assertTrue(folder.is_dir())

    def test_uses_an_existing_folder_as_is(self) -> None:
        (self.root / "assets" / "poses").mkdir(parents=True)
        (self.root / "assets" / "poses" / "a.vpd").write_bytes(b"x")
        self.assertEqual(poses_folder(self.root / "assets" / "Blender" / "V1.blend"), self.root / "assets" / "poses")
        self.assertTrue((self.root / "assets" / "poses" / "a.vpd").exists())

    def test_without_an_assets_folder_it_is_the_blend_folder(self) -> None:
        blend = self.root / "elsewhere" / "pose.blend"
        blend.parent.mkdir()
        self.assertEqual(poses_folder(blend), blend.parent)
        self.assertFalse((self.root / "assets").exists())

    def test_an_unsaved_file_has_no_folder(self) -> None:
        self.assertIsNone(poses_folder(None))


class MorphPropertyTest(unittest.TestCase):
    def test_round_trips_morph_weights(self) -> None:
        morphs = (VpdMorph("ウィンク右", 1.0), VpdMorph("あ", 0.25))
        self.assertEqual(decode_morphs(encode_morphs(morphs)), {"ウィンク右": 1.0, "あ": 0.25})

    def test_writes_readable_sorted_json(self) -> None:
        text = encode_morphs((VpdMorph("ウィンク右", 1.0), VpdMorph("あ", 0.25)))
        self.assertEqual(text, '{"あ": 0.25, "ウィンク右": 1.0}')

    def test_an_empty_property_means_no_morphs(self) -> None:
        self.assertEqual(decode_morphs(""), {})

    def test_refuses_a_broken_property(self) -> None:
        with self.assertRaisesRegex(VpdError, "morph property is not a JSON object of weights"):
            decode_morphs('["ウィンク右"]')


class HelpersTest(unittest.TestCase):
    def test_lists_bones_and_morphs_the_model_does_not_have(self) -> None:
        pose = parse_vpd(SAMPLE)
        self.assertEqual(
            missing_names(pose, bone_names={"右人指２"}, morph_names=set()),
            (["センター"], ["ウィンク右"]),
        )

    def test_names_a_pose_after_its_file(self) -> None:
        self.assertEqual(pose_name("/poses/wink-v-sign.vpd"), "wink-v-sign")


if __name__ == "__main__":
    unittest.main()
