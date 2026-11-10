"""Install a separate, pinned native Kokoro ROCm environment and verified assets."""

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import venv

from controller.kokoro_native import ASSETS, MODEL_DIR, REVISION
from controller.setup_kokoro import ASSETS as CPU_ASSETS, MODEL_DIR as CPU_MODEL_DIR, RELEASE, ROOT, digest

INDEX = 'https://download.pytorch.org/whl/rocm7.2'
ENVIRONMENT = ROOT / '.venv-kokoro-rocm'


def fetch_asset(url, target, expected, cache=None):
    """Verify before atomic replacement; never destroy an old file on download failure."""
    target = Path(target)
    if target.is_file() and digest(target) == expected:
        print(f'Verified existing {target.name}', flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.partial')
    try:
        cached = Path(cache) / target.name if cache is not None else None
        if cached is not None and cached.is_file():
            if digest(cached) != expected:
                raise RuntimeError(f'SHA256 mismatch for cached {cached.name}')
            shutil.copyfile(cached, partial)
        else:
            print(f'Downloading {target.name}…', flush=True)
            with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
        if digest(partial) != expected:
            raise RuntimeError(f'SHA256 mismatch for {target.name}')
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-only', action='store_true', help='Verify/download assets without installing packages')
    parser.add_argument('--asset-cache', type=Path, help='Optional directory of already downloaded native assets')
    args = parser.parse_args()
    if sys.platform != 'linux' or sys.version_info[:2] != (3, 12):
        raise SystemExit('The tested ROCm setup requires Linux and Python 3.12.')
    python = ENVIRONMENT / 'bin/python'
    if not args.assets_only:
        venv.EnvBuilder(with_pip=True).create(ENVIRONMENT)
        subprocess.run([str(python), '-m', 'pip', 'install', '--index-url', INDEX,
                        'torch==2.11.0+rocm7.2'], check=True)
        subprocess.run([str(python), '-m', 'pip', 'install', '--extra-index-url', INDEX,
                        '-r', str(ROOT / 'requirements-kokoro-rocm.txt')], check=True)
    for name, expected in ASSETS.items():
        fetch_asset(f'https://huggingface.co/hexgrad/Kokoro-82M/resolve/{REVISION}/{name}',
                    MODEL_DIR / name, expected, args.asset_cache)
    for name, expected in CPU_ASSETS.items():
        fetch_asset(f'{RELEASE}/{name}', CPU_MODEL_DIR / name, expected)
    if not args.assets_only:
        subprocess.run([str(python), '-m', 'controller.setup_kokoro', '--per-token'], cwd=ROOT, check=True)
        print('Native Kokoro is installed. GPU readiness still requires a successful worker warm-up.', flush=True)


if __name__ == '__main__':
    main()
