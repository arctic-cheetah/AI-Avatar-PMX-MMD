"""Local streaming text/expression bridge; demo and llama-server modes."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import re
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / 'renderer' / 'expressions.json'
ORIGIN = 'http://127.0.0.1:8770'
DEMO = '[soft-smile:0.6] Good morning. [thinking:0.5] Let me think about that. [neutral]'
TAG = re.compile(r'([a-z][a-z0-9-]*)(?::([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?')
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


async def llama_chunks(base_url, model, prompt, catalog):
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
                    content = choices[0].get('delta', {}).get('content')
                    if isinstance(content, str) and content:
                        yield content
            raise ValueError('LLM stream ended without [DONE]')


async def demo_chunks():
    for chunk in ['[soft-', 'smile:0.6]', ' Good morning. ', '[think',
                  'ing:0.5]', 'Let me think about that. ', '[neutral]']:
        yield chunk
        await asyncio.sleep(2 if not chunk.startswith('[') and ']' not in chunk else .05)


async def handle_connection(socket, args, catalog):
    from websockets.exceptions import ConnectionClosed
    async def send(event):
        await socket.send(json.dumps(event, ensure_ascii=False, allow_nan=False))
    async def generate():
        parser = TagParser(catalog)
        try:
            await send({'type': 'start'})
            await send({'type': 'expression', 'name': 'neutral', 'weight': 1})
            chunks = demo_chunks() if args.mode == 'demo' else llama_chunks(
                args.llama_url, args.model, args.prompt, catalog)
            async for chunk in chunks:
                for event in parser.feed(chunk):
                    await send(event)
            parser.finish()
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
    async def handler(socket):
        await handle_connection(socket, args, catalog)
    async with serve(handler, '127.0.0.1', args.port, origins=[ORIGIN], max_size=1024, max_queue=4):
        print(f'Bridge: ws://127.0.0.1:{args.port} ({args.mode}); open {ORIGIN}/renderer/', flush=True)
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['demo', 'llm'], default='demo')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--llama-url', default='http://127.0.0.1:8080')
    parser.add_argument('--model', default=None)
    parser.add_argument('--prompt', default='Say good morning, then think about what we could work on.')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
