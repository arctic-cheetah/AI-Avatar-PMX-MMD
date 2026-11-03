# LLM companion tools (issues #23 and #48)

Tools are opt-in and require an OpenAI-compatible server/model that supports
streaming `delta.tool_calls`. Existing text/mood-tag mode stays the default.
No extra Python packages are required beyond `requirements.txt`.

```bash
.venv/bin/python controller/bridge.py --mode llm --tools
```

For an external provider, keep the URL/model/key options described in
[external-llm.md](external-llm.md) and add `--tools`. If the provider rejects
the tools schema, restart without the flag; the bridge never silently retries
an unsupported schema. Legacy `function_call` responses are unsupported.

## Allowlist

| Tool | Arguments | Result / action |
| --- | --- | --- |
| `get_time` | `{}` | Bridge host's local ISO date/time with UTC offset and timezone name |
| `set_expression` | `{"name":"soft-smile","weight":0.6}` | Catalog expression and finite weight from 0 to 1; weight defaults to 1 |
| `remember` | `{"note":"Prefers tea"}` | Store one trimmed note, 1–500 characters |
| `recall` | `{}` | Return the session's notes, oldest first |
| `web_search` | `{"query":"confirm this","url":"https://en.wikipedia.org/wiki/Example"}` | Provider, actual query and up to five titles, URLs and snippets. Optional `site` is one public hostname. Optional `url` must be an HTTP(S) URL in the current user message |
| `read_webpage` | `{"url":"https://example.com/article"}` | Readable text and provenance for a URL returned by this connection's recent searches; enabled with web search |

Notes are held only in memory for one WebSocket connection, capped at 20
(oldest evicted). **New chat** clears notes and conversation history. A
disconnect also forgets notes. Notes survive normal history trimming. Tool
actions that finished before cancellation/failure remain effective until reset;
incomplete streams never execute buffered calls. There is no persistent memory.

`set_expression` feeds the existing mood-tag parser and speech segmenter.
With speech enabled the mood belongs to the following spoken segment and is
applied when its clip plays. Ordinary bracket tags remain supported. Tools
never control phonemes, visemes, Rhubarb alignment, Applio or clip timing.

## Optional keyless Bing web search

Bing RSS is the default provider and needs no API key or extra packages:

```bash
.venv/bin/python controller/bridge.py --mode llm --tools --web-search
```

`--web-search` requires `--mode llm --tools`. It advertises `web_search` only
while enabled. `--search-provider bing` selects the default explicitly.
The bridge requests the fixed HTTPS Bing search endpoint with `format=rss`,
parses titles, links and descriptions from RSS, and returns up to five results.
No API key or extra packages are required. This is an unofficial RSS
integration, separate from Microsoft's retired Search API; availability and
result quality can vary. XML document types/entities are rejected.

DuckDuckGo remains available via `--search-provider duckduckgo`.
The bridge posts the query to DuckDuckGo's fixed HTTPS HTML search endpoint,
parses result titles/snippets, and unwraps DuckDuckGo result redirect URLs
without visiting them. This is an unofficial HTML integration: CAPTCHA,
throttling or layout changes can make search unavailable. The bridge reports
those failures rather than bypassing challenges or returning a misleading
empty result. An explicit no-results page returns an empty list.

Brave remains an optional API provider:

```bash
export BRAVE_SEARCH_API_KEY='<your Brave Search API key>'
.venv/bin/python controller/bridge.py --mode llm --tools --web-search \
  --search-provider brave
```

Only Brave requires `BRAVE_SEARCH_API_KEY`; startup fails if it is missing
when Brave search is enabled. A Brave key in the environment does not switch
the default away from Bing. Brave API queries may incur usage charges.
There is no automatic cross-provider fallback.

Search queries (1–300 characters) leave this machine for the selected
provider. An optional `site` argument must be one public hostname, such as
`en.wikipedia.org`. The bridge lowercases it and sends `site:hostname` plus
the original query. It rejects schemes, paths, credentials, spaces, IP
addresses and local names. `site` does not fetch that host and does not add
it to the page allowlist. A `url` argument is accepted only when that exact
public HTTP(S) URL appears in the current user message. The bridge then searches
for that client-provided URL instead of the model's rewritten query. It does not
fetch the URL by itself. `read_webpage` can still read only URLs the provider
actually returned, including a trailing-slash equivalent of a returned URL.
A fetch failure, including an internal transport error, is a sanitized tool
error. It does not abort the reply. Bing does not guarantee that every result stays on the
named host. A check on 4 November 2026 found general anime queries returning
unrelated government or bicycle pages, while `site:en.wikipedia.org` returned
relevant Wikipedia and wiki pages for the same subjects. That is a retrieval
observation, not a promise that `site:` will always be honored.
The LLM key and extra LLM headers are never sent to search providers;
Bing and DuckDuckGo receive no API key. Redirects and environment proxies are disabled.
Search itself does not follow result links. `read_webpage`, described below,
may later read only a retained result URL. No shell, file access, MCP or
delegated agent is added here.

Results have at most five entries, each bounded to a 200-character title,
2000-character HTTP(S) URL and 500-character snippet. The response body is
capped at 256 KiB and search has a 10-second overall deadline. Empty results
are valid. Rate limits, timeouts and malformed responses return a sanitized
tool error so the model can explain that search failed. Chat notices distinguish
blocked/rate-limited searches, network failures, invalid provider responses and
invalid tool arguments, without exposing raw provider responses. Search content is
untrusted data; the system prompt tells the model to ignore instructions in
results and cite source URLs. This reduces injection risk but cannot guarantee
model compliance. Avoid searching for secrets or storing sensitive notes;
tool results go to the selected LLM provider during that turn.

## Bounded webpage reading and retained evidence (issue #48)

With `--web-search`, each successful `web_search` also records its actual
provider, query and normalized results in the connection's in-memory evidence
log. Those records—not a model's description of what it searched—are supplied
on later completion requests. Asking “what did the search return?” therefore
uses bounded bridge records, although the model can still summarize them
incorrectly. Search transport success, an empty result list and relevant
evidence remain different outcomes.

The evidence log holds at most eight searches and four successful page reads.
Each record is bounded by the source and extraction limits below. Older search
records are evicted first when the retained evidence exceeds 48 KiB of UTF-8
JSON; newer records are kept. These records, tool schemas and fetched text are
included in the bridge's conservative prompt-token estimate, so ordinary
history trimming accounts for their size. **New chat** and disconnect clear the
evidence log, allowed source URLs and fetch count. They do not create
persistent browsing history or notes.

`read_webpage` accepts only the exact HTTP(S) URL of a currently retained
search result, without a fragment or embedded credentials. Only default ports
80 and 443 are supported. Redirect destinations must also be currently
registered search-result URLs; there are at most three redirects. The reader
is not a general URL fetcher, crawler or browser and cannot open a URL supplied
only in chat.

Before every request, including redirects, the bridge resolves the host and
rejects it unless every returned IPv4/IPv6 address is globally routable.
Localhost, private/LAN, loopback, link-local, reserved, carrier-grade NAT,
multicast and cloud-metadata addresses are rejected. One validated address is
pinned at the network backend for that connection while the URL hostname is
retained for HTTP Host, TLS SNI and certificate verification. No fresh DNS
lookup occurs during the connection, preventing a second answer from silently
selecting a private address. A new redirect connection repeats validation.
DNS itself can still be spoofed by a hostile network; HTTPS certificate
verification remains necessary.

The reader uses `trust_env=False` and explicit safe request headers. It does
not forward LLM/search API keys, authorization, cookies, proxy credentials or
custom LLM headers. It does not execute JavaScript, submit forms, bypass
logins, paywalls, CAPTCHAs or provider challenges, or retain cookies across
redirects. Requests use a 15-second overall deadline, 1 MiB download cap, four
successful reads per connection, and 20,000-character extracted-text cap.
Each redirect response is also size-capped. Compressed bodies are decoded by
HTTPX within the same byte cap.

Only `text/html` and `application/xhtml+xml` are accepted. A missing charset
defaults to UTF-8; a declared charset is honored, and undecodable bytes are a
fetch error rather than replacement text. HTML `script`,
`style`, `noscript`, `template`, `nav`, `form`, `iframe` and SVG content are
excluded. Text from headings, paragraphs, lists, tables and other readable
markup is whitespace-normalized; the title, requested/final URL, timezone-aware
retrieval time, redirect count, truncation flag and `untrusted_content` trust
marker are returned. Malformed HTML uses the standard parser's deterministic
recovery. Unsupported content types, unknown/invalid declared charsets, broken
compression, empty readable text, HTTP/network failures, oversized bodies and
fetch-limit exhaustion have separate sanitized error codes. There is no PDF,
media or screenshot extraction.

Retrieved text remains untrusted data, including when retained for later turns.
Instructions in a page do not change system/tool rules, become session notes,
expand the source allowlist or authorize further actions. The model is asked
to cite only claims supported by relevant page content. A successful fetch and
parse does not establish factual accuracy or search relevance.

Source URLs stay visible as text in the chat transcript and are not rendered as
raw HTML. With speech enabled, the speech segmenter omits HTTP(S) URLs while
retaining surrounding answer text; URLs do not become spoken phonemes or alter
alignment cues. The same completed answer remains in text history.

### Recommended live evaluation

Use a small dated evaluation log with the provider, exact query, raw result
titles/URLs, a human relevance judgment, fetched-page outcome and final
citations. Include the unsuccessful anime queries from issue #48, a relevant
character-name query, an authoritative-documentation query and a simple factual
query. Score relevance separately from HTTP/parsing success. Do not hard-code
live rankings into regression tests or treat fetching unrelated pages as a
repair for retrieval quality. No live provider ranking, login-protected page,
or end-to-end voice quality is validated by mocked tests.

## Request and display flow

1. Advertise the fixed tool schemas on each completion request.
2. Collect tool-call ID/name/argument fragments by index; execute only after
   the stream's `[DONE]` marker. Reasoning remains hidden.
3. Append the assistant's complete `tool_calls`, then one `role: tool` result
   per call with the matching `tool_call_id`, and request continuation.
4. Feed ordinary answer text and validated expression controls through the
   existing text/speech pipeline. Only the completed spoken/text reply is
   retained in conversation history; tool protocol messages stay in this turn.
5. On later turns, prepend a bounded JSON evidence block to the system prompt.
   It records real provider/query/source/page provenance, is marked untrusted,
   and is counted along with the advertised tool schemas in context trimming.

The chat log displays short tool status notices and a bounded Sources line for
successful searches and page reads: provider, query, titles, URLs, snippets,
page title, final URL, truncation and an explicit note that transport success
is not relevance or verification. Sources are written with `textContent`.
Arguments, credentials, raw provider errors and full transport bodies are not
shown. Tool activity and source lines are not spoken. The loop permits four
tool rounds, up to eight calls per round, and 4096 argument characters per
call. Unknown/disabled tools, invalid JSON, extra arguments and invalid values
return errors to the model. Broken protocol envelopes, oversized call buffers,
or incomplete streams fail generation with the normal error notice.
After four tool rounds, the bridge requests one final answer with no tools
advertised. It instructs the model to use relevant evidence, acknowledge
uncertainty if results are unhelpful, and stop promising further searches.
If that final response is empty or still contains tool calls, the bridge
discards its prose and emits a short uncertainty reply instead. No fifth
round of tools executes. The final answer/fallback uses the normal text and
speech pipeline and can be retained in conversation history.
Overflow retries happen only before text or tool actions have started,
so completed actions are never replayed by that retry.

## Validation

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_tools.py' -v
.venv/bin/python -m unittest discover -s tests -p 'test_read_webpage.py' -v
.venv/bin/python -m unittest discover -s tests -v
node --test tests/renderer/
```

Tests mock upstream LLM/search/webpage responses, DNS answers and speech
synthesis, requiring no
paid API or voice model. DuckDuckGo tests use HTML fixtures, including blocked
and empty-result pages. For live checks, ask for the current time, ask her to
remember a preference, recall it, then choose **New chat** and recall again.
With search enabled ask for recent news with sources. With speech enabled,
confirm a tool-assisted reply speaks and uses the selected catalog mood.
Provider-specific formatting and real audio/search quality require these live
checks; automated mocks do not establish compatibility with every model.

A live DuckDuckGo check on 1 November 2026 reached the provider but received
HTTP 202 with a challenge page from this connection. The tool returned the
expected sanitized failure; successful live result retrieval remains unverified.

The DuckDuckGo failure above was an anti-bot challenge, not an empty search:
the HTTP status and challenge form were observed directly. The provider did
not disclose why this connection was challenged. Automated traffic detection,
IP reputation and request patterns are possible triggers, not confirmed causes.

A direct Bing RSS check on 1 November 2026 returned HTTP 200 and ten RSS items.
The bridge still limits output to five. A successful request does not establish
relevance, continued availability or end-to-end spoken response quality.

## Search quality and retry limits

Bing can return valid HTTP 200/RSS responses whose results are unrelated to
the full query. A replay of `My Dress-Up Darling anime female protagonist
name` returned results such as myGov on 1 November 2026. Successful parsing
does not establish search relevance. The LLM must judge relevance; the bridge
does not have a semantic relevance filter or a guaranteed alternate provider.

The tool prompt asks the model to preserve the user's subject, avoid invented
names in query rewrites, use `site` for an authoritative hostname when general
results are unrelated, and stop after two unhelpful searches. This is model
guidance, not an enforced per-search counter; the four-round bridge limit is
the enforced safeguard. It prevents runaway tool use and now ends gracefully,
but cannot guarantee the model's answer is correct or useful. Failed/truncated
upstream requests still use the normal generation error path.
