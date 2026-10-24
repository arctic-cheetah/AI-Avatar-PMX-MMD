"""Install the isolated CPU speech-to-text runtime and pinned Whisper models."""

import argparse
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from controller.stt_worker import MODEL_DIR, MODELS  # noqa: E402  (stdlib-only at import)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', nargs='+', default=['base.en'], choices=sorted(MODELS),
                        help='Whisper models to download (default: base.en).')
    args = parser.parse_args()
    if not (3, 11) <= sys.version_info[:2] < (3, 14):
        raise SystemExit('Setup requires Python 3.11–3.13; Python 3.12 is recommended.')
    environment = ROOT / '.venv-stt'
    venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / 'bin' / 'python'
    subprocess.run([str(python), '-m', 'pip', 'install', '-r',
                    str(ROOT / 'requirements-stt.txt')], check=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for name in args.models:
        repo, revision = MODELS[name]
        print(f'Fetching {name} ({repo} @ {revision[:12]})…', flush=True)
        subprocess.run([str(python), '-I', '-c',
                        'import sys; from faster_whisper.utils import download_model; '
                        'download_model(sys.argv[1], cache_dir=sys.argv[2], revision=sys.argv[3])',
                        repo, str(MODEL_DIR), revision], check=True)
    print('Speech-to-text is ready. Start the renderer with: '
          '.venv/bin/python renderer/serve.py --stt', flush=True)


if __name__ == '__main__':
    main()
