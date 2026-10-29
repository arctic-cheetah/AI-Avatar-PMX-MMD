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
    MAX_QUEUED,
    MAX_SAY,
    MAX_SOURCE,
    AgentError,
    AgentRouter,
    Stage,
    call_bridge,
    default_socket_path,
    prepare_socket_dir,
    serve,
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

    async def test_set_mood(self):
        self.router.attach(self.stage)
        result = await self.router.handle(
            {"tool": "set_mood", "source": "Claude Code", "name": "thinking", "weight": 0.6})
        self.assertEqual(result, "ok")
        self.assertEqual(self.sent, [{"type": "agent", "kind": "mood",
                                      "source": "Claude Code", "name": "thinking",
                                      "weight": 0.6}])


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
        self.assertEqual(tools, {"say", "set_mood"})
        with patch("controller.mcp_server.call_bridge", fake_call):
            await server.call_tool("say", {"text": "Hi", "mood": "happy"})
            await server.call_tool("set_mood", {"name": "thinking"})
        self.assertEqual(calls[0], (Path("/tmp/x.sock"),
                                    {"tool": "say", "source": "Claude Code", "text": "Hi",
                                     "mood": "happy", "weight": 1.0}))
        self.assertEqual(calls[1][1], {"tool": "set_mood", "source": "Claude Code",
                                       "name": "thinking", "weight": 1.0})


if __name__ == "__main__":
    unittest.main()
