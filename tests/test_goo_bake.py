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

from bake_lib import (  # noqa: E402
    build_manifest, dump_json, hash_files, pack_col, pmx_position, sample_indices,
)


class PackColTest(unittest.TestCase):
    def test_writes_rgba8_per_vertex_in_order(self) -> None:
        data = pack_col([(1.0, 0.0, 0.5, 1.0), (0.0, 1.0, 0.25, 0.0)], vertex_count=2)
        self.assertEqual(data, bytes([255, 0, 128, 255, 0, 255, 64, 0]))

    def test_clamps_out_of_range_values(self) -> None:
        self.assertEqual(pack_col([(-0.2, 1.4, 0.0, 1.0)], vertex_count=1), bytes([0, 255, 0, 255]))

    def test_refuses_a_count_that_does_not_match_the_pmx(self) -> None:
        with self.assertRaisesRegex(ValueError, "2 colours for 3 vertices"):
            pack_col([(0, 0, 0, 1), (0, 0, 0, 1)], vertex_count=3)

    def test_refuses_a_colour_without_four_channels(self) -> None:
        with self.assertRaisesRegex(ValueError, "vertex 0 has 3 channels"):
            pack_col([(0, 0, 0)], vertex_count=1)

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
            samples=[{"index": 0, "position": [1.0, 2.0, 3.0]}],
        )
        self.assertEqual(manifest, {
            "version": 1,
            "source": {"file": "Yidhari_V1.3_PMX.blend", "sha256": "ab" * 32},
            "blender": "4.4.3 Goo Engine",
            "colSpace": "sRGB",
            "pmx": {"vertexCount": 3, "materials": ["颜", "髮"],
                    "samples": [{"index": 0, "position": [1.0, 2.0, 3.0]}]},
            "files": {"col.bin": "cd" * 32},
        })

    def test_dump_json_is_stable_and_keeps_japanese_names(self) -> None:
        text = dump_json({"b": 1, "a": "颜"})
        self.assertEqual(text, '{\n  "a": "颜",\n  "b": 1\n}\n')
        self.assertEqual(dump_json(json.loads(text)), text)


class FingerprintTest(unittest.TestCase):
    def test_sample_indices_are_spread_and_stable(self) -> None:
        self.assertEqual(sample_indices(10, 4), [0, 3, 6, 9])
        self.assertEqual(sample_indices(3, 8), [0, 1, 2])

    def test_pmx_position_undoes_the_mmd_tools_import(self) -> None:
        # MMD Tools: Blender = (x, -z, y) * 0.08 of the PMX position three.js parses.
        self.assertEqual(pmx_position((0.08, -0.16, 0.24)), [1.0, 3.0, 2.0])


class HashFilesTest(unittest.TestCase):
    def test_hashes_only_the_files_given_relative_to_the_root(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "textures").mkdir()
            (root / "textures" / "a.png").write_bytes(b"a")
            (root / "stale.png").write_bytes(b"old")
            files = hash_files([root / "textures" / "a.png"], root)
        self.assertEqual(list(files), ["textures/a.png"])
        self.assertEqual(files["textures/a.png"],
                         "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb")


if __name__ == "__main__":
    unittest.main()
