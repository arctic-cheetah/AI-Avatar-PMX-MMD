"""Animation actions while she speaks (#269).

The shared action catalog (`renderer/actions.json`), inline `[@action]` and
`[@pose:name]` tags in the bridge, the `play_action` agent tool, and the one
pose-name rule shared by uploads and tags. See docs/speech-actions.md.
"""

import asyncio
import json
import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from controller import mcp_server
from controller.actions import (
    MAX_ACTIONS,
    POSE_PREFIX,
    list_poses,
    load_actions,
    pose_name,
    resolve_action,
)
from controller.agent import AgentError, AgentRouter, Stage, validate
from controller.bridge import TagParser, load_catalog, speak_segments, system_prompt
from controller.pose_store import PoseUploadError, save_pose, valid_name
from controller.speech import Segment, Segmenter

CATALOG = load_catalog()
ACTIONS = load_actions()
VPD = "Vocaloid Pose Data file\r\n\r\nm.osm;\r\n0;\r\n\r\n".encode("cp932")
NFD_POSE = unicodedata.normalize("NFD", "ポーズ")  # ホ + a combining U+309A mark


def parse(chunks, catalog=CATALOG):
    parser = TagParser(catalog)
    return [e for c in chunks for e in parser.feed(c)] + parser.finish()


def spoken(events):
    return "".join(e["text"] for e in events if e["type"] == "say")


class CatalogTests(unittest.TestCase):
    def test_every_action_has_a_label_description_layer_and_speech_flag(self):
        self.assertTrue(ACTIONS)
        for name, entry in ACTIONS.items():
            with self.subTest(name=name):
                self.assertRegex(name, r"^[a-z][a-z0-9-]*$")
                self.assertTrue(entry["label"].strip())
                self.assertTrue(entry["description"].strip())
                self.assertIsInstance(entry["speech"], bool)
                self.assertIn(entry.get("layer", "body"), ("body", "tentacle"))

    def test_tentacle_actions_name_their_tentacle_motion(self):
        tentacles = {n: e for n, e in ACTIONS.items() if e.get("layer") == "tentacle"}
        self.assertEqual({e["target"] for e in tentacles.values()}, {"wave", "perk", "droop", "sway"})

    def test_mouth_breath_and_sleepy_actions_are_not_speech_safe(self):
        for name in ("sigh", "stretch-yawn", "nod", "nodding-off", "sneeze", "hiccup",
                     "sniffle", "shiver", "deep-breath", "humming-bob", "contented-smile"):
            with self.subTest(name=name):
                self.assertFalse(ACTIONS[name]["speech"])

    def test_gestures_are_speech_safe(self):
        for name in ("glance", "tilt-left", "tilt-right", "shrug-both", "wink-left",
                     "eyebrow-raise", "shy-look-away", "tentacle-perk"):
            with self.subTest(name=name):
                self.assertTrue(ACTIONS[name]["speech"])

    def test_action_names_never_shadow_a_mood(self):
        self.assertFalse(set(ACTIONS) & set(CATALOG))


class ResolveTests(unittest.TestCase):
    def test_built_in_actions_while_speaking_must_be_speech_safe(self):
        self.assertEqual(resolve_action("tilt-left", ACTIONS), "tilt-left")
        self.assertIsNone(resolve_action("sneeze", ACTIONS))
        self.assertEqual(resolve_action("sneeze", ACTIONS, speaking=False), "sneeze")
        self.assertIsNone(resolve_action("moonwalk", ACTIONS, speaking=False))

    def test_poses_are_namespaced_and_normalised(self):
        self.assertEqual(resolve_action("pose:elated-fist", ACTIONS), "pose:elated-fist")
        self.assertEqual(resolve_action("pose:" + NFD_POSE, ACTIONS), "pose:ポーズ")
        self.assertEqual(resolve_action("pose:glance", ACTIONS), "pose:glance")
        for bad in ("pose:", "pose:../x", "pose:a b", "pose:.hidden", "pose:" + "x" * 65,
                    "pose:a\x1bb", "pose:－", "glance:0.5", "", None, 3):
            with self.subTest(bad=bad):
                self.assertIsNone(resolve_action(bad, ACTIONS, speaking=False))

    def test_pose_name_is_the_upload_rule(self):
        samples = ["wink-v-sign", "Wink_2", "考え中_2", "ウインク", NFD_POSE, "a", "x" * 64,
                   "../x", "a/b", ".hidden", "", "x" * 65, "a.vpd", "a b", "－", "a\nb"]
        for name in samples:
            with self.subTest(name=name):
                normalised = unicodedata.normalize("NFC", name)
                self.assertEqual(pose_name(name) is not None, valid_name(normalised))
                if pose_name(name) is not None:
                    # Every name the upload accepts can be tagged, and the other way round.
                    events = parse([f"Hi [@pose:{name}] there."])
                    self.assertEqual([e["name"] for e in events if e["type"] == "action"],
                                     [POSE_PREFIX + normalised])


class TagTests(unittest.TestCase):
    def test_actions_are_ordered_with_moods_and_never_spoken(self):
        events = parse(["[happy] Hi! [@tilt-left] How are you? [@pose:elated-fist] Yay."])
        self.assertEqual([(e["type"], e.get("name")) for e in events if e["type"] != "say"],
                         [("expression", "happy"), ("action", "tilt-left"),
                          ("action", "pose:elated-fist")])
        self.assertEqual(spoken(events), " Hi!  How are you?  Yay.")
        self.assertNotIn("@", spoken(events))

    def test_every_split_gives_the_same_events(self):
        text = "[happy] Hi! [@tilt-left] How are you? [@pose:ウインク] Yay."
        expected = parse([text])
        for i in range(len(text) + 1):
            with self.subTest(i=i):
                self.assertEqual(self._merged(parse([text[:i], text[i:]])), self._merged(expected))

    @staticmethod
    def _merged(events):
        out = []
        for event in events:
            if event["type"] == "say" and out and out[-1]["type"] == "say":
                out[-1] = {"type": "say", "text": out[-1]["text"] + event["text"]}
            else:
                out.append(dict(event))
        return out

    def test_unknown_idle_only_and_bad_tags_are_dropped(self):
        with self.assertLogs("controller.bridge", "WARNING"):
            events = parse(["A [@moonwalk] B [@sneeze] C [@pose:../x] D [@] E [@pose:] F"])
        self.assertEqual([e for e in events if e["type"] == "action"], [])
        self.assertEqual(spoken(events), "A  B  C  D  E  F")

    def test_actions_per_reply_are_capped(self):
        tags = " ".join(f"[@tilt-left] Line {n}." for n in range(MAX_ACTIONS + 3))
        events = parse([tags])
        self.assertEqual(len([e for e in events if e["type"] == "action"]), MAX_ACTIONS)


class SegmentTests(unittest.TestCase):
    def segments(self, text):
        segmenter = Segmenter()
        out = []
        for event in parse([text]):
            out += segmenter.feed(event)
        return out + segmenter.finish()

    def test_an_action_rides_on_the_next_spoken_segment(self):
        got = self.segments("[happy] Hi! [@tilt-left] How are you? Fine.")
        self.assertEqual([(s.text, s.expression, s.action) for s in got],
                         [("Hi!", "happy", None), ("How are you?", "happy", "tilt-left"),
                          ("Fine.", "happy", None)])

    def test_mid_sentence_action_starts_the_next_fragment(self):
        got = self.segments("I think [@shrug-both] maybe.")
        self.assertEqual([(s.text, s.action) for s in got], [("I think", None), ("maybe.", "shrug-both")])

    def test_second_action_before_the_same_words_and_a_trailing_action_are_dropped(self):
        got = self.segments("[@tilt-left][@wink-left] Hello. Bye. [@glance]")
        self.assertEqual([(s.text, s.action) for s in got], [("Hello.", "tilt-left"), ("Bye.", None)])

    def test_segment_defaults_to_no_action(self):
        self.assertIsNone(Segment("Hi.").action)


class SpeakEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_speak_event_carries_the_action_only_when_set(self):
        sent = []

        async def send(event):
            sent.append(event)

        async def fake_synthesise(segment, worker, run=None):
            return "0" * 16, {}

        queue = asyncio.Queue()
        for segment in (Segment("Hi.", action="tilt-left"), Segment("Bye.")):
            queue.put_nowait(segment)
        queue.put_nowait(None)
        with patch("controller.speech.synthesise", fake_synthesise):
            await speak_segments(queue, send, object(), "run-1")
        self.assertEqual(sent[0]["action"], "tilt-left")
        self.assertNotIn("action", sent[1])


class PromptTests(unittest.TestCase):
    def test_chat_prompt_lists_speech_safe_actions_only_when_asked(self):
        self.assertNotIn("[@", system_prompt(CATALOG))
        prompt = system_prompt(CATALOG, actions=ACTIONS)
        self.assertIn("[@tilt-left]", prompt)
        self.assertNotIn("[@sneeze]", prompt)
        self.assertIn("[@pose:", prompt)


class AgentToolTests(unittest.TestCase):
    def test_play_action_accepts_any_known_action_and_namespaced_poses(self):
        self.assertEqual(validate({"tool": "play_action", "name": "sneeze"}, CATALOG),
                         {"tool": "play_action", "source": "Agent", "name": "sneeze"})
        self.assertEqual(validate({"tool": "play_action", "name": "pose:" + NFD_POSE}, CATALOG)["name"],
                         "pose:ポーズ")

    def test_play_action_rejects_unknown_and_bad_names(self):
        for name in ("moonwalk", "happy", "pose:../x", "pose:", "", None, 3, "x" * 200):
            with self.subTest(name=name), self.assertRaises(AgentError):
                validate({"tool": "play_action", "name": name}, CATALOG)


class FakeSpeech:
    def __init__(self):
        self.segments = []

    async def __call__(self, queue, send, worker, run=None, turn=None):
        while (segment := await queue.get()) is not None:
            self.segments.append(segment)
        return len(self.segments)


class AgentRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent = []
        self.speech = FakeSpeech()
        patcher = patch("controller.agent.speak_segments", self.speech)
        patcher.start()
        self.addCleanup(patcher.stop)

        async def send(event):
            self.sent.append(event)

        self.stage = Stage(send, worker=object(), catalog=CATALOG)
        self.addAsyncCleanup(self.stage.close)
        self.router = AgentRouter(CATALOG)
        self.router.attach(self.stage)

    async def test_play_action_sends_an_agent_action_event(self):
        result = await self.router.handle({"tool": "play_action", "source": "Codex", "name": "shrug-both"})
        self.assertEqual(result, "ok")
        self.assertEqual(self.sent, [{"type": "agent", "kind": "action", "source": "Codex",
                                      "name": "shrug-both"}])

    async def test_play_action_is_rate_limited(self):
        await self.router.handle({"tool": "play_action", "name": "glance"})
        self.assertEqual(await self.router.handle({"tool": "play_action", "name": "glance"}), "busy")

    async def test_say_tags_reach_the_spoken_segments(self):
        await self.router.handle({"tool": "say", "text": "Hi! [@tilt-left] Look at this."})
        for _ in range(20):
            await asyncio.sleep(0)
        self.assertEqual([(s.text, s.action) for s in self.speech.segments],
                         [("Hi!", None), ("Look at this.", "tilt-left")])


class PoseListTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())

    def test_lists_finished_valid_poses_with_their_settings(self):
        save_pose(self.folder, "elated-fist", VPD, False)
        save_pose(self.folder, "ウインク", VPD, False)
        (self.folder / ".upload-abc.vpd").write_bytes(VPD)  # an upload still being written
        (self.folder / "a b.vpd").write_bytes(VPD)
        (self.folder / "notes.txt").write_text("x")
        (self.folder / "elated-fist.json").write_text(json.dumps(
            {"description": "Both fists up, \x1bcheering.", "speech": False, "speechHold": 9}))
        (self.folder / "ウインク.json").write_text("{ not json")
        poses = list_poses(self.folder)
        self.assertEqual([p["name"] for p in poses], sorted(["elated-fist", "ウインク"]))
        fist = next(p for p in poses if p["name"] == "elated-fist")
        self.assertEqual(fist["description"], "Both fists up, cheering.")
        self.assertFalse(fist["speech"])
        self.assertEqual(fist["speechHold"], 4)
        wink = next(p for p in poses if p["name"] == "ウインク")
        self.assertTrue(wink["speech"])
        self.assertEqual(wink["speechHold"], 2)

    def test_missing_folder_lists_nothing(self):
        self.assertEqual(list_poses(self.folder / "missing"), [])


class PoseStoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())

    def test_names_are_saved_in_nfc(self):
        path = save_pose(self.folder, NFD_POSE, VPD, False)
        self.assertEqual(path.name, "ポーズ.vpd")

    def test_a_name_that_differs_only_by_case_is_refused(self):
        save_pose(self.folder, "Wink", VPD, False)
        with self.assertRaises(PoseUploadError) as caught:
            save_pose(self.folder, "wink", VPD, True)
        self.assertEqual(caught.exception.status, 409)
        # The same name, same case, still overwrites.
        save_pose(self.folder, "Wink", VPD, True)

    def test_look_alike_punctuation_is_refused(self):
        for name in ("a－b", "ａ＿b"):
            with self.subTest(name=name):
                self.assertFalse(valid_name(name))


class McpTests(unittest.IsolatedAsyncioTestCase):
    async def test_play_action_tool_lists_actions_and_poses_and_forwards(self):
        folder = Path(tempfile.mkdtemp())
        save_pose(folder, "elated-fist", VPD, False)
        (folder / "elated-fist.json").write_text(json.dumps({"description": "Both fists up."}))
        server = mcp_server.build_server(Path("/tmp/test.sock"), "Codex", poses_dir=folder)
        tools = {t.name: t for t in await server.list_tools()}
        description = tools["play_action"].description
        self.assertIn("shrug-both", description)
        self.assertIn("pose:elated-fist", description)
        self.assertIn("Both fists up.", description)
        self.assertNotIn("enum", json.dumps(tools["play_action"].inputSchema))
        self.assertIn("[@", tools["say"].description)
        forward = AsyncMock(return_value="ok")
        with patch("controller.mcp_server.call_bridge", forward):
            await server.call_tool("play_action", {"name": "pose:elated-fist"})
        self.assertEqual(forward.call_args.args[1],
                         {"tool": "play_action", "source": "Codex", "name": "pose:elated-fist"})

    async def test_instructions_teach_action_tags(self):
        server = mcp_server.build_server(Path("/tmp/test.sock"), "Codex", poses_dir=Path(tempfile.mkdtemp()))
        self.assertIn("[@", server.instructions)
        self.assertIn("tilt-left", server.instructions)
        self.assertNotIn("sneeze", server.instructions)


if __name__ == "__main__":
    unittest.main()
