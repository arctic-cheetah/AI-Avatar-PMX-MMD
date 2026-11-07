"""Emphasis markup (#84 tier 4): *word* becomes a short pause before that word."""
import asyncio
import json
import sys
import tempfile
import unittest
from collections import namedtuple
from pathlib import Path
from unittest.mock import Mock, patch

from controller.bridge import (TagParser, build_parser, load_catalog, prompts_emphasis,
                               speech_settings, system_prompt)
from controller.kokoro_worker import Synthesizer, aligned, pause_points, serve, splice_silence
from controller.speech import ApplioSettings, ApplioWorker, Segment, Segmenter, synthesise
from test_prosody import ECHO_WORKER

Timing = namedtuple('Timing', 'phoneme start end')
# Kokoro's timings for "I really like it." (measured with af_heart, 7 Nov 2026).
REALLY = [Timing(p, s, e) for p, s, e in [
    ('a', 0.45, 0.525), ('ɪ', 0.525, 0.575), (' ', 0.575, 0.625), ('ɹ', 0.625, 0.65),
    ('ˈ', 0.65, 0.7), ('i', 0.7, 0.725), ('ə', 0.725, 0.75), ('l', 0.75, 0.8), ('i', 0.8, 0.85),
    (' ', 0.85, 0.9), ('l', 0.9, 0.925), ('ˈ', 0.925, 0.975), ('a', 0.975, 1.0), ('ɪ', 1.0, 1.05),
    ('k', 1.05, 1.1), (' ', 1.1, 1.15), ('ɪ', 1.15, 1.225), ('t', 1.225, 1.55), ('.', 1.55, 1.725)]]


def segments(text):
    parser, segmenter = TagParser(load_catalog()), Segmenter()
    return [s for e in parser.feed(text) for s in segmenter.feed(e)] + segmenter.finish()


class MarkupTests(unittest.TestCase):
    def test_single_asterisks_mark_emphasis_and_are_not_spoken(self):
        [segment] = segments('[happy] I *really* like it.')
        self.assertEqual((segment.text, segment.emphasis), ('I really like it.', (1,)))

    def test_emphasis_per_sentence_and_punctuation_words_skipped(self):
        out = segments('*Wow!* That is *so* good. Maybe — *who* knows?')
        self.assertEqual([(s.text, s.emphasis) for s in out],
                         [('Wow!', (0,)), ('That is so good.', (2,)), ('Maybe — who knows?', (1,))])

    def test_bold_maths_and_plain_text_have_no_emphasis(self):
        for text, spoken in (('**Bold** words here.', 'Bold words here.'),
                             ('Two * three * four.', 'Two three four.'),
                             ('Plain words.', 'Plain words.')):
            with self.subTest(text=text):
                [segment] = segments(text)
                self.assertEqual((segment.text, segment.emphasis), (spoken, ()))

    def test_marks_beyond_the_worker_limit_are_capped_not_fatal(self):
        # PR #88 review: four marks made the worker reject the request, dropping the sentence.
        [segment] = segments('I *really* *really* *really* *really* love it.')
        self.assertEqual(segment.text, 'I really really really really love it.')
        self.assertEqual(segment.emphasis, (1, 2, 3))

    def test_multi_word_spans_are_actions_not_emphasis(self):
        # PR #88 review: roleplay actions such as *giggles softly* are not emphasis.
        [segment] = segments('*giggles softly* Hi there, *you*.')
        self.assertEqual((segment.text, segment.emphasis), ('giggles softly Hi there, you.', (4,)))

    def test_stray_marker_character_is_ignored(self):
        [segment] = segments('Hi\ue000 there.')
        self.assertEqual((segment.text, segment.emphasis), ('Hi there.', ()))

    def test_default_segment_has_no_emphasis(self):
        self.assertEqual(Segment('Hi.').emphasis, ())


class PauseMathTests(unittest.TestCase):
    def test_alignment_requires_matching_word_counts(self):
        self.assertTrue(aligned('I really like it.', 'aɪ ɹˈiəli lˈaɪk ɪt.'))
        self.assertTrue(aligned('Maybe — who knows?', 'mˈeɪbiː — hˌuː nˈoʊz?'))
        self.assertFalse(aligned('In 1999 we won.', 'ɪn nˈaɪntiːnhˈʌndɹɪd nˈaɪnti nˈaɪn wiː wˈʌn.'))

    def test_pause_goes_in_the_space_before_the_word(self):
        self.assertEqual(pause_points(REALLY, [1]), [0.6])
        self.assertEqual(pause_points(REALLY, [3]), [1.125])
        self.assertEqual(pause_points(REALLY, [1, 3]), [0.6, 1.125])

    def test_first_and_missing_words_get_no_pause(self):
        self.assertEqual(pause_points(REALLY, [0]), [])
        self.assertEqual(pause_points(REALLY, [9]), [])

    def test_punctuation_only_words_do_not_count(self):
        timings = [Timing(p, i / 10, (i + 1) / 10) for i, p in enumerate('ab — cd')]
        # Words: "ab"(0), "—" (not counted), "cd"(1); the pause sits in the space before "cd".
        self.assertEqual(pause_points(timings, [1]), [0.45])

    def test_splice_inserts_faded_silence(self):
        rate = 1000
        samples = [1.0] * 1000
        out = splice_silence(samples, rate, [0.5], 0.1)
        self.assertEqual(len(out), 1100)
        self.assertEqual(out[500:600], [0.0] * 100)
        self.assertLess(out[499], 0.3)       # faded out into the pause
        self.assertLess(out[600], 0.3)       # faded back in
        self.assertEqual(out[400], 1.0)
        self.assertEqual(out[700], 1.0)
        self.assertEqual(splice_silence(samples, rate, [], 0.1), samples)


class KokoroEmphasisTests(unittest.IsolatedAsyncioTestCase):
    def synthesizer(self):
        synthesizer = Synthesizer.__new__(Synthesizer)
        synthesizer.model = Mock()
        synthesizer.model.tokenizer.phonemize.return_value = 'aɪ ɹˈiəli lˈaɪk ɪt.'
        synthesizer.model.create.return_value = ([0.5] * 24000, 24000)
        synthesizer.model.create_timed.return_value = ([0.5] * 24000, 24000, REALLY)
        synthesizer.soundfile = Mock()
        synthesizer.voice, synthesizer.style, synthesizer.speed = 'af_heart', object(), 1.0
        synthesizer.clause_pause = 0.25
        return synthesizer

    def test_emphasis_uses_timed_phonemes_and_adds_pause(self):
        synthesizer = self.synthesizer()
        metrics = synthesizer.synthesize('I really like it.', 'out.wav', emphasis=[1], emphasis_pause=0.12)
        args, kwargs = synthesizer.model.create_timed.call_args
        self.assertEqual(args[0], 'aɪ ɹˈiəli lˈaɪk ɪt.')
        self.assertTrue(kwargs['is_phonemes'])
        written = synthesizer.soundfile.write.call_args.args[1]
        self.assertEqual(len(written), 24000 + int(0.12 * 24000))
        self.assertEqual(metrics['emphasisPauses'], 1)
        self.assertAlmostEqual(metrics['sourceSeconds'], 1.12, places=3)

    def test_misaligned_text_falls_back_to_plain_synthesis(self):
        synthesizer = self.synthesizer()
        synthesizer.model.tokenizer.phonemize.return_value = 'ɪn nˈaɪntiːn nˈaɪnti nˈaɪn wiː wˈʌn.'
        metrics = synthesizer.synthesize('In 1999 we won.', 'out.wav', emphasis=[2], emphasis_pause=0.12)
        synthesizer.model.create_timed.assert_not_called()
        synthesizer.model.create.assert_called_once()
        self.assertEqual(metrics['emphasisPauses'], 0)

    def test_no_emphasis_keeps_plain_path(self):
        synthesizer = self.synthesizer()
        metrics = synthesizer.synthesize('I really like it.', 'out.wav')
        synthesizer.model.create_timed.assert_not_called()
        self.assertNotIn('emphasisPauses', metrics)

    def test_invalid_emphasis_rejected(self):
        synthesizer = self.synthesizer()
        for options in ({'emphasis': [True]}, {'emphasis': [-1]}, {'emphasis': 'x'},
                        {'emphasis': [1, 2, 3, 4]}, {'emphasis': [1], 'emphasis_pause': 0.4},
                        {'emphasis': [1], 'emphasis_pause': float('nan')}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                synthesizer.synthesize('I really like it.', 'out.wav', **options)

    async def test_serve_forwards_emphasis_fields(self):
        lines, calls, replies = asyncio.Queue(), [], []

        def synthesize(text, path, **options):
            calls.append(options)
            return {'ttsSeconds': 0.1}

        await lines.put(json.dumps({'id': 'a', 'text': 'a', 'source': 'a',
                                    'emphasis': [1], 'emphasis_pause': 0.12}))
        await lines.put(None)
        await serve(lines, synthesize, replies.append)
        self.assertEqual(calls, [{'emphasis': [1], 'emphasis_pause': 0.12}])


class PipelineEmphasisTests(unittest.IsolatedAsyncioTestCase):
    async def test_kokoro_line_carries_emphasis(self):
        settings = ApplioSettings(tts_provider='kokoro', emphasis=True, emphasis_pause=0.15)
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'echo.py'
            script.write_text(ECHO_WORKER)
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            seen = {}
            original = kokoro.request

            async def spy(*args, **kwargs):
                reply = await original(*args, **kwargs)
                seen['line'] = reply['request']
                return reply

            kokoro.request, worker.kokoro = spy, kokoro
            try:
                rvc = await worker.request('Hi there.', Path('s.wav'), Path('o.wav'), emphasis=(1,))
            finally:
                await worker.close()
        self.assertEqual((seen['line']['emphasis'], seen['line']['emphasis_pause']), ([1], 0.15))
        self.assertNotIn('emphasis', rvc['request'])

    async def run_segment(self, settings, segment):
        worker = Mock()
        worker.settings = settings
        sent = {}

        async def prepare(text, source, output, run, prosody=None, **kwargs):
            sent.update(text=text, **kwargs)
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3, 'emphasisPauses': 1}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                _, metrics = await synthesise(segment, worker, directory=Path(scratch))
        return sent, metrics

    async def test_enabled_emphasis_reaches_worker(self):
        sent, metrics = await self.run_segment(
            ApplioSettings(tts_provider='kokoro', emphasis=True),
            Segment('I really like it.', 'happy', 1.0, emphasis=(1,)))
        self.assertEqual(sent['emphasis'], (1,))
        self.assertEqual(metrics['emphasisPauses'], 1)

    async def test_emphasis_not_sent_when_off_edge_or_reshaped(self):
        cases = [
            (ApplioSettings(tts_provider='kokoro'), Segment('I really like it.', emphasis=(1,))),
            (ApplioSettings(tts_provider='edge', emphasis=True), Segment('I really like it.', emphasis=(1,))),
            # Dash shaping turns "1–5" into three words, so word positions would be wrong.
            (ApplioSettings(tts_provider='kokoro', emphasis=True, punctuation_cadence=True),
             Segment('Pages 1–5 are fine.', emphasis=(3,))),
        ]
        for settings, segment in cases:
            with self.subTest(provider=settings.tts_provider, text=segment.text):
                sent, _ = await self.run_segment(settings, segment)
                self.assertNotIn('emphasis', sent)

    def test_settings_and_flags(self):
        for value in (-0.01, 0.31, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), emphasis_pause=value).check()
        defaults = speech_settings(build_parser().parse_args(['--speech']))
        self.assertEqual((defaults.emphasis, defaults.emphasis_pause), (False, 0.12))
        settings = speech_settings(build_parser().parse_args(
            ['--speech', '--emphasis', '--emphasis-pause', '0.2']))
        self.assertEqual((settings.emphasis, settings.emphasis_pause), (True, 0.2))


class PromptTests(unittest.TestCase):
    def test_rule_is_prompted_only_for_kokoro_emphasis(self):
        self.assertTrue(prompts_emphasis(ApplioSettings(tts_provider='kokoro', emphasis=True)))
        self.assertFalse(prompts_emphasis(ApplioSettings(tts_provider='edge', emphasis=True)))
        self.assertFalse(prompts_emphasis(ApplioSettings(tts_provider='kokoro')))
        self.assertFalse(prompts_emphasis(None))

    def test_emphasis_rule_only_when_enabled(self):
        catalog = load_catalog()
        self.assertNotIn('*really*', system_prompt(catalog))
        prompt = system_prompt(catalog, emphasis=True)
        self.assertIn('*really*', prompt)
        self.assertIn('at most one word per sentence', prompt)


if __name__ == '__main__':
    unittest.main()
