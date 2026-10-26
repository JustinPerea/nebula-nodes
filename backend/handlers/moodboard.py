"""Native Nebula Moodboard source node."""
from __future__ import annotations

import asyncio
import copy
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent, add_run_note
from models.graph import GraphNode, PortValueDict
from services.moodboard_analysis import analysis_is_current, analyze_moodboard, rank_representative_images, steers
from services.moodboard_brief import NODE_NOTES_CHOICES, compose, generator_analysis
from services.moodboard_store import MoodboardStore, output_image
from services.stored_image_refs import is_outside_link
from execution.person_line import with_person_line


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
        raise with_person_line(
            ValueError("No moodboard chosen: set moodboard to a board id (GET /api/moodboards lists them)"),
            "Choose a board for this node, then run it again.")
    moodboard_id = raw.strip()
    try:
        # The node never reads the layout, so the board isn't laid out.
        moodboard = MoodboardStore().get(moodboard_id, laid_out=False)
    except ValueError:  # not an id the store can hold
        moodboard = None
    if moodboard is None:
        if _in_trash(moodboard_id):
            raise with_person_line(ValueError(f"Moodboard {moodboard_id!r} is in Recently deleted. Restore it (Moodboard Studio, "
                             f"or nebula trash restore moodboard {moodboard_id}) and run again."),
                "This node's board is in Recently deleted. Restore it in Moodboard Studio, then run the node again.")
        raise with_person_line(ValueError(f"Moodboard {moodboard_id!r} not found; it may have been deleted for good. "
                         "Pick another board for this node."),
            "This node's board can't be found. It may have been deleted for good. Pick another board for this node.")

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
    # Image notes go only when the board's notes do (gap 18, P4). Set-aside
    # images (the switch, or weight 0: plan section 4.4) never steer, so no
    # generator gets them.
    # An image saved before board writes were checked that links to another
    # site stays on the board but goes to no generator (the bundle is also
    # what the Inspector's Last output draws), as a Character's outside view
    # doesn't (handlers/character_node.py); the run says so.
    steering = [img for img in moodboard.get("images", []) if isinstance(img, dict) and steers(img)]
    outside = [img for img in steering if is_outside_link(str(img.get("url") or ""))]
    images = [
        output_image(img) if notes_sent else {**output_image(img), "notes": ""}
        for img in steering if not any(img is gone for gone in outside)
    ]
    if outside:
        count = len(outside)
        add_run_note(f"{count} image{'s' if count != 1 else ''} on Moodboard '{moodboard.get('name')}' "
                     f"{'are image links' if count != 1 else 'is an image link'} from outside Nebula, so "
                     f"{'they were' if count != 1 else 'it was'} left out. Replace "
                     f"{'them' if count != 1 else 'it'} with an upload in Moodboard Studio.")
    # What a generator (or an LLM on an Any port) may read of the analysis:
    # no notes unless sent, colour sentences without left-out colours, and
    # representative images that steer. The saved analysis is left as it was.
    analysis = generator_analysis(moodboard, analysis, brief)
    representative = analysis.get("representativeImages") or rank_representative_images(images)
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
