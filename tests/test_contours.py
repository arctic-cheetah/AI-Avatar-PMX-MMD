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


class WordLiftTests(unittest.IsolatedAsyncioTestCase):
    """Listening: "sweetheart!" / "honey!" sounded monotonous against the rest of the sentence."""

    def test_endearments_in_address_and_the_exclaimed_word(self):
        from controller.speech import lift_words
        cases = {
            'Thank you, sweetheart!': (2,),
            'Hi honey, how are you?': (1,),
            'Oh, my love.': (2,),
            'We did it!': (2,),
            'Good night, darling.': (2,),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(lift_words(text), expected)

    def test_ordinary_uses_and_interjections_are_not_lifted(self):
        from controller.speech import lift_words
        for text in ('I love it.', 'Honey cake is nice.', 'Aww!', 'Hello there.', 'Ooh!'):
            with self.subTest(text=text):
                self.assertEqual(lift_words(text), ())

    def test_kokoro_reports_which_words_it_found(self):
        synthesizer = KokoroSpanTests.synthesizer(self)
        metrics = synthesizer.synthesize('I really like it.', 'out.wav', spans=[3, 9, 1])
        self.assertEqual(metrics['spanWords'], [3, 1])
        self.assertEqual(metrics['wordSpans'], [[1.15, 1.55], [0.625, 0.85]])

    async def exchange(self, contours, lifts, worker_script, rises=()):
        settings = ApplioSettings(tts_provider='kokoro', interjection_contours=True, word_lifts=True,
                                  interjection_bend=8.0, word_lift_bend=4.0)
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(worker_script)
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
                reply = await worker.request('Aww, sweetheart!', Path('s.wav'), Path('o.wav'),
                                             contours=contours, lifts=lifts,
                                             **({'rises': rises} if rises else {}))
            finally:
                await worker.close()
        return seen['tts'], reply

    async def test_each_word_gets_its_own_bend(self):
        script = SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                      '"wordSpans": [[0.2, 0.5], [0.6, 1.0]], "spanWords": [0, 1]')
        tts, reply = await self.exchange((0,), (1,), script)
        self.assertEqual(tts['spans'], [0, 1])
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 8.0], [0.6, 1.0, 4.0]])
        self.assertEqual((reply['contours'], reply['lifts']), (1, 1))

    async def test_lifts_alone(self):
        tts, reply = await self.exchange((), (1,), SPANS_WORKER)  # no spanWords: request order
        self.assertEqual(tts['spans'], [1])
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 4.0]])
        self.assertEqual(reply['lifts'], 1)
        self.assertNotIn('contours', reply)

    async def run_segment(self, settings, text):
        return await SynthesiseContourTests.run_segment(self, settings, Segment(text, 'tender', 1.0))

    async def test_synthesise_sends_lifts_only_when_enabled_for_kokoro(self):
        sent, _ = await self.run_segment(ApplioSettings(tts_provider='kokoro', word_lifts=True),
                                         'Thank you, sweetheart!')
        self.assertEqual(sent['lifts'], (2,))
        for settings in (ApplioSettings(tts_provider='kokoro'),
                         ApplioSettings(tts_provider='edge', word_lifts=True)):
            with self.subTest(provider=settings.tts_provider):
                sent, _ = await self.run_segment(settings, 'Thank you, sweetheart!')
                self.assertNotIn('lifts', sent)

    def test_settings_and_flags(self):
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), word_lift_bend=value).check()
        defaults = speech_settings(build_parser().parse_args(['--speech']))
        self.assertEqual((defaults.word_lifts, defaults.word_lift_bend), (False, 4.0))
        settings = speech_settings(build_parser().parse_args(
            ['--speech', '--word-lifts', '--word-lift-bend', '5']))
        self.assertEqual((settings.word_lifts, settings.word_lift_bend), (True, 5.0))


class QuestionRiseTests(unittest.IsolatedAsyncioTestCase):
    """Kokoro ends questions on a fall ("Is that so?" drops ~8 st); the actor rises."""

    def test_bend_can_peak_at_its_end(self):
        n = 200
        factors = bend_factors(n, FRAME, PAD, [(0.2, 0.4, 4.0, 1.0)])
        frame = lambda t: round((t + PAD) / FRAME)
        inside = [factors[frame(0.2 + i * 0.01)] for i in range(20)]
        self.assertEqual(inside, sorted(inside))                       # rises all the way
        self.assertAlmostEqual(factors[frame(0.39)], 2 ** (4 / 12), delta=0.01)
        self.assertEqual(factors[frame(0.45)], 1.0)
        # Three-element bends keep the rise-fall shape.
        self.assertEqual(bend_factors(n, FRAME, PAD, [(0.2, 0.4, 4.0)]),
                         bend_factors(n, FRAME, PAD, [(0.2, 0.4, 4.0, 0.4)]))

    def test_peak_position_validation(self):
        validate_bends([[0.1, 0.4, 4.0, 1.0]])
        for bad in ([[0.1, 0.4, 4.0, 0.0]], [[0.1, 0.4, 4.0, 1.5]], [[0.1, 0.4, 4.0, True]],
                    [[0.1, 0.4, 4.0, 1.0, 9]]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_bends(bad)

    def test_question_words(self):
        from controller.speech import question_words
        cases = {'Are you okay?': (2,), 'Is that so?': (2,), 'Are you okay, honey?': (3,),
                 '"Really?"': (0,), 'Really?!': (), 'Hello.': (), 'We did it!': ()}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(question_words(text), expected)

    async def test_rises_become_end_peaked_bends(self):
        tts, reply = await WordLiftTests.exchange(self, (), (), SPANS_WORKER, rises=(2,))
        self.assertEqual(tts['spans'], [2])
        # Probe on real RVC: 4 st peaking at the end only touched the last blip; 8 st peaking
        # at 70 % turned Kokoro's fall ("so" 202 -> 152 Hz) into a rise (204 -> 192 -> 207 -> 241 Hz).
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 8.0, 0.7]])
        self.assertEqual(reply['rises'], 1)

    def test_question_rise_settings_and_flag(self):
        # Listening: questions needed 10-20 Hz more; one semitone is ~+14 Hz at ~230 Hz.
        self.assertEqual(ApplioSettings().question_rise_bend, 9.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), question_rise_bend=value).check()
        args = build_parser().parse_args(['--speech', '--question-rise-bend', '6'])
        self.assertEqual(speech_settings(args).question_rise_bend, 6.0)

    async def test_synthesise_rises_on_questions_instead_of_lifting(self):
        settings = ApplioSettings(tts_provider='kokoro', word_lifts=True)
        sent, _ = await SynthesiseContourTests.run_segment(self, settings, Segment('Are you okay?'))
        self.assertEqual((sent['rises'], 'lifts' in sent), ((2,), False))
        sent, _ = await SynthesiseContourTests.run_segment(self, settings, Segment('Are you okay, honey?'))
        self.assertEqual((sent['rises'], 'lifts' in sent), ((3,), False))
        sent, _ = await SynthesiseContourTests.run_segment(self, settings, Segment('Thank you, sweetheart!'))
        self.assertEqual((sent['lifts'], 'rises' in sent), ((2,), False))


class AudibleSpanTests(unittest.TestCase):
    """Kokoro's last phoneme often soaks up trailing silence ("so?" voiced 0.85-1.05 s, span to
    1.425 s), so an end-peaked rise landed in silence. Spans are trimmed to what is audible."""

    def test_span_shrinks_to_the_loud_part(self):
        from controller.kokoro_worker import audible_span
        rate = 1000
        samples = [0.0] * 200 + [0.5] * 300 + [0.001] * 400 + [0.0] * 100   # loud 0.2-0.5 s
        self.assertEqual(audible_span(samples, rate, 0.1, 0.9), (0.2, 0.5))
        self.assertEqual(audible_span(samples, rate, 0.25, 0.45), (0.25, 0.45))   # already loud
        self.assertEqual(audible_span([0.0] * 1000, rate, 0.1, 0.9), (0.1, 0.9))   # nothing to keep

    def test_reported_spans_are_audible(self):
        synthesizer = KokoroSpanTests.synthesizer(self)
        rate = 24000
        samples = [0.5] * int(1.3 * rate) + [0.0005] * int(0.45 * rate)   # quiet after 1.3 s
        synthesizer.model.create_timed.return_value = (samples, rate, REALLY)
        metrics = synthesizer.synthesize('I really like it.', 'out.wav', spans=[3])
        start, end = metrics['wordSpans'][0]
        self.assertEqual(start, 1.15)
        self.assertAlmostEqual(end, 1.3, delta=0.011)   # was 1.55: the quiet tail is dropped


class AwwSpellingTests(unittest.TestCase):
    """Listening: "awah" came back; LLM spellings like Awwww!/Aaww!/aWWW! escaped the fix."""

    def test_aww_family_is_written_canonically(self):
        from controller.kokoro_worker import canonical_aww
        self.assertEqual(canonical_aww('Awwww! Aaww, aWWW and Awwh. Awwwwww~'),
                         'Aww! Aww, aww and Aww. Aww~')
        for text in ('Aw, shucks.', 'Awful weather.', 'I saw it.', 'Away we go.', 'Aww, sweet.'):
            with self.subTest(text=text):
                self.assertEqual(canonical_aww(text), text)

    def test_synthesize_speaks_any_aww_spelling_as_one_vowel(self):
        synthesizer = KokoroSpanTests.synthesizer(self)
        espeak = {'Aww!': 'ˈɔːwə!', 'Awwww!': 'ˈɔːʊˌʊwə!'}
        synthesizer.model.tokenizer.phonemize.side_effect = lambda text, lang: espeak[text]
        synthesizer.synthesize('Awwww!', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual((args[0], kwargs['is_phonemes']), ('ˈɔːɔː!', True))
