"""directRoute's value rules: accepts, rejects and rejectsWhen (services/node_route.py).

Mirrors frontend/src/lib/directRoute.ts valueAccepted / matchValue /
directBlock; route_cases.json covers the routing end to end on both sides.
"""
import math

import pytest

from services.node_route import (
    SET, UNSUPPORTED, WIRED, DirectBlock, direct_block, match_value, value_accepted, wired_rule_params,
    with_wired_blockers,
)


@pytest.mark.parametrize(("value", "rule", "expected"), [
    ("16:9", {"values": ["16:9", "1:1"]}, True),
    ("9:21", {"values": ["16:9", "1:1"]}, False),
    (False, {"values": [False]}, True),
    (True, {"values": [False]}, False),
    (0, {"values": [False]}, False),          # 0 is not False, as in TS
    (6.0, {"values": [6, 10]}, True),         # 6.0 is 6, as in TS
    ("6", {"values": [6, 10]}, True),         # one spelling, as pricing compares
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


@pytest.mark.parametrize(("value", "expected"), [
    (None, ""), (True, "true"), (False, "false"), (0, "0"), (6.0, "6"), (6.5, "6.5"), ("4K", "4K"),
])
def test_match_value(value, expected):
    assert match_value(value) == expected


DEFINITION = {
    "id": "example-node",
    "params": [{"key": "duration", "type": "float", "default": 5}, {"key": "draft", "type": "boolean", "default": False},
               {"key": "resolution", "type": "enum", "default": "720p"}],
    "directRoute": {
        "accepts": {"duration": {"integer": True, "min": 4, "max": 15}, "draft": {"values": [False]}},
        "rejects": {"resolution": ["4K"]},
        "rejectsWhen": [
            {"match": {"resolution": "1080p", "duration": 10}, "label": "1080p at 10 seconds"},
            {"match": {"start_image": SET, "reference_images": SET}, "label": "a start image with references"},
        ],
    },
}


def test_defaults_and_saved_values_are_checked():
    assert direct_block(DEFINITION, {}) is None
    assert direct_block(DEFINITION, {"duration": 6.5}) == DirectBlock(UNSUPPORTED, "duration", None, "duration 6.5")
    assert direct_block(DEFINITION, {"draft": True}) == DirectBlock(UNSUPPORTED, "draft", None, "draft true")
    bad_default = {**DEFINITION, "params": [{"key": "duration", "type": "float", "default": 2.5}]}
    assert direct_block(bad_default, {}) == DirectBlock(UNSUPPORTED, "duration", None, "duration 2.5")


def test_rejects_and_rejects_when():
    assert direct_block(DEFINITION, {"resolution": "4K"}) == DirectBlock(UNSUPPORTED, "resolution", None, "resolution 4K")
    assert direct_block(DEFINITION, {"resolution": "1080p", "duration": 10.0}) == DirectBlock(
        UNSUPPORTED, "resolution", None, "1080p at 10 seconds")
    assert direct_block(DEFINITION, {"resolution": "1080p", "duration": 6}) is None
    both = {"start_image": "a.png", "reference_images": ["b.png"]}
    assert direct_block(DEFINITION, both) == DirectBlock(
        UNSUPPORTED, "start_image", None, "a start image with references")
    assert direct_block(DEFINITION, {"start_image": "a.png"}) is None


def test_a_wired_port_counts_as_set():
    assert wired_rule_params(DEFINITION) == {"start_image", "reference_images"}
    saved = {"start_image": "a.png"}
    routed = with_wired_blockers(DEFINITION, saved, {"reference_images", "prompt"})
    assert routed == {"start_image": "a.png", "reference_images": WIRED}
    assert direct_block(DEFINITION, routed).detail == "a start image with references"
    # A param no "(set)" rule names is never marked, whatever is wired.
    assert "duration" not in with_wired_blockers(DEFINITION, {}, {"duration"})
