"""Streaming text/expression bridge; demo and any OpenAI-compatible LLM."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import ipaddress
import os
import re
import secrets
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

if not __package__:
    # Support `python controller/bridge.py` as well as `python -m controller.bridge`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CATALOG = Path(__file__).resolve().parents[1] / "renderer" / "expressions.json"
ORIGIN = "http://127.0.0.1:8770"
DEMO = (
    "[soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]"
)
TAG = re.compile(r"([a-z][a-z0-9-]*)(?::([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?")
THINKING, THINKING_WEIGHT = "thinking", 0.6
MAX_IN_FLIGHT = 3  # sentences being synthesised or aligned at once
MAX_FRAME = 65536 * 2  # TODO: largest accepted browser message (bytes)
MAX_PROMPT = 4000  # TODO: longest accepted chat prompt (characters)
MAX_TOKENS = 1024 * 2
MIN_CONTEXT = 65536  # smallest context window assumed or accepted (tokens)
CONTEXT_MARGIN = 512  # tokens kept spare beyond the estimate
MESSAGE_OVERHEAD = 8  # estimated chat-template tokens per message
TRIM_TO = 0.75  # trim history below this share of the budget to keep the prompt cache warm
MAX_TURNS = 100  # user/assistant pairs kept per connection
LOG = logging.getLogger(__name__)


def load_catalog(path=CATALOG):
    catalog = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(catalog, dict) or "neutral" not in catalog:
        raise ValueError("Catalog must contain neutral")
    for name, entry in catalog.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]*", name) or not isinstance(entry, dict):
            raise ValueError("Invalid catalog entry")
        if (
            not isinstance(entry.get("description"), str)
            or not entry["description"].strip()
        ):
            raise ValueError(f"Missing description: {name}")
        morphs = entry.get("morphs")
        if not isinstance(morphs, dict) or any(
            not key.strip()
            or isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= 1
            for key, value in morphs.items()
        ):
            raise ValueError(f"Invalid morphs: {name}")
    if catalog["neutral"]["morphs"]:
        raise ValueError("Neutral must have no morphs")
    return catalog


class TagParser:
    """Preserve prose; discard reserved bracket controls unless allowlisted.

    Buffer at most 128 tag characters. Oversized blocks are discarded through
    their closing bracket. finish() discards an unfinished block.
    """

    def __init__(self, catalog):
        self.catalog = catalog
        self.pending = None
        self.overflow = False

    def feed(self, chunk):
        events, text = [], []

        def flush():
            if text:
                events.append({"type": "say", "text": "".join(text)})
                text.clear()

        for char in chunk:
            if self.pending is None:
                if char == "[":
                    flush()
                    self.pending = ""
                else:
                    text.append(char)
            elif char == "]":
                match = None if self.overflow else TAG.fullmatch(self.pending)
                if match and match[1] in self.catalog:
                    weight = float(match[2]) if match[2] is not None else 1.0
                    if math.isfinite(weight):
                        events.append(
                            {
                                "type": "expression",
                                "name": match[1],
                                "weight": max(0.0, min(1.0, weight)),
                            }
                        )
                else:
                    LOG.warning("Dropped invalid or unknown control tag")
                self.pending, self.overflow = None, False
            elif not self.overflow:
                self.pending += char
                if len(self.pending) > 128:
                    self.pending, self.overflow = "", True
        flush()
        return events

    def finish(self):
        if self.pending is not None:
            LOG.warning("Dropped unfinished control tag")
        self.pending, self.overflow = None, False
        return []


def system_prompt(catalog):
    return (
        "You are Yidhari, a warm, concise companion. Answer the user. "
        "Place optional emotion tags BEFORE the text they affect, one mood at a time. "
        "Use [name] or [name:0.6], intensity 0 to 1. Use tags sparingly. "
        "Use [neutral] to clear the mood. Square brackets are reserved for controls; "
        "avoid them in ordinary prose. Never invent tags or output morph names. "
        "Allowed expressions:\n"
        + "\n".join(
            f'[{name}]: {entry["description"]}' for name, entry in catalog.items()
        )
    )


def estimate_tokens(text):
    """Conservative token estimate: UTF-8 bytes / 3 over-counts English, and
    counts CJK and emoji as at least a token per character."""
    return math.ceil(len(text.encode("utf-8")) / 3)


class ContextOverflow(Exception):
    """llama-server rejected the request as larger than its context window."""


class Conversation:
    """Completed user/assistant pairs for one connection, trimmed to a token budget."""

    def __init__(self, window):
        self.budget = window - MAX_TOKENS - CONTEXT_MARGIN
        self.turns = []

    def commit(self, prompt, reply):
        self.turns.append((prompt, reply))
        del self.turns[:-MAX_TURNS]

    def clear(self):
        self.turns.clear()

    def shrink(self):
        """Drop the older half of history after an overflow; False if none is left."""
        if not self.turns:
            return False
        del self.turns[: max(1, len(self.turns) // 2)]
        return True

    def messages(self, system, prompt):
        """System prompt, earlier pairs, then ``prompt``. Over budget, the oldest
        pairs go until it fits in TRIM_TO of the budget, so the prefix stays
        stable for the next few turns."""

        def cost(text):
            return estimate_tokens(text) + MESSAGE_OVERHEAD

        used = cost(system) + cost(prompt)
        used += sum(cost(user) + cost(reply) for user, reply in self.turns)
        if used > self.budget:
            while self.turns and used > TRIM_TO * self.budget:
                user, reply = self.turns.pop(0)
                used -= cost(user) + cost(reply)
        history = [
            message
            for user, reply in self.turns
            for message in (
                {"role": "user", "content": user},
                {"role": "assistant", "content": reply},
            )
        ]
        return [
            {"role": "system", "content": system},
            *history,
            {"role": "user", "content": prompt},
        ]


def completions_url(base_url):
    """Chat-completions endpoint for a base URL that may already end in
    ``/v1`` or be the full endpoint (proxies often include ``/v1``)."""
    base = (base_url or "").strip().rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.rsplit("/", 1)[-1] == "v1":
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def is_loopback_url(base_url):
    host = urlsplit(base_url or "").hostname
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_llm_header(text):
    name, sep, value = text.partition(":")
    name, value = name.strip(), value.strip()
    if (
        not sep
        or not value
        or not re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+", name)
        or name.lower() == "authorization"
        or any(c in value for c in "\r\n")
    ):
        raise argparse.ArgumentTypeError(
            "must be 'Name: Value' (Authorization comes from --api-key-env)"
        )
    return (name, value)


@dataclass
class LlmConfig:
    endpoint: str
    external: bool
    headers: dict = field(default_factory=dict)


def resolve_llm_config(base_url, model, api_key_env, extra_headers,
                       allow_no_key=False, environ=None):
    """Validate the upstream once at startup; fail fast rather than per-chat.
    The key value itself is never logged or returned beyond the header."""
    environ = os.environ if environ is None else environ
    parts = urlsplit((base_url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise argparse.ArgumentTypeError(
            "--llama-url must be an http(s) URL with a host"
        )
    if parts.username or parts.password:
        raise argparse.ArgumentTypeError(
            "--llama-url must not embed credentials; use --api-key-env"
        )
    external = not is_loopback_url(base_url)
    if external and not model:
        raise argparse.ArgumentTypeError(
            "a non-loopback --llama-url requires --model"
        )
    headers = {}
    for name, value in extra_headers or []:
        if name.lower() == "authorization":
            raise argparse.ArgumentTypeError(
                "Authorization must come from --api-key-env, not --llm-header"
            )
        headers[name] = value
    if not api_key_env or not api_key_env.strip():
        raise argparse.ArgumentTypeError("--api-key-env must name a variable")
    key = (environ.get(api_key_env) or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    elif external and not allow_no_key:
        raise argparse.ArgumentTypeError(
            f"API key environment variable {api_key_env} is not set; export it, "
            "rename it with --api-key-env, or pass --allow-no-key for a keyless proxy"
        )
    return LlmConfig(completions_url(base_url), external, headers)


def context_tokens_arg(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a whole number of tokens") from None
    if value < MIN_CONTEXT:
        raise argparse.ArgumentTypeError(f"must be at least {MIN_CONTEXT}")
    return value


async def context_window(base_url, override=None):
    """Tokens one request may use: ``override``, else llama-server's per-slot
    ``n_ctx`` from /props, else MIN_CONTEXT."""
    if override is not None:
        return override
    if not is_loopback_url(base_url):
        LOG.warning(
            "Not probing external %s/props; assuming %d tokens (set "
            "--context-tokens for your model)", base_url.rstrip("/"), MIN_CONTEXT
        )
        return MIN_CONTEXT
    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10), trust_env=False) as client:
            response = await client.get(base_url.rstrip("/") + "/props")
            response.raise_for_status()
            n_ctx = response.json()["default_generation_settings"]["n_ctx"]
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        n_ctx = None
    if not isinstance(n_ctx, int) or isinstance(n_ctx, bool) or n_ctx <= 0:
        LOG.warning(
            "Could not read the context window from %s/props; assuming %d tokens "
            "(set --context-tokens to override)", base_url.rstrip("/"), MIN_CONTEXT
        )
        return MIN_CONTEXT
    if n_ctx < MIN_CONTEXT:
        LOG.warning(
            "llama-server context is %d tokens; start it with -c %d or more for chat history",
            n_ctx, MIN_CONTEXT,
        )
    return n_ctx


async def sse_data(lines):
    """Join SSE data lines; support comments, CRLF, and final EOF record."""
    data = []
    async for line in lines:
        if line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
        elif not line and data:
            yield "\n".join(data)
            data.clear()
    if data:
        yield "\n".join(data)


async def completion_deltas(base_url, model, messages, on_reasoning=None, headers=None,
                            tools=None):
    """One SSE request. Tool fragments remain data until a complete stream."""
    import httpx

    payload = {"stream": True, "max_tokens": MAX_TOKENS, "messages": messages}
    if model:
        payload["model"] = model
    if tools:
        payload["tools"] = tools
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(120, connect=10), trust_env=False
    ) as client:
        async with client.stream(
            "POST", completions_url(base_url), json=payload, headers=headers or None
        ) as response:
            if response.status_code == 400:
                await response.aread()
                if any(
                    marker in response.text
                    for marker in ("exceed_context_size", "context_length_exceeded")
                ):
                    raise ContextOverflow(response.text[:200])
            response.raise_for_status()
            async for body in sse_data(response.aiter_lines()):
                if body == "[DONE]":
                    return
                event = json.loads(body)
                if not isinstance(event, dict) or "error" in event:
                    raise ValueError("Invalid LLM stream or upstream error")
                choices = event.get("choices", [])
                if choices:
                    if tools and choices[0].get("finish_reason") in ("length", "content_filter"):
                        raise ValueError("Tool-enabled completion was truncated or filtered")
                    delta = choices[0].get("delta", {})
                    if on_reasoning is not None and (
                        delta.get("reasoning_content") or delta.get("reasoning")
                    ):
                        await on_reasoning()
                    yield delta
            raise ValueError("LLM stream ended without [DONE]")


async def llama_chunks(base_url, model, messages, on_reasoning=None, headers=None,
                      tool_session=None, on_tool=None):
    """Stream prose and validated moods, continuing bounded companion tool rounds."""
    from controller.tools import MAX_TOOL_ROUNDS, ToolCalls

    messages = list(messages)
    for round_number in range(MAX_TOOL_ROUNDS + 1):
        calls, content = ToolCalls(), []
        async for delta in completion_deltas(
            base_url, model, messages, on_reasoning, headers,
            tools=tool_session.definitions() if tool_session is not None else None,
        ):
            text = delta.get("content")
            if isinstance(text, str) and text:
                content.append(text)
                yield text
            if delta.get("tool_calls"):
                if tool_session is None:
                    raise ValueError("Received tool calls while tools are disabled")
                calls.feed(delta["tool_calls"])
        complete = calls.complete()
        if not complete:
            return
        if round_number == MAX_TOOL_ROUNDS:
            raise ValueError("Tool round limit reached")
        messages.append({"role": "assistant", "content": "".join(content) or None,
                         "tool_calls": complete})
        for call in complete:
            function = call["function"]
            # Status strings are bridge-authored; never echo untrusted names/arguments.
            allowed = {t["function"]["name"] for t in tool_session.definitions()}
            if on_tool is not None:
                await on_tool({"type": "notice", "text": f"Using {function['name']}…" if function["name"] in allowed else "Rejecting unknown tool."})
            result = await tool_session.execute(function["name"], function["arguments"])
            if on_tool is not None:
                await on_tool({"type": "notice", "text": "Tool failed or rejected." if "error" in result else "Tool complete."})
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "content": json.dumps(result, ensure_ascii=False, allow_nan=False)})
            if "expression" in result:
                expression = result["expression"]
                # Reuse tag parsing and speech mood timing; never send raw morphs.
                yield f"[{expression['name']}:{expression['weight']}]"


async def demo_chunks():
    for chunk in [
        "[soft-",
        "smile:0.6]",
        " Good morning. ",
        "[think",
        "ing:0.5]",
        "Let me think about that. ",
        "[neutral]",
    ]:
        yield chunk
        await asyncio.sleep(
            2 if not chunk.startswith("[") and "]" not in chunk else 0.05
        )


async def speak_segments(queue, send, worker, run=None):
    """Synthesise queued sentences with up to MAX_IN_FLIGHT in progress; announce in order.

    A failed sentence is skipped with a notice and never blocks later ones. On
    cancellation the remaining work is cancelled and the worker drops the run.
    Returns the number of clips announced.
    """
    from controller.speech import synthesise

    started = time.perf_counter()
    slots = asyncio.Semaphore(MAX_IN_FLIGHT)
    ordered = asyncio.Queue()

    async def submit():
        try:
            while (segment := await queue.get()) is not None:
                await slots.acquire()
                ordered.put_nowait(
                    (segment, asyncio.create_task(synthesise(segment, worker, run)))
                )
        finally:
            # Always end the ordered stream, so a submit failure surfaces instead of hanging.
            ordered.put_nowait(None)

    submitter = asyncio.create_task(submit())
    first = True
    spoken = 0
    try:
        while (item := await ordered.get()) is not None:
            segment, task = item
            try:
                clip_id, timings = await task
            except Exception:
                LOG.exception("Speech failed for: %s", segment.text)
                await send(
                    {
                        "type": "notice",
                        "text": "Speech failed for one sentence; see bridge terminal.",
                    }
                )
                continue
            finally:
                slots.release()
            if first:
                timings["firstClipSeconds"] = round(time.perf_counter() - started, 2)
                first = False
            LOG.info("Speech %s %s: %s", clip_id, timings, segment.text)
            await send(
                {
                    "type": "speak",
                    "id": clip_id,
                    "expression": segment.expression,
                    "weight": segment.weight,
                    "text": segment.text,
                }
            )
            spoken += 1
        await submitter
        return spoken
    except asyncio.CancelledError:
        if run is not None and hasattr(worker, "cancel"):
            worker.cancel(run)
        raise
    finally:
        submitter.cancel()
        leftovers = [submitter]
        while not ordered.empty():
            item = ordered.get_nowait()
            if item is not None:
                item[1].cancel()
                leftovers.append(item[1])
        await asyncio.gather(*leftovers, return_exceptions=True)


async def handle_connection(socket, args, catalog):
    from websockets.exceptions import ConnectionClosed

    worker = getattr(args, "speech_worker", None)
    system = system_prompt(catalog)
    tool_session = None
    if getattr(args, "tools", False):
        from controller.tools import ToolSession, TOOL_PROMPT

        tool_session = ToolSession(catalog, search_key=getattr(args, "search_key", None))
        system += TOOL_PROMPT
    conversation = None  # created on the first LLM request, once the window is known

    async def send(event):
        await socket.send(json.dumps(event, ensure_ascii=False, allow_nan=False))

    async def chat_chunks(prompt, on_reasoning, reply):
        """Stream a reply with history; after an overflow before any text, retry once
        with the older half of history dropped."""
        nonlocal conversation
        if conversation is None:
            conversation = Conversation(
                await context_window(args.llama_url, getattr(args, "context_tokens", None))
            )
        if tool_session is not None:
            tool_session.executed = False
        for attempt in range(2):
            messages = conversation.messages(system, prompt)
            try:
                async for chunk in llama_chunks(
                    args.llama_url,
                    args.model,
                    messages,
                    on_reasoning,
                    headers=getattr(args, "llm_headers", None),
                    **({"tool_session": tool_session, "on_tool": send} if tool_session is not None else {}),
                ):
                    reply.append(chunk)
                    yield chunk
                return
            except ContextOverflow:
                if reply or attempt or (tool_session is not None and tool_session.executed) or not conversation.shrink():
                    raise
                LOG.warning("Context overflow; retrying with older history dropped")

    async def generate(prompt):
        parser = TagParser(catalog)
        reply = []
        speaker = None
        thinking = False

        async def on_reasoning():
            # Show the thinking mood once while the model reasons. With speech it
            # stays until the first clip applies its own mood.
            nonlocal thinking
            if not thinking and THINKING in catalog:
                thinking = True
                await send(
                    {"type": "expression", "name": THINKING, "weight": THINKING_WEIGHT}
                )

        try:
            await send({"type": "start"})
            await send({"type": "expression", "name": "neutral", "weight": 1})
            chunks = (
                demo_chunks()
                if args.mode == "demo"
                else chat_chunks(prompt, on_reasoning, reply)
            )
            if worker is not None:
                from controller.speech import Segmenter, clear_live_clips

                clear_live_clips()
                segmenter, queue = Segmenter(), asyncio.Queue()
                run = secrets.token_hex(8)
                speaker = asyncio.create_task(speak_segments(queue, send, worker, run))
            async for chunk in chunks:
                if thinking and worker is None:
                    # Text-only: the answer has started, so drop the thinking face.
                    thinking = False
                    await send({"type": "expression", "name": "neutral", "weight": 1})
                for event in parser.feed(chunk):
                    if worker is None:
                        await send(event)
                        continue
                    # With speech, moods change when each clip starts playing, not on arrival.
                    if event["type"] == "say":
                        await send(event)
                    for segment in segmenter.feed(event):
                        queue.put_nowait(segment)
            if conversation is not None:
                # Only a reply that reached [DONE] is remembered, paired with its prompt.
                conversation.commit(prompt, "".join(reply))
            parser.finish()
            if speaker is not None:
                for segment in segmenter.finish():
                    queue.put_nowait(segment)
                queue.put_nowait(None)
                if await speaker == 0 and thinking:
                    # Nothing was spoken, so no clip will replace the thinking face.
                    await send({"type": "expression", "name": "neutral", "weight": 1})
            await send({"type": "end"})
        except ConnectionClosed:
            pass
        except Exception:
            LOG.exception("Generation failed")
            try:
                await send({"type": "expression", "name": "neutral", "weight": 1})
                await send(
                    {"type": "error", "text": "Generation failed; see bridge terminal."}
                )
            except ConnectionClosed:
                pass
        finally:
            if speaker is not None and not speaker.done():
                speaker.cancel()
                await asyncio.gather(speaker, return_exceptions=True)

    task = None
    try:
        async for raw in socket:
            try:
                if not isinstance(raw, str):
                    raise ValueError("Unknown request")
                request = json.loads(raw)
                if not isinstance(request, dict) or request.get("type") not in (
                    "start",
                    "reset",
                ):
                    raise ValueError("Unknown request")
                if request["type"] == "reset":
                    prompt = None
                elif "prompt" in request:
                    prompt = request["prompt"]
                    if (
                        not isinstance(prompt, str)
                        or not prompt.strip()
                        or len(prompt) > MAX_PROMPT
                    ):
                        raise ValueError("Invalid prompt")
                else:
                    prompt = getattr(args, "prompt", None)
            except (ValueError, TypeError):
                LOG.warning("Dropped invalid browser request")
                continue
            if request["type"] == "reset":
                # New chat: stop any reply and forget every turn.
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                if conversation is not None:
                    conversation.clear()
                if tool_session is not None:
                    tool_session.clear()
                await send({"type": "reset"})
                continue
            if task is not None and not task.done():
                LOG.warning("Dropped start request while generation is active")
                continue
            task = asyncio.create_task(generate(prompt))
    except ConnectionClosed:
        pass
    finally:
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def run(args):
    from websockets.asyncio.server import serve

    catalog = load_catalog()
    args.speech_worker = None
    if args.speech_settings is not None:
        from controller.speech import ApplioWorker

        args.speech_settings.check()
        print("Starting Applio worker (loads the voice model once)…", flush=True)
        args.speech_worker = ApplioWorker(args.speech_settings)
        try:
            ready = await args.speech_worker.start()
        except BaseException:
            await args.speech_worker.close()
            raise
        print(
            f"Applio worker ready: load {ready['loadSeconds']}s, warm-up {ready['warmSeconds']}s",
            flush=True,
        )

    async def handler(socket):
        await handle_connection(socket, args, catalog)

    try:
        async with serve(
            handler,
            "127.0.0.1",
            args.port,
            origins=[ORIGIN],
            max_size=MAX_FRAME,
            max_queue=4,
        ):
            speech = "speech on" if args.speech_worker is not None else "text only"
            upstream = ""
            if args.mode == "llm":
                host = urlsplit(args.llama_url).netloc or args.llama_url
                auth = "key sent" if getattr(args, "llm_headers", {}).get(
                    "Authorization"
                ) else "no key"
                place = "external" if getattr(args, "llm_external", False) else "local"
                upstream = (
                    f"; LLM {host} model={args.model or 'server default'} "
                    f"({place}, {auth})"
                )
                if getattr(args, "llm_external", False):
                    upstream += " — prompts and history leave this machine"
                if getattr(args, "tools", False):
                    upstream += "; companion tools on"
                if getattr(args, "web_search", False):
                    upstream += "; Brave web search on — queries leave this machine"
            print(
                f"Bridge: ws://127.0.0.1:{args.port} ({args.mode}, {speech}){upstream}; open {ORIGIN}/renderer/",
                flush=True,
            )
            await asyncio.Future()
    finally:
        if args.speech_worker is not None:
            await args.speech_worker.close()


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["demo", "llm"], default="demo")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--llama-url", default="http://127.0.0.1:8080")
    parser.add_argument("--model", default=None)
    parser.add_argument("--tools", action="store_true", help="Enable allowlisted companion tool calling.")
    parser.add_argument("--web-search", action="store_true", help="Enable Brave web_search (requires --tools and BRAVE_SEARCH_API_KEY).")
    parser.add_argument(
        "--api-key-env",
        default="OPENAI_API_KEY",
        help="Environment variable holding the upstream API key (default: OPENAI_API_KEY).",
    )
    parser.add_argument(
        "--llm-header",
        type=parse_llm_header,
        action="append",
        default=[],
        metavar="NAME: VALUE",
        help="Extra header for the LLM request; repeatable. Authorization comes from --api-key-env.",
    )
    parser.add_argument(
        "--allow-no-key",
        action="store_true",
        help="Allow a non-loopback --llama-url with no API key (keyless proxies only).",
    )
    parser.add_argument(
        "--context-tokens",
        type=context_tokens_arg,
        default=None,
        help=f"Model context window in tokens (at least {MIN_CONTEXT}); default reads llama-server /props.",
    )
    parser.add_argument(
        "--prompt", default="Say good morning, then think about what we could work on."
    )
    parser.add_argument(
        "--speech",
        action="store_true",
        help="Speak each sentence with the selected TTS source, Applio RVC and lip sync.",
    )
    parser.add_argument(
        "--applio-dir",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "Applio",
        help="Applio installation to launch (default: ../Applio; use ../Applio-rocm for ROCm).",
    )
    parser.add_argument(
        "--pth",
        type=Path,
        help="Applio voice model (.pth); default is the Yidhari model under --applio-dir.",
    )
    parser.add_argument(
        "--index",
        type=Path,
        help="Applio voice index (.index); default is the Yidhari index under --applio-dir.",
    )
    parser.add_argument("--tts", choices=["edge", "kokoro"], default="edge")
    parser.add_argument("--kokoro-voice", default="af_heart")
    parser.add_argument("--kokoro-speed", type=float, default=1.0)
    parser.add_argument("--kokoro-threads", type=int, default=2)
    parser.add_argument("--rvc-threads", type=int, default=0)
    return parser


def main():
    args = build_parser().parse_args()
    args.search_key = None
    if args.web_search:
        if args.mode != "llm" or not args.tools:
            raise SystemExit("bridge: error: --web-search requires --mode llm --tools")
        args.search_key = os.environ.get("BRAVE_SEARCH_API_KEY", "").strip()
        if not args.search_key:
            raise SystemExit("bridge: error: --web-search requires BRAVE_SEARCH_API_KEY")
    args.llm_headers, args.llm_external = {}, False
    if args.mode == "llm":
        try:
            config = resolve_llm_config(
                args.llama_url, args.model, args.api_key_env,
                args.llm_header, allow_no_key=args.allow_no_key,
            )
        except argparse.ArgumentTypeError as error:
            raise SystemExit(f"bridge: error: {error}") from None
        args.llm_headers, args.llm_external = config.headers, config.external
    args.speech_settings = None
    if args.speech:
        from controller.speech import ApplioSettings

        args.speech_settings = ApplioSettings(
            applio_dir=args.applio_dir.expanduser().resolve(),
            tts_provider=args.tts,
            kokoro_voice=args.kokoro_voice,
            kokoro_speed=args.kokoro_speed,
            kokoro_threads=args.kokoro_threads,
            rvc_threads=args.rvc_threads,
            **({"pth": args.pth.expanduser().resolve()} if args.pth else {}),
            **({"index": args.index.expanduser().resolve()} if args.index else {}),
        )
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
