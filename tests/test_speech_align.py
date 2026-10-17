import unittest
from controller.speech_align import validate_cues


class ValidateCuesTests(unittest.TestCase):
    def test_accepts_rhubarb_track(self):
        cues = [{'start': 0.0, 'end': 0.18, 'value': 'X'}, {'start': 0.18, 'end': 0.34, 'value': 'F'},
                {'start': 0.34, 'end': 10.66, 'value': 'A'}]
        self.assertEqual(validate_cues(cues, 10.66)[1], {'start': 0.18, 'end': 0.34, 'shape': 'F'})

    def test_rejects_bad_tracks(self):
        bad = [
            [],
            [{'start': 0, 'end': 1, 'value': 'Z'}],
            [{'start': 0, 'end': float('nan'), 'value': 'A'}],
            [{'start': 0.5, 'end': 0.4, 'value': 'A'}],
            [{'start': 0, 'end': 0.5, 'value': 'A'}, {'start': 0.2, 'end': 0.6, 'value': 'B'}],
            [{'start': 0, 'end': 2.0, 'value': 'A'}],
            [{'start': '0', 'end': 0.5, 'value': 'A'}],
            ['A'],
        ]
        for cues in bad:
            with self.subTest(cues=cues), self.assertRaises(ValueError):
                validate_cues(cues, 1.0)


if __name__ == '__main__':
    unittest.main()
