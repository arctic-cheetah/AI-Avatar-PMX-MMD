"""Pure helpers of the Goo shader bake (#250).

The Blender side (`tools/goo-bake/bake.py`) needs bpy. Everything that decides
the bytes on disk lives in `bake_lib.py`, so it can be tested without Blender.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "goo-bake"))

from bake_lib import build_manifest, dump_json, pack_col  # noqa: E402


class PackColTest(unittest.TestCase):
    def test_writes_rgba8_per_vertex_in_order(self) -> None:
        data = pack_col([(1.0, 0.0, 0.5, 1.0), (0.0, 1.0, 0.25, 0.0)], vertex_count=2)
        self.assertEqual(data, bytes([255, 0, 128, 255, 0, 255, 64, 0]))

    def test_clamps_out_of_range_values(self) -> None:
        self.assertEqual(pack_col([(-0.2, 1.4, 0.0, 1.0)], vertex_count=1), bytes([0, 255, 0, 255]))

    def test_refuses_a_count_that_does_not_match_the_pmx(self) -> None:
        with self.assertRaisesRegex(ValueError, "2 colours for 3 vertices"):
            pack_col([(0, 0, 0, 1), (0, 0, 0, 1)], vertex_count=3)

    def test_refuses_a_missing_vertex_colour(self) -> None:
        with self.assertRaisesRegex(ValueError, "vertex 1 has no colour"):
            pack_col([(0, 0, 0, 1), None], vertex_count=2)


class ManifestTest(unittest.TestCase):
    def test_records_what_the_renderer_checks(self) -> None:
        manifest = build_manifest(
            source="Yidhari_V1.3_PMX.blend",
            source_sha256="ab" * 32,
            blender="4.4.3 Goo Engine",
            vertex_count=3,
            materials=["颜", "髮"],
            files={"col.bin": "cd" * 32},
        )
        self.assertEqual(manifest, {
            "version": 1,
            "source": {"file": "Yidhari_V1.3_PMX.blend", "sha256": "ab" * 32},
            "blender": "4.4.3 Goo Engine",
            "pmx": {"vertexCount": 3, "materials": ["颜", "髮"]},
            "files": {"col.bin": "cd" * 32},
        })

    def test_dump_json_is_stable_and_keeps_japanese_names(self) -> None:
        text = dump_json({"b": 1, "a": "颜"})
        self.assertEqual(text, '{\n  "a": "颜",\n  "b": 1\n}\n')
        self.assertEqual(dump_json(json.loads(text)), text)


if __name__ == "__main__":
    unittest.main()
