"""Per-token speed (#83 scope 2): Kokoro draws a sound out itself, from a patched model.

Spike and listening, 8 Nov 2026 (docs/testing-kokoro.md §2h): the model's speed input
only feeds the duration Div, so declaring it as [n] gives one speed per token. Up to
5 frames (125 ms) on one sound sounded natural; 8 frames broke up.
"""
from collections import namedtuple
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from controller.bridge import build_parser, speech_settings
from controller.kokoro_worker import (
    FRAME,
    MAX_STRETCH,
    PROSODY_FIELDS,
    Synthesizer,
    TokenPlan,
    install_token_speeds,
    stretch_factors,
    stretch_sounds,
    token_speed_vector,
    validate_stretch,
)
from controller.speech import ApplioSettings, ApplioWorker
from test_contours import SPANS_WORKER

Timing = namedtuple('Timing', 'phoneme start end')
HAS_ONNX = importlib.util.find_spec('onnx') is not None
HAS_KOKORO = importlib.util.find_spec('kokoro_onnx') is not None


def timed(phonemes: str, frames: list[int]) -> list[Timing]:
    """Fake Kokoro timings: one entry per phoneme, ``frames`` 25 ms frames each."""
    out, t = [], 0.0
    for phoneme, count in zip(phonemes, frames):
        out.append(Timing(phoneme, t, t + count * FRAME))
        t += count * FRAME
    return out


class StretchSoundTests(unittest.TestCase):
    def test_the_stressed_vowel_and_a_holdable_consonant_after_it(self):
        cases = {
            'bˌʌt': [2],         # t stops the air: it cannot be drawn out
            'ʃˈʊɹ': [2, 3],      # suuure
            'wˈɛl': [2, 3],      # wellll
            'sˌoʊ': [2, 3],      # sooo: both halves of the diphthong
            'nˈoʊ': [2, 3],
            'tɹˈaɪ.': [3, 4],    # punctuation is never stretched
            'dˈɪd': [2],
            'həm': [1, 2],       # no stress mark: the first vowel
            'ˈɑːbviəsli': [1, 2],  # a length mark belongs to its vowel
        }
        for word, positions in cases.items():
            with self.subTest(word=word):
                self.assertEqual(stretch_sounds(word), positions)

    def test_primary_stress_wins_over_secondary(self):
        self.assertEqual(stretch_sounds('ˌʌndɚstˈænd'), [8])

    def test_no_extra_syllables(self):
        # Listening (9 Nov 2026): "really" drawn out over i, ə and l sounded like "reality".
        # Only a real diphthong's second half joins the vowel, and a consonant only when it
        # ends the word ("wellll", "suuure"), not when it starts the next syllable.
        cases = {'ɹˈiəli': [2], 'sˈiəɹɪəsli': [2], 'wˈʌt': [2], 'wˈaʊ': [2, 3], 'ʃˈʊɹ,': [2, 3],
                 'kjˈuːt': [3, 4], 'ɹˈaɪt': [2, 3], 'hˈɛloʊ': [2]}
        for word, positions in cases.items():
            with self.subTest(word=word):
                self.assertEqual(stretch_sounds(word), positions)

    def test_nothing_to_stretch(self):
        self.assertEqual(stretch_sounds('ʃ'), [])
        self.assertEqual(stretch_sounds(','), [])


class StretchFactorTests(unittest.TestCase):
    PHONEMES = 'bˌʌt aɪ.'
    FRAMES = [1, 1, 1, 1, 2, 3, 4, 2]

    def test_slows_only_the_chosen_sounds_to_the_target(self):
        factors = stretch_factors(timed(self.PHONEMES, self.FRAMES), self.PHONEMES, [[0, 0.125]])
        self.assertEqual(len(factors), len(self.PHONEMES))
        self.assertAlmostEqual(factors[2], 1 / 5)  # ʌ: 1 frame → 5
        self.assertEqual([f for i, f in enumerate(factors) if i != 2], [1.0] * 7)

    def test_capped_at_five_frames_and_never_faster(self):
        self.assertEqual(MAX_STRETCH, 0.125)
        factors = stretch_factors(timed(self.PHONEMES, self.FRAMES), self.PHONEMES, [[1, 0.075]])
        # aɪ: a is 3 frames → 3 (left alone), ɪ is 4 frames → 3 would be faster: left alone.
        self.assertEqual(factors, [1.0] * 8)
        long = stretch_factors(timed(self.PHONEMES, self.FRAMES), self.PHONEMES, [[0, 0.5]])
        self.assertAlmostEqual(long[2], 1 / 5)

    def test_target_follows_the_sentence_pace(self):
        # A sentence spoken at 1.25x gets a shorter drawl: 0.125 s / 1.25 = 4 frames.
        factors = stretch_factors(timed(self.PHONEMES, self.FRAMES), self.PHONEMES, [[0, 0.125]], speed=1.25)
        self.assertAlmostEqual(factors[2], 1 / 4)

    def test_misaligned_or_missing_words(self):
        self.assertIsNone(stretch_factors(timed('bˌʌt', [1] * 4), self.PHONEMES, [[0, 0.125]]))
        self.assertEqual(stretch_factors(timed(self.PHONEMES, self.FRAMES), self.PHONEMES, [[5, 0.125]]),
                         [1.0] * 8)

    def test_validation(self):
        validate_stretch([[0, 0.125], [3, 0.05]])
        for bad in ([[0, 0]], [[0, 0.126]], [[-1, 0.1]], [[True, 0.1]], [[0, float('nan')]], 'x',
                    [[0, 0.1]] * 5):
            with self.subTest(stretch=bad), self.assertRaises(ValueError):
                validate_stretch(bad)
        self.assertIn('stretch', PROSODY_FIELDS)


class TokenPlanTests(unittest.TestCase):
    def test_batches_take_their_own_factors_in_order(self):
        # Kokoro splits "a, b" into batches and may drop the space between them.
        plan = TokenPlan([10, 11, 12, 13, 14], [1.0, 0.5, 1.0, 1.0, 0.25])
        self.assertEqual(plan.take([10, 11]), [1.0, 0.5])
        self.assertEqual(plan.take([13, 14]), [1.0, 0.25])
        self.assertIsNone(plan.take([10]))  # already used: no match after the cursor

    def test_speed_vector_pads_both_ends(self):
        self.assertEqual(token_speed_vector([1.0, 0.2], 0.9), [0.9, 0.9, 0.18, 0.9])


class InstallTests(unittest.TestCase):
    def test_refuses_a_wrapper_without_the_expected_internals(self):
        self.assertFalse(install_token_speeds(object(), lambda: None))

    def test_unplanned_calls_use_the_original(self):
        model = Mock(spec=['_infer', 'sess', '_tokens_input', '_input_dtypes'])
        original = model._infer
        original.return_value = ('audio', 'duration')
        self.assertTrue(install_token_speeds(model, lambda: None))
        self.assertEqual(model._infer([1, 2], 'style', 1.0), ('audio', 'duration'))
        original.assert_called_once_with([1, 2], 'style', 1.0)


class SynthesizeStretchTests(unittest.TestCase):
    def synthesizer(self, token_speeds: bool):
        synthesizer = Synthesizer.__new__(Synthesizer)
        synthesizer.model = Mock()
        synthesizer.model.tokenizer.phonemize.return_value = 'bˌʌt aɪ.'
        synthesizer.model.tokenizer.known.side_effect = lambda p: p
        synthesizer.model.tokenizer.tokenize.side_effect = lambda p: list(range(len(p)))
        synthesizer.soundfile = Mock()
        synthesizer.voice, synthesizer.style, synthesizer.speed = 'af_heart', object(), 1.0
        synthesizer.clause_pause = 0.25
        synthesizer.token_speeds, synthesizer.plan = token_speeds, None
        return synthesizer

    def test_two_passes_with_the_plan_active_only_on_the_second(self):
        synthesizer = self.synthesizer(True)
        plans = []
        first = timed('bˌʌt aɪ.', [1, 1, 1, 1, 2, 3, 4, 2])
        second = timed('bˌʌt aɪ.', [1, 1, 5, 1, 2, 3, 4, 2])

        def create_timed(*args, **kwargs):
            plans.append(synthesizer.plan)
            timings = first if len(plans) == 1 else second
            return [0.0] * int(timings[-1].end * 24000), 24000, timings

        synthesizer.model.create_timed.side_effect = create_timed
        metrics = synthesizer.synthesize('But I.', 'out.wav', stretch=[[0, 0.125]], spans=[0])
        self.assertIsNone(plans[0])
        self.assertAlmostEqual(plans[1].factors[2], 1 / 5)
        self.assertIsNone(synthesizer.plan)  # cleared afterwards
        self.assertEqual(metrics['stretched'], 1)
        self.assertEqual(metrics['wordSpans'], [[0.0, 0.2]])  # from the second pass

    def test_without_the_patched_model_it_says_why(self):
        synthesizer = self.synthesizer(False)
        timings = timed('bˌʌt aɪ.', [1, 1, 1, 1, 2, 3, 4, 2])
        synthesizer.model.create_timed.return_value = ([0.0] * 7200, 24000, timings)
        metrics = synthesizer.synthesize('But I.', 'out.wav', stretch=[[0, 0.125]])
        self.assertEqual(synthesizer.model.create_timed.call_count, 1)
        self.assertEqual((metrics['stretched'], metrics['stretchSkipped']), (0, 'no-model'))


class DrawlStretchRequestTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, settings):
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                                   '"wordSpans": [[0.2, 0.5]], "spanWords": [0], "stretched": 1'))
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
        return seen['tts'], reply

    async def test_drawls_ask_kokoro_to_stretch_instead_of_holding(self):
        tts, reply = await self.exchange(ApplioSettings(tts_provider='kokoro', dynamic_emphasis=True,
                                                        drawl_hold=0.3))
        self.assertEqual(tts['stretch'], [[0, 0.125]])
        self.assertNotIn('holds', tts)
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, -2.0]])
        self.assertEqual(reply['stretched'], 1)

    async def test_stretch_off_keeps_the_old_hold(self):
        tts, _ = await self.exchange(ApplioSettings(tts_provider='kokoro', dynamic_emphasis=True,
                                                    drawl_stretch=0.0, drawl_hold=0.3))
        self.assertNotIn('stretch', tts)
        self.assertEqual(tts['holds'], [[0, 0.3]])


class DrawlStretchSettingsTests(unittest.TestCase):
    def test_listened_default_and_range(self):
        # Listening (8 Nov 2026): buut / buuut / buuuut / buuuuut at <= 5 frames a sound all
        # sounded good; 8 frames on one vowel broke up.
        self.assertEqual(ApplioSettings().drawl_stretch, 0.125)
        for value in (-0.01, 0.126, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), drawl_stretch=value).check()

    def test_flag(self):
        settings = speech_settings(build_parser().parse_args(['--speech', '--drawl-stretch', '0.075']))
        self.assertEqual(settings.drawl_stretch, 0.075)
        self.assertEqual(speech_settings(build_parser().parse_args(['--speech'])).drawl_stretch, 0.125)


@unittest.skipUnless(HAS_ONNX, 'needs the onnx package (.venv-kokoro after setup)')
class PerTokenModelTests(unittest.TestCase):
    def tiny_model(self, path: Path, extra_consumer: bool = False):
        import onnx
        from onnx import TensorProto, helper
        nodes = [helper.make_node('Div', ['dur', 'speed'], ['out'])]
        outputs = [helper.make_tensor_value_info('out', TensorProto.FLOAT, [1, 'n'])]
        if extra_consumer:
            nodes.append(helper.make_node('Identity', ['speed'], ['copy']))
            outputs.append(helper.make_tensor_value_info('copy', TensorProto.FLOAT, [1]))
        graph = helper.make_graph(nodes, 'tiny', [
            helper.make_tensor_value_info('dur', TensorProto.FLOAT, [1, 'n']),
            helper.make_tensor_value_info('speed', TensorProto.FLOAT, [1])], outputs)
        onnx.save(helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)]), str(path))

    def test_speed_becomes_one_value_per_token(self):
        import onnx
        from controller.setup_kokoro import make_per_token_model, per_token_ready
        with tempfile.TemporaryDirectory() as scratch:
            source, target = Path(scratch) / 'm.onnx', Path(scratch) / 'm-pertoken.onnx'
            self.tiny_model(source)
            self.assertFalse(per_token_ready(source))
            make_per_token_model(source, target)
            self.assertTrue(per_token_ready(target))
            speed = next(i for i in onnx.load(str(target)).graph.input if i.name == 'speed')
            self.assertEqual(speed.type.tensor_type.shape.dim[0].dim_param, 'speed_len')

    def test_refuses_a_graph_that_uses_speed_elsewhere(self):
        from controller.setup_kokoro import make_per_token_model
        with tempfile.TemporaryDirectory() as scratch:
            source, target = Path(scratch) / 'm.onnx', Path(scratch) / 'm-pertoken.onnx'
            self.tiny_model(source, extra_consumer=True)
            with self.assertRaises(RuntimeError):
                make_per_token_model(source, target)
            self.assertFalse(target.exists())


@unittest.skipUnless(HAS_KOKORO and Path('models/kokoro/kokoro-v1.0-pertoken.onnx').is_file(),
                     'needs .venv-kokoro and the per-token model from setup')
class RealModelTests(unittest.TestCase):
    def test_kokoro_draws_out_only_the_stretched_word(self):
        synthesizer = Synthesizer()
        self.assertTrue(synthesizer.token_speeds)
        with tempfile.TemporaryDirectory() as scratch:
            out = str(Path(scratch) / 'out.wav')
            plain = synthesizer.synthesize('But I really did try.', out, spans=[0, 2])
            drawn = synthesizer.synthesize('But I really did try.', out, spans=[0, 2], stretch=[[0, 0.125]])
        length = lambda spans, i: spans[i][1] - spans[i][0]
        self.assertEqual(drawn['stretched'], 1)
        self.assertGreaterEqual(length(drawn['wordSpans'], 0) - length(plain['wordSpans'], 0), 3 * FRAME)
        self.assertAlmostEqual(length(drawn['wordSpans'], 1), length(plain['wordSpans'], 1), delta=FRAME)


if __name__ == '__main__':
    unittest.main()
