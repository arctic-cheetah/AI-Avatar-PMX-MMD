"""Optional, local-only native Kokoro runtime. Imported only when selected."""

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models/kokoro-native'
REVISION = 'f3ff3571791e39611d31c381e3a41a3af07b4987'
ASSETS = {
    'config.json': '5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f',
    'kokoro-v1_0.pth': '496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4',
}


def validate_assets(directory=MODEL_DIR):
    directory = Path(directory)
    for name, expected in ASSETS.items():
        path = directory / name
        if not path.is_file():
            raise RuntimeError(f'Native Kokoro asset missing: {path}; run python3 -m controller.setup_kokoro_rocm')
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise RuntimeError(f'Native Kokoro SHA256 mismatch: {path}; run python3 -m controller.setup_kokoro_rocm')
    return directory / 'config.json', directory / 'kokoro-v1_0.pth'


def load_session(device, threads, model_dir=MODEL_DIR):
    config, weights = validate_assets(model_dir)
    try:
        import torch
        from kokoro.model import KModel
    except ImportError as error:
        raise RuntimeError('Native Kokoro dependencies unavailable; run python3 -m controller.setup_kokoro_rocm') from error
    if device == 'gpu' and (not torch.version.hip or not torch.cuda.is_available()):
        raise RuntimeError('Kokoro GPU requires usable ROCm PyTorch; check the native environment and /dev/kfd permissions')
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass  # May already be configured when used by an in-process audition.
    # Required by the measured configuration; affects this worker process only.
    torch.backends.cudnn.enabled = False
    model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(config), model=str(weights), disable_complex=True)
    return NativeSession(model, str(weights), torch, 'cuda' if device == 'gpu' else 'cpu')


class NativeSession:
    """Small session interface for kokoro_onnx's tokenizer/timing wrapper.

    Metadata is supplied directly; native synthesis never loads an ONNX graph.
    Both scalar and per-token speed are native duration-predictor inputs.
    """

    def __init__(self, model, model_path, torch, device):
        self.torch, self.device = torch, device
        self.model = model.to(device).eval()
        self._model_path = str(model_path)
        self.vocab = dict(model.vocab)
        self.context_length = model.context_length
        self.runtime = {'device': 'gpu' if device == 'cuda' else 'cpu',
                        'backend': 'pytorch-rocm' if torch.version.hip else 'pytorch',
                        'provider': 'PyTorchROCm' if device == 'cuda' else 'PyTorchCPU',
                        'torch': torch.__version__, 'hip': torch.version.hip,
                        'modelRevision': REVISION, 'modelSha256': ASSETS['kokoro-v1_0.pth'],
                        'customStft': True, 'miopenEnabled': False}
        if device == 'cuda':
            props = torch.cuda.get_device_properties(0)
            self.runtime.update(gpu=torch.cuda.get_device_name(0), arch=props.gcnArchName)

    def get_inputs(self):
        return [SimpleNamespace(name='input_ids', type='tensor(int64)', shape=[1, 'tokens']),
                SimpleNamespace(name='style', type='tensor(float)', shape=[1, 256]),
                SimpleNamespace(name='speed', type='tensor(float)', shape=['speed_len'])]

    def get_outputs(self):
        return [SimpleNamespace(name='waveform', type='tensor(float)', shape=['samples']),
                SimpleNamespace(name='duration', type='tensor(int64)', shape=['tokens'])]

    def get_modelmeta(self):
        return SimpleNamespace(custom_metadata_map={'kokoro_config': json.dumps({'vocab': self.vocab})})

    def get_providers(self):
        return [self.runtime['provider']]

    def run(self, output_names, inputs):
        import numpy as np
        torch = self.torch
        wanted = ['waveform', 'duration'] if output_names is None else output_names
        if any(name not in ('waveform', 'duration') for name in wanted):
            raise ValueError('Unknown native Kokoro output')
        tokens, style, speed = (np.asarray(inputs[k]) for k in ('input_ids', 'style', 'speed'))
        if (tokens.dtype != np.int64 or tokens.ndim != 2 or tokens.shape[0] != 1
                or not 3 <= tokens.shape[1] <= self.context_length
                or tokens[0, 0] != 0 or tokens[0, -1] != 0):
            raise ValueError('Native Kokoro needs padded int64 tokens [1,n] within model context')
        if (style.shape != (1, 256) or not np.isfinite(style).all()):
            raise ValueError('Native Kokoro style must be finite [1,256]')
        if (speed.ndim != 1 or len(speed) not in (1, tokens.shape[1])
                or not np.isfinite(speed).all() or (speed <= 0).any()):
            raise ValueError('Native Kokoro speed must be positive and scalar or per-token')
        with torch.inference_mode():
            audio, duration = self.model.forward_with_tokens(
                torch.as_tensor(tokens, dtype=torch.long, device=self.device),
                torch.as_tensor(style, dtype=torch.float32, device=self.device),
                torch.as_tensor(speed, dtype=torch.float32, device=self.device))
            if audio.device.type != self.device or duration.device.type != self.device:
                raise RuntimeError('Native Kokoro unexpectedly changed execution device')
            if duration.dtype != torch.int64:
                raise RuntimeError('Native Kokoro returned non-integer durations')
            audio = audio.detach().cpu().numpy().astype(np.float32).ravel()
            duration = duration.detach().cpu().numpy().ravel()
        if not len(audio) or not np.isfinite(audio).all():
            raise RuntimeError('Native Kokoro returned empty or nonfinite audio')
        if len(duration) != tokens.shape[1] or (duration < 1).any():
            raise RuntimeError('Native Kokoro durations do not match tokens')
        values = {'waveform': audio, 'duration': duration}
        return [values[name] for name in wanted]

    def close(self):
        self.model = None
        if self.device == 'cuda':
            self.torch.cuda.empty_cache()
