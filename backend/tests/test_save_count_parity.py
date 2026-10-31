"""Review 7 of PR #205 (limits MEDIUM-3): the backend counts a canvas's Save
file as the person's Save does (frontend serializeGraph + its walk), value for
value, so an agent's edit the backend accepts is one Save can save. The
frontend's tests/saveCountParity.pr205r8.test.ts reads the same canvases and
pins the same numbers. Before the fix the backend left out ``outputs`` on a
node with none and ``data`` on a connection with none, and counted fewer."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

CASES = json.loads((Path(__file__).parent / "fixtures" / "save_count_parity.json").read_text())["cases"]
PINNED = {
    "no outputs, no connections": 24,
    "outputs on one node, none on another": 44,
    "connections with and without data": 53,
}


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_backends_count_is_saves(case):
    import main

    view = main._canvas_save_file_view({"nodes": case["nodes"], "edges": case["edges"]})
    assert main._graph_shape_measure(view)[1] == PINNED[case["name"]]
