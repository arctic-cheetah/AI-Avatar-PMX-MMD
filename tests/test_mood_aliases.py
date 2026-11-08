"""Renamed moods keep working through catalog aliases (#99)."""
import json
import tempfile
import unittest
from pathlib import Path

from controller.agent import AgentError, validate
from controller.bridge import TagParser, load_catalog, resolve_mood, system_prompt
from controller.prosody import MOOD_GROUPS
from controller.speech import SKEPTICAL_MOODS

CATALOG = load_catalog()
RENAMES = {
    "sad-v2": "sorrowful",
    "sad-sceptical": "rueful",
    "wtf-dude": "exasperated",
    "super-angry": "furious",
}


def write_catalog(entries):
    catalog = {"neutral": {"description": "Rest.", "morphs": {}}, **entries}
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    with handle:
        json.dump(catalog, handle)
    return Path(handle.name)


class RenamedMoodTests(unittest.TestCase):
    def test_new_names_are_canonical_and_old_names_are_aliases(self):
        for old, new in RENAMES.items():
            with self.subTest(old=old):
                self.assertIn(new, CATALOG)
                self.assertNotIn(old, CATALOG)
                self.assertIn(old, CATALOG[new]["aliases"])

    def test_resolve_mood(self):
        for old, new in RENAMES.items():
            self.assertEqual(resolve_mood(CATALOG, old), new)
            self.assertEqual(resolve_mood(CATALOG, new), new)
        self.assertEqual(resolve_mood(CATALOG, "happy"), "happy")
        for unknown in ("evil", "", "Sorrowful", "__class__", None, 3):
            with self.subTest(unknown=unknown):
                self.assertIsNone(resolve_mood(CATALOG, unknown))

    def test_old_inline_tags_become_new_moods(self):
        parser = TagParser(CATALOG)
        events = parser.feed("[sad-v2:0.5]Oh no. [super-angry]Stop! [evil]Hm.") + parser.finish()
        self.assertEqual(
            [(e["name"], e["weight"]) for e in events if e["type"] == "expression"],
            [("sorrowful", 0.5), ("furious", 1.0)],
        )
        self.assertEqual("".join(e["text"] for e in events if e["type"] == "say"),
                         "Oh no. Stop! Hm.")

    def test_agent_tools_accept_old_names(self):
        self.assertEqual(
            validate({"tool": "set_mood", "name": "wtf-dude"}, CATALOG)["name"], "exasperated")
        self.assertEqual(
            validate({"tool": "say", "text": "Hm.", "mood": "sad-sceptical"}, CATALOG)["mood"],
            "rueful")
        with self.assertRaises(AgentError):
            validate({"tool": "set_mood", "name": "evil"}, CATALOG)

    def test_prompts_teach_only_new_names(self):
        prompt = system_prompt(CATALOG)
        for old, new in RENAMES.items():
            self.assertIn(f"[{new}]", prompt)
            self.assertNotIn(f"[{old}]", prompt)

    def test_mood_tables_use_canonical_names(self):
        self.assertLessEqual(set(MOOD_GROUPS), set(CATALOG))
        self.assertLessEqual(set(SKEPTICAL_MOODS), set(CATALOG))
        self.assertIn("sorrowful", MOOD_GROUPS)
        self.assertIn("rueful", SKEPTICAL_MOODS)


class AliasValidationTests(unittest.TestCase):
    def assertRejected(self, entries):
        path = write_catalog(entries)
        self.addCleanup(path.unlink)
        with self.assertRaises(ValueError):
            load_catalog(path)

    def test_accepts_valid_aliases(self):
        path = write_catalog({"glad": {"description": "Glad.", "morphs": {}, "aliases": ["glad-v2"]}})
        self.addCleanup(path.unlink)
        self.assertEqual(resolve_mood(load_catalog(path), "glad-v2"), "glad")

    def test_rejects_bad_aliases(self):
        glad = {"description": "Glad.", "morphs": {}}
        for aliases in ("glad-v2", ["Glad"], ["glad two"], [""], [3], ["glad"], ["neutral"]):
            with self.subTest(aliases=aliases):
                self.assertRejected({"glad": {**glad, "aliases": aliases}})
        self.assertRejected({
            "glad": {**glad, "aliases": ["cheery"]},
            "happy": {**glad, "aliases": ["cheery"]},
        })


if __name__ == "__main__":
    unittest.main()
