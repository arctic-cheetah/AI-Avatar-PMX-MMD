"""RVC device choice (#111): --rvc-device auto|gpu|cpu and backend reporting."""

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from controller.applio_worker import describe_device, hide_gpus, require_device
from controller.speech import ApplioSettings, ApplioWorker, ready_summary


def fake_torch(available, hip=None, cuda=None, name="", arch=None, capability=(0, 0)):
    """The few torch attributes describe_device reads."""
    props = types.SimpleNamespace(name=name, gcnArchName=arch) if arch else types.SimpleNamespace(name=name)
    return types.SimpleNamespace(
        __version__="2.11.0",
        version=types.SimpleNamespace(hip=hip, cuda=cuda),
        cuda=types.SimpleNamespace(
            is_available=lambda: available,
            get_device_properties=lambda index: props,
            get_device_capability=lambda index: capability,
        ),
    )


class RvcDeviceSettingsTests(unittest.TestCase):
    def test_default_is_auto_and_reaches_the_worker(self):
        settings = ApplioSettings()
        self.assertEqual(settings.rvc_device, "auto")
        self.assertEqual(ApplioSettings(rvc_device="gpu").worker_config()["rvc_device"], "gpu")

    def test_unknown_device_is_rejected_before_files(self):
        with self.assertRaisesRegex(ValueError, "auto, gpu or cpu"):
            ApplioSettings(applio_dir=Path("/nonexistent"), rvc_device="npu").check()

    def test_bridge_flag_reaches_settings(self):
        from controller.bridge import build_parser, speech_settings

        args = build_parser().parse_args(["--speech", "--rvc-device", "cpu"])
        self.assertEqual(speech_settings(args).rvc_device, "cpu")
        self.assertEqual(speech_settings(build_parser().parse_args(["--speech"])).rvc_device, "auto")
        with self.assertRaises(SystemExit):
            build_parser().parse_args(["--speech", "--rvc-device", "npu"])


class WorkerDeviceTests(unittest.TestCase):
    def test_cpu_hides_gpus_from_rocm_and_cuda_torch(self):
        environ = {"PATH": "/bin"}
        hide_gpus(environ, "cpu")
        self.assertEqual(environ["HIP_VISIBLE_DEVICES"], "")
        self.assertEqual(environ["CUDA_VISIBLE_DEVICES"], "")
        for requested in ("auto", "gpu"):
            untouched = {"PATH": "/bin"}
            hide_gpus(untouched, requested)
            self.assertEqual(untouched, {"PATH": "/bin"})

    def test_rocm_gpu_is_described_with_its_arch(self):
        torch = fake_torch(True, hip="7.2.26015", name="Radeon 8060S Graphics", arch="gfx1151")
        self.assertEqual(describe_device(torch), {
            "device": "gpu", "backend": "rocm 7.2.26015",
            "gpu": "Radeon 8060S Graphics", "arch": "gfx1151", "torch": "2.11.0"})

    def test_cuda_gpu_is_described_with_its_compute_capability(self):
        torch = fake_torch(True, cuda="12.8", name="NVIDIA GeForce RTX 4070", capability=(8, 9))
        info = describe_device(torch)
        self.assertEqual((info["device"], info["backend"], info["arch"]), ("gpu", "cuda 12.8", "sm_89"))

    def test_cpu_fallback_names_the_torch_build(self):
        info = describe_device(fake_torch(False, cuda="12.8"))
        self.assertEqual(info, {"device": "cpu", "backend": "cpu", "torch": "2.11.0", "build": "cuda 12.8"})

    def test_gpu_request_without_a_gpu_fails_with_a_hint(self):
        info = describe_device(fake_torch(False, cuda="12.8"))
        with self.assertRaisesRegex(RuntimeError, "no GPU.*cuda 12.8.*Applio-rocm"):
            require_device("gpu", info)
        require_device("auto", info)
        require_device("cpu", info)
        require_device("gpu", describe_device(fake_torch(True, hip="7.2", name="g", arch="gfx1150")))


class ReadySummaryTests(unittest.TestCase):
    def test_gpu_summary_names_backend_gpu_and_arch(self):
        ready = {"ready": True, "loadSeconds": 2.17, "warmSeconds": 4.89,
                 "device": {"device": "gpu", "backend": "rocm 7.2", "gpu": "Radeon 890M", "arch": "gfx1150"}}
        self.assertEqual(ready_summary(ready),
                         "on GPU (rocm 7.2, Radeon 890M, gfx1150): load 2.17s, warm-up 4.89s")

    def test_cpu_summary_and_older_worker(self):
        ready = {"loadSeconds": 1.0, "warmSeconds": 3.0, "device": {"device": "cpu", "backend": "cpu"}}
        self.assertEqual(ready_summary(ready), "on CPU: load 1.0s, warm-up 3.0s")
        self.assertEqual(ready_summary({"loadSeconds": 1.0, "warmSeconds": 3.0}), "load 1.0s, warm-up 3.0s")


class StartFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_start_error_is_shown_to_the_user(self):
        reply = json.dumps({"ready": False, "error": "RuntimeError: --rvc-device gpu: no GPU visible"})
        with tempfile.TemporaryDirectory() as scratch:
            worker = ApplioWorker(
                ApplioSettings(applio_dir=Path(scratch)),
                command=[sys.executable, "-c", f"print({reply!r})"],
                log_path=Path(scratch) / "log",
            )
            with self.assertRaisesRegex(RuntimeError, "failed to start: RuntimeError: --rvc-device gpu: no GPU"):
                await worker.start()


class RvcCheckTests(unittest.TestCase):
    def test_summary_reports_spool_up_and_real_time_factor(self):
        from controller.rvc_check import summarise

        ready = {"loadSeconds": 2.0, "warmSeconds": 5.0, "device": {"device": "gpu", "arch": "gfx1150"}}
        summary = summarise(ready, spool_seconds=7.4, clip_seconds=2.5, rvc_seconds=[0.6, 0.4, 0.5])
        self.assertEqual(summary["device"], {"device": "gpu", "arch": "gfx1150"})
        self.assertEqual((summary["spoolSeconds"], summary["loadSeconds"], summary["warmSeconds"]), (7.4, 2.0, 5.0))
        self.assertEqual((summary["rvcMedian"], summary["rvcMin"], summary["rvcMax"]), (0.5, 0.4, 0.6))
        self.assertEqual(summary["rtf"], 0.2)

    def test_applio_command_skips_the_kokoro_worker(self):
        from controller.rvc_check import check_worker

        worker = check_worker(ApplioSettings(applio_dir=Path("/opt/Applio-rocm"), rvc_device="gpu"))
        self.assertIsNone(worker.kokoro)
        self.assertEqual(worker.command[0], "/opt/Applio-rocm/.venv/bin/python")
        config = json.loads(worker.command[-1])
        self.assertEqual((config["rvc_device"], config["tts_provider"]), ("gpu", "kokoro"))


if __name__ == "__main__":
    unittest.main()
