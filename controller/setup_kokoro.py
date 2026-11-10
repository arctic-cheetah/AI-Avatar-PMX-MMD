"""Install the isolated CPU Kokoro runtime and verified model assets.

``--per-token`` (run inside .venv-kokoro by setup) writes a copy of the model
whose speed input takes one value per token (#83, docs/testing-kokoro.md §2h).
"""

import hashlib
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv

from controller import venv_python

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models' / 'kokoro'
RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1'
ASSETS = {
    'kokoro-v1.0.onnx': 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}
PER_TOKEN = 'kokoro-v1.0-pertoken.onnx'


def digest(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def _speed_input(model):
    return next((i for i in model.graph.input if i.name == 'speed'), None)


def per_token_ready(path: Path) -> bool:
    """True when the model at ``path`` declares its speed input with a dynamic size."""
    import onnx
    speed = _speed_input(onnx.load(str(path), load_external_data=False))
    dims = speed.type.tensor_type.shape.dim if speed is not None else []
    return len(dims) == 1 and bool(dims[0].dim_param)


def make_per_token_model(source: Path, target: Path) -> None:
    """Write ``source`` to ``target`` with speed declared [n] instead of [1].

    Speed must only feed one Div (the duration predictor's frames ÷ speed), which
    broadcasts a vector; any other use is refused rather than guessed at.
    """
    import onnx
    model = onnx.load(str(source))
    speed = _speed_input(model)
    users = [node.op_type for node in model.graph.node if 'speed' in node.input]
    if speed is None or len(speed.type.tensor_type.shape.dim) != 1 or users != ['Div']:
        raise RuntimeError(f'Unexpected Kokoro graph: speed is used by {users}; not patching.')
    dim = speed.type.tensor_type.shape.dim[0]
    dim.ClearField('dim_value')
    dim.dim_param = 'speed_len'
    partial = target.with_suffix(target.suffix + '.partial')
    try:
        onnx.save(model, str(partial))
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


def per_token() -> None:
    target = MODEL_DIR / PER_TOKEN
    if target.is_file() and per_token_ready(target):
        print(f'Verified existing {PER_TOKEN}', flush=True)
        return
    print(f'Writing {PER_TOKEN}…', flush=True)
    make_per_token_model(MODEL_DIR / 'kokoro-v1.0.onnx', target)


def main() -> None:
    if sys.argv[1:] == ['--per-token']:
        per_token()
        return
    if not (3, 11) <= sys.version_info[:2] < (3, 14):
        raise SystemExit('Setup requires Python 3.11–3.13; Python 3.12 is recommended.')
    environment = ROOT / '.venv-kokoro'
    venv.EnvBuilder(with_pip=True).create(environment)
    python = venv_python(environment)
    subprocess.run([str(python), '-m', 'pip', 'install', '-r',
                    str(ROOT / 'requirements-kokoro.txt')], check=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for name, expected in ASSETS.items():
        target = MODEL_DIR / name
        if target.is_file() and digest(target) == expected:
            print(f'Verified existing {name}', flush=True)
            continue
        partial = target.with_suffix(target.suffix + '.partial')
        print(f'Downloading {name}…', flush=True)
        try:
            with urllib.request.urlopen(f'{RELEASE}/{name}', timeout=60) as response:
                with partial.open('wb') as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            if digest(partial) != expected:
                raise RuntimeError(f'SHA256 mismatch for {name}')
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    subprocess.run([str(python), '-m', 'controller.setup_kokoro', '--per-token'], cwd=ROOT, check=True)
    print('Kokoro is ready. See docs/testing-kokoro.md.', flush=True)


if __name__ == '__main__':
    main()
