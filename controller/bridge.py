"""Minimal bridge from llama-server chat output to avatar events.

This is a scaffold. It does not render anything yet.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TAG_RE = re.compile(r"\[(blink|happy|thinking|tilt|idle)\]", re.IGNORECASE)


@dataclass(frozen=True)
class AvatarEvent:
    kind: str
    text: str


def parse_actions(text: str) -> list[AvatarEvent]:
    """Split model text into spoken text and simple avatar events."""
    events: list[AvatarEvent] = []
    cursor = 0
    for match in TAG_RE.finditer(text):
        spoken = text[cursor : match.start()].strip()
        if spoken:
            events.append(AvatarEvent(kind="say", text=spoken))
        events.append(AvatarEvent(kind=match.group(1).lower(), text=""))
        cursor = match.end()
    tail = text[cursor:].strip()
    if tail:
        events.append(AvatarEvent(kind="say", text=tail))
    return events


if __name__ == "__main__":
    sample = "Hello there. [happy] I am right here with you. [blink]"
    for event in parse_actions(sample):
        print(f"{event.kind}: {event.text}")
