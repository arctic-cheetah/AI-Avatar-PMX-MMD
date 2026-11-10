"""Isolated #62 compatibility probe; never selected by the normal bridge.

Run with a scratch environment, from the repository root, e.g.:
  PYTHONPATH=. <scratch>/bin/python tools/kokoro_gpu_spike.py --backend native
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIVE_REVISION = 'f3ff3571791e39611d31c381e3a41a3af07b4987'


def attach_migraphx(options, ort):
    """Attach plugin devices explicitly: ORT 1.29 drops this plugin by name."""
    devices = [device for device in ort.get_ep_devices()
               if device.ep_name == 'MIGraphXExecutionProvider']
    if not devices:
        raise RuntimeError('MIGraphX has no registered GPU device')
    options.add_provider_for_devices(devices, {})


class TorchSessionAdapter:
    """Reuse our ONNX wrapper's chunking/timing with native token inference.

    Metadata comes from the matching reference graph. The native model must
    still be checked against that graph; metadata reuse does not prove parity.
    """

    def __init__(self, model, reference, device='cuda'):
        import torch
        if device not in ('cpu', 'cuda'):
            raise ValueError('device must be cpu or cuda')
        if device == 'cuda' and (not torch.version.hip or not torch.cuda.is_available()):
            raise RuntimeError('native probe requires usable ROCm PyTorch for GPU inference')
        self.torch, self.device = torch, device
        self.model = model.to(device).eval()
        self.reference, self._model_path = reference, reference._model_path
        self.output_devices = []
        self.verify_reference = False
        self.reference_checks = []

    def get_inputs(self):
        return self.reference.get_inputs()

    def get_outputs(self):
        return self.reference.get_outputs()

    def get_modelmeta(self):
        return self.reference.get_modelmeta()

    def get_providers(self):
        return ['PyTorchROCm' if self.device == 'cuda' else 'PyTorchCPU']

    def synchronize(self):
        if self.device == 'cuda':
            self.torch.cuda.synchronize()

    def run(self, output_names, inputs):
        import numpy as np
        torch = self.torch
        names = [output.name for output in self.get_outputs()]
        wanted = names if output_names is None else output_names
        if any(name not in names for name in wanted):
            raise ValueError('unknown output requested')
        tokens, style, speed = (np.asarray(inputs[k]) for k in ('input_ids', 'style', 'speed'))
        if (tokens.ndim != 2 or tokens.shape[0] != 1 or tokens.shape[1] < 3
                or tokens[0, 0] != 0 or tokens[0, -1] != 0
                or tokens.dtype != np.int64):
            raise ValueError('token batch must be padded int64 [1, n]')
        if (speed.ndim != 1 or len(speed) not in (1, tokens.shape[1])
                or not np.isfinite(speed).all() or (speed <= 0).any()):
            raise ValueError('speed must contain one positive finite value or one per token')
        if style.shape != (1, 256):
            raise ValueError('style must have shape [1, 256]')
        with torch.inference_mode():
            audio, duration = self.model.forward_with_tokens(
                torch.as_tensor(tokens, dtype=torch.long, device=self.device),
                torch.as_tensor(style, dtype=torch.float32, device=self.device),
                torch.as_tensor(speed, dtype=torch.float32, device=self.device))
            actual = [audio.device.type, duration.device.type]
            if actual != [self.device, self.device]:
                raise RuntimeError(f'native outputs unexpectedly changed device: {actual}')
            self.output_devices.append(actual)
            audio = audio.detach().cpu().numpy().astype(np.float32).ravel()
            duration = duration.detach().cpu().numpy().astype(np.int64).ravel()
        if not len(audio) or not np.isfinite(audio).all():
            raise ValueError('audio must be nonempty and finite')
        if len(duration) != tokens.shape[1] or (duration < 1).any():
            raise ValueError('duration count/values do not match tokens')
        if self.verify_reference:
            expected_audio, expected_duration = self.reference.run(None, inputs)[:2]
            delta = duration - np.asarray(expected_duration).ravel()
            self.reference_checks.append({
                'tokens': tokens.tolist(), 'speed': speed.tolist(),
                'changedIndices': np.flatnonzero(delta).tolist(),
                'nativeDurations': duration.tolist(),
                'referenceDurations': np.asarray(expected_duration).ravel().tolist(),
                'sampleDelta': len(audio) - np.asarray(expected_audio).size})
        result = dict(zip(names, (audio, duration)))
        return [result[name] for name in wanted]


def main():
    import argparse
    from collections import Counter
    import hashlib
    import importlib.metadata
    import json
    import resource
    import statistics
    import time
    import traceback
    from unittest.mock import patch
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    from kokoro_onnx import Kokoro
    from controller import kokoro_worker as worker

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=('onnx', 'native', 'migraphx'), required=True)
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cuda')
    parser.add_argument('--native-aten', action='store_true',
                        help='diagnostic: bypass MIOpen using native PyTorch GPU operators')
    parser.add_argument('--native-custom-stft', action='store_true',
                        help='diagnostic: use the native model ONNX-export STFT implementation')
    parser.add_argument('--features-only', action='store_true',
                        help='reuse an existing medium NPZ; write a separate feature report')
    parser.add_argument('--verify-features', action='store_true',
                        help='instrument native feature runs with extra CPU oracle checks')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--scratch', type=Path, default=Path('/tmp/kokoro-gpu-62'))
    parser.add_argument('--output', type=Path, default=ROOT / 'assets/private/speech/62')
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error('repeats must be positive')
    args.output.mkdir(parents=True, exist_ok=True)
    tag = args.backend + ('-' + args.device if args.backend == 'native' else '')
    if args.native_aten:
        if args.backend != 'native':
            parser.error('native-aten requires native backend')
        tag += '-aten'
    if args.native_custom_stft:
        if args.backend != 'native':
            parser.error('native-custom-stft requires native backend')
        tag += '-custom-stft'
    report_path = args.output / f'{tag}{"-features" if args.features_only else ""}.json'
    report = {'backend': tag, 'conditions': 'ambient desktop; no controlled contention claim',
              'cpuPercentConvention': '100% = one logical CPU', 'status': 'running'}
    started = time.perf_counter()
    try:
        model_path = args.scratch / 'kokoro-pertoken.onnx'
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        ort.disable_telemetry_events()
        reference = ort.InferenceSession(str(model_path), options, providers=['CPUExecutionProvider'])
        metadata = lambda values: [{'name': x.name, 'shape': x.shape, 'type': x.type} for x in values]
        report.update(ort=ort.__version__, inputs=metadata(reference.get_inputs()),
                      outputs=metadata(reference.get_outputs()),
                      modelSha256=hashlib.sha256(model_path.read_bytes()).hexdigest())
        baseline = Kokoro.from_session(reference, str(worker.MODEL_DIR / 'voices-v1.0.bin'))
        style = worker.blend_style(worker.parse_voice('af_heart:0.7,af_bella:0.3'), baseline.get_voice_style)
        session = reference
        if args.backend == 'native':
            import torch
            from kokoro.model import KModel
            from huggingface_hub import hf_hub_download
            torch.set_num_threads(2)
            torch.set_num_interop_threads(1)
            if args.native_aten:
                torch.backends.cudnn.enabled = False
            assets = {name: hf_hub_download('hexgrad/Kokoro-82M', name, revision=NATIVE_REVISION)
                      for name in ('config.json', 'kokoro-v1_0.pth')}
            native = KModel(repo_id='hexgrad/Kokoro-82M', config=assets['config.json'],
                            model=assets['kokoro-v1_0.pth'], disable_complex=args.native_custom_stft)
            session = TorchSessionAdapter(native, reference, args.device)
            report.update(torch=torch.__version__, hip=torch.version.hip,
                          miopenEnabled=torch.backends.cudnn.enabled,
                          customStft=args.native_custom_stft,
                          nativePackage=importlib.metadata.version('kokoro'),
                          nativeRevision=NATIVE_REVISION,
                          gpu=torch.cuda.get_device_name(0) if args.device == 'cuda' else None,
                          arch=torch.cuda.get_device_properties(0).gcnArchName if args.device == 'cuda' else None)
        elif args.backend == 'migraphx':
            import migraphx
            import onnxruntime_ep_migraphx as plugin
            for name, path in zip(plugin.get_ep_names(), plugin.get_library_paths()):
                ort.register_execution_provider_library(name, path)
            report['availableProviders'] = ort.get_available_providers()
            options.enable_profiling = True
            options.profile_file_prefix = str(args.output / 'migraphx-profile')
            attach_migraphx(options, ort)
            session = ort.InferenceSession(str(model_path), options,
                                           providers=[])
            if 'MIGraphXExecutionProvider' not in session.get_providers():
                raise RuntimeError('MIGraphX registered but session is CPU-only')
        report['effectiveProviders'] = session.get_providers()
        report['loadSeconds'] = round(time.perf_counter() - started, 4)
        cases = [
            ('short', 'Good morning, sweetheart.'),
            ('medium', 'But I really did try, sweetheart! Are you ready?'),
            ('long', 'We can keep working together while the containers handle the other tasks. '
             'I will watch the timing carefully, preserve the pauses, and keep my voice clear. '
             'When the sentence grows longer, we can compare how much work each processor does.'),
        ]
        rows = []
        report['rows'] = rows
        for repeat in range(0 if args.features_only else args.repeats):
            for name, text in cases:
                phonemes = baseline.tokenizer.phonemize(text, 'en-us')
                tokens = baseline.tokenizer.tokenize(phonemes)
                inputs = {'input_ids': np.array([[0, *tokens, 0]], np.int64),
                          'style': np.asarray(baseline._style_for(style, len(tokens)), np.float32),
                          'speed': np.array([1], np.float32)}
                if hasattr(session, 'synchronize'):
                    session.synchronize()
                wall, cpu = time.perf_counter(), time.process_time()
                audio, duration = session.run(None, inputs)[:2]
                if hasattr(session, 'synchronize'):
                    session.synchronize()
                wall, cpu = time.perf_counter() - wall, time.process_time() - cpu
                audio, duration = np.asarray(audio).ravel(), np.asarray(duration).ravel()
                expected_audio, expected_duration = reference.run(None, inputs)[:2]
                seconds = len(audio) / 24000
                row = dict(case=name, repeat=repeat, tokens=len(tokens), phonemes=phonemes,
                           wallSeconds=round(wall, 4), cpuSeconds=round(cpu, 4),
                           cpuPercent=round(cpu / wall * 100, 1),
                           cpuSecondsPerAudioSecond=round(cpu / seconds, 4),
                           audioSeconds=round(seconds, 4), rtf=round(wall / seconds, 4),
                           maxDurationDelta=int(np.max(np.abs(duration - expected_duration))),
                           changedDurations=int(np.count_nonzero(duration != expected_duration)),
                           sampleDelta=len(audio) - np.asarray(expected_audio).size)
                rows.append(row)
                if repeat == 0:
                    sf.write(str(args.output / f'{tag}-{name}.wav'), audio, 24000)
                    np.savez(args.output / f'{tag}-{name}.npz', **inputs, duration=duration)
                print(json.dumps(row), flush=True)
        # A controlled per-token change, compared against the patched ONNX oracle.
        saved = np.load(args.output / f'{tag}-medium.npz')
        inputs = {key: saved[key] for key in ('input_ids', 'style', 'speed')}
        speeds = np.ones(inputs['input_ids'].shape[1], np.float32)
        speeds[len(speeds) // 2] = 0.5
        inputs['speed'] = speeds
        audio, duration = session.run(None, inputs)[:2]
        _, expected = reference.run(None, inputs)[:2]
        report['perToken'] = {'maxDurationDelta': int(np.max(np.abs(duration - expected))),
                              'changedDurations': int(np.count_nonzero(duration != expected)),
                              'tokenIndex': len(speeds) // 2}
        sf.write(str(args.output / f'{tag}-pertoken.wav'), np.asarray(audio).ravel(), 24000)
        # Reuse the real expressive worker in this process only.
        with patch.object(worker, 'PER_TOKEN_MODEL', model_path), patch.object(
                ort, 'InferenceSession', return_value=session):
            synth = worker.Synthesizer()
        report['features'] = {}
        if args.verify_features and isinstance(session, TorchSessionAdapter):
            session.verify_reference = True
            report['featureMetricsIncludeOracleChecks'] = True
        text = 'But I really did try, sweetheart! Are you ready?'
        for name, extra in [('timings', {'spans': [0, 2, 5]}),
                            ('emphasis', {'spans': [0, 2, 5], 'emphasis': [2]}),
                            ('drawl', {'spans': [0, 2, 5], 'stretch': [[0, 0.125]]}),
                            ('hold', {'spans': [0, 2, 5], 'holds': [[0, 0.3]]})]:
            result = synth.synthesize(text, str(args.output / f'{tag}-{name}.wav'), **extra)
            if (result.get('spanWords') != [0, 2, 5] or any(
                    not 0 <= start < end <= result['sourceSeconds'] + 0.002
                    for start, end in result.get('wordSpans', []))):
                raise RuntimeError(f'{name}: invalid or missing word spans')
            report['features'][name] = result
        if args.backend == 'native':
            report['featureReferenceChecks'] = session.reference_checks
            session.verify_reference = False
            if args.verify_features:
                # Isolate pause insertion from duration prediction: native
                # waveforms can have different quiet-frame boundaries.
                spoken = worker.respell_phonemes(text, baseline.tokenizer.phonemize(text, 'en-us'))
                report['pauseComparison'] = {}
                for engine_name, engine in [('onnx', baseline), ('native', synth.model)]:
                    for pause in (0.0, 0.25):
                        audio, rate, _ = engine.create_timed(spoken, voice=style, is_phonemes=True,
                                                            trim=False, sentence_pause=pause, clause_pause=pause)
                        report['pauseComparison'][f'{engine_name}-{pause}'] = len(audio) / rate
            report['nativeOutputDevices'] = sorted({tuple(x) for x in session.output_devices})
            if args.device == 'cuda':
                try:
                    with torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU,
                                                            torch.profiler.ProfilerActivity.CUDA]) as prof:
                        session.run(None, {**inputs, 'speed': np.array([1], np.float32)})
                        session.synchronize()
                    events = [e for e in prof.events() if e.device_type == torch.autograd.DeviceType.CUDA]
                    report['gpuKernelEvents'] = len(events)
                    report['gpuKernelExamples'] = list(dict.fromkeys(e.name for e in events))[:8]
                    trace_path = args.output / f'{tag}-trace.json'
                    prof.export_chrome_trace(str(trace_path))
                    trace = json.loads(trace_path.read_text())
                    launches = [e for e in trace.get('traceEvents', [])
                                if e.get('cat') == 'cuda_runtime' and 'launch' in e.get('name', '').lower()]
                    report['gpuLaunchEvents'] = len(launches)
                    report['gpuLaunchExamples'] = list(dict.fromkeys(e['name'] for e in launches))[:8]
                except Exception as error:
                    report['profilerError'] = str(error)
        if args.backend == 'migraphx':
            profile_path = session.end_profiling()
            profile = json.loads(Path(profile_path).read_text())
            report['profileProviders'] = dict(Counter(x.get('args', {}).get('provider') for x in profile
                                                      if x.get('args', {}).get('provider')))
            if not report['profileProviders'].get('MIGraphXExecutionProvider'):
                raise RuntimeError('profile contains no MIGraphX execution')
        report['rows'] = rows
        report['summary'] = {name: {'wallMedian': statistics.median(r['wallSeconds'] for r in rows if r['case'] == name),
                                   'cpuMedian': statistics.median(r['cpuSeconds'] for r in rows if r['case'] == name)}
                             for name, _ in cases} if rows else {}
        report['status'] = 'probe-complete-listening-pending'
    except Exception as error:
        report.update(status='failed', error=f'{type(error).__name__}: {error}', traceback=traceback.format_exc())
        raise
    finally:
        report['maxRssKiB'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        print('Report:', report_path, flush=True)


if __name__ == '__main__':
    main()
