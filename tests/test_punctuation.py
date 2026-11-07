"""Punctuation-driven cadence (#84 tiers 1–3): tails by ending, punctuation prosody, dashes."""
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch

from controller.bridge import TagParser, build_parser, load_catalog, speech_settings
from controller.prosody import Prosody, combine, prosody_for, punctuation_prosody
from controller.speech import ApplioSettings, Segment, Segmenter, shape_punctuation, synthesise
from controller.speech_trim import MAX_TAIL_KEEP, tail_keep, trim_clip
from test_speech_pipeline import duration, write_wav

TAILS = {'sentence_tail': 0.4, 'fragment_tail': 0.1, 'ellipsis_tail': 0.6,
         'exclaim_tail': 0.3, 'question_tail': 0.45}


class TailByEndingTests(unittest.TestCase):
    def test_each_ending_has_its_own_tail(self):
        cases = {'Hello.': 0.4, 'Well...': 0.6, 'Hmm…': 0.6, 'Wow!': 0.3, 'Really?!': 0.3,
                 'Really?': 0.45, 'He said "Yay!"': 0.3, '"Hmm…"': 0.6, 'Well': 0.1}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(tail_keep(text, **TAILS), expected)

    def test_unset_ending_tails_fall_back_to_sentence_tail(self):
        for text in ('Well...', 'Wow!', 'Really?'):
            self.assertEqual(tail_keep(text, sentence_tail=0.4, fragment_tail=0.1), 0.4)

    def test_max_tail_allows_lingering_ellipsis(self):
        self.assertEqual(MAX_TAIL_KEEP, 0.8)

    def test_tail_longer_than_clip_is_padded_with_silence(self):
        with tempfile.TemporaryDirectory() as scratch:
            source, output = Path(scratch) / 's.wav', Path(scratch) / 'o.wav'
            parts = [(0.2, 'silence'), (1.0, 'tone'), (0.1, 'silence')]
            write_wav(source, 24000, parts)
            write_wav(output, 40000, parts)
            result = trim_clip(source, output, 'Well...', sentence_tail=0.4, ellipsis_tail=0.6)
            self.assertTrue(result['trimmed'])
            # 0.05 s lead + 1.0 s speech + 0.6 s tail, of which 0.5 s is padding.
            self.assertAlmostEqual(duration(output), 1.65, delta=0.02)
            with wave.open(str(output), 'rb') as clip:
                rate = clip.getframerate()
                clip.setpos(int(1.2 * rate))
                tail = clip.readframes(int(0.4 * rate))
            self.assertEqual(set(tail), {0})

    def test_tail_range_up_to_new_max(self):
        for field in ('ellipsis_tail', 'exclaim_tail', 'question_tail', 'sentence_tail'):
            for value in (-0.01, 0.81, float('nan')):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    ApplioSettings(applio_dir=Path('/nonexistent'), **{field: value}).check()


class PunctuationProsodyTests(unittest.TestCase):
    def test_exclamation_follows_mood_valence(self):
        self.assertEqual(punctuation_prosody('Yay!', 'excited', 1.0), Prosody(1.0, 1.0, 1))
        self.assertEqual(punctuation_prosody('Really?!', 'joyful', 1.0), Prosody(1.0, 1.0, 1))
        self.assertEqual(punctuation_prosody('He said "Yay!"', 'happy', 1.0).pitch, 1)
        for mood in ('sad', 'angry', 'annoyed', 'frown', 'disgusted'):
            with self.subTest(mood=mood):
                self.assertEqual(punctuation_prosody('No!', mood, 1.0).pitch, -1)
        for mood in ('neutral', 'surprised', 'soft-smile'):
            with self.subTest(mood=mood):
                self.assertEqual(punctuation_prosody('Oh!', mood, 1.0), Prosody())
        self.assertEqual(punctuation_prosody('Yay!', 'excited', 0.4).pitch, 0)

    def test_ellipsis_is_slower_and_others_unchanged(self):
        for text in ('Hmm…', 'Well...', '"Well…"'):
            with self.subTest(text=text):
                self.assertEqual(punctuation_prosody(text, 'neutral', 1.0), Prosody(0.96, 1.0, 0))
        for text in ('Hello.', 'Really?', 'Well'):
            with self.subTest(text=text):
                self.assertEqual(punctuation_prosody(text, 'excited', 1.0), Prosody())

    def test_combine_multiplies_adds_and_clamps(self):
        self.assertEqual(combine(prosody_for('excited', 1.0), Prosody(1.0, 1.0, 1)),
                         Prosody(1.05, 0.7, 2))
        low = combine(prosody_for('sad', 1.0), Prosody(0.96, 1.0, -1))
        self.assertEqual((low.speed, low.pitch), (0.92, -2))
        self.assertEqual(combine(Prosody(1.0, 1.9, 2), Prosody(1.0, 1.9, 2)), Prosody(1.0, 2.0, 2))
        self.assertEqual(combine(Prosody(), Prosody()), Prosody())


class DashAndEllipsisTests(unittest.TestCase):
    def test_dashes_become_clause_pauses(self):
        cases = {
            'Maybe — who knows?': 'Maybe, who knows?',
            'Maybe—who knows?': 'Maybe, who knows?',
            'Maybe – who knows?': 'Maybe, who knows?',
            'Maybe - who knows?': 'Maybe, who knows?',
            'A false-positive alert.': 'A false-positive alert.',
            'Pages 1–5 and 3-4.': 'Pages 1 to 5 and 3-4.',
            'Well, — fine.': 'Well, fine.',
            'So it goes —': 'So it goes',
            'Plain text.': 'Plain text.',
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(shape_punctuation(text), expected)

    def test_ellipsis_touching_a_word_still_ends_a_sentence(self):
        parser, segmenter = TagParser(load_catalog()), Segmenter()
        out = [s for e in parser.feed('[thinking] Wait...what?! Hmm…maybe. 1...5 ok.')
               for s in segmenter.feed(e)] + segmenter.finish()
        self.assertEqual([s.text for s in out], ['Wait...', 'what?!', 'Hmm…', 'maybe.', '1...5 ok.'])


class SynthesisePunctuationTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, segment):
        worker = Mock()
        worker.settings = settings
        sent = {}

        async def prepare(text, source, output, run, prosody=None):
            sent.update(text=text, prosody=prosody)
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}) as trim, \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                await synthesise(segment, worker, directory=Path(scratch))
        return sent, trim.call_args.kwargs

    async def test_enabled_cadence_shapes_text_tails_and_prosody(self):
        settings = ApplioSettings(tts_provider='kokoro', punctuation_cadence=True)
        sent, tails = await self.run_segment(settings, Segment('Yay — we did it!', 'excited', 1.0))
        self.assertEqual(sent['text'], 'Yay, we did it!')
        self.assertEqual(sent['prosody'], Prosody(1.0, 1.0, 1))
        self.assertEqual(tails, {'sentence_tail': 0.4, 'fragment_tail': 0.1, 'ellipsis_tail': 0.6,
                                 'exclaim_tail': 0.3, 'question_tail': 0.4})

    async def test_cadence_stacks_with_mood_prosody(self):
        settings = ApplioSettings(tts_provider='kokoro', punctuation_cadence=True, mood_prosody=True)
        sent, _ = await self.run_segment(settings, Segment('No!', 'sad', 1.0))
        self.assertEqual(sent['prosody'], Prosody(0.92, 1.4, -2))

    async def test_disabled_by_default_leaves_text_and_tails(self):
        sent, tails = await self.run_segment(
            ApplioSettings(tts_provider='kokoro'), Segment('Yay — we did it!', 'excited', 1.0))
        self.assertEqual(sent['text'], 'Yay — we did it!')
        self.assertIsNone(sent['prosody'])
        self.assertEqual(tails, {'sentence_tail': 0.4, 'fragment_tail': 0.1})

    def test_bridge_flags(self):
        defaults = speech_settings(build_parser().parse_args(['--speech']))
        self.assertFalse(defaults.punctuation_cadence)
        self.assertEqual((defaults.ellipsis_tail, defaults.exclaim_tail, defaults.question_tail),
                         (0.6, 0.3, 0.4))
        settings = speech_settings(build_parser().parse_args([
            '--speech', '--punctuation-cadence', '--ellipsis-tail', '0.7',
            '--exclaim-tail', '0.25', '--question-tail', '0.35']))
        self.assertTrue(settings.punctuation_cadence)
        self.assertEqual((settings.ellipsis_tail, settings.exclaim_tail, settings.question_tail),
                         (0.7, 0.25, 0.35))


if __name__ == '__main__':
    unittest.main()
