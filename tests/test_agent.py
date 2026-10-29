"""Agent voice over MCP (#27): validation, the shared speech lane and the agent socket."""

import asyncio
import json
import os
import stat
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from controller.agent import (
    HOOK_QUIET,
    MAX_ANSWER,
    MAX_ASK_TIMEOUT,
    MAX_QUEUED,
    MAX_REPORT,
    MAX_SAY,
    MAX_SOURCE,
    MAX_SUMMARY_SENTENCES,
    AgentError,
    AgentRouter,
    Stage,
    call_bridge,
    default_socket_path,
    prepare_socket_dir,
    redact,
    serve,
    summary_messages,
    validate,
)
from controller.bridge import ORIGIN, handle_connection, load_catalog

CATALOG = load_catalog()


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class FakeSpeech:
    """Stands in for bridge.speak_segments: records segments, optionally holds."""

    def __init__(self):
        self.spoken = []
        self.hold = None
        self.started = asyncio.Event()

    async def __call__(self, queue, send, worker, run=None):
        texts = []
        while (segment := await queue.get()) is not None:
            texts.append((segment.text, segment.expression, segment.weight))
        self.started.set()
        if self.hold is not None:
            await self.hold.wait()
        self.spoken.append(texts)
        for text, expression, weight in texts:
            await send({"type": "speak", "id": "0" * 16, "expression": expression,
                        "weight": weight, "text": text})
        return len(texts)


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


class ValidateTests(unittest.TestCase):
    def test_say_normalised(self):
        request = validate(
            {"tool": "say", "source": "Claude Code", "text": " On it,\x07 checking\n tests. ",
             "mood": "happy", "weight": 0.5},
            CATALOG,
        )
        self.assertEqual(request, {"tool": "say", "source": "Claude Code",
                                   "text": "On it, checking tests.", "mood": "happy",
                                   "weight": 0.5})

    def test_say_defaults_and_clamp(self):
        request = validate({"tool": "say", "text": "Hi", "weight": 7}, CATALOG)
        self.assertEqual((request["source"], request["mood"], request["weight"]),
                         ("Agent", None, 1.0))

    def test_rejects_bad_input(self):
        bad = [
            "not a dict",
            {"tool": "rm -rf"},
            {"tool": "say"},
            {"tool": "say", "text": ""},
            {"tool": "say", "text": " \x00\x1b "},
            {"tool": "say", "text": 42},
            {"tool": "say", "text": "x" * (MAX_SAY + 1)},
            {"tool": "say", "text": "Hi", "mood": "evil-grin"},
            {"tool": "say", "text": "Hi", "mood": "happy", "weight": float("nan")},
            {"tool": "say", "text": "Hi", "mood": "happy", "weight": True},
            {"tool": "say", "text": "Hi", "mood": "happy", "weight": "1"},
            {"tool": "say", "text": "Hi", "source": 3},
            {"tool": "set_mood", "name": "nope"},
            {"tool": "set_mood"},
        ]
        for request in bad:
            with self.subTest(request=request), self.assertRaises(AgentError):
                validate(request, CATALOG)

    def test_source_capped_and_cleaned(self):
        request = validate({"tool": "say", "text": "Hi",
                            "source": "\x1b[31m" + "C" * 100}, CATALOG)
        self.assertLessEqual(len(request["source"]), MAX_SOURCE)
        self.assertNotIn("\x1b", request["source"])
        blank = validate({"tool": "say", "text": "Hi", "source": "\x00"}, CATALOG)
        self.assertEqual(blank["source"], "Agent")

    def test_set_mood(self):
        self.assertEqual(
            validate({"tool": "set_mood", "name": "thinking", "weight": 0.6}, CATALOG),
            {"tool": "set_mood", "source": "Agent", "name": "thinking", "weight": 0.6},
        )


class ReportValidateTests(unittest.TestCase):
    def test_report_keeps_lines_and_defaults_to_done(self):
        request = validate({"tool": "report", "text": "Fixed 3 tests.\n\tAll pass.\x07"}, CATALOG)
        self.assertEqual(request, {"tool": "report", "source": "Agent",
                                   "text": "Fixed 3 tests.\n\tAll pass.", "kind": "done"})

    def test_report_rejects_bad_input(self):
        for request in [
            {"tool": "report", "text": "x" * (MAX_REPORT + 1)},
            {"tool": "report", "text": "ok", "kind": "panic"},
            {"tool": "report", "text": "\n\n"},
            {"tool": "report"},
        ]:
            with self.subTest(request=request), self.assertRaises(AgentError):
                validate(request, CATALOG)


class AskValidateTests(unittest.TestCase):
    def test_ask_defaults_and_bounds(self):
        self.assertEqual(validate({"tool": "ask", "question": "Commit it?"}, CATALOG),
                         {"tool": "ask", "source": "Agent", "text": "Commit it?", "timeout": 120.0})
        for request in [
            {"tool": "ask", "question": "x" * (MAX_SAY + 1)},
            {"tool": "ask", "question": "ok?", "timeout": 0},
            {"tool": "ask", "question": "ok?", "timeout": MAX_ASK_TIMEOUT + 1},
            {"tool": "ask", "question": "ok?", "timeout": True},
            {"tool": "ask"},
        ]:
            with self.subTest(request=request), self.assertRaises(AgentError):
                validate(request, CATALOG)

    def test_hook_flag_only_on_report_and_say(self):
        self.assertTrue(validate({"tool": "report", "text": "x", "hook": True}, CATALOG)["hook"])
        self.assertNotIn("hook", validate({"tool": "report", "text": "x"}, CATALOG))
        with self.assertRaises(AgentError):
            validate({"tool": "report", "text": "x", "hook": "yes"}, CATALOG)


class RedactTests(unittest.TestCase):
    def test_secrets_never_reach_speech(self):
        # Fake tokens are joined at runtime so secret scanners do not flag this file.
        for secret in [
            "sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345",
            "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789",
            "github" + "_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
            "xox" + "b-123456789012-abcdefghijklmnop",
            "AKIA" + "IOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
            "password=hunter2hunter2",
            "Bearer abcdefghijklmnopqrstuvwxyz123456",
        ]:
            with self.subTest(secret=secret[:12]):
                spoken = redact(f"The key is {secret} now.")
                self.assertNotIn(secret, spoken)
                self.assertTrue(spoken.startswith("The key is"))

    def test_code_paths_urls_and_hashes_become_words(self):
        spoken = redact(
            "Edited /home/parrot/Code/x.py and ~/notes.md, see https://example.com/a?b=1 "
            "at commit 1937988, ran `pytest -q`.\n```python\nprint(1)\n```\nDone."
        )
        for leaked in ["/home/parrot", "notes.md", "example.com", "1937988", "pytest", "print"]:
            self.assertNotIn(leaked, spoken)
        self.assertIn("Done.", spoken)

    def test_plain_speech_unchanged(self):
        text = "All 33 tests pass now, and the fix is ready for review."
        self.assertEqual(redact(text), text)


class SummariserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent = []
        self.speech = FakeSpeech()
        patcher = patch("controller.agent.speak_segments", self.speech)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.calls = []

    async def send(self, event):
        self.sent.append(event)

    def stage(self, reply=None, fail=False, reason=False):
        async def llm(messages, on_reasoning=None):
            self.calls.append(messages)
            if reason:
                await on_reasoning()
            if fail:
                raise ValueError("upstream down")
            for chunk in reply:
                yield chunk

        stage = Stage(self.send, worker=object(), catalog=CATALOG,
                      llm=None if reply is None and not fail else llm)
        self.addAsyncCleanup(stage.close)
        return stage

    def report(self, text, kind="done"):
        return {"tool": "report", "source": "Claude Code", "text": text, "kind": kind}

    async def test_summary_is_spoken_with_moods(self):
        stage = self.stage(["[hap", "py] All 33 tests pass now. ", "[relieved] Details are in the chat."],
                           reason=True)
        stage.enqueue(self.report("Ran pytest: 33 passed in 4.1s"))
        await settle()
        self.assertEqual(self.speech.spoken, [[("All 33 tests pass now.", "happy", 1.0),
                                               ("Details are in the chat.", "relieved", 1.0)]])
        self.assertIn({"type": "expression", "name": "thinking", "weight": 0.6}, self.sent)

    async def test_prompt_rules_and_secret_free_input(self):
        stage = self.stage(["[happy] Done."])
        stage.enqueue(self.report("Deployed with key sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345", "error"))
        await settle()
        system, user = self.calls[0]
        self.assertEqual((system["role"], user["role"]), ("system", "user"))
        for rule in ["1", "3", "no code", "the details are in the chat"]:
            self.assertIn(rule, system["content"].lower())
        self.assertIn("[worried]", system["content"])
        self.assertNotIn("sk-proj", user["content"])
        self.assertIn("error", user["content"])
        self.assertEqual(summary_messages(CATALOG, self.report("x"))[0], system)

    async def test_summary_capped_and_redacted(self):
        stage = self.stage([f"Sentence {n} is at /etc/passwd{n}. " for n in range(10)])
        stage.enqueue(self.report("long"))
        await settle()
        spoken = self.speech.spoken[0]
        self.assertLessEqual(len(spoken), MAX_SUMMARY_SENTENCES)
        self.assertFalse(any("/etc" in text for text, _, _ in spoken))

    async def test_llm_failure_falls_back(self):
        stage = self.stage(fail=True)
        stage.enqueue(self.report("boom", "error"))
        await settle()
        self.assertEqual(len(self.speech.spoken), 1)
        self.assertIn("chat", " ".join(text for text, _, _ in self.speech.spoken[0]))
        self.assertEqual(self.speech.spoken[0][0][1], "worried")

    async def test_no_llm_falls_back(self):
        stage = self.stage()
        stage.enqueue(self.report("all good"))
        await settle()
        self.assertEqual(self.speech.spoken[0][0][1], "happy")

    async def test_say_is_redacted_before_tts(self):
        stage = self.stage()
        stage.enqueue({"tool": "say", "source": "Agent", "mood": None, "weight": 1.0,
                       "text": "Token ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789 is set."})
        await settle()
        self.assertNotIn("ghp_", self.speech.spoken[0][0][0])


class SocketPathTests(unittest.TestCase):
    def test_runtime_dir_and_fallback(self):
        self.assertEqual(default_socket_path({"XDG_RUNTIME_DIR": "/run/user/1000"}, 1000),
                         Path("/run/user/1000/yidhari/agent.sock"))
        self.assertEqual(default_socket_path({}, 1000),
                         Path(tempfile.gettempdir()) / "yidhari-1000" / "agent.sock")

    def test_prepare_creates_private_dir(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "yidhari" / "agent.sock"
            prepare_socket_dir(path)
            mode = stat.S_IMODE(path.parent.stat().st_mode)
            self.assertEqual(mode, 0o700)
            prepare_socket_dir(path)  # idempotent

    def test_prepare_rejects_shared_or_symlinked_dir(self):
        with tempfile.TemporaryDirectory() as root:
            shared = Path(root) / "shared"
            shared.mkdir(mode=0o777)
            shared.chmod(0o777)
            with self.assertRaises(AgentError):
                prepare_socket_dir(shared / "agent.sock")
            target = Path(root) / "target"
            target.mkdir(mode=0o700)
            link = Path(root) / "link"
            link.symlink_to(target)
            with self.assertRaises(AgentError):
                prepare_socket_dir(link / "agent.sock")

    def test_prepare_rejects_overlong_path(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(AgentError, "longer"):
                prepare_socket_dir(Path(root) / ("d" * 120) / "agent.sock")

    def test_prepare_removes_stale_socket_only(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "yidhari" / "agent.sock"
            prepare_socket_dir(path)
            path.write_text("not a socket")
            with self.assertRaises(AgentError):
                prepare_socket_dir(path)


class StageTests(unittest.IsolatedAsyncioTestCase):
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

    def say(self, text, mood=None, weight=1.0):
        return {"tool": "say", "source": "Agent", "text": text, "mood": mood,
                "weight": weight}

    async def test_speaks_with_tags_and_mood(self):
        self.stage.enqueue(self.say("Done. [relieved] All tests pass.", "happy", 0.8))
        await settle()
        self.assertEqual(self.speech.spoken, [[("Done.", "happy", 0.8),
                                               ("All tests pass.", "relieved", 1.0)]])

    async def test_waits_behind_chat_reply(self):
        self.stage.chat_started()
        self.stage.enqueue(self.say("Agent line."))
        await settle()
        self.assertEqual(self.speech.spoken, [])
        self.stage.chat_finished()
        await settle()
        self.assertEqual(self.speech.spoken, [[("Agent line.", "neutral", 1.0)]])

    async def test_items_keep_order(self):
        for n in range(3):
            self.stage.enqueue(self.say(f"Line {n}."))
        await settle()
        self.assertEqual([s[0][0] for s in self.speech.spoken],
                         ["Line 0.", "Line 1.", "Line 2."])

    async def test_chat_cancels_agent_speech(self):
        self.speech.hold = asyncio.Event()
        self.stage.enqueue(self.say("First."))
        self.stage.enqueue(self.say("Second."))
        await self.speech.started.wait()
        self.assertEqual(self.stage.pending, 2)
        self.stage.chat_started()
        await settle()
        self.assertEqual(self.stage.pending, 0)
        self.speech.hold.set()
        self.stage.chat_finished()
        await settle()
        self.assertEqual(self.speech.spoken, [])

    async def test_text_only_sends_mood(self):
        sent = []

        async def send(event):
            sent.append(event)

        stage = Stage(send, worker=None, catalog=CATALOG)
        self.addAsyncCleanup(stage.close)
        stage.enqueue(self.say("Hi.", "happy", 0.5))
        await settle()
        self.assertEqual(sent, [{"type": "expression", "name": "happy", "weight": 0.5}])
        self.assertEqual(self.speech.spoken, [])


class RouterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent = []
        self.speech = FakeSpeech()
        patcher = patch("controller.agent.speak_segments", self.speech)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.clock = Clock()
        self.router = AgentRouter(CATALOG, clock=self.clock)

        async def send(event):
            self.sent.append(event)

        self.stage = Stage(send, worker=object(), catalog=CATALOG)
        self.addAsyncCleanup(self.stage.close)

    async def test_no_renderer(self):
        self.assertEqual(await self.router.handle({"tool": "say", "text": "Hi"}),
                         "no renderer")

    async def test_invalid_request_is_a_result_not_a_crash(self):
        self.router.attach(self.stage)
        result = await self.router.handle({"tool": "say", "text": "Hi", "mood": "bogus"})
        self.assertTrue(result.startswith("error:"), result)

    async def test_say_logs_bubble_and_queues(self):
        self.router.attach(self.stage)
        result = await self.router.handle(
            {"tool": "say", "source": "Claude Code", "text": "On it."})
        self.assertEqual(result, "queued")
        self.assertEqual(self.sent[0], {"type": "agent", "kind": "say",
                                        "source": "Claude Code", "text": "On it."})
        await settle()
        self.assertEqual(self.speech.spoken, [[("On it.", "neutral", 1.0)]])

    async def test_latest_renderer_wins(self):
        other = []

        async def send(event):
            other.append(event)

        newer = Stage(send, worker=None, catalog=CATALOG)
        self.addAsyncCleanup(newer.close)
        self.router.attach(self.stage)
        self.router.attach(newer)
        await self.router.handle({"tool": "say", "text": "Hi."})
        self.assertEqual(other[0]["kind"], "say")
        self.router.detach(newer)
        self.clock.now += 5
        await self.router.handle({"tool": "say", "text": "Back."})
        self.assertEqual(self.sent[0]["text"], "Back.")

    async def test_rate_limit(self):
        self.router.attach(self.stage)
        self.assertEqual(await self.router.handle({"tool": "say", "text": "One."}), "queued")
        self.assertEqual(await self.router.handle({"tool": "say", "text": "Two."}), "busy")
        self.clock.now += 1.0
        self.assertEqual(await self.router.handle({"tool": "say", "text": "Three."}), "queued")

    async def test_queue_cap(self):
        self.router.attach(self.stage)
        self.stage.chat_started()
        results = []
        for n in range(MAX_QUEUED + 1):
            self.clock.now += 1.0
            results.append(await self.router.handle({"tool": "say", "text": f"Line {n}."}))
        self.assertEqual(results.count("queued"), MAX_QUEUED)
        self.assertEqual(results[-1], "busy")

    async def test_report_logs_full_text(self):
        self.router.attach(self.stage)
        text = "Fixed `bridge.py`.\nAll 33 tests pass."
        result = await self.router.handle(
            {"tool": "report", "source": "Claude Code", "text": text, "kind": "done"})
        self.assertEqual(result, "queued")
        self.assertEqual(self.sent[0], {"type": "agent", "kind": "report", "source": "Claude Code",
                                        "status": "done", "text": text})

    async def test_set_mood(self):
        self.router.attach(self.stage)
        result = await self.router.handle(
            {"tool": "set_mood", "source": "Claude Code", "name": "thinking", "weight": 0.6})
        self.assertEqual(result, "ok")
        self.assertEqual(self.sent, [{"type": "agent", "kind": "mood",
                                      "source": "Claude Code", "name": "thinking",
                                      "weight": 0.6}])


class AskTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent = []
        self.speech = FakeSpeech()
        patcher = patch("controller.agent.speak_segments", self.speech)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.router = AgentRouter(CATALOG)

        async def send(event):
            self.sent.append(event)

        self.stage = Stage(send, worker=object(), catalog=CATALOG)
        self.addAsyncCleanup(self.stage.close)
        self.router.attach(self.stage)

    async def wait_for_ask(self):
        for _ in range(50):
            asks = [e for e in self.sent if e.get("kind") == "ask"]
            if asks:
                return asks[-1]
            await asyncio.sleep(0)
        self.fail("no ask event")

    async def test_answer_is_the_tool_result(self):
        task = asyncio.create_task(self.router.handle(
            {"tool": "ask", "source": "Claude Code", "question": "Shall I commit the fix?"}))
        event = await self.wait_for_ask()
        self.assertEqual((event["source"], event["text"]), ("Claude Code", "Shall I commit the fix?"))
        await settle()
        self.assertEqual(self.speech.spoken, [[("Shall I commit the fix?", "neutral", 1.0)]])
        self.assertFalse(self.stage.answer("wrong-id", "no"))
        self.assertTrue(self.stage.answer(event["id"], "  Yes\x07 please  "))
        self.assertEqual(await task, "Yes please")

    async def test_timeout_gives_no_answer_and_closes(self):
        result = await self.router.handle({"tool": "ask", "question": "Still there?", "timeout": 0.05})
        self.assertEqual(result, "no answer")
        ask = next(e for e in self.sent if e.get("kind") == "ask")
        self.assertIn({"type": "agent", "kind": "ask-closed", "source": "Agent", "id": ask["id"]},
                      self.sent)

    async def test_one_ask_at_a_time(self):
        first = asyncio.create_task(self.router.handle({"tool": "ask", "question": "One?"}))
        event = await self.wait_for_ask()
        self.assertEqual(await self.router.handle({"tool": "ask", "question": "Two?"}), "busy")
        self.stage.answer(event["id"], "yes")
        self.assertEqual(await first, "yes")

    async def test_answer_capped(self):
        task = asyncio.create_task(self.router.handle({"tool": "ask", "question": "Long?"}))
        event = await self.wait_for_ask()
        self.stage.answer(event["id"], "y" * (MAX_ANSWER + 50))
        self.assertEqual(len(await task), MAX_ANSWER)

    async def test_new_chat_and_close_end_the_ask(self):
        task = asyncio.create_task(self.router.handle({"tool": "ask", "question": "Ready?"}))
        await self.wait_for_ask()
        self.stage.close_asks()
        self.assertEqual(await task, "no answer")

    async def test_hook_report_skipped_after_a_recent_report(self):
        clock = Clock()
        router = AgentRouter(CATALOG, clock=clock)
        router.attach(self.stage)
        self.assertEqual(await router.handle({"tool": "report", "text": "Done.", "hook": True}),
                         "queued")
        clock.now += 2
        self.assertEqual(await router.handle({"tool": "report", "text": "Done."}), "queued")
        clock.now += 2
        self.assertEqual(await router.handle({"tool": "report", "text": "Done.", "hook": True}),
                         "skipped")
        clock.now += HOOK_QUIET
        self.assertEqual(await router.handle({"tool": "report", "text": "Done.", "hook": True}),
                         "queued")


class AgentNotifyTests(unittest.IsolatedAsyncioTestCase):
    def test_last_assistant_text_from_transcript(self):
        from controller.agent_notify import last_assistant_text

        lines = [
            json.dumps({"type": "user", "message": {"role": "user", "content": "fix it"}}),
            json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "Looking."}, {"type": "tool_use", "name": "Bash"}]}}),
            "not json",
            json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "All 33 tests pass."},
                {"type": "text", "text": "Ready to commit."}]}}),
            json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "name": "Read"}]}}),
        ]
        self.assertEqual(last_assistant_text(lines), "All 33 tests pass.\nReady to commit.")
        self.assertIsNone(last_assistant_text(["garbage", "{}"]))

    async def test_stop_and_notification_requests(self):
        from controller.agent_notify import build_request

        with tempfile.TemporaryDirectory() as root:
            transcript = Path(root) / "t.jsonl"
            transcript.write_text(json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": [{"type": "text", "text": "Done!"}]}}) + "\n")
            self.assertEqual(
                build_request("stop", {"transcript_path": str(transcript)}, "Claude Code"),
                {"tool": "report", "source": "Claude Code", "text": "Done!", "kind": "done",
                 "hook": True})
        self.assertEqual(
            build_request("stop", {"last_assistant_message": "Finished."}, "Claude Code")["text"],
            "Finished.")
        self.assertIsNone(build_request("stop", {"stop_hook_active": True,
                                                 "last_assistant_message": "x"}, "A"))
        self.assertIsNone(build_request("stop", {"transcript_path": "/nonexistent"}, "A"))
        self.assertEqual(
            build_request("notification", {"message": "Claude needs your permission to use Bash"},
                          "Claude Code"),
            {"tool": "say", "source": "Claude Code", "mood": "worried", "hook": True,
             "text": "Claude needs your permission to use Bash"})

    async def test_main_never_fails(self):
        import io
        from controller import agent_notify

        calls = []

        async def fake_call(path, request, timeout=None):
            calls.append(request)
            return "queued"

        with patch("controller.agent_notify.call_bridge", fake_call):
            for stdin in ["not json", "[]", json.dumps({"last_assistant_message": "Done."})]:
                with patch("sys.stdin", io.StringIO(stdin)):
                    self.assertEqual(await agent_notify.run(["stop", "--name", "Claude Code"]), 0)
        self.assertEqual([c["text"] for c in calls], ["Done."])


class SocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_round_trip_and_bad_lines(self):
        router = AgentRouter(CATALOG)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "yidhari" / "agent.sock"
            server = await serve(path, router)
            try:
                self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)
                self.assertEqual(await call_bridge(path, {"tool": "say", "text": "Hi"}),
                                 "no renderer")
                reader, writer = await asyncio.open_unix_connection(path)
                writer.write(b"{broken json\n")
                await writer.drain()
                reply = json.loads(await reader.readline())
                self.assertTrue(reply["result"].startswith("error:"))
                writer.close()
                await writer.wait_closed()
            finally:
                server.close()
                await server.wait_closed()

    async def test_bridge_not_running(self):
        with tempfile.TemporaryDirectory() as root:
            missing = Path(root) / "agent.sock"
            self.assertEqual(await call_bridge(missing, {"tool": "say", "text": "Hi"}),
                             "bridge not running")
            overlong = Path(root) / ("d" * 120) / "agent.sock"
            result = await call_bridge(overlong, {"tool": "say", "text": "Hi"})
            self.assertTrue(result.startswith("error:"), result)


class BridgeIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_renderer_connection_receives_agent_speech(self):
        from websockets.asyncio.client import connect
        from websockets.asyncio.server import serve as ws_serve

        router = AgentRouter(CATALOG)
        args = Namespace(mode="demo", agent_router=router)

        async def handler(ws):
            await handle_connection(ws, args, CATALOG)

        async with ws_serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            async with connect(url, origin=ORIGIN) as ws:
                for _ in range(50):
                    if router.stages:
                        break
                    await asyncio.sleep(0.01)
                result = await router.handle(
                    {"tool": "say", "source": "Claude Code", "text": "Hello.", "mood": "happy"})
                self.assertEqual(result, "queued")
                events = [json.loads(await asyncio.wait_for(ws.recv(), 3)) for _ in range(2)]
                self.assertEqual(events[0]["type"], "agent")
                self.assertEqual(events[1], {"type": "expression", "name": "happy", "weight": 1.0})
            for _ in range(50):
                if not router.stages:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(router.stages, [])

    async def test_answer_frame_resolves_the_ask(self):
        from websockets.asyncio.client import connect
        from websockets.asyncio.server import serve as ws_serve

        router = AgentRouter(CATALOG)
        args = Namespace(mode="demo", agent_router=router)

        async def handler(ws):
            await handle_connection(ws, args, CATALOG)

        async with ws_serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            async with connect(url, origin=ORIGIN) as ws:
                for _ in range(50):
                    if router.stages:
                        break
                    await asyncio.sleep(0.01)
                task = asyncio.create_task(router.handle({"tool": "ask", "question": "Commit?"}))
                event = json.loads(await asyncio.wait_for(ws.recv(), 3))
                self.assertEqual(event["kind"], "ask")
                await ws.send(json.dumps({"type": "answer", "id": "bogus", "text": "no"}))
                await ws.send(json.dumps({"type": "answer", "id": event["id"], "text": 7}))
                await ws.send(json.dumps({"type": "answer", "id": event["id"], "text": "Yes please"}))
                self.assertEqual(await asyncio.wait_for(task, 3), "Yes please")


class McpServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_forward_to_bridge(self):
        try:
            import mcp  # noqa: F401
        except ImportError:
            self.skipTest("mcp is not installed")
        from controller import mcp_server

        calls = []

        async def fake_call(path, request, timeout=None):
            calls.append((path, request))
            return "queued"

        server = mcp_server.build_server(Path("/tmp/x.sock"), "Claude Code")
        tools = {tool.name for tool in await server.list_tools()}
        self.assertEqual(tools, {"say", "report", "ask", "set_mood"})
        with patch("controller.mcp_server.call_bridge", fake_call):
            await server.call_tool("say", {"text": "Hi", "mood": "happy"})
            await server.call_tool("set_mood", {"name": "thinking"})
            await server.call_tool("report", {"text": "All done.", "kind": "done"})
            await server.call_tool("ask", {"question": "Commit?", "timeout": 30})
        self.assertEqual(calls[0], (Path("/tmp/x.sock"),
                                    {"tool": "say", "source": "Claude Code", "text": "Hi",
                                     "mood": "happy", "weight": 1.0}))
        self.assertEqual(calls[1][1], {"tool": "set_mood", "source": "Claude Code",
                                       "name": "thinking", "weight": 1.0})
        self.assertEqual(calls[2][1], {"tool": "report", "source": "Claude Code",
                                       "text": "All done.", "kind": "done"})
        self.assertEqual(calls[3][1], {"tool": "ask", "source": "Claude Code",
                                       "question": "Commit?", "timeout": 30.0})


if __name__ == "__main__":
    unittest.main()
