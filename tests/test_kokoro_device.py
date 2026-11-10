"""Bridge/worker contract for optional native Kokoro (#62)."""

import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from controller.bridge import build_parser, speech_settings
from controller.speech import ApplioSettings, ApplioWorker


class KokoroDeviceFlagsTests(unittest.TestCase):
    def test_cpu_default_and_explicit_native_flags_reach_only_kokoro(self):
        default = speech_settings(build_parser().parse_args(['--speech', '--tts', 'kokoro']))
        self.assertEqual((default.kokoro_device, default.kokoro_backend), ('cpu', 'auto'))
        args = build_parser().parse_args(['--speech', '--tts', 'kokoro', '--kokoro-device', 'gpu',
                                         '--kokoro-backend', 'native', '--kokoro-python', '/opt/native/python',
                                         '--rvc-device', 'cpu'])
        settings = speech_settings(args)
        worker = ApplioWorker(settings)
        command = worker.kokoro.command
        self.assertEqual(command[0], '/opt/native/python')
        self.assertEqual(command[command.index('--device') + 1], 'gpu')
        self.assertEqual(command[command.index('--backend') + 1], 'native')
        self.assertEqual(settings.worker_config()['rvc_device'], 'cpu')
        self.assertNotIn('kokoro_device', settings.worker_config())

    def test_invalid_selection_fails_before_asset_checks(self):
        with self.assertRaisesRegex(ValueError, 'ONNX.*GPU|onnx.*gpu'):
            ApplioSettings(tts_provider='kokoro', kokoro_device='gpu', kokoro_backend='onnx').check()

    def test_interpreter_selection_respects_explicit_paths_and_installed_environments(self):
        from controller.kokoro_runtime import choose_python
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cpu = root / '.venv-kokoro/bin/python'
            native = root / '.venv-kokoro-rocm/bin/python'
            self.assertEqual(choose_python(root, 'auto', 'auto'), cpu)
            native.parent.mkdir(parents=True)
            native.touch()
            self.assertEqual(choose_python(root, 'auto', 'auto'), native)
            self.assertEqual(choose_python(root, 'cpu', 'auto'), cpu)
            self.assertEqual(choose_python(root, 'gpu', 'native'), native)
            self.assertEqual(choose_python(root, 'cpu', 'native'), native)
            self.assertEqual(choose_python(root, 'auto', 'auto', Path('/missing/python')),
                             Path('/missing/python'))

    def test_invalid_worker_request_is_a_structured_kokoro_startup_error(self):
        result = subprocess.run([sys.executable, '-m', 'controller.kokoro_worker', '--worker',
                                 '--device', 'gpu', '--backend', 'onnx'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        reply = json.loads(result.stdout.splitlines()[0])
        self.assertFalse(reply['ready'])
        self.assertIn('onnx', reply['error'].lower())
        self.assertIn('gpu', reply['error'].lower())


class RuntimePolicyTests(unittest.TestCase):
    def test_constructor_failure_releases_selected_native_session(self):
        from controller.kokoro_worker import Synthesizer
        session = Mock()
        session.get_inputs.return_value = []
        model = SimpleNamespace(voices={}, has_timings=False)
        kokoro = SimpleNamespace(Kokoro=SimpleNamespace(from_session=Mock(return_value=model)))
        with patch.dict('sys.modules', {'onnxruntime': Mock(), 'kokoro_onnx': kokoro, 'soundfile': Mock()}), \
             patch('controller.kokoro_runtime.select_session', return_value=(session, {})):
            with self.assertRaisesRegex(ValueError, 'Unknown Kokoro voice'):
                Synthesizer(device='gpu')
        session.close.assert_called_once()

    def select(self, device, backend, native=None):
        from controller.kokoro_runtime import select_session
        cpu = Mock(return_value=('cpu-session', {'device': 'cpu', 'backend': 'onnx'}))
        native = native or Mock(side_effect=lambda mode: ('native-' + mode,
                                {'device': mode, 'backend': 'native'}))
        result = select_session(device, backend, cpu, native)
        return result, cpu, native

    def test_cpu_default_does_not_probe_or_import_native(self):
        (session, info), cpu, native = self.select('cpu', 'auto')
        self.assertEqual(session, 'cpu-session')
        native.assert_not_called()
        self.assertEqual((info['requestedDevice'], info['requestedBackend']), ('cpu', 'auto'))

    def test_gpu_failure_is_not_silently_changed_to_cpu(self):
        from controller.kokoro_runtime import select_session
        cpu = Mock()
        native = Mock(side_effect=RuntimeError('HIP unavailable'))
        with self.assertRaisesRegex(RuntimeError, 'HIP unavailable'):
            select_session('gpu', 'auto', cpu, native)
        cpu.assert_not_called()

    def test_auto_fallback_is_visible_and_preserves_request(self):
        (session, info), _, _ = self.select('auto', 'auto', Mock(side_effect=ImportError('torch absent')))
        self.assertEqual(session, 'cpu-session')
        self.assertEqual(info['device'], 'cpu')
        self.assertEqual(info['requestedDevice'], 'auto')
        self.assertIn('torch absent', info['fallbackReason'])

    def test_explicit_native_keeps_its_backend_on_auto_cpu_fallback(self):
        native = Mock(side_effect=[RuntimeError('no GPU'), ('native-cpu', {'device': 'cpu', 'backend': 'native'})])
        (session, info), cpu, _ = self.select('auto', 'native', native)
        self.assertEqual(session, 'native-cpu')
        self.assertEqual(info['backend'], 'native')
        cpu.assert_not_called()
        self.assertEqual([c.args[0] for c in native.call_args_list], ['gpu', 'cpu'])

    def test_explicit_onnx_auto_reports_why_it_is_cpu(self):
        (_, info), _, native = self.select('auto', 'onnx')
        self.assertIn('CPU', info['fallbackReason'])
        native.assert_not_called()

    def test_warmup_failure_releases_gpu_before_auto_fallback(self):
        from controller.kokoro_runtime import prepare_synthesizer
        bad = Mock(runtime={'device': 'gpu', 'backend': 'native'})
        bad.synthesize.side_effect = RuntimeError('kernel warm-up failed')
        good = Mock(runtime={'device': 'cpu', 'backend': 'onnx'})
        good.synthesize.return_value = {'ttsSeconds': 0.1}
        calls = []
        def factory(**kwargs):
            calls.append((kwargs['device'], kwargs['backend']))
            if len(calls) == 1:
                return bad
            bad.close.assert_called_once()
            return good
        synth, ready = prepare_synthesizer(factory, device='auto', backend='auto')
        self.assertIs(synth, good)
        self.assertEqual(calls, [('auto', 'auto'), ('cpu', 'onnx')])
        self.assertIn('kernel warm-up failed', ready['device']['fallbackReason'])
        self.assertEqual(ready['device']['requestedDevice'], 'auto')

    def test_explicit_gpu_warmup_failure_stops_and_releases_model(self):
        from controller.kokoro_runtime import prepare_synthesizer
        bad = Mock(runtime={'device': 'gpu', 'backend': 'native'})
        bad.synthesize.side_effect = RuntimeError('GPU failed')
        factory = Mock(return_value=bad)
        with self.assertRaisesRegex(RuntimeError, 'GPU failed'):
            prepare_synthesizer(factory, device='gpu', backend='native')
        factory.assert_called_once()
        bad.close.assert_called_once()


class KokoroWorkerNameTests(unittest.IsolatedAsyncioTestCase):
    async def test_sentence_failure_names_kokoro(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = ('import json,sys; print(json.dumps({"ready":True}),flush=True)\n'
                      'for line in sys.stdin:\n'
                      ' request=json.loads(line)\n'
                      ' print(json.dumps({"id":request["id"],"ok":False,"error":"invalid sentence"}),flush=True)')
            worker = ApplioWorker(ApplioSettings(applio_dir=Path(tmp)), name='Kokoro',
                                 command=[sys.executable, '-c', script], log_path=Path(tmp)/'worker.log')
            try:
                with self.assertRaisesRegex(RuntimeError, 'Kokoro worker: invalid sentence'):
                    await worker.request('hello', Path(tmp)/'in.wav', Path(tmp)/'out.wav')
            finally:
                await worker.close()

    async def test_structured_child_failure_names_kokoro(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = ApplioWorker(ApplioSettings(applio_dir=Path(tmp)), name='Kokoro',
                                 command=[sys.executable, '-c',
                                          'print(\'{"ready":false,"error":"native assets missing"}\')'],
                                 log_path=Path(tmp)/'worker.log')
            with self.assertRaisesRegex(RuntimeError, 'Kokoro worker failed.*native assets missing'):
                await worker.start()


if __name__ == '__main__':
    unittest.main()
