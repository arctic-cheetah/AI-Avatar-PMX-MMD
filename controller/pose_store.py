"""Save Blender poses (VPD) uploaded from the renderer page (#49).

serve.py accepts POST /poses/<name> and writes `<poses dir>/<name>.vpd`.
See docs/held-poses.md.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import tempfile
import unicodedata

MAX_POSE_BYTES = 1024 * 1024
MAGIC = b"Vocaloid Pose Data file"
# Letters (Japanese included), digits, _ and -: nothing that can leave the folder.
# The one pose-name rule: uploads, [@pose:name] tags and play_action all use it (#269).
NAME = re.compile(r"\w[\w-]{0,63}")


class PoseUploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def valid_name(name: str) -> bool:
    # NFKC-stable only (review of #271): full-width letters, half-width kana,
    # circled digits and ligatures would let one pose look like another.
    return (
        bool(NAME.fullmatch(name))
        and "/" not in name
        and "\\" not in name
        and unicodedata.normalize("NFKC", name) == name
    )


def name_key(name: str) -> str:
    """Two pose names clash when their NFKC, case-folded forms are equal."""
    return unicodedata.normalize("NFKC", name).casefold()


def normal_name(name: str) -> str:
    """Pose names are stored and looked up in Unicode NFC (#269)."""
    return unicodedata.normalize("NFC", name)


def check_pose_upload(headers, origin: str, name: str) -> int:
    """Validate an upload's headers and pose name; return the byte length or raise PoseUploadError."""
    if headers.get("Origin") != origin:
        # Blocks other web pages (and DNS-rebinding hosts) from writing files.
        raise PoseUploadError(403, "Poses are accepted only from the renderer page.")
    if not valid_name(normal_name(name)):
        raise PoseUploadError(400, "Pose names are 1-64 letters, digits, _ or -.")
    kind = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if kind != "application/octet-stream":
        raise PoseUploadError(415, "Send the VPD as application/octet-stream.")
    try:
        length = int(headers.get("Content-Length", ""))
    except ValueError:
        raise PoseUploadError(411, "Pose size is missing.") from None
    if length <= 0:
        raise PoseUploadError(400, "The pose file is empty.")
    if length > MAX_POSE_BYTES:
        raise PoseUploadError(413, "The pose file is too large.")
    return length


def save_pose(folder: Path, name: str, data: bytes, overwrite: bool) -> Path:
    """Write `<folder>/<name>.vpd` through a temporary file; refuse non-VPD data and silent replacement.

    The name is saved in NFC. A name that differs from an existing pose only
    by case is refused, so `Wink` and `wink` never both exist (#269).
    """
    name = normal_name(name)
    if not valid_name(name):
        raise PoseUploadError(400, "Pose names are 1-64 letters, digits, _ or -.")
    if not data.startswith(MAGIC):
        raise PoseUploadError(422, "That is not a VPD pose file.")
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for existing in folder.glob("*.vpd"):
        stem = normal_name(existing.stem)
        if stem != name and name_key(stem) == name_key(name):
            raise PoseUploadError(409, f"A pose named {stem} already exists; names differ only by case.")
    path = folder / f"{name}.vpd"
    if path.exists() and not overwrite:
        raise PoseUploadError(409, f"A pose named {name} already exists.")
    handle, temporary = tempfile.mkstemp(dir=folder, prefix=".upload-", suffix=".vpd")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path
