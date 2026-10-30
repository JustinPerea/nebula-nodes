"""Money as Nebula writes it, in one place (PR #198 review 2, L4).

Two forms, the same in the frontend (frontend/src/lib/pricing.ts
``formatSpentUsd`` and ``formatUsd``); both read the table in
contracts/fixtures/money/cases.json, so neither side can drift:

- ``usd_spent``: what was spent, to the cent, as Settings and ``nebula spend``
  show it ("$3.40", "$1,234.50"). "$0.00" only ever means nothing: a
  non-zero amount that rounds to no cents is "<$0.01" (GM, PR #198 r1).
- ``usd_amount``: a price, a limit or a cost in a line (spend refusals, and
  every chip's figures): two significant figures under $0.10 ("$0.0047"),
  cents under $10 ("$0.43", "$4.20"), whole dollars from $10 ("$12"). It is
  rounded first and the form is picked from the rounded value, so $0.0995
  is "$0.10" (never "$0.1") and $9.996 is "$10" (never "$10.00").

Negative and non-finite amounts are clamped to nothing. Neither form has a
use for them: what was spent and what a run costs are sums of prices, and
the only way to get below zero is float noise from a subtraction (a limit
minus what was used), where "nothing left" is the true reading. A refund
would need its own words, not a minus sign ("$-0.00").

An amount under a millionth of a dollar is "<$0.000001" (review 3, L5): two
significant figures of a float denormal would be 324 decimals, past what a
float can scale to, and no price Nebula shows is that small. An amount above
$10 trillion (``CEILING_USD``) is ">$10,000,000,000,000" (">$10,000,000,000,000.00"
spent; review 5, N4): past it the figures are float noise (cents stop being
exact near 9e13), and at 1.8e308 ``value * 100`` is infinite. No amount up to
the largest float raises. frontend/src/lib/pricing.ts has the same rule.

Rounding is spelled out (half up on the binary value) instead of left to
each language's formatter, so Python and JavaScript agree on every amount.
"""
from __future__ import annotations

import math
from typing import Any

UNDER_A_CENT = "<$0.01"
# The smallest amount usd_amount writes in figures.
TINY_USD = 0.000001
UNDER_TINY = "<$0.000001"
# The largest amount written in figures (review 5, N4); above it, the ceiling.
CEILING_USD = 1e13
OVER_CEILING = ">$10,000,000,000,000"
OVER_CEILING_SPENT = ">$10,000,000,000,000.00"


def _clamped(amount: Any) -> float:
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        return 0.0
    value = float(amount)
    return value if math.isfinite(value) and value > 0 else 0.0


def _half_up(value: float) -> int:
    return math.floor(value + 0.5)


def _cents_text(cents: int) -> str:
    return f"${cents // 100:,}.{cents % 100:02d}"


def usd_spent(amount: Any) -> str:
    """What was spent, to the cent: "$0.00" for nothing, "<$0.01" for a
    non-zero amount under half a cent."""
    value = _clamped(amount)
    if value > CEILING_USD:
        return OVER_CEILING_SPENT
    cents = _half_up(value * 100)
    if cents == 0:
        return UNDER_A_CENT if value > 0 else "$0.00"
    return _cents_text(cents)


def _two_figures(value: float) -> tuple[float, int]:
    """``value`` (0 < value < 0.1) to two significant figures, and how many
    decimals that takes.

    The same on every platform (review 5, M2): ``scale`` is an exact int,
    ``*`` and ``/`` are correctly rounded, and the carry check is integer
    arithmetic (it was ``rounded >= 10 ** (exponent + 1)``, a libm ``pow``).
    ``math.log10`` is the one libm call. A last-ulp error in it can only move
    ``exponent`` by one, for a value within an ulp of a power of ten P, and
    that is self-correcting: at or just above P the right exponent gives
    ``figures`` 10 and one too low gives 100 (which drops a decimal); just
    below P the right one gives 100 and one too high gives 10. Each pair is
    the same rounded value (P, correctly rounded) with the same decimals.
    test_pr198_fix5 shifts log10 by an ulp both ways over the fuzz table."""
    exponent = math.floor(math.log10(value))
    decimals = 1 - exponent
    scale = 10 ** decimals
    figures = _half_up(value * scale)
    rounded = figures / scale
    if figures >= 100:
        # 0.0995 -> 0.10: one figure fewer after the point.
        decimals -= 1
    return rounded, decimals


def usd_amount(amount: Any) -> str:
    """A price, limit or cost: "$0" for nothing, two significant figures
    under $0.10, cents under $10, whole dollars from $10."""
    value = _clamped(amount)
    if value == 0:
        return "$0"
    if value > CEILING_USD:
        return OVER_CEILING
    if value < TINY_USD:
        return UNDER_TINY
    if value < 0.1:
        rounded, decimals = _two_figures(value)
        if rounded < 0.1:
            text = f"{rounded:.{decimals}f}".rstrip("0")
            return f"${text}"
    cents = _half_up(value * 100)
    if cents < 1000:
        return _cents_text(cents)
    return f"${_half_up(value):,}"
