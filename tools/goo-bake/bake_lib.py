"""Pure helpers for the Goo shader bake (#250); no bpy, so they are unit-tested."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Iterable, Sequence

MANIFEST_VERSION = 1


def _byte(value: float) -> int:
    return max(0, min(255, round(float(value) * 255)))


def pack_col(colours: Iterable[Sequence[float] | None], vertex_count: int) -> bytes:
    """RGBA floats (0–1) per vertex, in PMX order, as RGBA8 bytes."""
    colours = list(colours)
    if len(colours) != vertex_count:
        raise ValueError(f"{len(colours)} colours for {vertex_count} vertices")
    out = bytearray()
    for index, rgba in enumerate(colours):
        if rgba is None:
            raise ValueError(f"vertex {index} has no colour")
        out.extend(_byte(channel) for channel in rgba[:4])
    return bytes(out)


def build_manifest(*, source: str, source_sha256: str, blender: str, vertex_count: int,
                   materials: list[str], files: dict[str, str]) -> dict:
    """What the renderer checks before using a bake."""
    return {
        "version": MANIFEST_VERSION,
        "source": {"file": source, "sha256": source_sha256},
        "blender": blender,
        "pmx": {"vertexCount": vertex_count, "materials": list(materials)},
        "files": dict(files),
    }


def dump_json(value: object) -> str:
    """Stable JSON: sorted keys, readable Japanese names, trailing newline."""
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
