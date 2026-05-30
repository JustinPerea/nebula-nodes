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


def _character_node(character_id: str | None, **overrides) -> GraphNode:
    params = {"characterId": character_id} if character_id is not None else {}
    params.update(overrides)
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
async def test_empty_override_params_omit_fields(monkeypatch, tmp_path) -> None:
    """The per-use override layer is absent from the bundle when the node's
    override params are unset/empty (default '' for each) — the bundle stays
    byte-identical to the pre-override shape."""
    stored = _seed_character(monkeypatch, tmp_path)

    # Default-valued node: override_prompt='', override_refs='', strength_override=''
    result = await handle_character_node(
        _character_node(
            stored["id"], override_prompt="", override_refs="", strength_override=""
        ),
        inputs={},
        api_keys={},
        emit=None,
    )
    bundle = result["character"]["value"]
    assert "overridePrompt" not in bundle
    assert "overrideRefs" not in bundle
    assert "strengthOverride" not in bundle


@pytest.mark.asyncio
async def test_override_params_ride_in_bundle(monkeypatch, tmp_path) -> None:
    """Set override params -> the emitted bundle carries overridePrompt,
    overrideRefs (the single file ref wrapped as a one-element list), and
    strengthOverride (parsed to a float)."""
    stored = _seed_character(monkeypatch, tmp_path)

    result = await handle_character_node(
        _character_node(
            stored["id"],
            override_prompt="three-quarter view, soft rim light, neutral expression",
            override_refs="/api/uploads/pose-ref.png",
            strength_override="0.8",
        ),
        inputs={},
        api_keys={},
        emit=None,
    )
    bundle = result["character"]["value"]

    assert bundle["overridePrompt"] == (
        "three-quarter view, soft rim light, neutral expression"
    )
    # A `file` param (single path/URL) is wrapped as a one-element list.
    assert bundle["overrideRefs"] == ["/api/uploads/pose-ref.png"]
    # Parsed to a float in 0..1.
    assert bundle["strengthOverride"] == 0.8
    # The identity fields are still verbatim alongside the override layer.
    assert bundle["frozenTraitString"] == _TRAIT
    assert bundle["referenceViews"] == _VIEWS
    assert bundle["consistencyStrength"] == stored["consistencyStrength"]


@pytest.mark.asyncio
async def test_strength_override_clamps_and_ignores_garbage(monkeypatch, tmp_path) -> None:
    """strength_override out of range clamps to 0..1; unparseable -> inherit
    (field omitted), never a crash."""
    stored = _seed_character(monkeypatch, tmp_path)

    over = await handle_character_node(
        _character_node(stored["id"], strength_override="1.5"),
        inputs={}, api_keys={}, emit=None,
    )
    assert over["character"]["value"]["strengthOverride"] == 1.0

    garbage = await handle_character_node(
        _character_node(stored["id"], strength_override="not-a-number"),
        inputs={}, api_keys={}, emit=None,
    )
    assert "strengthOverride" not in garbage["character"]["value"]


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
