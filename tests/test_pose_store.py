"""Uploading Blender poses (VPD) from the renderer page (#49).

`controller/pose_store.py` checks and saves an upload; `renderer/serve.py`
accepts it on POST /poses/<name>. Poses are private (the model is), so they
are saved only under the server's poses folder, and only from the renderer
page itself.
"""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request

from controller.pose_store import MAX_POSE_BYTES, PoseUploadError, check_pose_upload, save_pose

ROOT = Path(__file__).resolve().parents[1]
SERVE = ROOT / "renderer" / "serve.py"
URL = re.compile(r"Yidhari renderer: (http://127\.0\.0\.1:(\d+))/renderer/")
ORIGIN = "http://127.0.0.1:8770"
VPD = "Vocaloid Pose Data file\r\n\r\nm.osm;\r\n0;\r\n\r\n".encode("cp932")


def headers(**extra: str) -> dict[str, str]:
    return {"Origin": ORIGIN, "Content-Type": "application/octet-stream", "Content-Length": str(len(VPD)), **extra}


class CheckTest(unittest.TestCase):
    def test_accepts_a_vpd_from_the_renderer_page(self) -> None:
        self.assertEqual(check_pose_upload(headers(), ORIGIN, "wink-v-sign"), len(VPD))

    def test_accepts_japanese_names(self) -> None:
        self.assertEqual(check_pose_upload(headers(), ORIGIN, "考え中_2"), len(VPD))

    def test_refuses_other_pages(self) -> None:
        with self.assertRaises(PoseUploadError) as caught:
            check_pose_upload(headers(Origin="http://evil.example"), ORIGIN, "p")
        self.assertEqual(caught.exception.status, 403)

    def test_refuses_names_that_could_leave_the_folder(self) -> None:
        for name in ("../x", "a/b", "a\\b", ".hidden", "", "x" * 65, "a.vpd", "a b"):
            with self.subTest(name=name), self.assertRaises(PoseUploadError) as caught:
                check_pose_upload(headers(), ORIGIN, name)
            self.assertEqual(caught.exception.status, 400)

    def test_refuses_other_content_types_and_sizes(self) -> None:
        cases = [
            (headers(**{"Content-Type": "text/html"}), 415),
            (headers(**{"Content-Length": "0"}), 400),
            (headers(**{"Content-Length": str(MAX_POSE_BYTES + 1)}), 413),
            ({k: v for k, v in headers().items() if k != "Content-Length"}, 411),
        ]
        for given, status in cases:
            with self.subTest(status=status), self.assertRaises(PoseUploadError) as caught:
                check_pose_upload(given, ORIGIN, "p")
            self.assertEqual(caught.exception.status, status)


class SaveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "poses"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_saves_into_the_folder_by_name(self) -> None:
        path = save_pose(self.dir, "wink-v-sign", VPD, overwrite=False)
        self.assertEqual(path, self.dir / "wink-v-sign.vpd")
        self.assertEqual(path.read_bytes(), VPD)

    def test_refuses_what_is_not_a_vpd(self) -> None:
        with self.assertRaises(PoseUploadError) as caught:
            save_pose(self.dir, "p", b"<html>", overwrite=False)
        self.assertEqual(caught.exception.status, 422)
        self.assertFalse((self.dir / "p.vpd").exists())

    def test_asks_before_replacing_a_pose(self) -> None:
        save_pose(self.dir, "p", VPD, overwrite=False)
        newer = VPD + b"\r\n"
        with self.assertRaises(PoseUploadError) as caught:
            save_pose(self.dir, "p", newer, overwrite=False)
        self.assertEqual(caught.exception.status, 409)
        save_pose(self.dir, "p", newer, overwrite=True)
        self.assertEqual((self.dir / "p.vpd").read_bytes(), newer)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["p.vpd"], "no temporary files left")


class ServeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        process = subprocess.Popen(
            [sys.executable, "-u", str(SERVE), "--port", "0", "--no-bridge", "--poses-dir", str(self.dir)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(process.wait, 5)
        self.addCleanup(process.kill)
        for line in process.stdout:
            match = URL.search(line)
            if match:
                self.addCleanup(process.stdout.close)
                self.origin = match.group(1)
                return
        self.fail("serve.py printed no ready URL")

    def post(self, name: str, body: bytes, origin: str | None = None, query: str = "") -> tuple[int, str]:
        request = urllib.request.Request(
            f"{self.origin}/poses/{urllib.parse.quote(name)}{query}", data=body, method="POST",
            headers={"Origin": origin or self.origin, "Content-Type": "application/octet-stream"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def test_uploads_a_pose_and_asks_before_replacing_it(self) -> None:
        self.assertEqual(self.post("考え中", VPD)[0], 201)
        self.assertEqual((self.dir / "考え中.vpd").read_bytes(), VPD)
        self.assertEqual(self.post("考え中", VPD)[0], 409)
        self.assertEqual(self.post("考え中", VPD, query="?overwrite=1")[0], 201)

    def test_refuses_another_page_and_path_tricks(self) -> None:
        self.assertEqual(self.post("p", VPD, origin="http://evil.example")[0], 403)
        self.assertEqual(self.post("..%2Fescape", VPD)[0], 400)
        self.assertEqual(list(self.dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
