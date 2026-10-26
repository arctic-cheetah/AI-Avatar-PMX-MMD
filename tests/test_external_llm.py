import asyncio
import json
import os
import unittest
from argparse import Namespace
from unittest.mock import patch

from controller.bridge import (
    MIN_CONTEXT,
    build_parser,
    completions_url,
    context_window,
    handle_connection,
    is_loopback_url,
    llama_chunks,
    load_catalog,
    parse_llm_header,
    resolve_llm_config,
    ORIGIN,
)

ENV = {"OPENAI_API_KEY": "test-secret-key", "PROXY_KEY": "proxy-secret"}


class UrlTests(unittest.TestCase):
    def test_completions_url_forms(self):
        cases = {
            "http://127.0.0.1:8080": "http://127.0.0.1:8080/v1/chat/completions",
            "http://127.0.0.1:8080/": "http://127.0.0.1:8080/v1/chat/completions",
            "http://127.0.0.1:11434/v1": "http://127.0.0.1:11434/v1/chat/completions",
            "https://proxy.example/v1/": "https://proxy.example/v1/chat/completions",
            "https://proxy.example/v1/chat/completions": (
                "https://proxy.example/v1/chat/completions"
            ),
            "https://host.example/prefix/v1": (
                "https://host.example/prefix/v1/chat/completions"
            ),
        }
        for base, expected in cases.items():
            with self.subTest(base=base):
                self.assertEqual(completions_url(base), expected)

    def test_loopback_detection(self):
        for url in [
            "http://127.0.0.1:8080",
            "http://127.5.0.1:8080/v1",
            "http://localhost:1234/v1",
            "http://[::1]:8080",
        ]:
            self.assertTrue(is_loopback_url(url), url)
        for url in [
            "https://api.openai.com/v1",
            "https://proxy.example/v1",
            "http://192.168.1.20:11434/v1",
            "http://ollama.lan:11434/v1",
            "not a url",
        ]:
            self.assertFalse(is_loopback_url(url), url)


class HeaderArgTests(unittest.TestCase):
    def test_parse_llm_header(self):
        self.assertEqual(
            parse_llm_header("X-Title: avatar-yidhari"),
            ("X-Title", "avatar-yidhari"),
        )
        self.assertEqual(
            parse_llm_header("HTTP-Referer:http://127.0.0.1:8770"),
            ("HTTP-Referer", "http://127.0.0.1:8770"),
        )

    def test_parse_llm_header_rejects_bad_shapes(self):
        for bad in [
            "NoColon",
            ": value",
            "X-Empty:",
            "Authorization: Bearer from-cli",
            "authorization: Bearer from-cli",
            "Bad Name: value",
            "X-Test: a\r\nInjected: yes",
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(Exception):
                    parse_llm_header(bad)


class ResolveConfigTests(unittest.TestCase):
    def test_local_needs_no_key_or_model(self):
        config = resolve_llm_config(
            "http://127.0.0.1:8080", None, "OPENAI_API_KEY", [], environ={}
        )
        self.assertEqual(
            config.endpoint, "http://127.0.0.1:8080/v1/chat/completions"
        )
        self.assertEqual(config.headers, {})
        self.assertFalse(config.external)

    def test_local_sends_key_when_env_set(self):
        config = resolve_llm_config(
            "http://localhost:1234/v1", None, "OPENAI_API_KEY", [], environ=ENV
        )
        self.assertEqual(
            config.headers, {"Authorization": "Bearer test-secret-key"}
        )
        self.assertFalse(config.external)

    def test_external_with_key_model_and_extra_headers(self):
        config = resolve_llm_config(
            "https://proxy.example/v1",
            "vendor/model",
            "PROXY_KEY",
            [("X-Title", "avatar-yidhari")],
            environ=ENV,
        )
        self.assertTrue(config.external)
        self.assertEqual(
            config.endpoint, "https://proxy.example/v1/chat/completions"
        )
        self.assertEqual(config.headers["Authorization"], "Bearer proxy-secret")
        self.assertEqual(config.headers["X-Title"], "avatar-yidhari")
        self.assertNotIn("test-secret-key", repr(config.headers))

    def test_external_requires_model(self):
        with self.assertRaisesRegex(Exception, "model"):
            resolve_llm_config(
                "https://proxy.example/v1", None, "OPENAI_API_KEY", [], environ=ENV
            )

    def test_external_requires_key_unless_allowed(self):
        with self.assertRaisesRegex(Exception, "OPENAI_API_KEY"):
            resolve_llm_config(
                "https://proxy.example/v1", "m", "OPENAI_API_KEY", [], environ={}
            )
        config = resolve_llm_config(
            "https://proxy.example/v1",
            "m",
            "OPENAI_API_KEY",
            [],
            allow_no_key=True,
            environ={},
        )
        self.assertEqual(config.headers, {})

    def test_empty_key_counts_as_missing(self):
        with self.assertRaisesRegex(Exception, "PROXY_KEY"):
            resolve_llm_config(
                "https://proxy.example/v1",
                "m",
                "PROXY_KEY",
                [],
                environ={"PROXY_KEY": "  "},
            )

    def test_invalid_url_and_authorization_header_rejected(self):
        for bad in ["ftp://host/v1", "https://", ""]:
            with self.subTest(bad=bad):
                with self.assertRaises(Exception):
                    resolve_llm_config(bad, "m", "OPENAI_API_KEY", [], environ=ENV)
        with self.assertRaises(Exception):
            resolve_llm_config(
                "https://proxy.example/v1",
                "m",
                "PROXY_KEY",
                [("Authorization", "Bearer other")],
                environ=ENV,
            )

    def test_cli_defaults_and_flags(self):
        args = build_parser().parse_args(["--mode", "llm"])
        self.assertEqual(args.api_key_env, "OPENAI_API_KEY")
        self.assertFalse(args.allow_no_key)
        self.assertEqual(args.llm_header, [])
        args = build_parser().parse_args(
            [
                "--mode", "llm",
                "--llama-url", "https://proxy.example/v1",
                "--model", "m",
                "--api-key-env", "PROXY_KEY",
                "--allow-no-key",
                "--llm-header", "X-Title: avatar-yidhari",
                "--llm-header", "X-Trace: 1",
            ]
        )
        self.assertEqual(args.api_key_env, "PROXY_KEY")
        self.assertTrue(args.allow_no_key)
        self.assertEqual(
            args.llm_header,
            [("X-Title", "avatar-yidhari"), ("X-Trace", "1")],
        )


class ExternalStreamTests(unittest.IsolatedAsyncioTestCase):
    async def capture(self, base_url, body, status=200, headers=None):
        import httpx

        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["headers"] = request.headers
            seen["payload"] = json.loads(request.content)
            return httpx.Response(status, text=body)

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("httpx.AsyncClient", return_value=client):
            chunks = [
                c
                async for c in llama_chunks(
                    base_url,
                    "vendor/model",
                    [{"role": "user", "content": "Hi"}],
                    headers=headers,
                )
            ]
        return seen, chunks

    async def test_auth_extra_headers_model_and_endpoint(self):
        body = (
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            "data: [DONE]\n\n"
        )
        seen, chunks = await self.capture(
            "https://proxy.example/v1",
            body,
            headers={
                "Authorization": "Bearer test-secret-key",
                "X-Title": "avatar-yidhari",
            },
        )
        self.assertEqual(chunks, ["hi"])
        self.assertEqual(
            seen["url"], "https://proxy.example/v1/chat/completions"
        )
        self.assertEqual(
            seen["headers"]["authorization"], "Bearer test-secret-key"
        )
        self.assertEqual(seen["headers"]["x-title"], "avatar-yidhari")
        self.assertEqual(seen["payload"]["model"], "vendor/model")

    async def test_reasoning_field_spelling_triggers_thinking(self):
        for field in ["reasoning", "reasoning_content"]:
            with self.subTest(field=field):
                noticed = []

                async def on_reasoning():
                    noticed.append(True)

                import httpx

                body = (
                    "data: "
                    + json.dumps(
                        {"choices": [{"delta": {field: "private", "content": "ok"}}]}
                    )
                    + "\n\ndata: [DONE]\n\n"
                )
                client = httpx.AsyncClient(
                    transport=httpx.MockTransport(
                        lambda r: httpx.Response(200, text=body)
                    )
                )
                with patch("httpx.AsyncClient", return_value=client):
                    chunks = [
                        c
                        async for c in llama_chunks(
                            "https://proxy.example/v1",
                            "m",
                            [{"role": "user", "content": "Hi"}],
                            on_reasoning,
                            headers={"Authorization": "Bearer test-secret-key"},
                        )
                    ]
                self.assertEqual(chunks, ["ok"])
                self.assertEqual(noticed, [True])

    async def test_cloud_context_overflow_spelling(self):
        import httpx
        from controller.bridge import ContextOverflow

        body = json.dumps(
            {"error": {"code": "context_length_exceeded", "message": "too long"}}
        )
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(400, text=body))
        )
        with patch("httpx.AsyncClient", return_value=client):
            with self.assertRaises(ContextOverflow):
                _ = [
                    c
                    async for c in llama_chunks(
                        "https://proxy.example/v1",
                        "m",
                        [{"role": "user", "content": "Hi"}],
                        headers={"Authorization": "Bearer test-secret-key"},
                    )
                ]

    async def test_external_context_window_is_not_probed(self):
        with patch(
            "httpx.AsyncClient", side_effect=AssertionError("must not probe")
        ):
            self.assertEqual(
                await context_window("https://api.example/v1", None), MIN_CONTEXT
            )
        self.assertEqual(
            await context_window("https://api.example/v1", 131072), 131072
        )


class ExternalConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_handle_connection_forwards_headers(self):
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect

        seen = {}

        async def fake_llama(base_url, model, messages, on_reasoning=None, headers=None):
            seen.update(base_url=base_url, model=model, headers=headers)
            yield "[neutral] ok"

        args = Namespace(
            mode="llm",
            llama_url="https://proxy.example/v1",
            model="vendor/model",
            prompt="Hi",
            context_tokens=65536,
            llm_headers={"Authorization": "Bearer test-secret-key"},
        )

        async def handler(ws):
            await handle_connection(ws, args, load_catalog())

        with patch("controller.bridge.llama_chunks", fake_llama):
            async with serve(handler, "127.0.0.1", 0, origins=[ORIGIN]) as server:
                url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
                async with connect(url, origin=ORIGIN) as ws:
                    await ws.send('{"type":"start"}')
                    while True:
                        event = json.loads(await asyncio.wait_for(ws.recv(), 3))
                        if event["type"] == "end":
                            break
        self.assertEqual(seen["model"], "vendor/model")
        self.assertEqual(
            seen["headers"], {"Authorization": "Bearer test-secret-key"}
        )


if __name__ == "__main__":
    unittest.main()
