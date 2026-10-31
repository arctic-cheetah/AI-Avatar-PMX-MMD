"""Issue #23: bounded tools, streamed round trips and speech continuity."""
import asyncio
import copy
import json
import unittest
from argparse import Namespace
from datetime import datetime
from unittest.mock import patch

import httpx

from controller.bridge import build_parser, handle_connection, llama_chunks, load_catalog
from controller.tools import ToolSession, MAX_TOOL_ROUNDS


def call(name, arguments="{}", index=0, ident="call-1"):
    return {"index": index, "id": ident, "type": "function",
            "function": {"name": name, "arguments": arguments}}


def stream(*deltas):
    return "".join("data: " + json.dumps({"choices": [{"delta": d}]}) + "\n\n"
                   for d in deltas) + "data: [DONE]\n\n"


class ToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tools = ToolSession(load_catalog())

    async def test_time_has_local_offset(self):
        result = await self.tools.execute("get_time", "{}")
        self.assertIsNotNone(datetime.fromisoformat(result["datetime"]).utcoffset())

    async def test_notes_bounded_isolated_and_clearable(self):
        for i in range(25):
            await self.tools.execute("remember", json.dumps({"note": f"note {i}"}))
        notes = (await self.tools.execute("recall", "{}"))["notes"]
        self.assertEqual(len(notes), 20)
        self.assertEqual(notes[0], "note 5")
        self.assertEqual((await ToolSession(load_catalog()).execute("recall", "{}"))["notes"], [])
        self.tools.clear()
        self.assertEqual((await self.tools.execute("recall", "{}"))["notes"], [])

    async def test_expression_validates_and_returns_control(self):
        result = await self.tools.execute("set_expression", '{"name":"soft-smile","weight":0.6}')
        self.assertEqual(result["expression"], {"type": "expression", "name": "soft-smile", "weight": 0.6})

    async def test_untrusted_arguments_return_errors(self):
        cases = [("shell", "{}"), ("remember", "[]"), ("get_time", "{bad"),
                 ("get_time", '{"path":"/etc/passwd"}'), ("remember", '{"note":""}'),
                 ("remember", json.dumps({"note": "x" * 501})),
                 ("recall", '{"extra":true}'), ("web_search", '{"query":"test"}')]
        for weight in [True, -1, 2, float("nan"), float("inf"), "0.5"]:
            cases.append(("set_expression", json.dumps({"name": "happy", "weight": weight})))
        cases.append(("set_expression", '{"name":"unknown","weight":0.5}'))
        cases.append(("set_expression", '{"name":"happy","weight":' + '9' * 1000 + '}'))
        for name, args in cases:
            with self.subTest(name=name, args=args):
                self.assertIn("error", await self.tools.execute(name, args))

    async def test_search_fixed_destination_bounded_results_and_no_llm_key(self):
        tools = ToolSession(load_catalog(), search_key="search-secret")
        def handler(request):
            self.assertEqual(str(request.url).split("?")[0], "https://api.search.brave.com/res/v1/web/search")
            self.assertEqual(request.url.params["q"], "avatar news")
            self.assertEqual(request.headers["X-Subscription-Token"], "search-secret")
            self.assertNotIn("authorization", request.headers)
            return httpx.Response(200, json={"web": {"results": [
                {"title": "News", "url": "https://example.com", "description": "x" * 2000},
                {"title": "Bad", "url": "javascript:alert(1)", "description": "bad"},
            ] * 10}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("httpx.AsyncClient", return_value=client):
            result = await tools.execute("web_search", '{"query":"avatar news"}')
        self.assertLessEqual(len(result["results"]), 5)
        self.assertLessEqual(len(result["results"][0]["snippet"]), 500)
        self.assertTrue(all(r["url"].startswith("https://") for r in result["results"]))

    async def test_search_failures_are_sanitized(self):
        for response in [httpx.Response(429, text="search-secret"), httpx.Response(200, text="broken")]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: response))
            with patch("httpx.AsyncClient", return_value=client):
                result = await ToolSession(load_catalog(), search_key="search-secret").execute("web_search", '{"query":"test"}')
            self.assertIn("error", result)
            self.assertNotIn("search-secret", json.dumps(result))


class LoopTests(unittest.IsolatedAsyncioTestCase):
    async def run_loop(self, scripts, tools=None):
        self.requests, self.status = [], []
        def handler(request):
            self.requests.append(copy.deepcopy(json.loads(request.content)))
            return httpx.Response(200, text=scripts[min(len(self.requests) - 1, len(scripts) - 1)])
        original = httpx.AsyncClient
        def factory(**kwargs):
            return original(transport=httpx.MockTransport(handler))
        async def status(event):
            self.status.append(event)
        with patch("httpx.AsyncClient", side_effect=factory):
            return [c async for c in llama_chunks("http://localhost", "test", [{"role": "user", "content": "hi"}],
                    tool_session=tools or ToolSession(load_catalog()), on_tool=status)]

    async def test_no_tool_reply(self):
        self.assertEqual(await self.run_loop([stream({"content": "Hello."})]), ["Hello."])
        self.assertIn("tools", self.requests[0])
        self.assertEqual(len(self.requests), 1)

    async def test_fragmented_parallel_calls_continue_with_matching_ids(self):
        chunks = await self.run_loop([
            stream({"tool_calls": [call("remember", '{"no'), call("get_time", index=1, ident="call-2")]},
                   {"tool_calls": [{"index": 0, "function": {"arguments": 'te":"tea"}'}}]}),
            stream({"content": "Remembered."})])
        messages = self.requests[1]["messages"]
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "tool", "tool"])
        self.assertEqual([m["tool_call_id"] for m in messages[-2:]], ["call-1", "call-2"])
        self.assertEqual(chunks, ["Remembered."])
        self.assertTrue(self.status)

    async def test_unknown_and_bad_json_return_errors_then_answer(self):
        for name, args in [("shell", "{}"), ("remember", "{bad")]:
            self.assertEqual(await self.run_loop([stream({"tool_calls": [call(name, args)]}),
                                                  stream({"content": "Still here."})]), ["Still here."])
            self.assertIn("error", json.loads(self.requests[1]["messages"][-1]["content"]))

    async def test_runaway_loop_stops(self):
        with self.assertRaisesRegex(ValueError, "round"):
            await self.run_loop([stream({"tool_calls": [call("get_time")]})])
        self.assertLessEqual(len(self.requests), MAX_TOOL_ROUNDS + 1)

    async def test_incomplete_or_oversized_stream_never_executes(self):
        tools = ToolSession(load_catalog())
        for script in [stream({"tool_calls": [call("remember", '{"note":"tea"}')] }).replace("data: [DONE]\n\n", ""),
                       stream({"tool_calls": [call("remember", "x" * 5000)]})]:
            with self.assertRaises(ValueError):
                await self.run_loop([script], tools)
        self.assertEqual((await tools.execute("recall", "{}"))["notes"], [])

    async def test_truncated_tool_completion_never_executes(self):
        tools = ToolSession(load_catalog())
        script = stream({"tool_calls": [call("remember", '{"note":"tea"}')]})
        script = script.replace("data: [DONE]", 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]')
        with self.assertRaises(ValueError):
            await self.run_loop([script], tools)
        self.assertEqual((await tools.execute("recall", "{}"))["notes"], [])

    async def test_expression_tool_emits_validated_control_before_answer(self):
        self.assertEqual(await self.run_loop([
            stream({"tool_calls": [call("set_expression", '{"name":"soft-smile","weight":0.6}')]}),
            stream({"content": "Hello."})]), ["[soft-smile:0.6]", "Hello."])

    async def test_failed_search_continues_into_reply(self):
        tools = ToolSession(load_catalog(), search_key="secret")
        with patch.object(tools, "search", return_value={"error": "Web search unavailable"}):
            reply = await self.run_loop([
                stream({"tool_calls": [call("web_search", '{"query":"news"}')]}),
                stream({"content": "Search is unavailable."})], tools)
        self.assertEqual(reply, ["Search is unavailable."])

    async def test_cancellation_during_search_propagates(self):
        tools = ToolSession(load_catalog(), search_key="secret")
        with patch.object(tools, "search", side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.run_loop([stream({"tool_calls": [call("web_search", '{"query":"news"}')]})], tools)

    async def test_expression_continues_through_speech_and_reset_clears_notes(self):
        events, segments, sessions = [], [], []
        ended = asyncio.Event()
        class Socket:
            async def send(self, raw):
                event = json.loads(raw)
                events.append(event)
                if event["type"] in ("end", "error", "reset"):
                    ended.set()
            async def __aiter__(self):
                yield json.dumps({"type": "start", "prompt": "hi"})
                await asyncio.wait_for(ended.wait(), 3)
                ended.clear()
                yield '{"type":"reset"}'
                await asyncio.wait_for(ended.wait(), 3)
        original_llm = llama_chunks
        async def llm(*args, **kwargs):
            session = kwargs["tool_session"]
            sessions.append(session)
            async for chunk in original_llm(*args, **kwargs):
                yield chunk
        requests = []
        def handler(request):
            requests.append(json.loads(request.content))
            if len(requests) == 1:
                return httpx.Response(200, text=stream({"tool_calls": [
                    call("set_expression", '{"name":"soft-smile","weight":0.6}'),
                    call("remember", '{"note":"tea"}', index=1, ident="call-2")]}))
            return httpx.Response(200, text=stream({"content": "Hello there."}))
        original_client = httpx.AsyncClient
        def factory(**kwargs):
            return original_client(transport=httpx.MockTransport(handler))
        async def synth(segment, worker, run):
            segments.append(segment)
            return "a" * 16, {}
        args = Namespace(mode="llm", tools=True, web_search=False, llama_url="http://localhost", model=None,
                         context_tokens=65536, speech_worker=object())
        with patch("httpx.AsyncClient", side_effect=factory), patch("controller.bridge.llama_chunks", llm), patch("controller.speech.synthesise", synth), patch("controller.speech.clear_live_clips"):
            await handle_connection(Socket(), args, load_catalog())
        self.assertTrue(any(e["type"] == "speak" for e in events))
        self.assertEqual(segments[0].expression, "soft-smile")
        self.assertEqual(segments[0].weight, 0.6)
        self.assertEqual((await sessions[0].execute("recall", "{}"))["notes"], [])
        self.assertTrue(any(e["type"] == "notice" for e in events))

    def test_cli_defaults_are_opt_in(self):
        args = build_parser().parse_args([])
        self.assertFalse(args.tools)
        self.assertFalse(args.web_search)
        self.assertTrue(build_parser().parse_args(["--tools", "--web-search"]).web_search)
