"""An emphasis pause must not break a voiced transition at a text-space token."""

import unittest
from unittest.mock import Mock

from controller.kokoro_worker import Synthesizer, pause_points
from test_emphasis import REALLY


class SafePauseTests(unittest.TestCase):
    def test_voiced_space_is_not_an_audio_gap(self):
        self.assertEqual(pause_points(REALLY, [1], samples=[0.5] * 2000, rate=1000), [])

    def test_finds_quiet_window_inside_space_away_from_nominal_midpoint(self):
        samples = [0.5] * 2000
        samples[580:590] = [0.0] * 10
        points = pause_points(REALLY, [1], samples=samples, rate=1000)
        self.assertEqual(points, [0.585])

    def test_short_silence_and_soft_voiced_nasal_are_not_safe_gaps(self):
        for length, amplitude in ((5, 0.0), (50, 0.02)):
            with self.subTest(length=length, amplitude=amplitude):
                samples = [0.5] * 2000
                samples[575:575 + length] = [amplitude] * length
                self.assertEqual(pause_points(REALLY, [1], samples=samples, rate=1000), [])

    def test_quiet_elsewhere_does_not_move_pause_into_another_word(self):
        samples = [0.5] * 2000
        samples[625:675] = [0.0] * 50
        self.assertEqual(pause_points(REALLY, [1], samples=samples, rate=1000), [])

    def test_silent_clip_first_and_missing_words_get_no_pause(self):
        self.assertEqual(pause_points(REALLY, [1], samples=[0.0] * 2000, rate=1000), [])
        self.assertEqual(pause_points(REALLY, [0, 9], samples=[0.5] * 2000, rate=1000), [])


class OnsetSynthesisTests(unittest.TestCase):
    def synthesizer(self, samples):
        synth = Synthesizer.__new__(Synthesizer)
        synth.model = Mock()
        synth.model.tokenizer.phonemize.return_value = 'aɪ ɹˈiəli lˈaɪk ɪt.'
        synth.model.create_timed.return_value = (samples, 1000, REALLY)
        synth.soundfile = Mock()
        synth.voice, synth.style, synth.speed = 'af_heart', object(), 1.0
        synth.clause_pause = .25
        return synth

    def test_unsafe_pause_preserves_every_speech_sample_and_word_span(self):
        samples = [0.5] * 2000
        synth = self.synthesizer(samples)
        metrics = synth.synthesize('I really like it.', 'unused.wav', emphasis=[1], spans=[1])
        self.assertEqual(synth.soundfile.write.call_args.args[1], samples)
        self.assertEqual(metrics['emphasisPauses'], 0)
        self.assertEqual(metrics['emphasisSkipped'], 'no-safe-gap')
        self.assertEqual(metrics['wordSpans'], [[.625, .85]])

    def test_mixed_requests_shift_spans_only_for_the_safe_pause(self):
        samples = [0.5] * 2000
        samples[1115:1135] = [0.0] * 20
        synth = self.synthesizer(samples)
        metrics = synth.synthesize('I really like it.', 'unused.wav', emphasis=[1, 3], spans=[1, 3])
        self.assertEqual(metrics['emphasisPauses'], 1)
        self.assertEqual(metrics['wordSpans'][0], [.625, .85])
        self.assertAlmostEqual(metrics['wordSpans'][1][0], 1.27)
        self.assertEqual(len(synth.soundfile.write.call_args.args[1]), 2120)


if __name__ == '__main__':
    unittest.main()
