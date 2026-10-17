"""Local streaming text/expression bridge; demo and llama-server modes."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import re
import sys
import time
from pathlib import Path

if not __package__:
    # Support `python controller/bridge.py` as well as `python -m controller.bridge`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CATALOG = Path(__file__).resolve().parents[1] / 'renderer' / 'expressions.json'
ORIGIN = 'http://127.0.0.1:8770'
DEMO = '[soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]'
TAG = re.compile(r'([a-z][a-z0-9-]*)(?::([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?')
THINKING, THINKING_WEIGHT = 'thinking', 0.6
LOG = logging.getLogger(__name__)


def load_catalog(path=CATALOG):
    catalog = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(catalog, dict) or 'neutral' not in catalog:
        raise ValueError('Catalog must contain neutral')
    for name, entry in catalog.items():
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name) or not isinstance(entry, dict):
            raise ValueError('Invalid catalog entry')
        if not isinstance(entry.get('description'), str) or not entry['description'].strip():
            raise ValueError(f'Missing description: {name}')
        morphs = entry.get('morphs')
        if not isinstance(morphs, dict) or any(
            not key.strip() or isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not 0 <= value <= 1
            for key, value in morphs.items()
        ):
            raise ValueError(f'Invalid morphs: {name}')
    if catalog['neutral']['morphs']:
        raise ValueError('Neutral must have no morphs')
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
                events.append({'type': 'say', 'text': ''.join(text)})
                text.clear()
        for char in chunk:
            if self.pending is None:
                if char == '[':
                    flush()
                    self.pending = ''
                else:
                    text.append(char)
            elif char == ']':
                match = None if self.overflow else TAG.fullmatch(self.pending)
                if match and match[1] in self.catalog:
                    weight = float(match[2]) if match[2] is not None else 1.0
                    if math.isfinite(weight):
                        events.append({'type': 'expression', 'name': match[1],
                                       'weight': max(0.0, min(1.0, weight))})
                else:
                    LOG.warning('Dropped invalid or unknown control tag')
                self.pending, self.overflow = None, False
            elif not self.overflow:
                self.pending += char
                if len(self.pending) > 128:
                    self.pending, self.overflow = '', True
        flush()
        return events

    def finish(self):
        if self.pending is not None:
            LOG.warning('Dropped unfinished control tag')
        self.pending, self.overflow = None, False
        return []


def system_prompt(catalog):
    return ('You are Yidhari, a warm, concise companion. Answer the user. '
            'Place optional emotion tags BEFORE the text they affect, one mood at a time. '
            'Use [name] or [name:0.6], intensity 0 to 1. Use tags sparingly. '
            'Use [neutral] to clear the mood. Square brackets are reserved for controls; '
            'avoid them in ordinary prose. Never invent tags or output morph names. '
            'Allowed expressions:\n' + '\n'.join(
                f'[{name}]: {entry["description"]}' for name, entry in catalog.items()))


async def sse_data(lines):
    """Join SSE data lines; support comments, CRLF, and final EOF record."""
    data = []
    async for line in lines:
        if line.startswith('data:'):
            data.append(line[5:].removeprefix(' '))
        elif not line and data:
            yield '\n'.join(data)
            data.clear()
    if data:
        yield '\n'.join(data)


async def llama_chunks(base_url, model, prompt, catalog, on_reasoning=None):
    """Yield content deltas. Reasoning text is never forwarded; ``on_reasoning``
    is awaited for each reasoning delta so the avatar can look thoughtful."""
    import httpx
    payload = {'stream': True, 'max_tokens': 1024, 'messages': [
        {'role': 'system', 'content': system_prompt(catalog)},
        {'role': 'user', 'content': prompt}]}
    if model:
        payload['model'] = model
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10), trust_env=False) as client:
        async with client.stream('POST', base_url.rstrip('/') + '/v1/chat/completions', json=payload) as response:
            response.raise_for_status()
            async for body in sse_data(response.aiter_lines()):
                if body == '[DONE]':
                    return
                event = json.loads(body)
                if not isinstance(event, dict) or 'error' in event:
                    raise ValueError('Invalid LLM stream or upstream error')
                choices = event.get('choices', [])
                if choices:
                    delta = choices[0].get('delta', {})
                    if on_reasoning is not None and delta.get('reasoning_content'):
                        await on_reasoning()
                    content = delta.get('content')
                    if isinstance(content, str) and content:
                        yield content
            raise ValueError('LLM stream ended without [DONE]')


async def demo_chunks():
    for chunk in ['[soft-', 'smile:0.6]', ' Good morning. ', '[think',
                  'ing:0.5]', 'Let me think about that. ', '[neutral]']:
        yield chunk
        await asyncio.sleep(2 if not chunk.startswith('[') and ']' not in chunk else .05)


async def speak_segments(queue, send, worker):
    """Synthesise queued sentences in order and announce each clip by ID."""
    from controller.speech import synthesise
    started = time.perf_counter()
    first = True
    while (segment := await queue.get()) is not None:
        try:
            clip_id, timings = await synthesise(segment, worker)
        except Exception:
            LOG.exception('Speech failed for: %s', segment.text)
            await send({'type': 'notice', 'text': 'Speech failed for one sentence; see bridge terminal.'})
            continue
        if first:
            timings['firstClipSeconds'] = round(time.perf_counter() - started, 2)
            first = False
        LOG.info('Speech %s %s: %s', clip_id, timings, segment.text)
        await send({'type': 'speak', 'id': clip_id, 'expression': segment.expression,
                    'weight': segment.weight, 'text': segment.text})


async def handle_connection(socket, args, catalog):
    from websockets.exceptions import ConnectionClosed
    worker = getattr(args, 'speech_worker', None)
    async def send(event):
        await socket.send(json.dumps(event, ensure_ascii=False, allow_nan=False))
    async def generate():
        parser = TagParser(catalog)
        speaker = None
        thinking = False
        async def on_reasoning():
            # Show the thinking mood once while the model reasons. With speech it
            # stays until the first clip applies its own mood.
            nonlocal thinking
            if not thinking and THINKING in catalog:
                thinking = True
                await send({'type': 'expression', 'name': THINKING, 'weight': THINKING_WEIGHT})
        try:
            await send({'type': 'start'})
            await send({'type': 'expression', 'name': 'neutral', 'weight': 1})
            chunks = demo_chunks() if args.mode == 'demo' else llama_chunks(
                args.llama_url, args.model, args.prompt, catalog, on_reasoning)
            if worker is not None:
                from controller.speech import Segmenter, clear_live_clips
                clear_live_clips()
                segmenter, queue = Segmenter(), asyncio.Queue()
                speaker = asyncio.create_task(speak_segments(queue, send, worker))
            async for chunk in chunks:
                if thinking and worker is None:
                    # Text-only: the answer has started, so drop the thinking face.
                    thinking = False
                    await send({'type': 'expression', 'name': 'neutral', 'weight': 1})
                for event in parser.feed(chunk):
                    if worker is None:
                        await send(event)
                        continue
                    # With speech, moods change when each clip starts playing, not on arrival.
                    if event['type'] == 'say':
                        await send(event)
                    for segment in segmenter.feed(event):
                        queue.put_nowait(segment)
            parser.finish()
            if speaker is not None:
                for segment in segmenter.finish():
                    queue.put_nowait(segment)
                queue.put_nowait(None)
                await speaker
            await send({'type': 'end'})
        except ConnectionClosed:
            pass
        except Exception:
            LOG.exception('Generation failed')
            try:
                await send({'type': 'expression', 'name': 'neutral', 'weight': 1})
                await send({'type': 'error', 'text': 'Generation failed; see bridge terminal.'})
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
                if not isinstance(raw, str) or json.loads(raw) != {'type': 'start'}:
                    raise ValueError('Unknown request')
            except (ValueError, TypeError):
                LOG.warning('Dropped invalid browser request')
                continue
            if task is not None and not task.done():
                LOG.warning('Dropped start request while generation is active')
                continue
            task = asyncio.create_task(generate())
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
        print('Starting Applio worker (loads the voice model once)…', flush=True)
        args.speech_worker = ApplioWorker(args.speech_settings)
        ready = await args.speech_worker.start()
        print(f"Applio worker ready: load {ready['loadSeconds']}s, warm-up {ready['warmSeconds']}s", flush=True)
    async def handler(socket):
        await handle_connection(socket, args, catalog)
    try:
        async with serve(handler, '127.0.0.1', args.port, origins=[ORIGIN], max_size=1024, max_queue=4):
            speech = 'speech on' if args.speech_worker is not None else 'text only'
            print(f'Bridge: ws://127.0.0.1:{args.port} ({args.mode}, {speech}); open {ORIGIN}/renderer/', flush=True)
            await asyncio.Future()
    finally:
        if args.speech_worker is not None:
            await args.speech_worker.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['demo', 'llm'], default='demo')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--llama-url', default='http://127.0.0.1:8080')
    parser.add_argument('--model', default=None)
    parser.add_argument('--prompt', default='Say good morning, then think about what we could work on.')
    parser.add_argument('--speech', action='store_true',
                        help='Speak each sentence with Applio (Edge TTS + RVC) and lip sync.')
    parser.add_argument('--pth', type=Path, help='Applio voice model (.pth); default in controller/speech.py.')
    args = parser.parse_args()
    args.speech_settings = None
    if args.speech:
        from controller.speech import ApplioSettings
        args.speech_settings = ApplioSettings(**({'pth': args.pth} if args.pth else {}))
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
