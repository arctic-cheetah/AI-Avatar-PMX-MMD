"""Animation actions while she speaks (#269): the shared catalog and pose names.

`renderer/actions.json` lists the built-in actions for both the bridge and the
renderer. Blender poses are named `pose:<name>`, checked by the one pose-name
rule in `controller/pose_store.py`. See docs/speech-actions.md.
"""

from __future__ import annotations

import functools
import json
import math
from pathlib import Path
import re
import unicodedata

from controller.pose_store import name_key, valid_name

ACTIONS_PATH = Path(__file__).resolve().parents[1] / "renderer" / "actions.json"
POSES_DIR = Path(__file__).resolve().parents[1] / "assets" / "poses"
POSE_PREFIX = "pose:"
ACTION_NAME = re.compile(r"[a-z][a-z0-9-]*")  # built-in names, like mood names
MAX_ACTIONS = 8  # action tags kept per reply; later ones are dropped (the user's limit)
MAX_REF = len(POSE_PREFIX) + 64 * 4  # a generous cap before any parsing
SPEECH_POSE_HOLD = 2.0  # seconds a pose is held while speaking, by default
SPEECH_POSE_HOLD_RANGE = (0.5, 4.0)
MAX_POSE_TEXT = 80  # characters of a sidecar label or description
POSE_TEXT_PUNCTUATION = ".,'!?()-"


def load_actions(path: Path = ACTIONS_PATH) -> dict[str, dict]:
    """Read and check the shared action catalog."""
    actions = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(actions, dict) or not actions:
        raise ValueError("The action catalog must be a non-empty object")
    for name, entry in actions.items():
        if (
            not ACTION_NAME.fullmatch(name)
            or not isinstance(entry, dict)
            or not str(entry.get("label", "")).strip()
            or not str(entry.get("description", "")).strip()
            or not isinstance(entry.get("speech"), bool)
            or entry.get("layer", "body") not in ("body", "tentacle")
            or (entry.get("layer") == "tentacle" and not isinstance(entry.get("target"), str))
        ):
            raise ValueError(f"Invalid action definition: {name}")
    return actions


@functools.cache
def default_actions() -> dict[str, dict]:
    return load_actions()


def pose_name(name) -> str | None:
    """The NFC form of a valid pose name, or None. The upload rule decides."""
    if not isinstance(name, str) or len(name) > MAX_REF:
        return None
    name = unicodedata.normalize("NFC", name)
    return name if valid_name(name) else None


def resolve_action(ref, actions: dict | None = None, *, speaking: bool = True) -> str | None:
    """The canonical reference for an action or `pose:<name>`, or None.

    While speaking only speech-safe built-in actions are allowed. A pose's
    own speech setting is the renderer's to check, since it reads the sidecar.
    """
    actions = default_actions() if actions is None else actions
    if not isinstance(ref, str) or len(ref) > MAX_REF:
        return None
    if ref.startswith(POSE_PREFIX):
        name = pose_name(ref[len(POSE_PREFIX):])
        return None if name is None else POSE_PREFIX + name
    entry = actions.get(ref)
    if entry is None or (speaking and not entry["speech"]):
        return None
    return ref


def _clean(value) -> str | None:
    """Sidecar text as short plain data (review of #271): it reaches the agent's
    tool description, so keep letters, digits, spaces and . , ' ! ? ( ) - only."""
    if not isinstance(value, str):
        return None
    kept = "".join(c for c in value if c.isalnum() or c in POSE_TEXT_PUNCTUATION or c.isspace())
    text = " ".join(kept.split())[:MAX_POSE_TEXT].strip()
    return text or None


def pose_settings(data) -> dict:
    """Normalise a pose sidecar (`<name>.json`): label, description, speech, speechHold."""
    data = data if isinstance(data, dict) else {}
    speech = data.get("speech")
    hold = data.get("speechHold")
    low, high = SPEECH_POSE_HOLD_RANGE
    if isinstance(hold, bool) or not isinstance(hold, (int, float)) or not math.isfinite(hold):
        hold = SPEECH_POSE_HOLD
    settings = {
        "speech": speech if isinstance(speech, bool) else True,
        "speechHold": min(high, max(low, float(hold))),
    }
    for key in ("label", "description"):
        text = _clean(data.get(key))
        if text:
            settings[key] = text
    return settings


def list_poses(folder: Path = POSES_DIR) -> list[dict]:
    """Finished, validly named `.vpd` poses in `folder`, sorted, with their sidecar settings."""
    try:
        paths = list(Path(folder).iterdir())
    except OSError:
        return []
    poses = []
    for path in paths:
        if path.suffix != ".vpd" or not path.is_file():
            continue
        name = pose_name(path.stem)
        if name is None or name != path.stem:
            continue  # temporary uploads (.upload-*) and names the rule refuses
        try:
            data = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        poses.append({"name": name, **pose_settings(data)})
    # A git pull can bring case twins that uploads refuse: list the first only.
    seen, unique = set(), []
    for pose in sorted(poses, key=lambda pose: pose["name"]):
        if name_key(pose["name"]) not in seen:
            seen.add(name_key(pose["name"]))
            unique.append(pose)
    return unique
