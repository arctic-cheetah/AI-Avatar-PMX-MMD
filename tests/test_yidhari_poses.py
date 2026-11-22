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
    missing_names, parse_vpd, pose_name,
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
