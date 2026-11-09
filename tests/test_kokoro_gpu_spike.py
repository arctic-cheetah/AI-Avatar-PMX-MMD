"""Opt-in investigation adapter tests: run with the scratch native environment."""

from types import SimpleNamespace
import unittest

try:
    import numpy as np
    import torch
except ImportError:
    np = torch = None

from tools.kokoro_gpu_spike import TorchSessionAdapter, attach_migraphx


class MigraphxSelectionTests(unittest.TestCase):
    def test_only_registered_migraphx_devices_are_attached(self):
        cpu = SimpleNamespace(ep_name='CPUExecutionProvider')
        gpu = SimpleNamespace(ep_name='MIGraphXExecutionProvider')
        calls = []
        options = SimpleNamespace(add_provider_for_devices=lambda devices, values: calls.append(devices))
        attach_migraphx(options, SimpleNamespace(get_ep_devices=lambda: [cpu, gpu]))
        self.assertEqual(calls, [[gpu]])

    def test_registered_name_without_a_gpu_device_is_rejected(self):
        options = SimpleNamespace(add_provider_for_devices=lambda *args: self.fail('must not attach CPU'))
        with self.assertRaisesRegex(RuntimeError, 'MIGraphX.*device'):
            attach_migraphx(options, SimpleNamespace(get_ep_devices=lambda: []))


@unittest.skipIf(torch is None, 'requires scratch NumPy/PyTorch environment')
class NativeSessionTests(unittest.TestCase):
    def setUp(self):
        class Model(torch.nn.Module):
            def forward_with_tokens(self, tokens, style, speed=1):
                duration = torch.round(torch.ones_like(tokens) * 4 / speed).clamp(min=1).long().ravel()
                audio = torch.full((int(duration.sum()) * 600,), float(style[0, 0]))
                return audio, duration

        self.reference = SimpleNamespace(
            _model_path='scratch.onnx',
            get_inputs=lambda: [SimpleNamespace(name=n) for n in ('input_ids', 'style', 'speed')],
            get_outputs=lambda: [SimpleNamespace(name=n) for n in ('waveform', 'duration')],
            get_modelmeta=lambda: SimpleNamespace(custom_metadata_map={}),
        )
        self.adapter = TorchSessionAdapter(Model(), self.reference, device='cpu')
        self.inputs = {'input_ids': np.array([[0, 10, 11, 0]], dtype=np.int64),
                       'style': np.full((1, 256), 0.25, dtype=np.float32),
                       'speed': np.array([1], dtype=np.float32)}

    def test_scalar_speed_preserves_audio_and_duration_contract(self):
        audio, duration = self.adapter.run(None, self.inputs)
        np.testing.assert_array_equal(duration, [4, 4, 4, 4])
        self.assertEqual(audio.shape, (16 * 600,))
        self.assertEqual((audio.dtype, duration.dtype), (np.dtype('float32'), np.dtype('int64')))
        self.assertTrue(np.all(audio == 0.25))

    def test_per_token_speed_changes_only_the_selected_duration(self):
        self.inputs['speed'] = np.array([1, 0.5, 1, 1], dtype=np.float32)
        _, duration = self.adapter.run(None, self.inputs)
        np.testing.assert_array_equal(duration, [4, 8, 4, 4])

    def test_named_outputs_follow_requested_order(self):
        result = self.adapter.run(['duration', 'waveform'], self.inputs)
        self.assertEqual(result[0].shape, (4,))
        self.assertEqual(result[1].shape, (16 * 600,))
        with self.assertRaisesRegex(ValueError, 'output'):
            self.adapter.run(['missing'], self.inputs)

    def test_invalid_speed_is_rejected_before_inference(self):
        for speed in ([1, 1], [0], [-1], [float('nan')]):
            with self.subTest(speed=speed), self.assertRaisesRegex(ValueError, 'speed'):
                self.adapter.run(None, {**self.inputs, 'speed': np.array(speed, dtype=np.float32)})

    def test_empty_or_unpadded_token_batches_are_rejected(self):
        for tokens in (np.zeros((1, 0), dtype=np.int64), np.array([[1, 2, 3]]),
                       np.zeros((2, 4), dtype=np.int64)):
            with self.subTest(shape=tokens.shape), self.assertRaisesRegex(ValueError, 'token'):
                self.adapter.run(None, {**self.inputs, 'input_ids': tokens})

    def test_nonfinite_output_is_not_saved_as_successful_speech(self):
        self.inputs['style'][0, 0] = float('nan')
        with self.assertRaisesRegex(ValueError, 'finite'):
            self.adapter.run(None, self.inputs)


if __name__ == '__main__':
    unittest.main()
