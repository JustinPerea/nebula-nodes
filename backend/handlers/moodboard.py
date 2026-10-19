"""Native Nebula Moodboard source node."""
from __future__ import annotations

import asyncio
import copy
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent, add_run_note
from models.graph import GraphNode, PortValueDict
from services.moodboard_analysis import analysis_is_current, analyze_moodboard, rank_representative_images
from services.moodboard_brief import NODE_NOTES_CHOICES, compose, generator_analysis
from services.moodboard_store import MoodboardStore, output_image


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
        # The node never reads the layout, so the board isn't laid out.
        moodboard = MoodboardStore().get(moodboard_id, laid_out=False)
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

    # The node's own say on the board's notes ("board", the default, follows
    # the board's sendNotes; a node saved before the param reads "board").
    choice = (node.params or {}).get("send_notes")
    send_notes = NODE_NOTES_CHOICES.get(choice if isinstance(choice, str) else "board")
    # The brief generators get: the analysis joined with the person's
    # Direction, Avoid and pinned colours, or their hand-written override.
    brief = compose(moodboard, analysis, send_notes=send_notes)
    notes_sent = bool(brief["notesSent"])
    # Only the keys generators read: never the person's private notes, which
    # never leave the board, or the layout (placements), which steers nothing.
    # Image notes go only when the board's notes do (gap 18, P4).
    images = [
        output_image(img) if notes_sent else {**output_image(img), "notes": ""}
        for img in moodboard.get("images", [])
        if isinstance(img, dict) and not bool(img.get("excluded"))
    ]
    representative = analysis.get("representativeImages") or rank_representative_images(images)
    # What a generator (or an LLM on an Any port) may read of the analysis:
    # no notes unless sent, and colour sentences without left-out colours.
    # The saved analysis is left as it was.
    analysis = generator_analysis(moodboard, analysis, brief)
    if brief["override"]["stale"]:
        add_run_note(f"Moodboard '{moodboard.get('name')}' changed after its brief was edited by hand; "
                     "this run used the edited brief. Keep or Regenerate it in Moodboard Studio.")
    hints = copy.deepcopy(analysis.get("providerHints") or {})
    if isinstance(hints.get("krea"), dict):
        hints["krea"]["styleBrief"] = brief["styleBrief"]
    if isinstance(hints.get("generic"), dict):
        hints["generic"]["promptSuffix"] = brief["styleBrief"]
        hints["generic"]["negativePrompt"] = brief["negativePrompt"]
        hints["generic"]["avoidPrompt"] = brief["avoidPrompt"]
    bundle = {
        "kind": "nebula_moodboard",
        "moodboardId": moodboard.get("id"),
        "name": moodboard.get("name"),
        "mode": moodboard.get("mode", "look"),
        "strength": moodboard.get("strength", 0.7),
        "images": images,
        "notes": moodboard.get("notes", "") if notes_sent else "",
        "notesSent": notes_sent,
        "analysis": {**analysis, "providerHints": hints},
        "styleBrief": brief["styleBrief"],
        "negativePrompt": brief["negativePrompt"],
        "avoid": brief["avoid"],
        "avoidPrompt": brief["avoidPrompt"],
        "direction": brief["direction"],
        "pinnedColors": brief["pinnedColors"],
        "briefOverride": brief["override"],
        "palette": brief["palette"],
        "accents": brief["accents"],
        # Why some measured colours aren't in palette/accents, and the ones
        # that still go but may clash (services/moodboard_brief.compose).
        "leftOut": brief["leftOut"],
        "mayClash": brief["mayClash"],
        "kept": brief["kept"],
        "pinnedClashes": brief["pinnedClashes"],
        "paletteClashes": brief["paletteClashes"],
        "clashMode": brief["clashMode"],
        "representativeImages": representative,
        "providerHints": hints,
    }

    return {
        "moodboard": {"type": "Moodboard", "value": bundle},
        "style_brief": {"type": "Text", "value": bundle["styleBrief"]},
        "negative_prompt": {"type": "Text", "value": bundle["negativePrompt"]},
        "representative_images": {"type": "Array", "value": representative},
        "palette": {"type": "Array", "value": bundle["palette"]},
    }
