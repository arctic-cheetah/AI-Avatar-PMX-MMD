"""Review follow-ups from #86 and #88: tail-padding fade, empty audition lines, emphasis skip reasons."""
import tempfile
import unittest
import wave
from array import array
from pathlib import Path
from unittest.mock import Mock

from controller.kokoro_worker import Synthesizer
from controller.speech_trim import trim_clip
from test_speech_pipeline import write_wav


class PaddingFadeTests(unittest.TestCase):
    def test_audio_fades_out_before_padded_silence(self):
        # Review (#86): a hard switch from RVC's residual tail to digital zeros can click.
        with tempfile.TemporaryDirectory() as scratch:
            source, output = Path(scratch) / 's.wav', Path(scratch) / 'o.wav'
            write_wav(source, 24000, [(0.2, 'silence'), (1.0, 'tone'), (0.05, 'silence')])
            write_wav(output, 24000, [(0.2, 'silence'), (1.0, 'tone'), (0.05, 'tone')])  # loud to the end
            trim_clip(source, output, 'Well...', ellipsis_tail=0.6)
            with wave.open(str(output), 'rb') as clip:
                rate, frames = clip.getframerate(), clip.readframes(clip.getnframes())
            samples = array('h', frames)
            pad_start = int((0.05 + 1.0 + 0.05) * rate)        # lead + speech + the clip's own tail
            last = samples[pad_start - int(0.002 * rate):pad_start]
            self.assertLess(max(abs(x) for x in last), 1500)   # faded, not cut at full level
            self.assertEqual(set(samples[pad_start:]), {0})


class JoinWavsTests(unittest.TestCase):
    def test_no_clips_writes_no_file(self):
        # Review (#86): an unspeakable audition line produced an invalid WAV.
        from controller.audition_kokoro import join_wavs
        with tempfile.TemporaryDirectory() as scratch:
            target = Path(scratch) / 'joined.wav'
            self.assertFalse(join_wavs([], target))
            self.assertFalse(target.exists())


class EmphasisSkipReasonTests(unittest.TestCase):
    def synthesizer(self, phonemes, timings):
        synthesizer = Synthesizer.__new__(Synthesizer)
        synthesizer.model = Mock()
        synthesizer.model.tokenizer.phonemize.return_value = phonemes
        synthesizer.model.create.return_value = ([0.5] * 24000, 24000)
        synthesizer.model.create_timed.return_value = ([0.5] * 24000, 24000, timings)
        synthesizer.soundfile = Mock()
        synthesizer.voice, synthesizer.style, synthesizer.speed = 'af_heart', object(), 1.0
        synthesizer.clause_pause = 0.25
        return synthesizer

    def test_reasons_tell_apart_why_no_pause_was_made(self):
        # Review (#88): emphasisPauses 0 looked the same for every cause.
        from test_emphasis import REALLY
        cases = [
            ('misaligned', 'a b c d e f', REALLY, [1]),
            ('no-timings', 'aɪ ɹˈiəli lˈaɪk ɪt.', [], [1]),
            ('first-word', 'aɪ ɹˈiəli lˈaɪk ɪt.', REALLY, [0]),
        ]
        for reason, phonemes, timings, emphasis in cases:
            with self.subTest(reason=reason):
                metrics = self.synthesizer(phonemes, timings).synthesize(
                    'I really like it.', 'out.wav', emphasis=emphasis, emphasis_pause=0.12)
                self.assertEqual((metrics['emphasisPauses'], metrics.get('emphasisSkipped')), (0, reason))
        metrics = self.synthesizer('aɪ ɹˈiəli lˈaɪk ɪt.', REALLY).synthesize(
            'I really like it.', 'out.wav', emphasis=[1], emphasis_pause=0.12)
        self.assertEqual(metrics['emphasisPauses'], 1)
        self.assertNotIn('emphasisSkipped', metrics)


if __name__ == '__main__':
    unittest.main()
