"""Native Nebula Moodboard source node."""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.moodboard_analysis import analyze_moodboard
from services.moodboard_store import MoodboardStore


async def handle_moodboard_node(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Load a saved Moodboard and emit provider-neutral creative direction."""
    params = node.params or {}
    moodboard_id = str(params.get("_moodboardId") or "").strip()
    embedded = params.get("moodboard") if isinstance(params.get("moodboard"), dict) else None

    moodboard = MoodboardStore().get(moodboard_id) if moodboard_id else None
    if moodboard is None and embedded:
        moodboard = dict(embedded)
    if moodboard is None:
        raise ValueError(f"Moodboard not found: {moodboard_id}")

    analysis = moodboard.get("analysis")
    if not isinstance(analysis, dict) or not analysis.get("styleBrief"):
        analysis = analyze_moodboard(moodboard)

    images = [
        img for img in moodboard.get("images", [])
        if isinstance(img, dict) and not bool(img.get("excluded"))
    ]
    representative = analysis.get("representativeImages") or [img.get("url") for img in images if img.get("url")]
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
