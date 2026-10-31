"""Keyless Bing RSS defaults, parsing, bounded requests and failure categories."""
import json
import unittest
from unittest.mock import patch

import httpx

from controller.bridge import build_parser, load_catalog
from controller.tools import ToolSession


class BingTests(unittest.IsolatedAsyncioTestCase):
    async def search(self, response):
        original = httpx.AsyncClient
        def handler(request):
            self.assertEqual(request.method, "GET")
            self.assertEqual(str(request.url).split("?")[0], "https://www.bing.com/search")
            self.assertEqual(request.url.params["q"], "avatar news")
            self.assertEqual(request.url.params["format"], "rss")
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
            return await ToolSession(load_catalog(), search_provider="bing").execute("web_search", '{"query":"avatar news"}')

    async def test_rss_results_normalized_and_bounded(self):
        item = '<item><title>Avatar &amp; news</title><link>https://example.com/?a=1&amp;b=2</link><description>&lt;b&gt;Hello&lt;/b&gt; ' + 'x' * 600 + '</description></item>'
        invalid = '<item><title>Bad</title><link>javascript:alert(1)</link></item>'
        result = await self.search(httpx.Response(200, text='<rss version="2.0"><channel>' + invalid + item * 10 + '</channel></rss>'))
        self.assertEqual(len(result["results"]), 5)
        self.assertEqual(result["results"][0]["title"], "Avatar & news")
        self.assertEqual(result["results"][0]["url"], "https://example.com/?a=1&b=2")
        self.assertTrue(result["results"][0]["snippet"].startswith("Hello "))
        self.assertEqual(len(result["results"][0]["snippet"]), 500)

    async def test_empty_channel_is_valid(self):
        self.assertEqual(await self.search(httpx.Response(200, text='<rss><channel/></rss>')), {"results": []})

    async def test_failure_codes_are_sanitized(self):
        for response, code in [
            (httpx.Response(403, text="private details"), "search_blocked"),
            (httpx.Response(429), "search_blocked"),
            (httpx.Response(200, text="<html>challenge</html>"), "search_response_invalid"),
            (httpx.Response(200, text="<rss><channel>"), "search_response_invalid"),
            (httpx.Response(200, text='<!DOCTYPE rss [<!ENTITY x "expanded">]><rss><channel><item><title>&x;</title></item></channel></rss>'), "search_response_invalid"),
            (httpx.Response(200, content=b"x" * (256 * 1024 + 1)), "search_response_invalid"),
            (httpx.ReadTimeout("private details"), "search_network_error"),
            (httpx.Response(302, headers={"location": "https://unexpected.example"}), "search_response_invalid"),
        ]:
            with self.subTest(code=code, response=response):
                result = await self.search(response)
                self.assertEqual(result["code"], code)
                self.assertIn("error", result)
                self.assertNotIn("private details", json.dumps(result))

    async def test_bing_advertised_and_argument_errors_distinct(self):
        tools = ToolSession(load_catalog(), search_provider="bing")
        self.assertIn("web_search", [t["function"]["name"] for t in tools.definitions()])
        result = await tools.execute("web_search", '{"query":""}')
        self.assertEqual(result["code"], "invalid_arguments")

    def test_bing_is_cli_default_and_other_providers_remain_selectable(self):
        self.assertEqual(build_parser().parse_args([]).search_provider, "bing")
        for name in ("bing", "duckduckgo", "brave"):
            self.assertEqual(build_parser().parse_args(["--search-provider", name]).search_provider, name)
