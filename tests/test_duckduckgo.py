"""Keyless DuckDuckGo search: real HTML shapes, bounded IO and CLI wiring."""
import json
import unittest
from unittest.mock import patch

import httpx

from controller.bridge import build_parser, load_catalog, main
from controller.tools import ToolSession


HTML = '''<!doctype html><html><body>
<div class="result results_links web-result">
 <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%3Fa%3D1%26b%3D2&amp;rut=hash">Avatar <b>news</b> &amp; updates</a></h2>
 <a class="result__snippet">Latest <b>avatar</b> news &amp; details.</a>
</div>
<div class="result"><a class="result__a" href="https://example.org/direct">Direct result</a>
 <div class="result__snippet">A <span>nested</span> snippet.</div></div>
<a class="result__a" href="javascript:alert(1)">Unsafe</a><a class="result__snippet">Skip this.</a>
<a class="result__a" href="https://user:password@example.com">Credentials</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad redirect</a>
<a class="result__a" href="https://[bad">Malformed URL</a>
<a class="result__a" href="https://example.net/">Last</a><a class="result__snippet">Last snippet.</a>
</body></html>'''


class DuckDuckGoTests(unittest.IsolatedAsyncioTestCase):
    async def search(self, response):
        tools = ToolSession(load_catalog(), search_provider="duckduckgo")
        original = httpx.AsyncClient
        def handler(request):
            self.assertEqual(request.method, "POST")
            self.assertEqual(str(request.url), "https://html.duckduckgo.com/html/")
            self.assertIn(b"q=avatar+news", request.content)
            self.assertNotIn("authorization", request.headers)
            self.assertNotIn("x-subscription-token", request.headers)
            if isinstance(response, Exception):
                raise response
            return response
        def factory(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            self.assertFalse(kwargs["follow_redirects"])
            return original(transport=httpx.MockTransport(handler))
        with patch("httpx.AsyncClient", side_effect=factory):
            return await tools.execute("web_search", '{"query":"avatar news"}')

    async def test_keyless_html_results_unwrap_links_and_strip_markup(self):
        result = await self.search(httpx.Response(200, text=HTML))
        self.assertEqual(result, {"results": [
            {"title": "Avatar news & updates", "url": "https://example.com/news?a=1&b=2", "snippet": "Latest avatar news & details."},
            {"title": "Direct result", "url": "https://example.org/direct", "snippet": "A nested snippet."},
            {"title": "Last", "url": "https://example.net/", "snippet": "Last snippet."},
        ]})

    async def test_bounds_results_and_fields(self):
        html = ''.join(f'<a class="result__a" href="https://example.com/{i}">' + 't' * 300 +
                       '</a><a class="result__snippet">' + 's' * 1000 + '</a>' for i in range(10))
        results = (await self.search(httpx.Response(200, text=html)))["results"]
        self.assertEqual(len(results), 5)
        self.assertEqual(len(results[0]["title"]), 200)
        self.assertEqual(len(results[0]["snippet"]), 500)

    async def test_no_results_is_valid_but_blocked_or_unknown_pages_are_errors(self):
        self.assertEqual(await self.search(httpx.Response(200, text='<div class="no-results">No results.</div>')), {"results": []})
        for response in [httpx.Response(202, text="challenge"), httpx.Response(429),
                         httpx.Response(302, headers={"location": "https://unexpected.example"}),
                         httpx.Response(200, text='<form id="challenge-form">Verify human</form>'),
                         httpx.Response(200, text="Unknown layout"),
                         httpx.Response(200, text="x" * (256 * 1024 + 1)),
                         httpx.ReadTimeout("private upstream error")]:
            with self.subTest(response=response):
                result = await self.search(response)
                self.assertIn("error", result)
                self.assertNotIn("private upstream", json.dumps(result))

    async def test_search_is_advertised_only_when_enabled_and_validates_query(self):
        disabled = ToolSession(load_catalog())
        enabled = ToolSession(load_catalog(), search_provider="duckduckgo")
        self.assertNotIn("web_search", [t["function"]["name"] for t in disabled.definitions()])
        self.assertIn("web_search", [t["function"]["name"] for t in enabled.definitions()])
        for query in ["", " " * 4, "x" * 301, True]:
            with patch.object(enabled, "search") as search:
                self.assertIn("error", await enabled.execute("web_search", json.dumps({"query": query})))
                search.assert_not_called()

    async def test_connection_enables_duckduckgo_without_a_key(self):
        import asyncio
        from argparse import Namespace
        from controller.bridge import handle_connection

        ended = asyncio.Event()
        seen = []
        class Socket:
            async def send(self, raw):
                if json.loads(raw)["type"] in ("end", "error"):
                    ended.set()
            async def __aiter__(self):
                yield '{"type":"start","prompt":"search for news"}'
                await asyncio.wait_for(ended.wait(), 2)
        async def llm(*args, **kwargs):
            session = kwargs["tool_session"]
            seen.append(session.search_provider)
            self.assertIsNone(session.search_key)
            self.assertIn("web_search", [t["function"]["name"] for t in session.definitions()])
            yield "Ready."
        args = Namespace(mode="llm", tools=True, web_search=True, search_provider="duckduckgo",
                         search_key=None, llama_url="http://localhost", model=None, context_tokens=65536)
        with patch("controller.bridge.llama_chunks", llm):
            await handle_connection(Socket(), args, load_catalog())
        self.assertEqual(seen, ["duckduckgo"])


class SearchCliTests(unittest.TestCase):
    def test_default_provider_is_duckduckgo(self):
        self.assertEqual(build_parser().parse_args([]).search_provider, "duckduckgo")

    def test_keyless_startup_and_explicit_brave_startup(self):
        seen = []
        async def run(args):
            seen.append(args)
        with patch("controller.bridge.run", run), patch.dict("os.environ", {}, clear=True):
            with patch("sys.argv", ["bridge", "--mode", "llm", "--tools", "--web-search"]):
                main()
            self.assertEqual(seen[-1].search_provider, "duckduckgo")
            self.assertIsNone(seen[-1].search_key)
            with patch("sys.argv", ["bridge", "--mode", "llm", "--tools", "--web-search", "--search-provider", "brave"]):
                with self.assertRaisesRegex(SystemExit, "BRAVE_SEARCH_API_KEY"):
                    main()
                with patch.dict("os.environ", {"BRAVE_SEARCH_API_KEY": "test-key"}):
                    main()
            self.assertEqual(seen[-1].search_provider, "brave")
            self.assertEqual(seen[-1].search_key, "test-key")
