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

from cinema.identity import (
    DEFAULT_MAX_REFS,
    MODEL_MAX_REFS,
    MODEL_STRENGTH_PARAM,
    expand_character,
    max_refs_for,
    strength_param_for,
)


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


def _bundle(views: list[str] | None = None, seed: int = 84, **overrides) -> dict:
    bundle = {
        "characterId": "char_1",
        "name": "Iris Vane",
        "referenceViews": list(views if views is not None else _VIEWS),
        "frozenTraitString": _TRAIT,
        "seed": seed,
        "consistencyStrength": 0.65,
    }
    # Optional per-use override layer (overridePrompt / overrideRefs /
    # strengthOverride) — only present when the test sets it.
    bundle.update(overrides)
    return bundle


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
    # No strengthOverride -> effective strength falls back to consistencyStrength.
    assert out["strength"] == bundle["consistencyStrength"]


# ---------- per-use override layer ----------


def test_override_prompt_folded_in_documented_order() -> None:
    """overridePrompt trails the base prompt: "{trait}. {base}. {override}"."""
    bundle = _bundle(overridePrompt="low-angle, dramatic rim light")
    out = expand_character(
        bundle,
        base_prompt="a forest at dawn",
        override_refs=None,
        model_max_refs=14,
    )
    assert out["prompt"] == (
        f"{_TRAIT}. a forest at dawn. low-angle, dramatic rim light"
    )


def test_empty_override_prompt_does_not_alter_prompt() -> None:
    bundle = _bundle(overridePrompt="")
    out = expand_character(
        bundle, base_prompt="a forest at dawn", override_refs=None, model_max_refs=14
    )
    assert out["prompt"] == f"{_TRAIT}. a forest at dawn"


def test_override_refs_appear_after_reference_views() -> None:
    """The bundle's node-level overrideRefs slot in AFTER referenceViews and
    BEFORE the consumer's override_refs parameter (scene/shot refs)."""
    bundle = _bundle(overrideRefs=["node-ref.png"])
    out = expand_character(
        bundle,
        base_prompt="x",
        override_refs=["scene-ref.png"],
        model_max_refs=14,
    )
    assert out["image_urls"] == _VIEWS + ["node-ref.png", "scene-ref.png"]


def test_strength_override_wins_over_consistency_strength() -> None:
    bundle = _bundle(strengthOverride=0.9)  # consistencyStrength is 0.65
    out = expand_character(
        bundle, base_prompt="x", override_refs=None, model_max_refs=14
    )
    assert out["strength"] == 0.9


def test_strength_override_none_falls_back_to_consistency_strength() -> None:
    bundle = _bundle(strengthOverride=None)
    out = expand_character(
        bundle, base_prompt="x", override_refs=None, model_max_refs=14
    )
    assert out["strength"] == bundle["consistencyStrength"]


def test_capability_guardrail_counts_override_refs_in_total() -> None:
    """The anti-FLORA guard counts the FINAL total INCLUDING the bundle's
    overrideRefs (not just referenceViews + the parameter)."""
    # 3 views + 1 node overrideRef + 1 scene ref = 5 final refs; cap 4 -> raise.
    bundle = _bundle(overrideRefs=["node-ref.png"])
    with pytest.raises(ValueError) as exc:
        expand_character(
            bundle,
            base_prompt="x",
            override_refs=["scene-ref.png"],
            model_max_refs=4,
        )
    msg = str(exc.value)
    assert "4" in msg  # the cap
    assert "5" in msg  # the required total (incl. overrideRefs)


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
    assert out["strength"] is None  # no strength on the no-character path


def test_no_bundle_with_no_overrides_returns_empty_list() -> None:
    out = expand_character(None, base_prompt="x", override_refs=None, model_max_refs=14)
    assert out == {"prompt": "x", "image_urls": [], "seed": None, "strength": None}


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


def test_max_refs_nano_banana_pro_is_14() -> None:
    # Confirmed 14 reference images per Google AI docs (verified 2026-06-03).
    # Keyed as "nano-banana-pro" to match cinema_scene's _guard_base_model output.
    assert max_refs_for("nano-banana-pro") == 14
    assert MODEL_MAX_REFS["nano-banana-pro"] == 14


def test_max_refs_normalizes_stray_whitespace() -> None:
    # A stray-whitespace id must not silently fall to the conservative default.
    assert max_refs_for("  nano-banana  ") == 14
    assert max_refs_for("seedream-4-5\n") == 10


# ---------- strength-param support map (the honest finding) ----------


def test_no_v1_base_exposes_a_strength_param() -> None:
    """HONEST FINDING: every reachable v1 reference-edit base lacks an
    IP-adherence knob, so the support map is empty and strength_param_for
    returns None for all of them. The consumer must therefore NOT inject a
    strength param for these models (silent-no-op anti-pattern)."""
    assert MODEL_STRENGTH_PARAM == {}
    assert strength_param_for("nano-banana") is None
    assert strength_param_for("seedream-4-5") is None
    assert strength_param_for("flux-kontext") is None
    assert strength_param_for("nano-banana-pro") is None
    assert strength_param_for("  nano-banana  ") is None  # normalized, still None
