"""Character source node.

A pure utility/glue node: it loads a persisted Character from the project
CharacterStore by id (params.characterId) and re-emits it as a CharacterBundle
on the `character` output port. Downstream cinematic nodes consume the bundle.

Identity-correctness contract — copied VERBATIM from the stored Character:
  - referenceViews are emitted in stored order (never sorted/reordered).
  - frozenTraitString is emitted byte-identical (never normalized/paraphrased).
    Paraphrasing the trait string breaks downstream identity (Seedance finding,
    documented on the Character type).

No network, no generation — this node is deterministic given a stored asset.

The three editor params (override_prompt, override_refs, strength_override)
are per-shot direction consumed by downstream nodes (e.g. cinema-scene), not by
this node. This node only resolves and re-emits the stored identity bundle.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.character_store import CharacterStore


async def handle_character_node(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Load the stored Character by id and emit it as a CharacterBundle.

    Raises ValueError with a clear message when characterId is absent or points
    at a Character that does not exist in the store.
    """
    params = node.params or {}
    character_id = params.get("characterId")

    character = CharacterStore().get(character_id) if character_id else None
    if character is None:
        raise ValueError(f"Character not found: {character_id}")

    # Build the lightweight bundle. referenceViews + frozenTraitString are
    # passed through verbatim — no copy-with-sort, no string normalization.
    bundle: dict[str, Any] = {
        "characterId": character["id"],
        "name": character["name"],
        "referenceViews": character["referenceViews"],
        "frozenTraitString": character["frozenTraitString"],
        "seed": character["seed"],
        "consistencyStrength": character["consistencyStrength"],
    }

    return {"character": {"type": "Character", "value": bundle}}
