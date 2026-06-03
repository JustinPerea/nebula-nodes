"""Character identity expansion — the pure (no-I/O) core of Character consumption.

A *consumer* (today: ``cinema-scene``; later: the standalone edit nodes) takes a
:class:`CharacterBundle` and folds it into its base-generation call:

  - the bundle's ``frozenTraitString`` is prepended to the prompt VERBATIM,
  - the bundle's ``overridePrompt`` (per-use direction) is appended AFTER the
    base prompt when set (see PROMPT ORDER below),
  - the bundle's ``referenceViews`` are placed FIRST in the reference-image list
    (stored order), then the node-level per-use ``overrideRefs``, then the
    scene/shot ``override_refs`` parameter — all order-preserving,
  - the bundle's ``seed`` is surfaced so the consumer can force determinism,
  - an effective ``strength`` (``strengthOverride`` if set, else
    ``consistencyStrength``) is surfaced so the consumer can pass it to a base
    model that exposes an IP-adherence knob (see :data:`MODEL_STRENGTH_PARAM`).

PROMPT ORDER (documented choice — see implementation notes):
  - override set:   ``"{trait}. {base_prompt}. {overridePrompt}"``
  - override unset: ``"{trait}. {base_prompt}"``
  The trait string always leads (identity anchor); the per-use override trails
  the base prompt as additional directive, so it refines rather than displaces
  the scene/shot intent.

Two correctness invariants the rest of the feature depends on:

1. **Verbatim trait string.** The trait string is prepended exactly as stored —
   never paraphrased, re-cased, or whitespace-normalized. Paraphrasing the
   trait string breaks downstream identity (the Seedance finding, documented on
   the Character type and the character node).
2. **Anti-FLORA capability guardrail.** If the final reference-image count
   exceeds the base model's published cap, we raise a clear ``ValueError``
   rather than silently truncating the refs or falling back to a single ref
   (the FLORA silent-failure mode). A consumer cannot quietly drop a view that
   the user explicitly wired in.

This module is intentionally pure: no network, no disk, no global state — so it
can be unit-tested in isolation and reused by any consumer.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence


# Per-base-model reference-image caps. Conservative default of 1 is the
# guardrail: an unknown/unpublished cap must surface a clear error rather than
# silently single-ref-fail (the FLORA failure mode).
#
# RECONCILIATION (key choice): the implementation plan / design spec talk about
# the *edit-node* ids ``nano-banana-2/edit`` = 14 and ``seedream-4-5/edit`` = 10,
# but the actual consumer wired up — ``cinema_scene`` — resolves its base model
# to the REGISTRY NODE-DEFINITION ids it dispatches through the handler registry,
# NOT the sub-model names. The reachable image base ids are exactly:
# ``seedream-4-5``, ``nano-banana``, ``nano-banana-pro``, ``flux-kontext``
# (see ``cinema_scene._guard_base_model`` / ``_COMMERCIAL_OK_DEFAULT_BASES`` and
# ``_DEFAULT_BASE_MODEL = "seedream-4-5"``). There is NO ``nano-banana-2`` def id
# — "Nano Banana 2" (``gemini-3.1-flash-image-preview``) is the *default
# sub-model enum value* of the single ``nano-banana`` node (see
# ``frontend/src/constants/nodeDefinitions.ts`` -> ``nano-banana`` ->
# ``params.model.default = 'gemini-3.1-flash-image-preview'``). So this table is
# keyed on those real, reachable base ids:
#   - ``seedream-4-5`` -> 10  (Seedream v4 / v4.5 published hard cap, last-10 rule)
#   - ``nano-banana``  -> 14  (its model enum DEFAULTS to Nano Banana 2 =
#                              ``gemini-3.1-flash-image-preview``, the 14-ref
#                              model the design spec §5 names as the Character
#                              default; research synthesis firmly publishes 14)
#
# ``nano-banana-pro`` (``gemini-3-pro-image-preview``): confirmed 14 reference
# images per Google AI docs (verified 2026-06-03). Mapped here so a multi-view
# Character bundle on the Pro sub-model passes the guardrail rather than hitting
# the conservative DEFAULT_MAX_REFS (1) and raising a spurious capability error.
#
# ``flux-kontext`` likewise has no confirmed multi-ref cap (kontext-multi is
# unpublished by fal) -> falls through to DEFAULT_MAX_REFS (1). Conservative is
# correct here.
MODEL_MAX_REFS: dict[str, int] = {
    "seedream-4-5": 10,
    "nano-banana": 14,
    "nano-banana-pro": 14,
}

DEFAULT_MAX_REFS = 1


# Per-base-model IP-adherence / consistency-strength PARAM NAME.
#
# HONEST FINDING (v1, reference-edit bases): none of the reachable v1 base
# models expose a usable IP-adherence / reference-strength knob.
#   - ``nano-banana`` (gemini-3.1-flash-image-preview, "Nano Banana 2") drives
#     identity purely by re-feeding reference images; the Gemini generateContent
#     imageConfig accepts only ``aspectRatio`` + ``imageSize`` — NO strength /
#     guidance / adherence field (verified in handlers/google_gemini.py
#     handle_nano_banana).
#   - ``seedream-4-5`` (fal-ai/bytedance/seedream/v4.5/text-to-image) likewise
#     publishes no reference-strength param — its node def exposes only
#     image_size / num_images / max_images / enable_safety_checker / seed
#     (frontend/src/constants/nodeDefinitions.ts), and reference-edit keeps
#     identity by re-feeding refs, not by a strength dial.
#   - ``flux-kontext`` is reference-edit (kontext) with no published adherence
#     knob either.
#
# So this map is EMPTY for v1: ``consistencyStrength`` / ``strength_override``
# are carried in the bundle and surfaced by ``expand_character`` as
# ``strength``, but the consumer only injects them when a base model has a real
# param here. Fabricating one for a model that ignores it would be a silent
# no-op (the anti-pattern this feature explicitly avoids). The dial becomes
# active in v2 (trained-LoRA), where a LoRA scale IS a real adherence knob.
# When a base gains a confirmed adherence param, add it here (e.g. a future
# {"some-base": "image_prompt_strength"}) and it flows automatically.
MODEL_STRENGTH_PARAM: dict[str, str] = {}


def strength_param_for(base_model: str) -> str | None:
    """Return the IP-adherence param NAME for ``base_model``, or None.

    None (the v1 default for every reachable base) means the model has no
    usable strength knob — the consumer must NOT inject one (silent-no-op
    anti-pattern). See :data:`MODEL_STRENGTH_PARAM`.
    """
    return MODEL_STRENGTH_PARAM.get(str(base_model or "").strip().lower())


def max_refs_for(base_model: str) -> int:
    """Return the reference-image cap for ``base_model``.

    Unknown / unpublished models get the conservative ``DEFAULT_MAX_REFS`` (1)
    so that a multi-ref Character bundle raises a clear error rather than being
    silently truncated to a single ref.
    """
    # Normalize the key (strip whitespace; table keys are lowercase) so a
    # stray-whitespace id can't silently fall to the conservative default.
    return MODEL_MAX_REFS.get(str(base_model or "").strip().lower(), DEFAULT_MAX_REFS)


def expand_character(
    bundle: Mapping[str, Any] | None,
    base_prompt: str,
    override_refs: Sequence[str] | None,
    model_max_refs: int,
) -> dict[str, Any]:
    """Fold a CharacterBundle into a base-generation call.

    Parameters
    ----------
    bundle:
        A CharacterBundle dict (``{characterId, name, referenceViews,
        frozenTraitString, seed, consistencyStrength}``) or a falsy value
        (None / empty) for the no-Character case.
    base_prompt:
        The consumer's base prompt (e.g. scene prompt + shot prompt).
    override_refs:
        Per-use reference images to append AFTER the bundle's stored views.
        For ``cinema-scene`` these are the existing ``character_refs + shot_refs``.
    model_max_refs:
        The chosen base model's reference-image cap (see :func:`max_refs_for`).

    Returns
    -------
    ``{"prompt": str, "image_urls": list[str], "seed": int | None,
    "strength": float | None}``

    Behaviour
    ---------
    * **No-op** (``bundle`` falsy): returns the base prompt unchanged, the
      override refs as-is, ``seed = None`` and ``strength = None`` — base
      generation proceeds exactly as it did before Character existed. No trait
      prefix, no forced seed, no strength.
    * **Active** (``bundle`` present):
        - ``prompt``: trait VERBATIM, then the base prompt, then the bundle's
          per-use ``overridePrompt`` when set (see PROMPT ORDER in the module
          docstring): ``f"{trait}. {base_prompt}. {overridePrompt}"`` (or
          ``f"{trait}. {base_prompt}"`` when no override).
        - ``image_urls``: ``referenceViews`` (stored order) ++ the bundle's
          node-level ``overrideRefs`` ++ the ``override_refs`` parameter
          (scene/shot refs). Order preserved, no reordering / order-changing
          dedup.
        - ``seed = bundle["seed"]``.
        - ``strength``: ``strengthOverride`` if set (not None), else
          ``consistencyStrength``. The CONSUMER decides whether to inject it
          (only for a base model with a real adherence param — see
          :func:`strength_param_for`); a model without one carries it unused.
      Raises :class:`ValueError` if ``len(image_urls) > model_max_refs`` — the
      anti-FLORA guardrail (never silently truncate or single-ref-fail). The
      count includes ``overrideRefs`` and the ``override_refs`` parameter.
    """
    overrides = list(override_refs or [])

    # No-op: base generation proceeds exactly as before.
    if not bundle:
        return {
            "prompt": base_prompt,
            "image_urls": overrides,
            "seed": None,
            "strength": None,
        }

    trait = bundle["frozenTraitString"]
    # Verbatim prefix — exactly this f-string, never paraphrased/normalized.
    # The per-use overridePrompt (when set) trails the base prompt as additional
    # direction so it refines rather than displaces scene/shot intent.
    override_prompt = str(bundle.get("overridePrompt") or "").strip()
    if override_prompt:
        prompt = f"{trait}. {base_prompt}. {override_prompt}"
    else:
        prompt = f"{trait}. {base_prompt}"

    # referenceViews FIRST (stored order), then the node-level per-use
    # overrideRefs from the bundle, then the consumer's override_refs parameter
    # (scene/shot refs). All order-preserving; the guardrail counts the total.
    node_override_refs = [str(r) for r in (bundle.get("overrideRefs") or []) if r]
    image_urls = list(bundle["referenceViews"]) + node_override_refs + overrides

    # Anti-FLORA capability guardrail — check the FINAL ref count.
    if len(image_urls) > model_max_refs:
        raise ValueError(
            f"Base model accepts at most {model_max_refs} reference image(s) "
            f"but the Character bundle requires {len(image_urls)} — pick a model "
            f"with a higher reference cap (e.g. nano-banana or seedream-4-5) or "
            f"reduce the views."
        )

    # Effective strength: per-use override wins over the stored default.
    strength_override = bundle.get("strengthOverride")
    strength = (
        strength_override
        if strength_override is not None
        else bundle.get("consistencyStrength")
    )

    return {
        "prompt": prompt,
        "image_urls": image_urls,
        "seed": bundle["seed"],
        "strength": strength,
    }
