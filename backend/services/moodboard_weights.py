"""A board's weights in the form each node needs (Q21 b, plan section 5.7.4).

Justin, 2026-10-20: "They should normalize for however any nodes need the
information." One pure helper, so no adapter does its own maths:

- ``sum-to-strength``: native per-image strengths that share out the board's
  strength ``S`` (Krea 2's ``image_style_references[].strength`` from PR13a,
  every Krea ``style_images[].strength`` from PR15). ``s_i = S * w_i / sum(w)``
  over the images actually sent, so it is worked out after every cut.
- ``sum-to-one``: shares, for a weight list made once (Recraft's
  ``image_weights``, PR24).
- ``none``: the raw ``S * w_i``, the pre-Q21 behaviour, for test fixtures only.
- ``rank`` carries no numbers (order and legend words only), so it has no
  strengths to give; ``weight_view`` gives its ``rel``.

Rounding is to ``precision`` (4 decimals) by largest remainder, so the
strengths add up to exactly ``S`` (as decimals) and a cache key is stable. A
strength that rounds to 0 stays 0 here; the caller leaves that image out and
says so, since Krea reads 0 as "no style influence". The clamp to ``range``
is a guard only: with ``0 <= S <= 1`` and weights of 0 or more it never
triggers, and ``clamped`` tells the caller when it did. No negatives: a card
size can't be negative, and Krea 2's enforced schema has a minimum of 0.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

NORMALIZE_FORMS = ("sum-to-strength", "sum-to-one", "rank", "none")
DEFAULT_PRECISION = 0.0001


@dataclass(frozen=True)
class NativeStrengths:
    """One strength per weight, in the weights' order."""

    strengths: list[float]
    clamped: bool = False


def weight_view(weights: Sequence[float]) -> list[dict[str, float]]:
    """The normalized view of the images sent: ``w`` (the raw weight),
    ``share`` (``w / sum(w)``) and ``rel`` (``w / max(w)``). Legend words read
    ``rel``; ``sum-to-one`` reads ``share`` (section 5.7.3 step 4)."""
    values = [float(w) for w in weights]
    if any(w < 0 for w in values):
        raise ValueError("Board weights can't be negative")
    total = sum(values)
    top = max(values, default=0.0)
    return [{"w": w, "share": w / total if total > 0 else 0.0, "rel": w / top if top > 0 else 0.0}
            for w in values]


def _round_to_total(total_units: int, weights: list[float]) -> list[int]:
    """Largest remainder: ``total_units`` split by ``weights``, each a whole
    number of units, adding up to exactly ``total_units``. Ties go to the
    earlier weight (callers pass images heaviest first)."""
    whole = sum(weights)
    if total_units <= 0 or whole <= 0:
        return [0] * len(weights)
    exact = [total_units * w / whole for w in weights]
    units = [math.floor(x) for x in exact]
    left = total_units - sum(units)
    order = sorted(range(len(weights)), key=lambda i: (-(exact[i] - units[i]), i))
    for i in order[:left]:
        units[i] += 1
    return units


def native_strengths(
    S: float,
    weights: Sequence[float],
    *,
    normalize: str,
    range: tuple[float, float] = (0.0, 1.0),  # noqa: A002 - the entry's field name (section 5.7.2)
    precision: float = DEFAULT_PRECISION,
) -> NativeStrengths:
    """The strengths to send for ``weights`` (the images sent, after every
    cut, heaviest first) at board strength ``S``."""
    if normalize not in NORMALIZE_FORMS:
        raise ValueError(f"Unknown weight normalize form {normalize!r}; expected one of {', '.join(NORMALIZE_FORMS)}")
    if normalize == "rank":
        raise ValueError("A 'rank' entry sends no strengths: read 'rel' from weight_view for its order and words")
    values = [float(w) for w in weights]
    if S < 0 or any(w < 0 for w in values):
        raise ValueError("Board strength and weights can't be negative")
    if precision <= 0:
        raise ValueError("precision must be above 0")
    decimals = max(0, round(-math.log10(precision)))

    if normalize == "none":
        raw = [S * w for w in values]
    else:
        target = 1.0 if normalize == "sum-to-one" else S
        units = _round_to_total(round(target / precision), values)
        raw = [u * precision for u in units]
    low, high = range
    strengths = [round(min(high, max(low, s)), decimals) for s in raw]
    clamped = any(abs(s - round(r, decimals)) > precision / 2 for s, r in zip(strengths, raw))
    return NativeStrengths(strengths=strengths, clamped=clamped)
