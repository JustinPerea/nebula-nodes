"""Unit tests for backend/cinema/identity.py::expand_character.

`expand_character` is the pure (no-I/O) core of Character consumption: given a
CharacterBundle dict, a base prompt, per-use override refs, and the chosen base
model's reference-image cap, it returns the expanded `{prompt, image_urls, seed}`
that a consumer (e.g. cinema-scene) feeds into its base generation call.

Identity-correctness contract under test:
  - frozenTraitString is prepended VERBATIM (never paraphrased/normalized).
  - referenceViews come FIRST, in stored order; then the per-use overrides
    (no reordering, no order-changing dedup).
  - the stored seed is surfaced so consumers can force determinism.
  - the anti-FLORA capability guardrail: if the FINAL ref count exceeds the
    base model's cap, raise a clear ValueError (never silently truncate or
    single-ref-fail).
  - a falsy/None/empty bundle is a no-op: base generation proceeds exactly as
    before (no trait prefix, no forced seed).
"""

from __future__ import annotations

import pytest

from cinema.identity import DEFAULT_MAX_REFS, MODEL_MAX_REFS, expand_character, max_refs_for


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
]


def _bundle(views: list[str] | None = None, seed: int = 84) -> dict:
    return {
        "characterId": "char_1",
        "name": "Iris Vane",
        "referenceViews": list(views if views is not None else _VIEWS),
        "frozenTraitString": _TRAIT,
        "seed": seed,
        "consistencyStrength": 0.65,
    }


# ---------- active bundle ----------


def test_active_bundle_prepends_trait_verbatim_and_orders_refs() -> None:
    bundle = _bundle()
    out = expand_character(
        bundle,
        base_prompt="a forest at dawn",
        override_refs=["o1.png"],
        model_max_refs=14,
    )

    assert out["prompt"] == f"{bundle['frozenTraitString']}. a forest at dawn"
    # referenceViews FIRST (stored order), then per-use overrides.
    assert out["image_urls"] == bundle["referenceViews"] + ["o1.png"]
    assert out["seed"] == bundle["seed"]


def test_capability_guardrail_raises_when_refs_exceed_cap() -> None:
    # 3-view bundle + 1 override = 4 final refs; model cap = 1 -> must raise.
    bundle = _bundle()
    with pytest.raises(ValueError) as exc:
        expand_character(
            bundle,
            base_prompt="a forest at dawn",
            override_refs=["o1.png"],
            model_max_refs=1,
        )
    msg = str(exc.value)
    # Message names both the cap and the required count (anti-FLORA clarity).
    assert "1" in msg
    assert "4" in msg


# ---------- no-op (no bundle) ----------


@pytest.mark.parametrize("empty", [None, {}, False])
def test_no_bundle_is_a_noop(empty) -> None:
    out = expand_character(
        empty,
        base_prompt="a forest at dawn",
        override_refs=["o1.png"],
        model_max_refs=14,
    )
    assert out["prompt"] == "a forest at dawn"  # unchanged, no trait prefix
    assert out["image_urls"] == ["o1.png"]  # just the overrides
    assert out["seed"] is None  # no forced seed


def test_no_bundle_with_no_overrides_returns_empty_list() -> None:
    out = expand_character(None, base_prompt="x", override_refs=None, model_max_refs=14)
    assert out == {"prompt": "x", "image_urls": [], "seed": None}


# ---------- maxRefs table + lookup ----------


def test_max_refs_table_known_models() -> None:
    assert MODEL_MAX_REFS["seedream-4-5"] == 10
    assert max_refs_for("seedream-4-5") == 10


def test_max_refs_nano_banana_is_14() -> None:
    # The `nano-banana` node's model enum DEFAULTS to Nano Banana 2
    # (gemini-3.1-flash-image-preview, 14 refs) — the design spec §5 Character
    # default. The reachable base id is `nano-banana`, NOT `nano-banana-2`, so
    # the cap must be keyed on `nano-banana`. (Regression guard: the original
    # table keyed 14 on the unreachable `nano-banana-2` def id, so a real
    # nano-banana base fell through to the conservative default and rejected a
    # bundle the model can actually handle.)
    assert max_refs_for("nano-banana") == 14
    assert MODEL_MAX_REFS["nano-banana"] == 14


def test_max_refs_flux_kontext_is_conservative_default() -> None:
    # kontext-multi's ref cap is unpublished by fal -> conservative default.
    assert max_refs_for("flux-kontext") == DEFAULT_MAX_REFS


def test_max_refs_unknown_model_defaults_conservative() -> None:
    assert max_refs_for("totally-unknown-model") == DEFAULT_MAX_REFS
    assert DEFAULT_MAX_REFS == 1
    # nano-banana-pro's exact ref cap is unconfirmed in repo/research, so it is
    # deliberately NOT mapped and falls through to the conservative default.
    assert max_refs_for("nano-banana-pro") == DEFAULT_MAX_REFS


def test_max_refs_normalizes_stray_whitespace() -> None:
    # A stray-whitespace id must not silently fall to the conservative default.
    assert max_refs_for("  nano-banana  ") == 14
    assert max_refs_for("seedream-4-5\n") == 10
