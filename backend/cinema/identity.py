"""Character identity expansion — the pure (no-I/O) core of Character consumption.

A *consumer* (today: ``cinema-scene``; later: the standalone edit nodes) takes a
:class:`CharacterBundle` and folds it into its base-generation call:

  - the bundle's ``frozenTraitString`` is prepended to the prompt VERBATIM,
  - the bundle's ``referenceViews`` are placed FIRST in the reference-image list
    (stored order), with the per-use override refs appended after,
  - the bundle's ``seed`` is surfaced so the consumer can force determinism.

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
# WHY ``nano-banana-pro`` IS *NOT* MAPPED: although Nano Banana Pro
# (``gemini-3-pro-image-preview``) is a selectable sub-model of the same node and
# is widely believed to support many references, the research synthesis only
# *firmly publishes* a multi-ref cap for Nano Banana 2 (14) and Seedream (10) —
# Pro's exact ref cap is NOT confirmed in the repo/research. Mapping it to a high
# guess would be the opposite guardrail failure (letting too many refs silently
# reach a model that may single-ref-fail). It is left to DEFAULT_MAX_REFS (1) so
# a multi-view bundle on Pro surfaces the clear capability error rather than
# silently failing. (Note: cinema_scene's _guard_base_model can technically
# yield "nano-banana-pro" as a base id, so this default is reachable, not dead.)
# When Pro's cap is confirmed from a primary source, add it here.
# TODO: confirm nano-banana-pro (gemini-3-pro-image-preview) ref cap, then map it.
#
# ``flux-kontext`` likewise has no confirmed multi-ref cap (kontext-multi is
# unpublished by fal) -> falls through to DEFAULT_MAX_REFS (1). Conservative is
# correct here.
MODEL_MAX_REFS: dict[str, int] = {
    "seedream-4-5": 10,
    "nano-banana": 14,
}

DEFAULT_MAX_REFS = 1


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
    ``{"prompt": str, "image_urls": list[str], "seed": int | None}``

    Behaviour
    ---------
    * **No-op** (``bundle`` falsy): returns the base prompt unchanged, the
      override refs as-is, and ``seed = None`` — base generation proceeds exactly
      as it did before Character existed. No trait prefix, no forced seed.
    * **Active** (``bundle`` present):
        - ``prompt = f"{frozenTraitString}. {base_prompt}"`` (trait VERBATIM),
        - ``image_urls = referenceViews + override_refs`` (views first, order
          preserved, no reordering / order-changing dedup),
        - ``seed = bundle["seed"]``.
      Raises :class:`ValueError` if ``len(image_urls) > model_max_refs`` — the
      anti-FLORA guardrail (never silently truncate or single-ref-fail).
    """
    overrides = list(override_refs or [])

    # No-op: base generation proceeds exactly as before.
    if not bundle:
        return {"prompt": base_prompt, "image_urls": overrides, "seed": None}

    trait = bundle["frozenTraitString"]
    # Verbatim prefix — exactly this f-string, never paraphrased/normalized.
    prompt = f"{trait}. {base_prompt}"

    # referenceViews FIRST (stored order), then the per-use overrides.
    image_urls = list(bundle["referenceViews"]) + overrides

    # Anti-FLORA capability guardrail — check the FINAL ref count.
    if len(image_urls) > model_max_refs:
        raise ValueError(
            f"Base model accepts at most {model_max_refs} reference image(s) "
            f"but the Character bundle requires {len(image_urls)} — pick a model "
            f"with a higher reference cap (e.g. nano-banana or seedream-4-5) or "
            f"reduce the views."
        )

    return {"prompt": prompt, "image_urls": image_urls, "seed": bundle["seed"]}
