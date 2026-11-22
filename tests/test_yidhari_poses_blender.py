"""Run the Yidhari Poses round trip inside Blender (#261).

The checks themselves are in `tests/blender/yidhari_poses_case.py` and use a
synthetic rig, so no private model is needed. They need a Blender 4.4 with MMD
Tools installed. Set `YIDHARI_BLENDER` to its binary; otherwise the stock
4.4.3 tarball from `docs/blender-poses.md` or `blender` on the PATH is used.
The test is skipped when none is found.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
CASE = ROOT / "tests" / "blender" / "yidhari_poses_case.py"


def find_blender() -> str | None:
    for candidate in (
        os.environ.get("YIDHARI_BLENDER"),
        str(Path.home() / "Applications" / "blender-4.4.3-linux-x64" / "blender"),
        shutil.which("blender"),
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


BLENDER = find_blender()


@unittest.skipUnless(BLENDER, "needs Blender 4.4 with MMD Tools (set YIDHARI_BLENDER)")
class BlenderRoundTripTest(unittest.TestCase):
    def test_import_apply_reset_and_save_inside_blender(self) -> None:
        run = subprocess.run(
            [BLENDER, "-b", "--factory-startup", "--python-exit-code", "1",
             "--addons", "bl_ext.blender_org.mmd_tools", "--python", str(CASE)],
            capture_output=True, text=True, timeout=300, cwd=ROOT,
        )
        output = run.stdout + run.stderr
        self.assertNotIn("No module named 'bl_ext", output, "MMD Tools is not installed for this Blender")
        self.assertEqual(run.returncode, 0, output[-4000:])
        self.assertRegex(output, r"Ran \d+ tests")


if __name__ == "__main__":
    unittest.main()
