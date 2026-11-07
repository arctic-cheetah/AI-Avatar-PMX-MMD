"""Interjection pitch contours (#84 tier 5a): bend Applio's F0 curve over Kokoro word spans."""
import asyncio
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from controller.applio_worker import (Pipeline, Worker, bend_factors, coarse_pitch,
                                      install_f0_bend, validate_bends)
from controller.bridge import build_parser, speech_settings
from controller.kokoro_worker import Synthesizer, serve, shift_spans, word_spans
from controller.speech import ApplioSettings, ApplioWorker, Segment, interjection_words, synthesise
from test_emphasis import REALLY

FRAME, PAD = 0.01, 1.0  # Applio: 160-sample hop at 16 kHz, 1 s of reflect padding
MEL_MIN, MEL_MAX = 1127 * math.log(1 + 50 / 700), 1127 * math.log(1 + 1100 / 700)


class InterjectionTests(unittest.TestCase):
    def test_aww_and_ooh_family(self):
        cases = {'Aww, that is sweet.': (0,), 'Awww!': (0,), 'Aw shucks.': (0,), 'Ooh! Nice.': (0,),
                 'Well, ooh, fancy.': (1,), 'Ohh, I see.': (0,), '"Aww…"': (0,)}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(interjection_words(text), expected)

    def test_other_words_are_not_interjections(self):
        for text in ('Oh no.', 'I saw it.', 'Awful weather.', 'Hello there.', 'Hmm.'):
            with self.subTest(text=text):
                self.assertEqual(interjection_words(text), ())


class BendMathTests(unittest.TestCase):
    def test_rise_then_fall_inside_the_span_only(self):
        n = int((PAD + 1.0) / FRAME) + 50
        factors = bend_factors(n, FRAME, PAD, [(0.2, 0.4, 2.0)])
        frame = lambda t: round((t + PAD) / FRAME)
        self.assertEqual(factors[frame(0.1)], 1.0)
        self.assertEqual(factors[frame(0.5)], 1.0)
        self.assertAlmostEqual(factors[frame(0.28)], 2 ** (2 / 12), places=4)  # peak at 40 %
        rising = [factors[frame(0.2 + i * 0.01)] for i in range(9)]
        falling = [factors[frame(0.28 + i * 0.01)] for i in range(13)]
        self.assertEqual(rising, sorted(rising))
        self.assertEqual(falling, sorted(falling, reverse=True))

    def test_negative_bend_and_overlaps_add(self):
        n = 300
        down = bend_factors(n, FRAME, PAD, [(0.2, 0.4, -2.0)])
        self.assertAlmostEqual(down[round((0.28 + PAD) / FRAME)], 2 ** (-2 / 12), places=4)
        both = bend_factors(n, FRAME, PAD, [(0.2, 0.4, 1.0), (0.2, 0.4, 1.0)])
        self.assertAlmostEqual(both[round((0.28 + PAD) / FRAME)], 2 ** (2 / 12), places=4)
        self.assertEqual(bend_factors(n, FRAME, PAD, []), [1.0] * n)

    def test_coarse_pitch_matches_applio_formula(self):
        def applio(f0):
            mel = 1127 * math.log(1 + f0 / 700)
            if mel > 0:
                mel = (mel - MEL_MIN) * 254 / (MEL_MAX - MEL_MIN) + 1
            return int(round(min(255, max(1, mel))))
        values = [0.0, 50.0, 110.0, 220.0, 440.0, 1100.0, 2000.0]
        self.assertEqual(coarse_pitch(values, MEL_MIN, MEL_MAX), [applio(v) for v in values])

    def test_bend_validation(self):
        validate_bends([[0.1, 0.4, 2.0]])
        validate_bends([[0.1, 0.4, 12.0]])  # one octave is the limit (listening, 7 Nov 2026)
        for bad in ('x', [[0.4, 0.1, 2]], [[-0.1, 0.4, 2]], [[0.1, 0.4, 12.5]], [[0.1, 0.4]],
                    [[0.1, 0.4, float('nan')]], [[0.1, 0.4, True]], [[0, 1, 1]] * 5, [[0.1, 61, 1]]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_bends(bad)


class HookTests(unittest.TestCase):
    def fake_pipeline_class(self):
        class FakePipe:
            window, sample_rate, t_pad = 160, 16000, 16000
            f0_mel_min, f0_mel_max = MEL_MIN, MEL_MAX

            def get_f0(self, x, p_len, *args, **kwargs):
                f0 = [220.0] * p_len
                return coarse_pitch(f0, MEL_MIN, MEL_MAX), f0
        return FakePipe

    def test_hook_bends_f0_and_coarse_only_while_converting(self):
        cls, state = self.fake_pipeline_class(), Mock(bends=())
        self.assertTrue(install_f0_bend(cls, lambda: state.bends))
        pipe, p_len = cls(), 200
        flat_coarse, flat = pipe.get_f0(None, p_len)
        self.assertEqual(flat, [220.0] * p_len)
        state.bends = [(0.2, 0.4, 2.0)]
        coarse, bent = pipe.get_f0(None, p_len)
        peak = round((0.28 + PAD) / FRAME)
        self.assertAlmostEqual(bent[peak], 220 * 2 ** (2 / 12), places=3)
        self.assertEqual(bent[10], 220.0)
        self.assertGreater(coarse[peak], flat_coarse[peak])
        self.assertTrue(install_f0_bend(cls, lambda: state.bends))  # idempotent

    def test_hook_refuses_an_unexpected_applio(self):
        class Different:
            def get_f0(self, audio):  # no p_len: a future Applio we have not checked
                return [], []
        self.assertFalse(install_f0_bend(Different, lambda: ()))
        self.assertFalse(install_f0_bend(object, lambda: ()))


class WorkerBendTests(unittest.IsolatedAsyncioTestCase):
    async def test_pipeline_passes_valid_bends_and_rejects_bad(self):
        converted, replies = [], []

        async def edge(text, path):
            return 0

        def convert(source, output, pitch=0, bends=()):
            converted.append((source, list(bends)))

        pipeline = Pipeline(edge, convert, replies.append)
        base = {'run': 'r', 'text': 't', 'output': 'o'}
        pipeline.submit({**base, 'id': 'plain', 'source': 'plain'})
        pipeline.submit({**base, 'id': 'bent', 'source': 'bent', 'bend': [[0.1, 0.4, 2.0]]})
        pipeline.submit({**base, 'id': 'bad', 'source': 'bad', 'bend': [[0.4, 0.1, 2.0]]})
        await pipeline.drain()
        self.assertEqual(converted, [('plain', []), ('bent', [[0.1, 0.4, 2.0]])])
        self.assertFalse({r['id']: r for r in replies}['bad']['ok'])

    def test_worker_exposes_bends_only_during_conversion(self):
        worker = Worker.__new__(Worker)
        worker.settings = {'pth': 'm.pth', 'index': 'm.index', 'pitch': 0, 'index_rate': 0.7,
                           'volume_envelope': 1, 'protect': 0.5, 'f0_method': 'rmvpe',
                           'embedder': 'contentvec', 'sid': 0}
        worker.current_bends = ()
        seen = []
        worker.converter = Mock()
        worker.converter.convert_audio.side_effect = lambda **kwargs: seen.append(worker.current_bends)
        worker.convert('s.wav', 'o.wav', 0, [[0.1, 0.4, 2.0]])
        self.assertEqual(seen, [[[0.1, 0.4, 2.0]]])
        self.assertEqual(worker.current_bends, ())


class KokoroSpanTests(unittest.IsolatedAsyncioTestCase):
    def test_word_spans_skip_punctuation(self):
        spans = word_spans(REALLY, [1, 3])
        self.assertEqual(spans, {1: (0.625, 0.85), 3: (1.15, 1.55)})  # "it." ends before "."
        self.assertEqual(word_spans(REALLY, [9]), {})

    def test_spans_move_with_spliced_pauses(self):
        self.assertEqual(shift_spans({3: (1.15, 1.55)}, [0.6], 0.12), {3: (1.27, 1.67)})
        self.assertEqual(shift_spans({0: (0.45, 0.575)}, [0.6], 0.12), {0: (0.45, 0.575)})

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

    def test_synthesize_reports_requested_spans_after_pauses(self):
        synthesizer = self.synthesizer()
        metrics = synthesizer.synthesize('I really like it.', 'out.wav', spans=[3])
        self.assertEqual(metrics['wordSpans'], [[1.15, 1.55]])
        metrics = synthesizer.synthesize('I really like it.', 'out.wav', spans=[3], emphasis=[1],
                                         emphasis_pause=0.12)
        self.assertEqual(metrics['wordSpans'], [[1.27, 1.67]])

    def test_misaligned_spans_are_empty_and_bad_spans_rejected(self):
        synthesizer = self.synthesizer()
        synthesizer.model.tokenizer.phonemize.return_value = 'a b c d e f'
        self.assertEqual(synthesizer.synthesize('I really like it.', 'out.wav', spans=[0])['wordSpans'], [])
        for spans in ('x', [True], [-1], [0] * 5):
            with self.subTest(spans=spans), self.assertRaises(ValueError):
                synthesizer.synthesize('I really like it.', 'out.wav', spans=spans)

    async def test_serve_forwards_spans(self):
        lines, calls = asyncio.Queue(), []

        def synthesize(text, path, **options):
            calls.append(options)
            return {'ttsSeconds': 0.1}

        await lines.put(json.dumps({'id': 'a', 'text': 'a', 'source': 'a', 'spans': [0]}))
        await lines.put(None)
        await serve(lines, synthesize, Mock())
        self.assertEqual(calls, [{'spans': [0]}])


SPANS_WORKER = """
import json, sys
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True, "rvcSeconds": 0, "ttsProvider": "kokoro",
                      "ttsSeconds": 0, "sourceSeconds": 1, "sampleRate": 24000, "ttsRtf": 0,
                      "wordSpans": [[0.2, 0.5]], "request": request}), flush=True)
"""


class RequestContourTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, contours):
        settings = ApplioSettings(tts_provider='kokoro', interjection_contours=True, interjection_bend=2.0)
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER)
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
                reply = await worker.request('Aww, sweet.', Path('s.wav'), Path('o.wav'), contours=contours)
            finally:
                await worker.close()
        return seen['tts'], reply

    async def test_spans_from_kokoro_become_rvc_bends(self):
        tts, reply = await self.exchange((0,))
        self.assertEqual(tts['spans'], [0])
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 2.0]])
        self.assertEqual(reply['contours'], 1)

    async def test_no_contours_keeps_old_lines(self):
        tts, reply = await self.exchange(())
        self.assertNotIn('spans', tts)
        self.assertNotIn('bend', reply['request'])


class SynthesiseContourTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, segment):
        worker = Mock()
        worker.settings = settings
        sent = {}

        async def prepare(text, source, output, run, prosody=None, **kwargs):
            sent.update(kwargs)
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3, 'contours': 1}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                _, metrics = await synthesise(segment, worker, directory=Path(scratch))
        return sent, metrics

    async def test_enabled_contours_reach_worker(self):
        sent, metrics = await self.run_segment(
            ApplioSettings(tts_provider='kokoro', interjection_contours=True),
            Segment('Aww, that is sweet.', 'tender', 1.0))
        self.assertEqual(sent['contours'], (0,))
        self.assertEqual(metrics['contours'], 1)

    async def test_off_edge_or_no_interjection_sends_nothing(self):
        cases = [(ApplioSettings(tts_provider='kokoro'), 'Aww, that is sweet.'),
                 (ApplioSettings(tts_provider='edge', interjection_contours=True), 'Aww, that is sweet.'),
                 (ApplioSettings(tts_provider='kokoro', interjection_contours=True), 'Hello there.')]
        for settings, text in cases:
            with self.subTest(provider=settings.tts_provider, text=text):
                sent, _ = await self.run_segment(settings, Segment(text))
                self.assertNotIn('contours', sent)

    def test_listened_default_bend(self):
        # Listening (7 Nov 2026): Aww needed far more lift; bend 8 peaks about one
        # octave up (Kokoro adds ~4 st itself) while RVC still voices it cleanly.
        self.assertEqual(ApplioSettings().interjection_bend, 8.0)
        # Listening: a 0.84 s hold sounded like "aw-aw-aw" and too slow for the rest of the
        # speech; the fixed vowel alone is ~0.36-0.39 s, so the hold is off by default.
        self.assertEqual(ApplioSettings().interjection_hold, 0.0)

    def test_settings_and_flags(self):
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), interjection_bend=value).check()
        for value in (-0.1, 1.3, float('nan')):
            with self.subTest(hold=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), interjection_hold=value).check()
        defaults = speech_settings(build_parser().parse_args(['--speech']))
        self.assertEqual((defaults.interjection_contours, defaults.interjection_bend,
                          defaults.interjection_hold), (False, 8.0, 0.0))
        settings = speech_settings(build_parser().parse_args(
            ['--speech', '--interjection-contours', '--interjection-bend', '3',
             '--interjection-hold', '0.6']))
        self.assertEqual((settings.interjection_contours, settings.interjection_bend,
                          settings.interjection_hold), (True, 3.0, 0.6))


if __name__ == '__main__':
    unittest.main()


class AwwPronunciationTests(unittest.TestCase):
    """Listening: "Aww" sounded like "awah" because espeak gives ɔːwə ("aw-wuh")."""

    def test_aww_family_becomes_one_long_vowel(self):
        from controller.kokoro_worker import respell_phonemes
        cases = [
            ('Aww, that is so sweet.', 'ˈɔːwə, ðæt ɪz sˌoʊ swˈiːt.', 'ˈɔːɔː, ðæt ɪz sˌoʊ swˈiːt.'),
            ('Awww!', 'ˈɔːʊwə!', 'ˈɔːɔː!'),
            ('Well, aww.', 'wˈɛl, ˈɔːwə.', 'wˈɛl, ˈɔːɔː.'),
        ]
        for text, phonemes, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(respell_phonemes(text, phonemes), expected)

    def test_other_words_and_misaligned_text_are_untouched(self):
        from controller.kokoro_worker import respell_phonemes
        for text, phonemes in (('Aw.', 'ˈɔː.'), ('I saw it.', 'aɪ sˈɔː ɪt.'),
                               ('Aww, sweet.', 'ˈɔːwə')):  # word counts differ
            with self.subTest(text=text):
                self.assertEqual(respell_phonemes(text, phonemes), phonemes)

    def synthesizer(self, phonemes):
        synthesizer = KokoroSpanTests.synthesizer(self)
        synthesizer.model.tokenizer.phonemize.return_value = phonemes
        return synthesizer

    def test_synthesize_speaks_corrected_phonemes(self):
        synthesizer = self.synthesizer('ˈɔːwə!')
        synthesizer.synthesize('Aww!', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual((args[0], kwargs['is_phonemes']), ('ˈɔːɔː!', True))

    def test_text_without_aww_keeps_the_plain_path(self):
        synthesizer = self.synthesizer('hɛlˈoʊ.')
        synthesizer.synthesize('Hello.', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual(args[0], 'Hello.')
        self.assertNotIn('is_phonemes', kwargs)
        synthesizer.model.tokenizer.phonemize.assert_not_called()

    def test_timed_path_uses_corrected_phonemes(self):
        synthesizer = self.synthesizer('ˈɔːwə, ðæt ɪz sˌoʊ swˈiːt.')
        synthesizer.synthesize('Aww, that is so sweet.', 'out.wav', spans=[0])
        self.assertEqual(synthesizer.model.create_timed.call_args.args[0], 'ˈɔːɔː, ðæt ɪz sˌoʊ swˈiːt.')


class AwwHoldTests(unittest.TestCase):
    """Listening: Aww should last about 0.6-1 s; Kokoro tops out near 0.45 s before it splits."""

    def periodic(self, rate=8000, seconds=1.0, hz=200):
        return [0.5 * math.sin(2 * math.pi * hz * i / rate) for i in range(int(rate * seconds))]

    def test_hold_repeats_whole_periods_to_reach_the_target(self):
        from controller.kokoro_worker import hold_vowel
        rate, samples = 8000, self.periodic()
        out, added = hold_vowel(list(samples), rate, 0.3, 0.5, 0.8)
        self.assertAlmostEqual(added, 0.6, delta=0.02)
        self.assertEqual(len(out), len(samples) + round(added * rate))
        self.assertEqual(out[:int(0.3 * rate)], samples[:int(0.3 * rate)])
        self.assertEqual(out[-int(0.4 * rate):], samples[-int(0.4 * rate):])
        period = rate // 200
        for at in range(int(0.4 * rate), int(0.95 * rate), period * 7):
            a, b = out[at:at + period], out[at + period:at + 2 * period]
            corr = sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
            self.assertGreater(corr, 0.98, f'held vowel stays periodic at {at / rate:.3f} s')

    def test_short_target_or_unpitched_span_is_left_alone(self):
        from controller.kokoro_worker import hold_vowel
        rate, samples = 8000, self.periodic()
        self.assertEqual(hold_vowel(list(samples), rate, 0.3, 0.5, 0.15), (samples, 0.0))
        silence = [0.0] * 8000
        self.assertEqual(hold_vowel(list(silence), rate, 0.3, 0.5, 0.8), (silence, 0.0))

    def test_hold_validation(self):
        from controller.kokoro_worker import validate_holds
        validate_holds([[0, 0.8]])
        for bad in ('x', [[0]], [[True, 0.8]], [[-1, 0.8]], [[0, 0.0]], [[0, 1.6]], [[0, 0.8]] * 5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_holds(bad)

    def test_synthesize_holds_aww_and_stretches_its_span(self):
        synthesizer = KokoroSpanTests.synthesizer(self)
        tone = self.periodic(rate=24000, seconds=1.75, hz=220)
        synthesizer.model.create_timed.return_value = (tone, 24000, REALLY)
        metrics = synthesizer.synthesize('I really like it.', 'out.wav', spans=[1], holds=[[1, 0.8]])
        written = synthesizer.soundfile.write.call_args.args[1]
        added = len(written) / 24000 - 1.75
        self.assertAlmostEqual(added, 0.8 - (0.85 - 0.625), delta=0.02)
        start, end = metrics['wordSpans'][0]
        self.assertEqual(start, 0.625)
        self.assertAlmostEqual(end - start, 0.8, delta=0.02)
        self.assertAlmostEqual(metrics['sourceSeconds'], 1.75 + added, places=2)

    async def run_request(self, settings, text):
        return await SynthesiseContourTests.run_segment(self, settings, Segment(text, 'tender', 1.0))

    def test_only_aww_words_are_held(self):
        settings = ApplioSettings(tts_provider='kokoro', interjection_contours=True,
                                  interjection_hold=0.8)
        sent, _ = asyncio.run(self.run_request(settings, 'Aww, that is so sweet.'))
        self.assertEqual(sent['holds'], ((0, 0.8),))
        sent, _ = asyncio.run(self.run_request(settings, 'Ooh! Nice.'))
        self.assertNotIn('holds', sent)
        sent, _ = asyncio.run(self.run_request(
            ApplioSettings(tts_provider='kokoro', interjection_contours=True, interjection_hold=0.0),
            'Aww, that is so sweet.'))
        self.assertNotIn('holds', sent)
