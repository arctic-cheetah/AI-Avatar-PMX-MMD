"""Native setup/session boundaries without requiring GPU hardware."""

import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

try:
    import numpy as np
    import torch
except ImportError:
    np = torch = None


class NativeAssetTests(unittest.TestCase):
    def test_bad_download_preserves_existing_asset_and_cleans_partial(self):
        from controller.setup_kokoro_rocm import fetch_asset
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'model.pth'
            target.write_bytes(b'original')
            with patch('controller.setup_kokoro_rocm.urllib.request.urlopen', return_value=io.BytesIO(b'corrupt')):
                with self.assertRaisesRegex(RuntimeError, 'SHA256'):
                    fetch_asset('https://example.invalid/model', target, hashlib.sha256(b'expected').hexdigest())
            self.assertEqual(target.read_bytes(), b'original')
            self.assertFalse(target.with_suffix('.pth.partial').exists())

    def test_verified_asset_does_not_need_network(self):
        from controller.setup_kokoro_rocm import fetch_asset
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'model.pth'
            target.write_bytes(b'verified')
            with patch('controller.setup_kokoro_rocm.urllib.request.urlopen') as network:
                fetch_asset('https://example.invalid/model', target, hashlib.sha256(b'verified').hexdigest())
            network.assert_not_called()

    def test_native_assets_are_verified_before_loading(self):
        from controller.kokoro_native import validate_assets
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'config.json').write_text('{}')
            (root/'kokoro-v1_0.pth').write_bytes(b'wrong weights')
            with self.assertRaisesRegex(RuntimeError, 'SHA256|setup_kokoro_rocm'):
                validate_assets(root)

    def test_native_factory_requires_matching_decoder_and_bypasses_miopen(self):
        from controller.kokoro_native import load_session
        torch=SimpleNamespace(version=SimpleNamespace(hip='7.2'),
                              cuda=SimpleNamespace(is_available=lambda: False),
                              backends=SimpleNamespace(cudnn=SimpleNamespace(enabled=True)),
                              set_num_threads=Mock(), set_num_interop_threads=Mock())
        factory=Mock(return_value=Mock())
        with patch('controller.kokoro_native.validate_assets', return_value=(Path('config.json'), Path('model.pth'))), \
             patch.dict('sys.modules', {'torch':torch, 'kokoro.model':SimpleNamespace(KModel=factory)}), \
             patch('controller.kokoro_native.NativeSession', return_value=SimpleNamespace(runtime={})):
            load_session('cpu',2)
        self.assertTrue(factory.call_args.kwargs['disable_complex'])
        self.assertFalse(torch.backends.cudnn.enabled)


@unittest.skipUnless(torch is not None and np is not None, 'optional native runtime is not installed')
class NativeSessionTests(unittest.TestCase):
    def setUp(self):
        from controller.kokoro_native import NativeSession
        self.model = Mock(vocab={'a': 1}, context_length=512)
        self.model.to.return_value = self.model
        self.model.eval.return_value = self.model
        self.model.forward_with_tokens.return_value = (torch.zeros(24), torch.ones(3, dtype=torch.int64))
        self.session = NativeSession(self.model, __file__, torch, 'cpu')
        self.inputs = {'input_ids': np.array([[0, 1, 0]], dtype=np.int64),
                       'style': np.zeros((1, 256), dtype=np.float32),
                       'speed': np.ones(1, dtype=np.float32)}

    def test_scalar_and_per_token_speeds_preserve_durations_and_output_order(self):
        for speed in (np.ones(1, dtype=np.float32), np.array([1, .5, 1], dtype=np.float32)):
            self.inputs['speed'] = speed
            durations, audio = self.session.run(['duration', 'waveform'], self.inputs)
            self.assertEqual(durations.tolist(), [1, 1, 1])
            self.assertEqual(audio.shape, (24,))
            self.assertEqual(audio.dtype, np.float32)
            np.testing.assert_array_equal(self.model.forward_with_tokens.call_args.args[2].numpy(), speed)

    def test_invalid_inputs_are_rejected_before_inference(self):
        for key, invalid in [('speed', np.array([0.])), ('speed', np.array([np.nan])),
                             ('speed', np.ones(2)), ('style', np.full((1, 256), np.inf)),
                             ('input_ids', np.array([[1, 1, 0]], dtype=np.int64))]:
            with self.subTest(key=key, invalid=invalid):
                inputs = {**self.inputs, key: invalid}
                with self.assertRaises(ValueError):
                    self.session.run(None, inputs)
        self.model.forward_with_tokens.assert_not_called()

    def test_broken_model_outputs_are_not_written_as_success(self):
        for audio, duration in [(torch.zeros(0), torch.ones(3, dtype=torch.int64)),
                                (torch.tensor([float('nan')]), torch.ones(3, dtype=torch.int64)),
                                (torch.zeros(24), torch.ones(2, dtype=torch.int64)),
                                (torch.zeros(24), torch.ones(3))]:
            self.model.forward_with_tokens.return_value = audio, duration
            with self.assertRaises(RuntimeError):
                self.session.run(None, self.inputs)


if __name__ == '__main__':
    unittest.main()
