"""Everything approved by listening is on by default; each part can still be switched off."""
import unittest

from controller.bridge import build_parser, speech_settings
from controller.speech import ApplioSettings

FEATURES = ('mood_prosody', 'punctuation_cadence', 'emphasis', 'interjection_contours', 'word_lifts',
            'quote_voice')


class ExpressiveDefaultTests(unittest.TestCase):
    def test_settings_default_to_the_listened_voice(self):
        settings = ApplioSettings()
        self.assertEqual({name: getattr(settings, name) for name in FEATURES},
                         dict.fromkeys(FEATURES, True))

    def test_bridge_defaults_on_and_each_part_can_be_turned_off(self):
        defaults = speech_settings(build_parser().parse_args(['--speech']))
        self.assertTrue(all(getattr(defaults, name) for name in FEATURES))
        for name in FEATURES:
            flag = '--no-' + name.replace('_', '-')
            with self.subTest(flag=flag):
                settings = speech_settings(build_parser().parse_args(['--speech', flag]))
                self.assertFalse(getattr(settings, name))
                self.assertTrue(all(getattr(settings, other) for other in FEATURES if other != name))

    def test_plain_voice_turns_every_part_off(self):
        settings = speech_settings(build_parser().parse_args(['--speech', '--plain-voice']))
        self.assertFalse(any(getattr(settings, name) for name in FEATURES))


if __name__ == '__main__':
    unittest.main()
