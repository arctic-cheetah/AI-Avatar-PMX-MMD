"""Prepare the optional, fixed filler clip once when the speech bridge starts."""

from __future__ import annotations

import logging
from pathlib import Path

from controller.speech import Segment, synthesise

LOG = logging.getLogger(__name__)
FILLER_TEXT = "Hmm…"
FILLER_DIR = Path(__file__).resolve().parents[1] / "assets" / "private" / "speech" / "filler"


async def prepare_filler(worker, text=FILLER_TEXT, directory=FILLER_DIR):
    """Return a cached clip ID, or None when the optional filler is unavailable."""
    try:
        clip_id, timings = await synthesise(Segment(text), worker, directory=directory)
    except Exception:
        # The filler is decorative; never make an otherwise working speech bridge fail.
        LOG.exception("Thinking filler unavailable; continuing without it")
        return None
    LOG.info("Thinking filler cached: %s %s", clip_id, timings)
    return clip_id
