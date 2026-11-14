"""#56: host-authored narration and a bridge with no chat/summarisation LLM."""

import asyncio
import json
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from controller import bridge, mcp_server
from controller.agent import (
    AgentError, AgentRouter, MAX_SUMMARY_CHARS, Stage, validate,
)
from tests.test_agent import CATALOG, Clock, FakeSpeech, settle


class NarrationValidationTests(unittest.TestCase):
    def test_narration_is_cleaned_without_changing_written_report(self):
        call = validate({"tool": "report", "text": "# Result\n\nAll done.",
                         "spoken_text": " [happy] Done.\x07\n [relieved] All checked. "}, CATALOG)
        self.assertEqual(call["text"], "# Result\n\nAll done.")
        self.assertEqual(call["spoken_text"], "[happy] Done. [relieved] All checked.")

    def test_invalid_narration_is_rejected(self):
        for value in [42, False, [], "", " \x00\n", "x" * (MAX_SUMMARY_CHARS + 1)]:
            with self.subTest(value=str(value)[:30]), self.assertRaises(AgentError):
                validate({"tool": "report", "text": "Done", "spoken_text": value}, CATALOG)

    def test_optional_narration_and_exact_limit(self):
        for extra in [{}, {"spoken_text": None}]:
            call = validate({"tool": "report", "text": "Done", **extra}, CATALOG)
            self.assertNotIn("spoken_text", call)
        call = validate({"tool": "report", "text": "Done",
                         "spoken_text": "x" * MAX_SUMMARY_CHARS}, CATALOG)
        self.assertEqual(len(call["spoken_text"]), MAX_SUMMARY_CHARS)


class NarrationStageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sent, self.calls = [], []
        self.speech = FakeSpeech()
        patcher = patch("controller.agent.speak_segments", self.speech)
        patcher.start()
        self.addCleanup(patcher.stop)

        async def send(event):
            self.sent.append(event)

        async def llm(messages, on_reasoning=None):
            self.calls.append(messages)
            yield "[worried] Summariser was called."

        self.stage = Stage(send, object(), CATALOG, llm=llm)
        self.addAsyncCleanup(self.stage.close)
        self.clock = Clock()
        self.router = AgentRouter(CATALOG, clock=self.clock)
        self.router.attach(self.stage)

    async def report(self, spoken_text, text="# Full result\n\nPassed."):
        return await self.router.handle({"tool": "report", "text": text,
                                         "spoken_text": spoken_text})

    async def test_direct_narration_bypasses_llm_and_keeps_report_and_replay_turn(self):
        self.assertEqual(await self.report("[happy] Done. [relieved] All checked."), "queued")
        await settle()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.speech.spoken, [[("Done.", "happy", 1.0),
                                             ("All checked.", "relieved", 1.0)]])
        bubble = self.sent[0]
        self.assertEqual(bubble["text"], "# Full result\n\nPassed.")
        self.assertEqual(self.speech.turns, [bubble["turn"]])
        self.assertNotIn("spoken_text", bubble)
        self.assertFalse(any(e.get("name") == "thinking" for e in self.sent))

    async def test_redaction_tag_allowlist_and_speech_cap_still_apply(self):
        narration = ("[unknown][happy:2] Fixed /etc/passwd. "
                     "[relieved] See https://example.com now. "
                     "password=hunter2 is hidden. Fourth sentence.")
        self.assertEqual(await self.report(narration), "queued")
        await settle()
        spoken = self.speech.spoken[0]
        self.assertEqual(len(spoken), 3)
        self.assertEqual(spoken[0][1:], ("happy", 1.0))
        self.assertEqual(spoken[1][1], "relieved")
        text = " ".join(s[0] for s in spoken)
        for excluded in ["passwd", "example.com", "hunter2", "unknown", "Fourth"]:
            self.assertNotIn(excluded, text)
        self.assertEqual(self.calls, [])

    async def test_invalid_narration_never_queues_or_falls_back(self):
        self.assertTrue((await self.report(42)).startswith("error:"))
        await settle()
        self.assertEqual(self.sent, [])
        self.assertEqual(self.calls, [])

    async def test_rate_limit_queue_order_and_cancellation_are_shared(self):
        self.speech.hold = asyncio.Event()
        self.assertEqual(await self.report("First."), "queued")
        await self.speech.started.wait()
        self.assertEqual(await self.report("Too soon."), "busy")
        self.clock.now += 2
        self.assertEqual(await self.report("Second."), "queued")
        self.assertEqual(self.stage.pending, 2)
        self.stage.chat_started()
        self.stage.chat_finished()
        self.speech.hold.set()
        await settle()
        self.assertEqual(self.speech.spoken, [])
        self.assertEqual(self.stage.pending, 0)
        self.assertEqual(self.calls, [])

    async def test_fixed_policy_never_calls_available_llm(self):
        self.stage.report_fallback = "fixed"
        self.assertEqual(await self.router.handle({"tool": "report", "text": "Full result"}), "queued")
        await settle()
        self.assertEqual(self.calls, [])
        self.assertIn("details are in the chat", " ".join(s[0] for s in self.speech.spoken[0]))

    async def test_text_only_still_shows_full_report(self):
        self.stage.worker = None
        self.assertEqual(await self.report("[happy] Done."), "queued")
        await settle()
        self.assertEqual(self.sent[0]["text"], "# Full result\n\nPassed.")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.speech.spoken, [])

    async def test_large_single_summary_chunk_respects_character_limit(self):
        async def llm(messages, on_reasoning=None):
            yield "a" * (MAX_SUMMARY_CHARS + 100)

        self.stage.llm = llm
        await self.router.handle({"tool": "report", "text": "Summarise this."})
        await settle()
        self.assertEqual(len(self.speech.spoken[0][0][0]), MAX_SUMMARY_CHARS)


class NarrationMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_optional_narration_schema_and_forwarding(self):
        server = mcp_server.build_server(Path("/tmp/test.sock"), "Codex")
        listing = {t.name: t for t in await server.list_tools()}
        schema = listing["report"].inputSchema
        self.assertIn("spoken_text", schema["properties"])
        self.assertNotIn("spoken_text", schema["required"])
        forward = AsyncMock(return_value="queued")
        with patch("controller.mcp_server.call_bridge", forward):
            await server.call_tool("report", {"text": "# Full report", "spoken_text": "Done."})
        self.assertEqual(forward.call_args.args[1], {
            "tool": "report", "source": "Codex", "text": "# Full report",
            "kind": "done", "spoken_text": "Done.",
        })


class AgentModeStartupTests(unittest.TestCase):
    def start(self, *flags):
        run = AsyncMock()
        with patch("sys.argv", ["bridge", *flags]), patch("controller.bridge.run", run), \
             patch("controller.bridge.resolve_llm_config") as resolve:
            bridge.main()
            resolve.assert_not_called()
        return run.call_args.args[0]

    def test_agent_mode_needs_no_llm_configuration_and_enables_socket(self):
        args = self.start("--mode", "agent")
        self.assertTrue(args.agent)
        self.assertEqual(args.report_fallback, "fixed")
        self.assertIsNotNone(args.agent_socket)
        self.assertEqual(args.llm_headers, {})

    def test_agent_mode_rejects_llm_features(self):
        for flags in [("--report-fallback", "summarise"), ("--tools",), ("--web-search",)]:
            with self.subTest(flags=flags), self.assertRaises(SystemExit):
                self.start("--mode", "agent", *flags)

    def test_existing_demo_mode_keeps_default_and_fixed_override(self):
        self.assertEqual(self.start("--agent").report_fallback, "summarise")
        self.assertEqual(self.start("--agent", "--report-fallback", "fixed").report_fallback, "fixed")


class AgentModeConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_tools_and_ask_answers_work_without_an_upstream(self):
        sent, results = [], []
        router = AgentRouter(CATALOG)
        speech = FakeSpeech()

        class Socket:
            async def send(self, raw):
                sent.append(json.loads(raw))

            async def __aiter__(self):
                for call in [{"tool": "set_mood", "name": "thinking"},
                             {"tool": "say", "text": "Checking."},
                             {"tool": "report", "text": "Written report"}]:
                    results.append(await router.handle(call))
                    await settle()
                ask = asyncio.create_task(router.handle({"tool": "ask", "question": "Continue?"}))
                await settle()
                question = next(e for e in sent if e.get("kind") == "ask")
                yield json.dumps({"type": "answer", "id": question["id"], "text": "Yes please"})
                results.append(await ask)
                await settle()

        args = Namespace(mode="agent", agent_router=router, speech_worker=object(),
                         report_fallback="summarise")  # Runtime still forces a fixed fallback.
        with patch("controller.agent.speak_segments", speech), \
             patch("controller.bridge.llama_chunks", Mock()) as llm:
            await bridge.handle_connection(Socket(), args, CATALOG)
        llm.assert_not_called()
        self.assertEqual(results, ["ok", "queued", "queued", "Yes please"])
        texts = [text for turn in speech.spoken for text, _, _ in turn]
        self.assertEqual(texts, ["Checking.", "All done.", "The details are in the chat.", "Continue?"])

    async def test_browser_chat_cannot_reach_llm_or_demo(self):
        sent = []

        class Socket:
            async def send(self, raw):
                sent.append(json.loads(raw))

            async def __aiter__(self):
                for request in [{"type": "start", "prompt": "Hello"}, {"type": "reset"},
                                {"type": "start"}]:
                    yield json.dumps(request)
                    await settle()

        args = Namespace(mode="agent", agent_router=AgentRouter(CATALOG),
                         llama_url="http://forbidden.invalid", model="unused",
                         context_tokens=65536)
        with patch("controller.bridge.llama_chunks", Mock()) as llm, \
             patch("controller.bridge.context_window", AsyncMock()) as context, \
             patch("controller.bridge.demo_chunks", Mock()) as demo:
            await bridge.handle_connection(Socket(), args, CATALOG)
        llm.assert_not_called()
        context.assert_not_called()
        demo.assert_not_called()
        self.assertEqual(len([e for e in sent if e["type"] == "error"]), 2)
        self.assertFalse(any(e["type"] == "start" for e in sent))
        # The renderer handles error as terminal; a following end would erase
        # the explanatory status with "Complete".
        self.assertFalse(any(e["type"] == "end" for e in sent))
        self.assertTrue(all("agent-only" in e["text"] for e in sent if e["type"] == "error"))
        self.assertIn({"type": "reset"}, sent)


if __name__ == "__main__":
    unittest.main()
