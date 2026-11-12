"""#152: spoken turns kept on disk so any chat bubble can be replayed."""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from controller import replay_store
from controller.replay_store import (
    DEFAULT_CAP_MB,
    MANIFEST,
    delete_turns,
    open_turn,
    prune_turns,
    record_clip,
    turn_dir,
)

A, B, C = "a" * 16, "b" * 16, "c" * 16


def clip(n, expression="happy"):
    return {"id": f"{n:016x}", "expression": expression, "weight": 1.0, "text": f"Line {n}."}


class TurnStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "turns"
        self.addCleanup(self.tmp.cleanup)

    def make_turn(self, turn, size, age):
        """A turn folder holding ``size`` bytes of audio, last written ``age`` seconds ago."""
        directory = open_turn(turn, cap_bytes=10**12, root=self.root)
        (directory / "0000000000000001.wav").write_bytes(b"\0" * size)
        stamp = 1_000_000 - age
        for path in (*directory.iterdir(), directory):
            os.utime(path, (stamp, stamp))
        return directory

    def manifest(self, turn):
        return json.loads((self.root / turn / MANIFEST).read_text(encoding="utf-8"))

    def test_default_cap_is_500_mb(self):
        self.assertEqual(DEFAULT_CAP_MB, 500)

    def test_open_turn_starts_an_empty_manifest(self):
        directory = open_turn(A, cap_bytes=10**9, root=self.root)
        self.assertEqual(directory, self.root / A)
        self.assertEqual(self.manifest(A), {"version": 1, "clips": []})

    def test_clips_are_recorded_in_order(self):
        directory = open_turn(A, cap_bytes=10**9, root=self.root)
        record_clip(directory, clip(1, "happy"))
        record_clip(directory, clip(2, "thinking"))
        self.assertEqual(self.manifest(A)["clips"], [clip(1, "happy"), clip(2, "thinking")])
        self.assertEqual(sorted(p.name for p in directory.iterdir()), [MANIFEST],
                         "the manifest is written in place, with no temp file left over")

    def test_turn_ids_are_checked(self):
        for bad in ("../" + "a" * 13, "A" * 16, "a" * 15, "a" * 17, "", "aaaa/aaaaaaaaaaa"):
            with self.subTest(turn=bad), self.assertRaises(ValueError):
                turn_dir(bad, root=self.root)
        self.assertEqual(turn_dir(A, root=self.root), self.root / A)

    def test_over_the_cap_the_oldest_whole_turns_go_first(self):
        self.make_turn(A, 400, age=30)
        self.make_turn(B, 400, age=20)
        self.make_turn(C, 400, age=10)
        deleted = prune_turns(self.root, cap_bytes=1000)
        self.assertEqual(deleted, [A])
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [B, C])

    def test_under_the_cap_nothing_is_deleted(self):
        self.make_turn(A, 400, age=30)
        self.assertEqual(prune_turns(self.root, cap_bytes=10_000), [])
        self.assertTrue((self.root / A).is_dir())

    def test_the_turn_being_written_is_never_pruned(self):
        self.make_turn(A, 400, age=30)
        self.make_turn(B, 400, age=20)
        self.assertEqual(prune_turns(self.root, cap_bytes=0, keep={A}), [B])
        self.assertTrue((self.root / A).is_dir())

    def test_opening_a_turn_prunes_older_turns(self):
        self.make_turn(A, 600, age=30)
        self.make_turn(B, 600, age=20)
        open_turn(C, cap_bytes=1000, root=self.root)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [B, C])

    def test_only_turn_folders_are_touched(self):
        self.make_turn(A, 400, age=30)
        (self.root / "notes").mkdir()
        (self.root / "notes" / "keep.txt").write_text("mine")
        (self.root / "loose.wav").write_bytes(b"\0" * 5000)
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "precious.wav").write_bytes(b"\0" * 5000)
        (self.root / B).symlink_to(outside, target_is_directory=True)
        prune_turns(self.root, cap_bytes=0)
        self.assertFalse((self.root / A).exists())
        self.assertTrue((self.root / "notes" / "keep.txt").exists())
        self.assertTrue((self.root / "loose.wav").exists())
        self.assertTrue((outside / "precious.wav").exists(), "a symlink is never followed")

    def test_a_missing_folder_is_not_an_error(self):
        self.assertEqual(prune_turns(self.root / "nope", cap_bytes=0), [])
        self.assertEqual(delete_turns([A], root=self.root / "nope"), [])

    def test_new_chat_deletes_only_valid_listed_turns(self):
        self.make_turn(A, 10, age=30)
        self.make_turn(B, 10, age=20)
        deleted = delete_turns([A, "../outside", "Z" * 16, C], root=self.root)
        self.assertEqual(deleted, [A])
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), [B])


class SpeakTurnTests(unittest.IsolatedAsyncioTestCase):
    async def test_clips_go_into_the_turn_folder_and_name_their_turn(self):
        from controller.bridge import speak_segments
        from controller.speech import Segment

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name) / "turns"
        folders = []

        async def fake_synthesise(segment, worker, run=None, directory=None):
            folders.append(directory)
            return f"{len(folders):016x}", {}

        queue = asyncio.Queue()
        for text, mood in (("Hello there.", "happy"), ("Hmm, let me see.", "thinking")):
            queue.put_nowait(Segment(text, mood, 0.8))
        queue.put_nowait(None)
        sent = []

        async def send(event):
            sent.append(event)

        worker = SimpleNamespace(settings=SimpleNamespace(replay_cap_mb=500))
        with patch("controller.speech.synthesise", fake_synthesise), patch.object(
            replay_store, "TURNS_DIR", root
        ):
            await speak_segments(queue, send, worker, "run", turn=A)
        self.assertEqual(folders, [root / A, root / A])
        self.assertEqual(
            [(e["id"], e["turn"], e["expression"]) for e in sent],
            [("0000000000000001", A, "happy"), ("0000000000000002", A, "thinking")],
        )
        manifest = json.loads((root / A / MANIFEST).read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["clips"],
            [
                {"id": "0000000000000001", "expression": "happy", "weight": 0.8, "text": "Hello there."},
                {"id": "0000000000000002", "expression": "thinking", "weight": 0.8, "text": "Hmm, let me see."},
            ],
        )


class ReplayCapSettingTests(unittest.TestCase):
    def test_flag_reaches_settings_and_is_checked(self):
        from controller.bridge import build_parser, speech_settings
        from controller.speech import ApplioSettings

        self.assertEqual(speech_settings(build_parser().parse_args(["--speech"])).replay_cap_mb, 500)
        args = build_parser().parse_args(["--speech", "--replay-cap-mb", "64"])
        self.assertEqual(speech_settings(args).replay_cap_mb, 64)
        with self.assertRaises(ValueError):
            ApplioSettings(applio_dir=Path("/nonexistent"), replay_cap_mb=-1).check()


if __name__ == "__main__":
    unittest.main()
