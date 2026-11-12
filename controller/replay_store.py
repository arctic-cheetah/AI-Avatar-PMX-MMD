"""Spoken turns kept on disk so any chat bubble can be replayed (#152).

Each turn has its own folder under ``assets/private/speech/turns/`` (gitignored),
named by a 16-hex-character turn ID. It holds the clips and ``turn.json``, an
ordered manifest of the clips with their moods and text. The folder is capped:
whole turns are deleted oldest first. Only folders named by a turn ID inside
the turns folder are ever deleted, and symlinks are never followed.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TURNS_DIR = ROOT / "assets" / "private" / "speech" / "turns"
TURN_ID = re.compile(r"[0-9a-f]{16}")
MANIFEST = "turn.json"
DEFAULT_CAP_MB = 500
MB = 1_000_000


def new_turn_id() -> str:
    return secrets.token_hex(8)


def _root(root: Path | None) -> Path:
    # Read at call time so tests (and callers) can point it elsewhere.
    return TURNS_DIR if root is None else root


def turn_dir(turn: str, root: Path | None = None) -> Path:
    """The folder for ``turn``; ValueError unless it is a turn ID."""
    if not isinstance(turn, str) or not TURN_ID.fullmatch(turn):
        raise ValueError("Invalid turn ID")
    return _root(root) / turn


def _write_manifest(directory: Path, clips: list) -> None:
    temp = directory / f".{MANIFEST}.tmp"
    temp.write_text(json.dumps({"version": 1, "clips": clips}, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    os.replace(temp, directory / MANIFEST)


def open_turn(turn: str, cap_bytes: int, root: Path | None = None) -> Path:
    """Create the turn's folder with an empty manifest, then prune older turns."""
    directory = turn_dir(turn, root)
    directory.mkdir(parents=True, exist_ok=True)
    _write_manifest(directory, [])
    prune_turns(_root(root), cap_bytes, keep={turn})
    return directory


def record_clip(directory: Path, clip: dict) -> None:
    """Append one announced clip to the turn's manifest."""
    try:
        clips = json.loads((directory / MANIFEST).read_text(encoding="utf-8"))["clips"]
    except (OSError, ValueError, KeyError, TypeError):
        clips = []
    clips.append({key: clip[key] for key in ("id", "expression", "weight", "text")})
    _write_manifest(directory, clips)


def _turn_folders(root: Path):
    """(turn, path) for each real folder named by a turn ID; symlinks are skipped."""
    try:
        entries = list(root.iterdir())
    except FileNotFoundError:
        return []
    return [
        (path.name, path)
        for path in entries
        if TURN_ID.fullmatch(path.name) and not path.is_symlink() and path.is_dir()
    ]


def _size(directory: Path) -> int:
    return sum(path.stat().st_size for path in directory.iterdir()
               if path.is_file() and not path.is_symlink())


def _last_written(directory: Path) -> int:
    stamps = [directory.lstat().st_mtime_ns]
    stamps += [path.lstat().st_mtime_ns for path in directory.iterdir()]
    return max(stamps)


def _remove(directory: Path) -> None:
    """Delete a turn folder's own entries, then the folder; nothing is followed."""
    for path in directory.iterdir():
        if path.is_dir() and not path.is_symlink():
            continue  # a turn folder holds files only; leave anything else alone
        path.unlink(missing_ok=True)
    try:
        directory.rmdir()
    except OSError:
        pass


def prune_turns(root: Path | None, cap_bytes: int, keep=frozenset()) -> list[str]:
    """Delete whole turns, oldest first, until the folder fits ``cap_bytes``.

    Turns in ``keep`` are never deleted. Returns the deleted turn IDs, oldest first.
    """
    root = _root(root)
    turns = []
    for turn, path in _turn_folders(root):
        try:
            turns.append((_last_written(path), turn, path, _size(path)))
        except FileNotFoundError:
            continue  # deleted meanwhile
    total = sum(size for *_, size in turns)
    deleted = []
    for _, turn, path, size in sorted(turns):
        if total <= cap_bytes:
            break
        if turn in keep:
            continue
        _remove(path)
        total -= size
        deleted.append(turn)
    return deleted


def delete_turns(turns, root: Path | None = None) -> list[str]:
    """Delete the listed turns (New chat). Invalid or missing IDs are ignored."""
    root = _root(root)
    deleted = []
    for turn in turns:
        if not isinstance(turn, str) or not TURN_ID.fullmatch(turn) or turn in deleted:
            continue
        path = root / turn
        if path.is_symlink() or not path.is_dir():
            continue
        _remove(path)
        deleted.append(turn)
    return deleted
