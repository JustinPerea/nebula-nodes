"""Handler tests for backend/handlers/character_node.py.

The `character` node is a pure utility/glue node: it loads a stored Character
from the project-scoped CharacterStore by id and re-emits it as a
CharacterBundle on the `character` output port.

Identity-correctness contract (the whole point of this node):
  - referenceViews are returned in the SAME ORDER they were stored (no sort).
  - frozenTraitString is returned BYTE-IDENTICAL (no normalization/paraphrase —
    paraphrasing the trait string breaks downstream identity per the Seedance
    finding documented on the Character type).

A missing / unknown id raises a clear ValueError("Character not found: ...").
"""

from __future__ import annotations

import pytest

from handlers.character_node import handle_character_node
from models.graph import GraphNode
from services.character_store import CharacterStore


# A distinctive, punctuation-heavy trait string so any normalization
# (whitespace collapse, casing, reordering) would show up as a mismatch.
_TRAIT = (
    "freckled olive skin, deep-set hazel eyes, asymmetric undercut (left side), "
    "a faint scar above the RIGHT brow; 1.78m; wears a worn leather aviator jacket"
)

_VIEWS = [
    "/api/outputs/char/front.png",
    "/api/outputs/char/three-quarter.png",
    "/api/outputs/char/profile.png",
    "/api/outputs/char/back.png",
]


def _seed_character(monkeypatch, tmp_path) -> dict:
    """Sandbox the store under tmp_path and create one Character; return it."""
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
    return CharacterStore().create(
        name="Iris Vane",
        subjectType="human",
        referenceViews=_VIEWS,
        frozenTraitString=_TRAIT,
        seed=84,
        consistencyStrength=0.65,
        projectId="proj_demo",
    )


def _character_node(character_id: str | None) -> GraphNode:
    params = {"characterId": character_id} if character_id is not None else {}
    return GraphNode(id="char1", definitionId="character", params=params)


@pytest.mark.asyncio
async def test_emits_bundle_verbatim(monkeypatch, tmp_path) -> None:
    stored = _seed_character(monkeypatch, tmp_path)

    result = await handle_character_node(
        _character_node(stored["id"]), inputs={}, api_keys={}, emit=None
    )

    assert set(result.keys()) == {"character"}
    port = result["character"]
    assert port["type"] == "Character"

    bundle = port["value"]
    assert bundle["characterId"] == stored["id"]
    assert bundle["name"] == stored["name"]
    assert bundle["seed"] == stored["seed"]
    assert bundle["consistencyStrength"] == stored["consistencyStrength"]

    # Identity contract: byte-identical trait string, same-order reference views.
    assert bundle["frozenTraitString"] == _TRAIT
    assert bundle["referenceViews"] == _VIEWS
    # Same object content, same order — not merely set-equal.
    assert bundle["referenceViews"] == stored["referenceViews"]


@pytest.mark.asyncio
async def test_missing_id_raises(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="Character not found"):
        await handle_character_node(
            _character_node(None), inputs={}, api_keys={}, emit=None
        )


@pytest.mark.asyncio
async def test_unknown_id_raises(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="Character not found: doesnotexist"):
        await handle_character_node(
            _character_node("doesnotexist"), inputs={}, api_keys={}, emit=None
        )
