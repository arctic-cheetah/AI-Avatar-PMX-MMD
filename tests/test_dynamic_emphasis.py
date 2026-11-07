"""Dynamic emphasis (#83): a deeper, drawn-out "buuut", and brighter *word* emphasis."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from controller.bridge import build_parser, speech_settings
from controller.speech import ApplioSettings, ApplioWorker, Segment, drawl_words, synthesise
from test_contours import SPANS_WORKER


class DrawlWordTests(unittest.TestCase):
    def test_sentence_opening_discourse_words(self):
        for text in ('But I like it.', 'Well, okay.', 'So, what now?', 'Okay then.'):
            with self.subTest(text=text):
                self.assertEqual(drawl_words(text, 'neutral'), (0,))
        self.assertEqual(drawl_words('I like it, but no.', 'neutral'), ())

    def test_attitude_words_only_in_skeptical_moods(self):
        self.assertEqual(drawl_words('Sure, that works.', 'neutral'), ())
        self.assertEqual(drawl_words('Sure, that works.', 'skeptical'), (0,))
        self.assertEqual(drawl_words('Oh, really.', 'unimpressed'), (1,))

    def test_marked_words_drawl_only_in_skeptical_moods(self):
        self.assertEqual(drawl_words('That is *so* clever.', 'suspicious', emphasis=(2,)), (2,))
        self.assertEqual(drawl_words('That is *so* clever.', 'happy', emphasis=(2,)), ())


class DrawlVowelTests(unittest.TestCase):
    """Listening: "buuuut" sounded like "boot". A spectrum check showed bˈʌːːt is closer to
    "buːt" (0.84) than to "bˌʌt" (0.80); holding Kokoro's own vowel stays "but" (0.85 vs 0.81)."""

    def test_drawls_do_not_change_phonemes(self):
        import controller.kokoro_worker as kokoro
        self.assertFalse(hasattr(kokoro, 'drawl_token'))
        self.assertNotIn('drawls', kokoro.PROSODY_FIELDS)


class DrawlRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_drawls_reach_kokoro_and_bend_deeper(self):
        settings = ApplioSettings(tts_provider='kokoro', dynamic_emphasis=True, drawl_bend=-3.0,
                                  drawl_hold=0.3)
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                                   '"wordSpans": [[0.2, 0.5]], "spanWords": [0]'))
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            worker.kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            seen = {}
            original = worker.kokoro.request

            async def spy(*args, **kwargs):
                reply = await original(*args, **kwargs)
                seen['tts'] = reply['request']
                return reply

            worker.kokoro.request = spy
            try:
                reply = await worker.request('But I like it.', Path('s.wav'), Path('o.wav'), drawls=(0,))
            finally:
                await worker.close()
        self.assertEqual((seen['tts']['holds'], seen['tts']['spans']), ([[0, 0.3]], [0]))
        self.assertNotIn('drawls', seen['tts'])
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, -3.0]])
        self.assertEqual(reply['drawls'], 1)


class SynthesiseDynamicTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, segment):
        worker = Mock()
        worker.settings = settings
        sent = {}

        async def prepare(text, source, output, run, prosody=None, **options):
            sent.update(options)
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3, 'drawls': 1}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                    patch('controller.speech.apply_gain', return_value={'gainDb': 0.0}), \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                _, metrics = await synthesise(segment, worker, directory=Path(scratch))
        return sent, metrics

    async def test_drawls_and_bright_emphasis(self):
        settings = ApplioSettings(tts_provider='kokoro', dynamic_emphasis=True)
        sent, metrics = await self.run_segment(settings, Segment('But I like it.'))
        self.assertEqual(sent['drawls'], (0,))
        self.assertEqual(metrics['drawls'], 1)
        sent, _ = await self.run_segment(settings, Segment('That is so clever.', 'happy', 1.0, emphasis=(2,)))
        self.assertIn(2, sent['lifts'])
        self.assertNotIn('drawls', sent)

    def test_listened_defaults_keep_only_a_slightly_deeper_tone(self):
        # Listening (8 Nov 2026): the held "buuut" still sounded like "boot" and one take broke
        # up (its ~20 ms steady vowel repeated many times). Lengthening waits for ONNX per-token
        # speed (#83 scope 2); for now a drawl is only a slightly deeper tone, no hold.
        settings = ApplioSettings()
        self.assertEqual((settings.drawl_bend, settings.drawl_hold), (-2.0, 0.0))

    async def test_off_or_edge_sends_no_drawls(self):
        for settings in (ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False),
                         ApplioSettings(tts_provider='edge', dynamic_emphasis=True)):
            with self.subTest(provider=settings.tts_provider):
                sent, _ = await self.run_segment(settings, Segment('But I like it.'))
                self.assertNotIn('drawls', sent)

    def test_settings_and_flags(self):
        self.assertEqual((ApplioSettings().dynamic_emphasis, ApplioSettings().drawl_bend,
                          ApplioSettings().drawl_hold), (False, -2.0, 0.0))
        for value in (-0.1, 0.46, float('nan')):
            with self.subTest(hold=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), drawl_hold=value).check()
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), drawl_bend=value).check()
        settings = speech_settings(build_parser().parse_args(
            ['--speech', '--dynamic-emphasis', '--drawl-bend', '-4']))
        self.assertEqual((settings.dynamic_emphasis, settings.drawl_bend), (True, -4.0))
        plain = speech_settings(build_parser().parse_args(['--speech', '--dynamic-emphasis', '--plain-voice']))
        self.assertFalse(plain.dynamic_emphasis)


if __name__ == '__main__':
    unittest.main()
