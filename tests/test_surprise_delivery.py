"""Surprise batch (#83): a surprised "what" / "really" rises and is drawn out ("whaaat", "reeeally")."""
from pathlib import Path
import sys
import tempfile
import unittest

from controller.bridge import build_parser, speech_settings
from controller.speech import DELIVERIES, ApplioSettings, ApplioWorker, Segment, delivered_words
import test_contours  # the module, not its TestCase class, so its tests do not run twice here
from test_contours import SPANS_WORKER


class SurpriseRowTests(unittest.TestCase):
    def test_surprise_row(self):
        row = next(row for row in DELIVERIES if row.family == 'surprise')
        self.assertTrue({'what', 'really', 'seriously', 'wow', 'whoa'} <= row.words)
        self.assertTrue({'surprised', 'shocked', 'gasp'} <= row.moods)
        self.assertEqual((row.bend, row.peak, row.stretch, row.opener_only, row.standalone),
                         ('surprise_bend', 0.7, True, False, True))

    def test_only_in_surprised_moods(self):
        self.assertEqual(delivered_words('What, you did that?', 'surprised')[0].family, 'surprise')
        self.assertEqual(delivered_words('What, you did that?', 'neutral'), {})

    def test_only_when_said_on_its_own(self):
        # #123 review: intensifier "really" and relative "what" are not surprise.
        for text, mood in (('This is really good!', 'excited'), ("I'm really happy!", 'excited'),
                           ("I don't know what to say.", 'shocked'), ('Wow is a word I like.', 'gasp')):
            with self.subTest(text=text):
                self.assertEqual(delivered_words(text, mood), {})
        for text, index in (('What, you did that?', 0), ('Oh, really?', 1), ('You did what?!', 2),
                            ('Seriously, again?', 0), ('Whoa!', 0), ('Wow… okay.', 0)):
            with self.subTest(text=text):
                self.assertEqual(delivered_words(text, 'surprised')[index].family, 'surprise')

    def test_an_elongated_word_counts_as_said_on_its_own(self):
        self.assertEqual(delivered_words('I am really happy.', 'excited', elongated=(2,))[2].family, 'surprise')


class SynthesiseSurpriseTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text, mood):
        sent, _ = await test_contours.SynthesiseContourTests.run_segment(self, settings, Segment(text, mood, 1.0))
        return sent

    async def test_a_surprised_word_rises_and_is_stretched(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'What, you did that?', 'surprised')
        self.assertEqual(sent['delivered'], ((0, 5.0, 0.7, True),))
        self.assertNotIn('delivered', await self.run_segment(
            ApplioSettings(tts_provider='kokoro'), 'What, you did that?', 'neutral'))

    async def test_a_question_keeps_its_own_rise_and_is_only_stretched(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Really?', 'surprised')
        self.assertEqual(sent['rises'], (0,))
        self.assertEqual(sent['delivered'], ((0, None, None, True),))

    async def test_a_marked_surprise_word_is_not_lifted_as_well(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), '*Really*, you did that?', 'surprised')
        self.assertEqual(sent['delivered'], ((0, 5.0, 0.7, True),))
        self.assertNotIn(0, sent.get('lifts', ()))

    async def test_an_exclaimed_surprise_word_gets_one_bend(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Whoa!', 'gasp')
        self.assertEqual(sent['delivered'], ((0, 5.0, 0.7, True),))
        self.assertNotIn('lifts', sent)

    async def test_plain_voice_turns_the_row_off(self):
        settings = speech_settings(build_parser().parse_args(['--speech', '--tts', 'kokoro', '--plain-voice']))
        self.assertNotIn('delivered', await self.run_segment(settings, 'What, you did that?', 'surprised'))

    async def test_off_with_dynamic_emphasis(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False),
                                      'What, you did that?', 'surprised')
        self.assertNotIn('delivered', sent)


class SurpriseRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_bend_spans_and_stretch_reach_the_workers(self):
        settings = ApplioSettings(tts_provider='kokoro')
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                                   '"wordSpans": [[0.2, 0.5]], "spanWords": [1]'))
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
                reply = await worker.request('Oh, what happened?', Path('s.wav'), Path('o.wav'),
                                             delivered=((1, 5.0, 0.7, True),))
            finally:
                await worker.close()
        self.assertEqual((seen['tts']['spans'], seen['tts']['stretch']), ([1], [[1, 0.125]]))
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 5.0, 0.7]])
        self.assertEqual(reply['delivered'], 1)

    async def test_a_stretched_only_row_word_still_counts_as_delivered(self):
        settings = ApplioSettings(tts_provider='kokoro')
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER)
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            worker.kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            try:
                reply = await worker.request('Really?', Path('s.wav'), Path('o.wav'), rises=(0,),
                                             delivered=((0, None, None, True),))
            finally:
                await worker.close()
        self.assertEqual(reply['delivered'], 1)  # the question's rise, plus the row's stretch


class SurpriseSettingsTests(unittest.TestCase):
    def test_default_range_and_flag(self):
        self.assertEqual(ApplioSettings().surprise_bend, 5.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), surprise_bend=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--surprise-bend', '7']))
        self.assertEqual(settings.surprise_bend, 7.0)


if __name__ == '__main__':
    unittest.main()
