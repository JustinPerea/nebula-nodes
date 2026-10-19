"""Native Nebula Moodboard source node."""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.moodboard_analysis import analysis_is_current, analyze_moodboard, rank_representative_images
from services.moodboard_store import MoodboardStore


def _in_trash(moodboard_id: str) -> bool:
    try:
        return MoodboardStore().trashed(moodboard_id) is not None
    except ValueError:
        return False


async def handle_moodboard_node(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Load the saved Moodboard named by the ``moodboard`` param (a board id)
    and emit provider-neutral creative direction.

    A node saved before the id was public kept it in ``_moodboardId``; the
    engine's ``migrate_params`` has moved it to ``moodboard`` by now."""
    raw = (node.params or {}).get("moodboard")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("No moodboard chosen: set moodboard to a board id (GET /api/moodboards lists them)")
    moodboard_id = raw.strip()
    try:
        moodboard = MoodboardStore().get(moodboard_id)
    except ValueError:  # not an id the store can hold
        moodboard = None
    if moodboard is None:
        if _in_trash(moodboard_id):
            raise ValueError(f"Moodboard {moodboard_id!r} is in Recently deleted. Restore it (Moodboard Studio, "
                             f"or nebula trash restore moodboard {moodboard_id}) and run again.")
        raise ValueError(f"Moodboard {moodboard_id!r} not found; it may have been deleted for good. "
                         "Pick another board for this node.")

    analysis = moodboard.get("analysis")
    if not analysis_is_current(moodboard, analysis):
        stale = isinstance(analysis, dict) and bool(analysis.get("styleBrief"))
        # It reads every image file, so it runs off the event loop.
        analysis = await asyncio.to_thread(analyze_moodboard, moodboard)
        if stale:
            analysis["warnings"] = [
                *analysis.get("warnings", []),
                "The board changed after its saved analysis, so this run analyzed it again. "
                "Analyze it in Moodboard Studio to save the new analysis.",
            ]

    images = [
        img for img in moodboard.get("images", [])
        if isinstance(img, dict) and not bool(img.get("excluded"))
    ]
    representative = analysis.get("representativeImages") or rank_representative_images(images)
    bundle = {
        "kind": "nebula_moodboard",
        "moodboardId": moodboard.get("id"),
        "name": moodboard.get("name"),
        "mode": moodboard.get("mode", "look"),
        "strength": moodboard.get("strength", 0.7),
        "images": images,
        "notes": moodboard.get("notes", ""),
        "analysis": analysis,
        "styleBrief": analysis.get("styleBrief", ""),
        "negativePrompt": analysis.get("negativePrompt", ""),
        "palette": analysis.get("palette", []),
        "accents": analysis.get("accents", []),
        "representativeImages": representative,
        "providerHints": analysis.get("providerHints", {}),
    }

    return {
        "moodboard": {"type": "Moodboard", "value": bundle},
        "style_brief": {"type": "Text", "value": bundle["styleBrief"]},
        "negative_prompt": {"type": "Text", "value": bundle["negativePrompt"]},
        "representative_images": {"type": "Array", "value": representative},
        "palette": {"type": "Array", "value": bundle["palette"]},
    }
