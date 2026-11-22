"""VPD files and pose properties for the Yidhari Poses add-on (#261).

Pure Python, no bpy, so it can be tested outside Blender. A VPD (Vocaloid Pose
Data) file is Shift-JIS text with CRLF line ends:

    Vocaloid Pose Data file

    model.osm;        // 親ファイル名
    2;                // 総ポーズボーン数

    Bone0{右人指２
      0,0,0;          // trans x,y,z
      0.1,0.2,0.3,0.9; // Quaternion x,y,z,w
    }

    Morph0{ウィンク右
      1.000000;       // weight
    }

Values are in MMD space; MMD Tools' BoneConverter turns them into Blender
bone transforms.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import PurePath
from typing import Iterable

HEADER = "Vocaloid Pose Data file"
ENCODING = "cp932"


class VpdError(ValueError):
    """A VPD file, or a stored pose, that cannot be read or written."""


@dataclass(frozen=True)
class VpdBone:
    name: str
    location: tuple[float, float, float]
    rotation: tuple[float, float, float, float]  # x, y, z, w


@dataclass(frozen=True)
class VpdMorph:
    name: str
    weight: float


@dataclass(frozen=True)
class VpdPose:
    model: str
    bones: tuple[VpdBone, ...]
    morphs: tuple[VpdMorph, ...]


def _numbers(line: str, count: int, what: str) -> tuple[float, ...]:
    try:
        values = tuple(float(v) for v in line.split(";")[0].split(","))
    except ValueError:
        values = ()
    if len(values) != count:
        raise VpdError(f"{what} needs {count} numbers")
    return values


def parse_vpd(data: bytes) -> VpdPose:
    """Read a VPD file. Raises VpdError naming the broken entry."""
    try:
        text = data.decode(ENCODING)
    except UnicodeDecodeError as error:
        raise VpdError(f"not Shift-JIS text: {error}") from None
    lines = [line.strip() for line in text.splitlines()]
    if not lines or not lines[0].startswith(HEADER):
        raise VpdError("not a VPD file")

    body = iter([line for line in lines[1:] if line])
    try:
        model = next(body).split(";")[0].strip()
        declared = int(next(body).split(";")[0].strip())
    except (StopIteration, ValueError):
        raise VpdError("missing the model name or bone count") from None

    def take(label: str) -> str:
        line = next(body, None)
        if line is None:
            raise VpdError(f"{label} ends early")
        return line

    bones: list[VpdBone] = []
    morphs: list[VpdMorph] = []
    for line in body:
        head, _, name = line.partition("{")
        name = name.strip()
        label = f"{head} ({name})"
        if head.startswith("Bone"):
            location = _numbers(take(label), 3, f"{label} location")
            rotation = _numbers(take(label), 4, f"{label} rotation")
            if not any(rotation):
                rotation = (0.0, 0.0, 0.0, 1.0)
            if not take(label).startswith("}"):
                raise VpdError(f"{label} is not closed")
            bones.append(VpdBone(name, location, rotation))  # type: ignore[arg-type]
        elif head.startswith("Morph"):
            (weight,) = _numbers(take(label), 1, f"{label} weight")
            if not take(label).startswith("}"):
                raise VpdError(f"{label} is not closed")
            morphs.append(VpdMorph(name, weight))
    if len(bones) != declared:
        raise VpdError(f"declares {declared} bones but has {len(bones)}")
    return VpdPose(model, tuple(bones), tuple(morphs))


def _check_name(name: str) -> None:
    try:
        name.encode(ENCODING)
    except UnicodeEncodeError:
        raise VpdError(f"cannot be written in Shift-JIS: {name}") from None


def _num(value: float) -> str:
    return repr(float(value))


def format_vpd(pose: VpdPose) -> bytes:
    """Write a VPD file the way MMD and MMD Tools do (Shift-JIS, CRLF)."""
    for name in [pose.model, *(b.name for b in pose.bones), *(m.name for m in pose.morphs)]:
        _check_name(name)
    out = [HEADER, "", f"{pose.model};\t\t// 親ファイル名", f"{len(pose.bones)};\t\t\t\t// 総ポーズボーン数", ""]
    for i, bone in enumerate(pose.bones):
        out += [
            f"Bone{i}{{{bone.name}",
            f"  {','.join(_num(v) for v in bone.location)};\t\t\t\t// trans x,y,z",
            f"  {','.join(_num(v) for v in bone.rotation)};\t\t// Quaternion x,y,z,w",
            "}",
            "",
        ]
    for i, morph in enumerate(pose.morphs):
        out += [f"Morph{i}{{{morph.name}", f"  {_num(morph.weight)};\t\t\t\t// weight", "}", ""]
    return "".join(line + "\r\n" for line in out).encode(ENCODING)


def encode_morphs(morphs: Iterable[VpdMorph]) -> str:
    """Morph weights as the JSON stored on a pose action."""
    return json.dumps({m.name: float(m.weight) for m in morphs}, ensure_ascii=False, sort_keys=True)


def decode_morphs(text: str) -> dict[str, float]:
    """Read the stored morph weights; an empty property means none."""
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        value = None
    if not isinstance(value, dict) or not all(
        isinstance(k, str) and isinstance(v, (int, float)) and not isinstance(v, bool) for k, v in value.items()
    ):
        raise VpdError("morph property is not a JSON object of weights")
    return {k: float(v) for k, v in value.items()}


def missing_names(pose: VpdPose, bone_names: set[str], morph_names: set[str]) -> tuple[list[str], list[str]]:
    """Bones and morphs in the pose that the model does not have, in file order."""
    return (
        [b.name for b in pose.bones if b.name not in bone_names],
        [m.name for m in pose.morphs if m.name not in morph_names],
    )


def pose_name(path: str | PurePath) -> str:
    """A pose is named after its file."""
    return PurePath(path).stem
