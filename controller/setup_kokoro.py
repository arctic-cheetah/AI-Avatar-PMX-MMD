"""Install the isolated CPU Kokoro runtime and verified model assets."""

import hashlib
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'models' / 'kokoro'
RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1'
ASSETS = {
    'kokoro-v1.0.onnx': 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}


def digest(path: Path) -> str:
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main() -> None:
    if not (3, 11) <= sys.version_info[:2] < (3, 14):
        raise SystemExit('Setup requires Python 3.11–3.13; Python 3.12 is recommended.')
    environment = ROOT / '.venv-kokoro'
    venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / 'bin' / 'python'
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
    print('Kokoro is ready. See docs/testing-kokoro.md.', flush=True)


if __name__ == '__main__':
    main()
