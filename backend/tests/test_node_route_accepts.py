"""directRoute.accepts: the values a maker takes for a param (services/node_route.py).

Mirrors frontend/src/lib/directRoute.ts valueAccepted; route_cases.json covers
the routing end to end on both sides.
"""
import math

import pytest

from services.node_route import VALUE, DirectBlock, direct_block, value_accepted


@pytest.mark.parametrize(("value", "rule", "expected"), [
    ("16:9", {"values": ["16:9", "1:1"]}, True),
    ("9:21", {"values": ["16:9", "1:1"]}, False),
    (False, {"values": [False]}, True),
    (True, {"values": [False]}, False),
    (0, {"values": [False]}, False),          # 0 is not False, as with === in TS
    (5, {"integer": True, "min": 4, "max": 15}, True),
    (5.0, {"integer": True, "min": 4, "max": 15}, True),
    (5.5, {"integer": True, "min": 4, "max": 15}, False),
    (3, {"integer": True, "min": 4, "max": 15}, False),
    (16, {"integer": True, "min": 4, "max": 15}, False),
    ("5", {"integer": True, "min": 4, "max": 15}, False),
    (True, {"min": 0, "max": 2}, False),      # a bool is not a number
    (math.nan, {"min": 0, "max": 2}, False),
    (math.inf, {"min": 0}, False),
])
def test_value_accepted(value, rule, expected):
    assert value_accepted(value, rule) is expected


DEFINITION = {
    "id": "example-node",
    "params": [{"key": "duration", "type": "float", "default": 5}, {"key": "draft", "type": "boolean", "default": False}],
    "directRoute": {"accepts": {"duration": {"integer": True, "min": 4, "max": 15}, "draft": {"values": [False]}}},
}


def test_defaults_and_saved_values_are_checked():
    assert direct_block(DEFINITION, {}) is None
    assert direct_block(DEFINITION, {"duration": 6.5}) == DirectBlock(VALUE, "duration")
    assert direct_block(DEFINITION, {"draft": True}) == DirectBlock(VALUE, "draft")
    bad_default = {**DEFINITION, "params": [{"key": "duration", "type": "float", "default": 2.5}]}
    assert direct_block(bad_default, {}) == DirectBlock(VALUE, "duration")
