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

Rounding is spelled out (half up on the binary value) instead of left to
each language's formatter, so Python and JavaScript agree on every amount.
"""
from __future__ import annotations

import math
from typing import Any

UNDER_A_CENT = "<$0.01"


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
    cents = _half_up(value * 100)
    if cents == 0:
        return UNDER_A_CENT if value > 0 else "$0.00"
    return _cents_text(cents)


def _two_figures(value: float) -> tuple[float, int]:
    """``value`` (0 < value < 0.1) to two significant figures, and how many
    decimals that takes."""
    exponent = math.floor(math.log10(value))
    decimals = 1 - exponent
    scale = 10 ** decimals
    rounded = _half_up(value * scale) / scale
    if rounded >= 10 ** (exponent + 1):
        # 0.0995 -> 0.10: one figure fewer after the point.
        decimals -= 1
    return rounded, decimals


def usd_amount(amount: Any) -> str:
    """A price, limit or cost: "$0" for nothing, two significant figures
    under $0.10, cents under $10, whole dollars from $10."""
    value = _clamped(amount)
    if value == 0:
        return "$0"
    if value < 0.1:
        rounded, decimals = _two_figures(value)
        if rounded < 0.1:
            text = f"{rounded:.{decimals}f}".rstrip("0")
            return f"${text}"
    cents = _half_up(value * 100)
    if cents < 1000:
        return _cents_text(cents)
    return f"${_half_up(value):,}"
