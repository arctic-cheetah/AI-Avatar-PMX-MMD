# Conversation history

Yidhari remembers earlier turns of the current chat, so a follow-up like
"say another one" keeps the topic. Her memory lasts for one browser connection
only. The chat log on screen survives a page refresh (see
[Chat log after a refresh](#chat-log-after-a-refresh)), but her memory does not.
Nothing is saved across bridge restarts and there is no long-term memory. Full
persistence is tracked in #141.

## How it works

The bridge keeps an ordered list of completed user/assistant pairs for each
WebSocket connection. Each request to llama-server contains:

```text
system prompt  →  earlier pairs (oldest first)  →  newest user message
```

- Typed prompts, voice transcripts and the **Start default response** button
  (which uses `--prompt`) all go through this same path.
- Assistant turns are stored as the raw reply, emotion tags included, so her
  mood style stays consistent. Reasoning (`reasoning_content`) is never stored.
- Earlier turns are context for the model only. The browser receives, shows and
  speaks just the newest reply; old text is never spoken again.

## What gets remembered

A pair is stored only after the model stream finishes with `[DONE]`. The user
message and the reply are stored together, so roles always alternate.

| Outcome                                   | Stored?                       |
| ----------------------------------------- | ----------------------------- |
| Reply completed                           | ✅ prompt and reply           |
| Upstream error, or stream ends without `[DONE]` | ❌ neither (partial text dropped) |
| Cancelled by **New chat** or disconnect   | ❌ neither                    |
| Prompt sent while she is busy (ignored)   | ❌ neither                    |

If speech synthesis fails after the text finished, the reply is still stored,
because the full text already reached the chat log.

## Context window and trimming

The bridge works out the model's context window once per connection:

1. `--context-tokens N`, if given. It must be at least **65,536** (64K).
2. Otherwise `GET {--llama-url}/props` → `default_generation_settings.n_ctx`
   (per-slot size, so `-np` is already accounted for).
3. If that fails, the 64K default is assumed and a warning is logged.

If the server reports less than 64K, the server's value is used, because sending
more than the server holds would fail. A warning suggests raising `-c`.

The history budget is the window minus `max_tokens` (2,048 reserved for the
reply) and a safety margin. Tokens are estimated as UTF-8 bytes ÷ 3, which
over-counts English and counts CJK and emoji as at least a token per character.

When history goes over budget, the oldest whole pairs are dropped until it fits
in 75% of the budget. Trimming further than needed keeps the start of the
prompt unchanged for the next few turns, so llama-server can reuse its prompt
cache instead of reprocessing everything. The system prompt and newest message
are always kept, even when that leaves no room for any history. A hard limit of
100 pairs also caps the bridge's memory use.

If llama-server still rejects a request as too large
(`exceed_context_size_error`), the bridge drops the older half of history and
retries once. If it fails again, she shows an error and nothing is stored.

## New chat and reconnects

- **New chat** (in the chat box bar) sends `{"type":"reset"}`. The bridge cancels
  any reply in progress, forgets all turns and answers `{"type":"reset"}`. The
  browser then clears the chat log and stops any speech still playing.
- Each connection has its own history, so two tabs never share memory.
- A reconnect (bridge restart, network blip, page reload) starts a fresh
  conversation. Old bubbles stay on screen after a blip or a reload, but the
  model no longer sees them. Press **New chat** to clear them.

## Chat log after a refresh

The renderer saves the visible chat log in the tab's `sessionStorage`
(`yidhari.chat-log.v1`) and rebuilds it when the page loads, before the bridge
connects (#105). This is **display only**:

- Saved: your messages, her replies, agent say, ask and report bubbles (with the
  full report text), and tool notices. The raw text is kept, so restored bubbles
  go through the same Markdown rendering as live ones.
- Not saved: the page-open greeting, so refreshing doesn't pile up greetings.
- Restoring plays no speech, changes no mood, runs no tools and sends nothing to
  the bridge. A restored agent question is shown as no longer waiting, and your
  next message starts a normal chat reply.
- Her memory starts fresh. A note under the restored bubbles says she won't
  remember them in new replies.
- A reply that is still streaming when the page unloads, the bridge drops or an
  error arrives is saved with its partial text and labelled **interrupted**.
- **New chat** clears the saved log as well.
- The saved log keeps the latest 200 entries and at most 1,000,000 characters.
  The oldest entries go first.
- `sessionStorage` belongs to one tab. Closing the tab discards the log, and two
  tabs keep separate logs. A duplicated tab starts with a copy.
- If storage is blocked or full, the chat works as before and just isn't saved.
  Damaged saved data is skipped with a notice in the log, and the next message
  saves over it.

## Security note 🛡️

With memory, a successful prompt injection or jailbreak persists for the rest of
the conversation instead of ending with the turn. Only your own messages and
her completed replies are ever stored. **New chat** or a reconnect wipes the
slate. Her history stays in bridge memory only and is never written to disk.
The on-screen log in `sessionStorage` is never sent back to the model. Browsers
can still keep `sessionStorage` in the profile to restore tabs, so treat the
chat log, including agent reports, like any other page content in that
browser profile.

## Example llama-server setup

The reference setup runs `-c 131072 -np 1`, which gives a 128K window for one
conversation:

```bash
llama-server -m model.gguf --host 127.0.0.1 --port 8080 -c 131072 -np 1
```

With `-np 2` each slot gets half (64K). Use `--context-tokens` only if `/props`
is unavailable, for example with a different OpenAI-compatible server.
