# LLM companion tools (issue #23)

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
| `web_search` | `{"query":"latest astronomy news"}` | Up to five titles, URLs and snippets; separately enabled below |

Notes are held only in memory for one WebSocket connection, capped at 20
(oldest evicted). **New chat** clears notes and conversation history. A
disconnect also forgets notes. Notes survive normal history trimming. Tool
actions that finished before cancellation/failure remain effective until reset;
incomplete streams never execute buffered calls. There is no persistent memory.

`set_expression` feeds the existing mood-tag parser and speech segmenter.
With speech enabled the mood belongs to the following spoken segment and is
applied when its clip plays. Ordinary bracket tags remain supported. Tools
never control phonemes, visemes, Rhubarb alignment, Applio or clip timing.

## Optional keyless DuckDuckGo web search

DuckDuckGo is the default provider and needs no API key or extra packages:

```bash
.venv/bin/python controller/bridge.py --mode llm --tools --web-search
```

`--web-search` requires `--mode llm --tools`. It advertises `web_search` only
while enabled. `--search-provider duckduckgo` selects the default explicitly.
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
the default away from DuckDuckGo. Brave API queries may incur usage charges.
There is no automatic cross-provider fallback.

Search queries (1–300 characters) leave this machine for the selected
provider. The LLM key and extra LLM headers are never sent to search providers;
DuckDuckGo receives no API key. Redirects and environment proxies are disabled.
The bridge never follows result links or accepts a model-chosen destination
URL. No shell, file access, MCP or delegated agent is added here.

Results have at most five entries, each bounded to a 200-character title,
2000-character HTTP(S) URL and 500-character snippet. The response body is
capped at 256 KiB and search has a 10-second overall deadline. Empty results
are valid. Rate limits, timeouts and malformed responses return a sanitized
tool error so the model can explain that search failed. Search content is
untrusted data; the system prompt tells the model to ignore instructions in
results and cite source URLs. This reduces injection risk but cannot guarantee
model compliance. Avoid searching for secrets or storing sensitive notes;
tool results go to the selected LLM provider during that turn.

## Request and display flow

1. Advertise the fixed tool schemas on each completion request.
2. Collect tool-call ID/name/argument fragments by index; execute only after
   the stream's `[DONE]` marker. Reasoning remains hidden.
3. Append the assistant's complete `tool_calls`, then one `role: tool` result
   per call with the matching `tool_call_id`, and request continuation.
4. Feed ordinary answer text and validated expression controls through the
   existing text/speech pipeline. Only the completed spoken/text reply is
   retained in conversation history; tool protocol messages stay in this turn.

The chat log displays short tool status notices, never arguments, raw result
payloads or credentials. Tool activity is not spoken. The loop permits four
tool rounds, up to eight calls per round, and 4096 argument characters per
call. Unknown/disabled tools, invalid JSON, extra arguments and invalid values
return errors to the model. Broken protocol envelopes, oversized call buffers,
exhausted rounds or incomplete streams fail generation with the normal error
notice. Overflow retries happen only before text or tool actions have started,
so completed actions are never replayed by that retry.

## Validation

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_tools.py' -v
.venv/bin/python -m unittest discover -s tests -v
node --test tests/renderer/
```

Tests mock upstream LLM/search responses and speech synthesis, requiring no
paid API or voice model. DuckDuckGo tests use HTML fixtures, including blocked
and empty-result pages. For live checks, ask for the current time, ask her to
remember a preference, recall it, then choose **New chat** and recall again.
With search enabled ask for recent news with sources. With speech enabled,
confirm a tool-assisted reply speaks and uses the selected catalog mood.
Provider-specific formatting and real audio/search quality require these live
checks; automated mocks do not establish compatibility with every model.
