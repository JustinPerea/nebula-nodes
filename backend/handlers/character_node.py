"""Character source node.

A pure utility/glue node: it loads a persisted Character from the project
CharacterStore by id (the ``character`` param) and re-emits it as a
CharacterBundle on the `character` output port. Downstream cinematic nodes
consume the bundle.

``character`` is a public param of type ``character`` (services/agent_params.py):
the Inspector shows a picker, agents set it to an id from GET /api/characters,
and the canvas card reads the Character itself. A node saved before 2026-10-18
kept the id in ``_characterId``; ``retired_nodes.migrate_params`` moves it.

Identity-correctness contract — copied VERBATIM from the stored Character:
  - referenceViews are emitted in stored order (never sorted/reordered).
  - frozenTraitString is emitted byte-identical (never normalized/paraphrased).
    Paraphrasing the trait string breaks downstream identity (Seedance finding,
    documented on the Character type).

No network, no generation — this node is deterministic given a stored asset.

Per-use override layer (this node's own editor params):
  - ``override_prompt`` — extra pose/expression/wardrobe/framing direction,
  - ``override_refs`` — an extra per-use reference image (a ``file`` param),
  - ``strength_override`` — a per-use consistency strength (``''`` = inherit).
These ride along in the emitted CharacterBundle (as ``overridePrompt`` /
``overrideRefs`` / ``strengthOverride``) and are APPLIED by the consumer
(cinema-scene / edit nodes) inside ``cinema.identity.expand_character`` — not by
this node. This node only resolves the stored identity and packs the bundle.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent, add_run_note
from models.graph import GraphNode, PortValueDict
from services.character_store import CharacterStore
from services.stored_image_refs import is_outside_link
from execution.person_line import with_person_line


def _in_trash(character_id: str) -> bool:
    try:
        return CharacterStore().trashed(character_id) is not None
    except ValueError:
        return False


async def handle_character_node(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Load the stored Character by id and emit it as a CharacterBundle.

    Raises ValueError with a clear message when ``character`` is empty or
    names a Character that does not exist in the store.
    """
    params = node.params or {}
    raw = params.get("character")
    if not isinstance(raw, str) or not raw.strip():
        raise with_person_line(
            ValueError("No character chosen: set character to a character id (GET /api/characters lists them)"),
            "Choose a character in “Character”, then run it again.")
    character_id = raw.strip()
    try:
        character = CharacterStore().get(character_id)
    except ValueError:  # not an id the store can hold
        character = None
    if character is None:
        if _in_trash(character_id):
            raise with_person_line(ValueError(f"Character {character_id!r} is in Recently deleted. Restore it (Character Studio, "
                             f"or nebula trash restore character {character_id}) and run again."),
                "This node's character is in Recently deleted. Restore it in Character Studio, then run the node again.")
        raise with_person_line(ValueError(f"Character {character_id!r} not found; it may have been deleted for good. "
                         "Pick another character for this node."),
            "This node's character can't be found. It may have been deleted for good. Pick another character for this node.")

    # Build the lightweight bundle. referenceViews + frozenTraitString are
    # passed through verbatim — no copy-with-sort, no string normalization —
    # except a view that is an image link from outside Nebula: a Character
    # saved before writes were checked (services/stored_image_refs.py) can
    # hold one. It stays on the Character, but the bundle is what a run sends
    # and what the Inspector's Last output draws, so it is left out (as
    # Create leaves it out of a Style's references) and the run says so.
    views = list(character["referenceViews"])
    kept = [view for view in views if not (isinstance(view, str) and is_outside_link(view))]
    if len(kept) < len(views):
        name = character.get("name") or character_id
        if not kept:
            raise with_person_line(ValueError(f"Every reference view of Character {name!r} is an image link from outside Nebula, "
                             "so none can be used. Replace them with uploads in Character Studio and run again."), "Every reference view of this node's character is an image link from outside Nebula, so none can be used. "
                             "Replace them with uploads in Character Studio, then run the node again.")
        left_out = len(views) - len(kept)
        add_run_note(f"{left_out} reference view{'s' if left_out != 1 else ''} of Character {name!r} "
                     f"{'are image links' if left_out != 1 else 'is an image link'} from outside Nebula, so "
                     f"{'they were' if left_out != 1 else 'it was'} left out. Replace "
                     f"{'them' if left_out != 1 else 'it'} with an upload in Character Studio.")
    bundle: dict[str, Any] = {
        "characterId": character["id"],
        "name": character["name"],
        "referenceViews": kept,
        "frozenTraitString": character["frozenTraitString"],
        "seed": character["seed"],
        "consistencyStrength": character["consistencyStrength"],
    }

    # Per-use override layer (this node's own params) — packed into the bundle
    # only when actually set, so an unconfigured character node emits a bundle
    # byte-identical to the pre-override shape. The consumer applies these.
    override_prompt = str(params.get("override_prompt") or "").strip()
    if override_prompt:
        bundle["overridePrompt"] = override_prompt

    # override_refs is a `file` param — a single path/URL string (or empty).
    # Wrap a non-empty value as a one-element list (the bundle field is a list,
    # mirroring referenceViews); leave it absent when empty. No resolution here —
    # the consumer resolves/downloads refs exactly like referenceViews.
    override_refs_raw = params.get("override_refs")
    override_ref = str(override_refs_raw).strip() if override_refs_raw else ""
    if override_ref:
        bundle["overrideRefs"] = [override_ref]

    # strength_override is a float param with '' sentinel = "inherit". Parse to a
    # float in 0..1 when set; absent (None) means inherit consistencyStrength.
    strength_override = _parse_strength(params.get("strength_override"))
    if strength_override is not None:
        bundle["strengthOverride"] = strength_override

    return {"character": {"type": "Character", "value": bundle}}


def _parse_strength(raw: Any) -> float | None:
    """Parse the strength_override param to a float clamped to 0..1, or None.

    The param uses '' (and None / unset) as the "inherit" sentinel. Any
    unparseable value is treated as inherit rather than raising — a malformed
    override should not break identity resolution.
    """
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    # Clamp into the documented 0..1 range (mirrors the slider's min/max).
    return max(0.0, min(1.0, value))
