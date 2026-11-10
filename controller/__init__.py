"""Yidhari avatar controller."""

import os
import sys
from pathlib import Path


def venv_python(venv_dir) -> Path:
    """Return the interpreter path inside a venv: ``Scripts/python.exe`` on
    Windows, ``bin/python`` everywhere else."""
    venv_dir = Path(venv_dir)
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def applio_python(applio_dir) -> Path:
    """Return the Python interpreter inside an Applio install.

    Probes the layouts Applio uses across platforms: a ``.venv`` created by the
    Linux/macOS installer, or the conda-style ``env`` directory its Windows
    ``run-install.bat`` produces. Falls back to the first candidate when none
    exists so the caller's file-not-found error names the expected path."""
    applio_dir = Path(applio_dir)
    candidates = [
        venv_python(applio_dir / ".venv"),                 # .venv/Scripts|bin
        applio_dir / "env" / "python.exe",                  # Windows conda env
        applio_dir / "env" / "bin" / "python",              # conda env (POSIX)
        applio_dir / "env" / "Scripts" / "python.exe",      # conda env, alt
        venv_python(applio_dir / "env"),                    # env as a plain venv
    ]
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]
