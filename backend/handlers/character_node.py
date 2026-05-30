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
