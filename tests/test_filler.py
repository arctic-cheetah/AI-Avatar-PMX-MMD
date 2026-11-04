import unittest
from unittest.mock import AsyncMock, patch

from controller.bridge import build_parser
from controller.filler import FILLER_TEXT, prepare_filler
from controller.speech import Segment


class FillerPreparationTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepares_fixed_filler_once_in_private_cache(self):
        synthesise = AsyncMock(return_value=("0123456789abcdef", {}))
        with patch("controller.filler.synthesise", synthesise):
            result = await prepare_filler(object())
        self.assertEqual(result, "0123456789abcdef")
        segment = synthesise.await_args.args[0]
        self.assertIsInstance(segment, Segment)
        self.assertEqual(segment.text, FILLER_TEXT)
        self.assertTrue(synthesise.await_args.kwargs["directory"].name == "filler")
        synthesise.assert_awaited_once()

    async def test_optional_filler_failure_does_not_stop_bridge(self):
        with patch("controller.filler.synthesise", AsyncMock(side_effect=RuntimeError("no TTS"))):
            self.assertIsNone(await prepare_filler(object()))


class FillerArgumentTests(unittest.TestCase):
    def test_disabled_by_default(self):
        args = build_parser().parse_args([])
        self.assertFalse(args.thinking_filler)

    def test_explicit_opt_in(self):
        args = build_parser().parse_args(["--speech", "--thinking-filler"])
        self.assertTrue(args.thinking_filler)


if __name__ == "__main__":
    unittest.main()
