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
from pathlib import Path, PurePath
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


def _writable(name: str) -> bool:
    try:
        name.encode(ENCODING)
    except UnicodeEncodeError:
        return False
    return True


# Simplified-Chinese characters in this model's names that Shift-JIS lacks,
# and the Japanese forms written in their place (齿上 → 歯上, 右结1_2 → 右結1_2).
SJIS_ALIASES = {"齿": "歯", "结": "結"}

# Morphs that may go below 0 (the user, 25 Nov 2026): pulling the teeth back
# shows them in a smile. Every other morph stays within 0 to 1.
SIGNED_MORPHS = frozenset({"齿上", "齿下", "歯上", "歯下"})


def to_vpd_name(name: str) -> str:
    """The name to write: Japanese forms for characters Shift-JIS lacks."""
    if _writable(name):
        return name
    return "".join(SJIS_ALIASES.get(ch, ch) for ch in name)


def from_vpd_name(name: str, model: set[str]) -> str:
    """The model's own name for a name read from a VPD (歯下 → 齿下 when the model has 齿下)."""
    if name in model:
        return name
    for simplified, japanese in SJIS_ALIASES.items():
        candidate = name.replace(japanese, simplified)
        if candidate in model:
            return candidate
    return name


def keep_morph(name: str, value: float) -> bool:
    """Whether a morph's value is saved: above 0, or any non-zero value for the teeth."""
    return value != 0 if name in SIGNED_MORPHS else value > 0


def split_unwritable(pose: VpdPose) -> tuple[VpdPose, list[str]]:
    """Write names Shift-JIS cannot hold with SJIS_ALIASES; set aside the rest.

    PMX names are UTF-16, so a model can use characters VPD cannot store,
    such as the simplified 齿 in 齿上, which is written as 歯上. Returns the
    writable pose and the names still left out, in file order.
    """
    bones = [VpdBone(to_vpd_name(b.name), b.location, b.rotation) for b in pose.bones]
    morphs = [VpdMorph(to_vpd_name(m.name), m.weight) for m in pose.morphs]
    skipped = [b.name for b in bones if not _writable(b.name)] + [m.name for m in morphs if not _writable(m.name)]
    return VpdPose(pose.model, tuple(b for b in bones if _writable(b.name)),
                   tuple(m for m in morphs if _writable(m.name))), skipped


def _num(value: float) -> str:
    """Six decimals, as MMD writes them. three.js only reads `-?digits.digits`."""
    return f"{float(value):.6f}"


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


# Each arm from the shoulder down, parents first, then the fingers.
ARM_CHAIN = ("肩", "腕", "腕捩", "ひじ", "手捩", "手首")
FINGERS = tuple(f"{digit}{joint}" for digit in ("親指", "人指", "中指", "薬指", "小指") for joint in "０１２３")


def arm_chain_fill(posed: set[str], model: set[str]) -> list[str]:
    """Bones to save at rest because a bone above them in the arm is posed.

    The renderer does not keep arm bones at rest: its relaxed pose curls the
    fingers and its hand drift turns 手捩. So when an arm is posed, every bone
    below its highest posed bone is saved too, even if it is at rest. Bones
    above it stay out, so a pose of the hand alone does not pull a lowered
    arm back to the T-pose. A posed finger brings the rest of that hand.
    Returns names the model has and `posed` does not, side by side, in chain
    order.
    """
    fill: list[str] = []
    for side in "左右":
        chain = [f"{side}{name}" for name in ARM_CHAIN] + [f"{side}{name}" for name in FINGERS]
        first_finger = len(ARM_CHAIN)
        top = next((i for i, name in enumerate(chain) if name in posed), None)
        if top is None:
            continue
        # A posed finger means the hand: start from its first finger.
        start = first_finger if top >= first_finger else top
        fill += [name for name in chain[start:] if name in model and name not in posed]
    return fill


def poses_folder(blend: Path | None) -> Path | None:
    """Where poses are imported from and saved to by default.

    The repository's `assets/poses/` (tracked in git), found from the nearest
    parent of the .blend that has an `assets` folder, and created if missing.
    Without one, the .blend's own folder; an unsaved file has none.
    """
    if blend is None:
        return None
    for parent in Path(blend).parents:
        if (parent / "assets").is_dir():
            folder = parent / "assets" / "poses"
            folder.mkdir(exist_ok=True)
            return folder
    return Path(blend).parent


def pose_name(path: str | PurePath) -> str:
    """A pose is named after its file."""
    return PurePath(path).stem
