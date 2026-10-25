"""Conversation history (issue #34): budget, trimming, commit rules, reset, isolation."""

import argparse
import asyncio
import json
import unittest
from argparse import Namespace
from unittest.mock import patch

from controller.bridge import (
    CONTEXT_MARGIN,
    MAX_TOKENS,
    MAX_TURNS,
    MESSAGE_OVERHEAD,
    MIN_CONTEXT,
    ORIGIN,
    TRIM_TO,
    ContextOverflow,
    Conversation,
    context_tokens_arg,
    context_window,
    estimate_tokens,
    handle_connection,
    llama_chunks,
    load_catalog,
    system_prompt,
)

SYSTEM = "system rules"


def window_for(budget):
    """A context window that leaves exactly ``budget`` tokens for the prompt."""
    return budget + MAX_TOKENS + CONTEXT_MARGIN


def cost(messages):
    return sum(estimate_tokens(m["content"]) + MESSAGE_OVERHEAD for m in messages)


def roles(messages):
    return [m["role"] for m in messages]


class EstimateTests(unittest.TestCase):
    def test_conservative_for_ascii_and_cjk(self):
        # Real tokenisers average ~4 ASCII chars per token; never under-count that.
        self.assertGreaterEqual(estimate_tokens("a" * 400), 100)
        # CJK is often a token per character or more.
        self.assertGreaterEqual(estimate_tokens("伊德海莉" * 25), 100)
        self.assertGreaterEqual(estimate_tokens("🌸" * 10), 10)
        self.assertEqual(estimate_tokens(""), 0)


class ConversationTests(unittest.TestCase):
    def test_turns_in_order_with_system_first_and_prompt_last(self):
        chat = Conversation(MIN_CONTEXT)
        chat.commit("u1", "a1")
        chat.commit("u2", "a2")
        self.assertEqual(
            chat.messages(SYSTEM, "u3"),
            [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": "u1"},
                {"role": "assistant", "content": "a1"},
                {"role": "user", "content": "u2"},
                {"role": "assistant", "content": "a2"},
                {"role": "user", "content": "u3"},
            ],
        )

    def test_messages_does_not_store_the_pending_prompt(self):
        chat = Conversation(MIN_CONTEXT)
        chat.messages(SYSTEM, "never answered")
        self.assertEqual(chat.messages(SYSTEM, "next"), [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "next"},
        ])

    def test_trims_oldest_whole_pairs_within_budget(self):
        chat = Conversation(window_for(300))
        for i in range(20):
            chat.commit(f"question {i} " + "q" * 60, f"answer {i} " + "a" * 60)
        messages = chat.messages(SYSTEM, "latest")
        self.assertLessEqual(cost(messages), 300)
        self.assertEqual(messages[0], {"role": "system", "content": SYSTEM})
        self.assertEqual(messages[-1], {"role": "user", "content": "latest"})
        self.assertEqual(roles(messages[1:-1]), ["user", "assistant"] * ((len(messages) - 2) // 2))
        self.assertTrue(messages[-2]["content"].startswith("answer 19"))
        self.assertFalse(any(m["content"].startswith("question 0 ") for m in messages))

    def test_trim_overshoots_so_the_prefix_stays_stable(self):
        # Trimming to TRIM_TO of the budget keeps the next few requests' prefix
        # unchanged, so llama-server can reuse its prompt cache.
        chat = Conversation(window_for(1000))
        for i in range(40):
            chat.commit(f"q{i} " + "x" * 60, f"a{i} " + "y" * 60)
        first = chat.messages(SYSTEM, "now")
        self.assertLessEqual(cost(first), TRIM_TO * 1000 + estimate_tokens("now") + MESSAGE_OVERHEAD)
        chat.commit("now", "short")
        second = chat.messages(SYSTEM, "again")
        self.assertEqual(second[1], first[1])

    def test_oversized_prompt_keeps_system_and_prompt_only(self):
        chat = Conversation(window_for(100))
        chat.commit("u1", "a1")
        huge = "z" * 4000
        self.assertEqual(chat.messages(SYSTEM, huge), [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": huge},
        ])

    def test_clear(self):
        chat = Conversation(MIN_CONTEXT)
        chat.commit("u1", "a1")
        chat.clear()
        self.assertEqual(len(chat.messages(SYSTEM, "u2")), 2)

    def test_turn_count_is_capped(self):
        chat = Conversation(MIN_CONTEXT * 100)
        for i in range(MAX_TURNS + 5):
            chat.commit(f"u{i}", f"a{i}")
        messages = chat.messages(SYSTEM, "now")
        self.assertEqual(len(messages), 2 + 2 * MAX_TURNS)
        self.assertEqual(messages[1]["content"], "u5")

    def test_shrink_drops_older_half(self):
        chat = Conversation(MIN_CONTEXT)
        for i in range(4):
            chat.commit(f"u{i}", f"a{i}")
        self.assertTrue(chat.shrink())
        self.assertEqual(
            [m["content"] for m in chat.messages(SYSTEM, "now")[1:-1]],
            ["u2", "a2", "u3", "a3"],
        )
        chat.clear()
        self.assertFalse(chat.shrink())


class ContextWindowTests(unittest.IsolatedAsyncioTestCase):
    def client(self, handler):
        import httpx

        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def test_override_skips_server(self):
        def handler(request):
            raise AssertionError("must not query the server")

        with patch("httpx.AsyncClient", return_value=self.client(handler)):
            self.assertEqual(await context_window("http://localhost:8080", 98304), 98304)

    async def test_reads_llama_server_props(self):
        import httpx

        def handler(request):
            self.assertEqual(request.url.path, "/props")
            return httpx.Response(
                200,
                json={"total_slots": 1, "default_generation_settings": {"n_ctx": 131072}},
            )

        with patch("httpx.AsyncClient", return_value=self.client(handler)):
            self.assertEqual(await context_window("http://localhost:8080/"), 131072)

    async def test_falls_back_to_minimum(self):
        import httpx

        for response in [
            httpx.Response(404),
            httpx.Response(200, text="not json"),
            httpx.Response(200, json={"default_generation_settings": {}}),
            httpx.Response(200, json={"default_generation_settings": {"n_ctx": "big"}}),
            httpx.Response(200, json={"default_generation_settings": {"n_ctx": True}}),
        ]:
            with patch("httpx.AsyncClient", return_value=self.client(lambda r: response)):
                with self.assertLogs("controller.bridge", "WARNING"):
                    self.assertEqual(await context_window("http://localhost:8080"), MIN_CONTEXT)

    async def test_small_server_window_wins_with_warning(self):
        # Never claim more context than the server really has.
        import httpx

        response = httpx.Response(200, json={"default_generation_settings": {"n_ctx": 32768}})
        with patch("httpx.AsyncClient", return_value=self.client(lambda r: response)):
            with self.assertLogs("controller.bridge", "WARNING"):
                self.assertEqual(await context_window("http://localhost:8080"), 32768)

    def test_cli_override_has_64k_floor(self):
        self.assertEqual(MIN_CONTEXT, 65536)
        self.assertEqual(context_tokens_arg("131072"), 131072)
        for bad in ["65535", "1000", "-1", "abc"]:
            with self.assertRaises(argparse.ArgumentTypeError):
                context_tokens_arg(bad)


class PayloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_given_messages(self):
        import httpx

        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "[happy] a1"},
            {"role": "user", "content": "u2"},
        ]

        def handler(request):
            payload = json.loads(request.content)
            self.assertEqual(payload["messages"], messages)
            self.assertEqual(payload["max_tokens"], MAX_TOKENS)
            return httpx.Response(200, text="data: [DONE]\n\n")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("httpx.AsyncClient", return_value=client):
            self.assertEqual(
                [c async for c in llama_chunks("http://localhost:8080", None, messages)], []
            )

    async def test_context_overflow_is_recognised(self):
        import httpx

        body = {
            "error": {
                "code": 400,
                "type": "exceed_context_size_error",
                "message": "the request exceeds the available context size",
            }
        }
        for response, error in [
            (httpx.Response(400, json=body), ContextOverflow),
            (httpx.Response(500, text="boom"), httpx.HTTPStatusError),
        ]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response))
            with patch("httpx.AsyncClient", return_value=client):
                with self.assertRaises(error):
                    _ = [
                        c
                        async for c in llama_chunks(
                            "http://localhost:8080", None, [{"role": "user", "content": "x"}]
                        )
                    ]


class FakeLlama:
    """Records each request's messages; replies are scripted per call."""

    def __init__(self, *replies):
        self.seen = []
        self.replies = list(replies)
        self.release = asyncio.Event()

    async def __call__(self, base_url, model, messages, on_reasoning=None):
        self.seen.append([dict(m) for m in messages])
        reply = self.replies.pop(0)
        if callable(reply):
            async for chunk in reply(messages, self):
                yield chunk
            return
        for chunk in reply:
            yield chunk

    def contents(self, call):
        return [m["content"] for m in self.seen[call][1:]]


def llm_args(**extra):
    return Namespace(
        mode="llm", llama_url="http://localhost:8080", model=None,
        prompt="default prompt", context_tokens=MIN_CONTEXT, **extra,
    )


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from websockets.asyncio.server import serve

        self.catalog = load_catalog()
        self.args = llm_args()

        async def handler(ws):
            await handle_connection(ws, self.args, self.catalog)

        self.server = await serve(handler, "127.0.0.1", 0, origins=[ORIGIN]).__aenter__()
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    def connect(self):
        from websockets.asyncio.client import connect

        return connect(self.url, origin=ORIGIN)

    async def collect(self, ws, frame=None, until=("end", "error", "reset")):
        if frame is not None:
            await ws.send(json.dumps(frame))
        events = []
        while True:
            event = json.loads(await asyncio.wait_for(ws.recv(), 3))
            events.append(event)
            if event["type"] in until:
                return events

    async def ask(self, ws, prompt):
        return await self.collect(ws, {"type": "start", "prompt": prompt})

    @staticmethod
    def said(events):
        return "".join(e["text"] for e in events if e["type"] == "say")

    async def test_follow_up_includes_earlier_turns_and_only_new_text_is_sent(self):
        fake = FakeLlama(
            ["[happy] Red teamers ", "find the weakest link."],
            ["[soft-smile] Another one about ", "red teams."],
        )
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.ask(ws, "Make a joke about red teaming.")
                events = await self.ask(ws, "Please say another one.")
        self.assertEqual(fake.seen[1][0], {"role": "system", "content": system_prompt(self.catalog)})
        self.assertEqual(roles(fake.seen[1]), ["system", "user", "assistant", "user"])
        self.assertEqual(fake.contents(1), [
            "Make a joke about red teaming.",
            # Raw reply with tags, so her mood style stays consistent.
            "[happy] Red teamers find the weakest link.",
            "Please say another one.",
        ])
        # Old turns are context for the model only; the browser gets just the new reply.
        self.assertEqual(self.said(events), " Another one about red teams.")

    async def test_bare_start_uses_default_prompt_in_history(self):
        fake = FakeLlama(["one"], ["two"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.collect(ws, {"type": "start"})
                await self.ask(ws, "next")
        self.assertEqual(fake.contents(1), ["default prompt", "one", "next"])

    async def test_failed_reply_is_not_stored(self):
        async def fails_midway(messages, fake):
            yield "partial answer"
            raise ValueError("LLM stream ended without [DONE]")

        fake = FakeLlama(["first"], fails_midway, ["third"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.ask(ws, "u1")
                with self.assertLogs("controller.bridge", "ERROR"):
                    events = await self.ask(ws, "u2")
                self.assertEqual(events[-1]["type"], "error")
                await self.ask(ws, "u3")
        # Neither the failed prompt nor its partial reply is remembered.
        self.assertEqual(fake.contents(2), ["u1", "first", "u3"])

    async def test_dropped_busy_prompt_is_not_stored(self):
        async def slow(messages, fake):
            await fake.release.wait()
            yield "slow answer"

        fake = FakeLlama(slow, ["later"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "start", "prompt": "u1"}))
                await self.collect(ws, until=("start",))
                with self.assertLogs("controller.bridge", "WARNING"):
                    await ws.send(json.dumps({"type": "start", "prompt": "while busy"}))
                    await asyncio.sleep(0.05)
                fake.release.set()
                await self.collect(ws)
                await self.ask(ws, "u2")
        self.assertEqual(fake.contents(1), ["u1", "slow answer", "u2"])

    async def test_reset_clears_history(self):
        fake = FakeLlama(["a1"], ["a2"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.ask(ws, "u1")
                events = await self.collect(ws, {"type": "reset"})
                self.assertEqual(events, [{"type": "reset"}])
                await self.ask(ws, "u2")
        self.assertEqual(fake.contents(1), ["u2"])

    async def test_reset_cancels_active_reply(self):
        async def hangs(messages, fake):
            yield "half "
            await asyncio.Event().wait()

        fake = FakeLlama(["a1"], hangs, ["a3"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.ask(ws, "u1")
                await ws.send(json.dumps({"type": "start", "prompt": "u2"}))
                await self.collect(ws, until=("say",))
                events = await self.collect(ws, {"type": "reset"})
                self.assertEqual(events[-1], {"type": "reset"})
                await self.ask(ws, "u3")
        self.assertEqual(fake.contents(2), ["u3"])

    async def test_connections_are_isolated_and_reconnect_starts_fresh(self):
        fake = FakeLlama(["secret answer"], ["b1"], ["c1"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as a:
                await self.ask(a, "secret question")
                async with self.connect() as b:
                    await self.ask(b, "hello from b")
            async with self.connect() as again:
                await self.ask(again, "after reconnect")
        self.assertEqual(fake.contents(1), ["hello from b"])
        self.assertEqual(fake.contents(2), ["after reconnect"])

    async def test_context_overflow_shrinks_and_retries_once(self):
        from controller.bridge import ContextOverflow

        async def overflow(messages, fake):
            raise ContextOverflow("too long")
            yield ""

        fake = FakeLlama(["a1"], ["a2"], overflow, ["a3"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.ask(ws, "u1")
                await self.ask(ws, "u2")
                events = await self.ask(ws, "u3")
        self.assertEqual(self.said(events), "a3")
        self.assertEqual(fake.contents(2), ["u1", "a1", "u2", "a2", "u3"])
        self.assertEqual(fake.contents(3), ["u2", "a2", "u3"])

    async def test_repeated_overflow_reports_error_and_stores_nothing(self):
        async def overflow(messages, fake):
            raise ContextOverflow("too long")
            yield ""

        fake = FakeLlama(["a1"], overflow, overflow, ["a3"])
        with patch("controller.bridge.llama_chunks", fake):
            async with self.connect() as ws:
                await self.ask(ws, "u1")
                with self.assertLogs("controller.bridge", "ERROR"):
                    events = await self.ask(ws, "u2")
                self.assertEqual(events[-1]["type"], "error")
                await self.ask(ws, "u3")
        self.assertEqual(fake.contents(3), ["u3"])

    async def test_window_is_read_once_per_connection(self):
        calls = []

        async def fake_window(base_url, override=None):
            calls.append(override)
            return MIN_CONTEXT

        fake = FakeLlama(["a"], ["b"], ["c"])
        with patch("controller.bridge.llama_chunks", fake), \
                patch("controller.bridge.context_window", fake_window):
            async with self.connect() as ws:
                await self.ask(ws, "u1")
                await self.ask(ws, "u2")
            async with self.connect() as ws:
                await self.ask(ws, "u3")
        self.assertEqual(calls, [MIN_CONTEXT, MIN_CONTEXT])


class SpokenHistoryTests(unittest.IsolatedAsyncioTestCase):
    """With --speech, only the newest reply is synthesised; history is never spoken."""

    async def test_only_newest_reply_is_spoken(self):
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect

        spoken = []

        class Worker:
            def cancel(self, run):
                pass

        async def fake_synthesise(segment, worker, run=None):
            spoken.append(segment.text.strip())
            return format(len(spoken), "016x"), {}

        catalog = load_catalog()
        args = llm_args(speech_worker=Worker())

        async def handler(ws):
            await handle_connection(ws, args, catalog)

        fake = FakeLlama(["First reply here."], ["Second reply here."])
        with patch("controller.bridge.llama_chunks", fake), \
                patch("controller.speech.synthesise", fake_synthesise), \
                patch("controller.speech.clear_live_clips", lambda *a: None):
            async with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
                url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
                async with connect(url, origin=ORIGIN) as ws:
                    for prompt in ["u1", "u2"]:
                        await ws.send(json.dumps({"type": "start", "prompt": prompt}))
                        while json.loads(await asyncio.wait_for(ws.recv(), 3))["type"] != "end":
                            pass
        self.assertEqual(fake.contents(1), ["u1", "First reply here.", "u2"])
        self.assertEqual(spoken, ["First reply here.", "Second reply here."])


if __name__ == "__main__":
    unittest.main()
