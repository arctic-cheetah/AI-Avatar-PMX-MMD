"""Save Blender poses (VPD) uploaded from the renderer page (#49).

serve.py accepts POST /poses/<name> and writes `<poses dir>/<name>.vpd`.
See docs/held-poses.md.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import tempfile

MAX_POSE_BYTES = 1024 * 1024
MAGIC = b"Vocaloid Pose Data file"
# Letters (Japanese included), digits, _ and -: nothing that can leave the folder.
NAME = re.compile(r"\w[\w-]{0,63}")


class PoseUploadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def valid_name(name: str) -> bool:
    return bool(NAME.fullmatch(name)) and "/" not in name and "\\" not in name


def check_pose_upload(headers, origin: str, name: str) -> int:
    """Validate an upload's headers and pose name; return the byte length or raise PoseUploadError."""
    if headers.get("Origin") != origin:
        # Blocks other web pages (and DNS-rebinding hosts) from writing files.
        raise PoseUploadError(403, "Poses are accepted only from the renderer page.")
    if not valid_name(name):
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
    """Write `<folder>/<name>.vpd` through a temporary file; refuse non-VPD data and silent replacement."""
    if not valid_name(name):
        raise PoseUploadError(400, "Pose names are 1-64 letters, digits, _ or -.")
    if not data.startswith(MAGIC):
        raise PoseUploadError(422, "That is not a VPD pose file.")
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
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
