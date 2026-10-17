import asyncio
import json
import unittest
from argparse import Namespace
from unittest.mock import patch

from controller.bridge import ORIGIN, TagParser, handle_connection, load_catalog
from controller.speech import ApplioSettings, Segmenter, clean_for_tts


def segments(chunks):
    parser, segmenter = TagParser(load_catalog()), Segmenter()
    out = [s for c in chunks for e in parser.feed(c) for s in segmenter.feed(e)] + segmenter.finish()
    return [(s.text, s.expression, s.weight) for s in out]


class SegmenterTests(unittest.TestCase):
    def test_sentences_and_moods(self):
        self.assertEqual(segments(['[soft-smile:0.6] Good morning. How are', ' you? [thinking:0.5]Let me think', ' about that.']), [
            ('Good morning.', 'soft-smile', 0.6),
            ('How are you?', 'soft-smile', 0.6),
            ('Let me think about that.', 'thinking', 0.5),
        ])

    def test_mood_tag_mid_sentence_splits(self):
        self.assertEqual(segments(['Well [happy]that is great!']), [
            ('Well', 'neutral', 1.0), ('that is great!', 'happy', 1.0)])

    def test_unspeakable_fragments_dropped(self):
        self.assertEqual(segments(['🌸 ', '[happy] ... ', '**Hi** there']), [('Hi there', 'happy', 1.0)])

    def test_clean_for_tts(self):
        self.assertEqual(clean_for_tts('  **Bold** `code` 💕 ✨\n# Title  '), 'Bold code Title')
        self.assertEqual(clean_for_tts('-- --pth-path=evil'), 'pth-path=evil')


class SpeechBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_speak_events_in_order_without_early_moods(self):
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect
        async def fast_demo():
            yield '[soft-smile:0.6] Hello there. [thinking]Hmm, '
            yield 'let me see.'
        spoken = []
        async def fake_synthesise(segment, settings):
            spoken.append(segment.text)
            return f'{len(spoken):016x}', {}
        args = Namespace(mode='demo', speech_settings=ApplioSettings())
        async def handler(ws): await handle_connection(ws, args, load_catalog())
        with patch('controller.bridge.demo_chunks', fast_demo), \
                patch('controller.speech.synthesise', fake_synthesise), \
                patch('controller.speech.clear_live_clips'):
            async with serve(handler, '127.0.0.1', 0, origins=[ORIGIN]) as server:
                async with connect(f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}', origin=ORIGIN) as ws:
                    await ws.send('{"type":"start"}')
                    events = []
                    while not events or events[-1]['type'] != 'end':
                        events.append(json.loads(await asyncio.wait_for(ws.recv(), 3)))
        speaks = [e for e in events if e['type'] == 'speak']
        self.assertEqual([(e['id'], e['expression'], e['text']) for e in speaks], [
            ('0000000000000001', 'soft-smile', 'Hello there.'),
            ('0000000000000002', 'thinking', 'Hmm, let me see.'),
        ])
        # Only the initial neutral reset; later moods travel with their clip.
        self.assertEqual([e['name'] for e in events if e['type'] == 'expression'], ['neutral'])


if __name__ == '__main__':
    unittest.main()
