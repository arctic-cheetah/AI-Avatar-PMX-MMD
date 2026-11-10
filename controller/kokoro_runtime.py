"""Kokoro device policy, independent of RVC and optional runtime imports."""

from pathlib import Path
import tempfile
import time


def validate_selection(device, backend):
    if device not in ('cpu', 'gpu', 'auto'):
        raise ValueError('Kokoro device must be cpu, gpu or auto')
    if backend not in ('auto', 'onnx', 'native'):
        raise ValueError('Kokoro backend must be auto, onnx or native')
    if device == 'gpu' and backend == 'onnx':
        raise ValueError('ONNX GPU execution is not supported here; choose --kokoro-backend native')


def choose_python(root, device, backend, override=None):
    validate_selection(device, backend)
    if override is not None:
        return Path(override).expanduser()
    root = Path(root)
    cpu, native = (root / name / 'bin/python' for name in ('.venv-kokoro', '.venv-kokoro-rocm'))
    if backend == 'native' or device == 'gpu':
        return native
    if device == 'auto' and backend == 'auto' and native.is_file():
        return native
    return cpu


def select_session(device, backend, onnx_factory, native_factory):
    """Resolve the requested policy; only auto may fail over after an error."""
    validate_selection(device, backend)
    reason = None
    selected = backend
    if backend == 'onnx' or (backend == 'auto' and device == 'cpu'):
        session, info = onnx_factory()
        selected = 'onnx'
        if device == 'auto':
            reason = 'The ONNX backend supports CPU only; using CPU'
    elif device != 'auto':
        session, info = native_factory(device)
        selected = 'native'
    else:
        try:
            session, info = native_factory('gpu')
            selected = 'native'
        except Exception as error:
            reason = f'Native GPU unavailable: {type(error).__name__}: {error}'[:600]
            selected = 'native' if backend == 'native' else 'onnx'
            session, info = native_factory('cpu') if selected == 'native' else onnx_factory()
    info = {**info, 'requestedDevice': device, 'requestedBackend': backend,
            'selectedBackend': selected}
    if reason:
        info['fallbackReason'] = reason
    return session, info


def prepare_synthesizer(factory, *, device='cpu', backend='auto', **settings):
    """Initialise and warm once, with a visible auto retry after GPU warm failure."""
    validate_selection(device, backend)
    started = time.perf_counter()
    synth = factory(device=device, backend=backend, **settings)
    load = time.perf_counter() - started
    warm_total = 0.0
    with tempfile.TemporaryDirectory(prefix='kokoro-warm-') as scratch:
        path = str(Path(scratch) / 'warm.wav')
        warm_started = time.perf_counter()
        try:
            synth.synthesize('Hello, I am ready.', path)
        except Exception as error:
            warm_total += time.perf_counter() - warm_started
            info = dict(synth.runtime)
            try:
                synth.close()
            except Exception:
                pass  # Preserve the inference error; release is best effort after GPU failure.
            if device != 'auto' or info.get('device') != 'gpu':
                raise
            reason = f'Native GPU warm-up failed: {type(error).__name__}: {error}'[:600]
            load_started = time.perf_counter()
            retry_backend = 'native' if backend == 'native' else 'onnx'
            synth = factory(device='cpu', backend=retry_backend, **settings)
            load += time.perf_counter() - load_started
            synth.runtime.update(requestedDevice=device, requestedBackend=backend, fallbackReason=reason)
            warm_started = time.perf_counter()
            try:
                synth.synthesize('Hello, I am ready.', path)
            except Exception:
                synth.close()
                raise
        warm_total += time.perf_counter() - warm_started
    return synth, {'ready': True, 'loadSeconds': round(load, 3), 'warmSeconds': round(warm_total, 3),
                   'startupSeconds': round(time.perf_counter() - started, 3), 'device': synth.runtime}


def ready_summary(ready):
    info = ready.get('device', {})
    device = 'GPU' if info.get('device') == 'gpu' else 'CPU'
    details = [str(info[k]) for k in ('backend', 'provider', 'torch', 'gpu', 'arch') if info.get(k)]
    result = (f'on {device} ({", ".join(details)}): load {ready["loadSeconds"]}s, '
              f'warm-up {ready["warmSeconds"]}s')
    if info.get('fallbackReason'):
        result += f'; fallback: {info["fallbackReason"]}'
    return result
