"""The one helper that turns a board's weights into the form a node needs
(services/moodboard_weights.py; plan sections 5.7.2 and 5.7.4, Q21 b)."""
from __future__ import annotations

from decimal import Decimal

import pytest

from services.moodboard_weights import native_strengths, weight_view


def _exact(values: list[float]) -> Decimal:
    return sum((Decimal(str(v)) for v in values), Decimal(0))


@pytest.mark.parametrize("count", [1, 2, 3, 5, 7, 10])
def test_sum_to_strength_adds_up_exactly_at_four_decimals(count) -> None:
    weights = [1.0 / (i + 1) for i in range(count)]
    for strength in (0.7, 0.33, 1.0, 0.0001):
        result = native_strengths(strength, weights, normalize="sum-to-strength")
        assert _exact(result.strengths) == Decimal(str(strength))
        assert all(Decimal(str(s)) == Decimal(str(s)).quantize(Decimal("0.0001")) for s in result.strengths)
        assert result.clamped is False


def test_largest_remainder_breaks_ties_heaviest_first() -> None:
    # 1/3 each of 0.7: 2333.33 units, one unit left over, to the first.
    assert native_strengths(0.7, [1, 1, 1], normalize="sum-to-strength").strengths == [0.2334, 0.2333, 0.2333]


def test_strength_zero_and_all_zero_weights_send_nothing() -> None:
    assert native_strengths(0.0, [1.0, 0.5], normalize="sum-to-strength").strengths == [0.0, 0.0]
    assert native_strengths(0.7, [0.0, 0.0], normalize="sum-to-strength").strengths == [0.0, 0.0]
    assert native_strengths(0.7, [], normalize="sum-to-strength").strengths == []


def test_no_negatives() -> None:
    with pytest.raises(ValueError, match="negative"):
        native_strengths(0.7, [1.0, -0.5], normalize="sum-to-strength")
    with pytest.raises(ValueError, match="negative"):
        native_strengths(-0.1, [1.0], normalize="sum-to-strength")


def test_other_forms() -> None:
    # sum-to-one: shares, rounded the same way (Recraft's image_weights, PR24).
    assert native_strengths(0.7, [1.0, 0.5, 0.5], normalize="sum-to-one").strengths == [0.5, 0.25, 0.25]
    # none: the pre-Q21 raw strength x weight, for test fixtures.
    assert native_strengths(0.7, [1.0, 0.5], normalize="none").strengths == [0.7, 0.35]
    with pytest.raises(ValueError, match="rank"):
        native_strengths(0.7, [1.0], normalize="rank")
    with pytest.raises(ValueError, match="Unknown"):
        native_strengths(0.7, [1.0], normalize="sum")


def test_clamp_is_a_guard_that_says_so() -> None:
    result = native_strengths(1.0, [1.0], normalize="sum-to-strength", range=(0.0, 0.5))
    assert result.strengths == [0.5]
    assert result.clamped is True


def test_weight_view_after_the_cut() -> None:
    view = weight_view([1.0, 0.5, 0.25])
    assert [v["w"] for v in view] == [1.0, 0.5, 0.25]
    assert [v["share"] for v in view] == pytest.approx([1 / 1.75, 0.5 / 1.75, 0.25 / 1.75])
    assert [v["rel"] for v in view] == [1.0, 0.5, 0.25]
    assert weight_view([0.0, 0.0]) == [{"w": 0.0, "share": 0.0, "rel": 0.0}] * 2
