"""Placeholders and statuses, round 10 (review 9 of feat/agent-presence).

- Nit c: Krea Style Search's free-text ``model`` is a search filter, not the
  model the node runs, so the run pill never names it as one (the person's
  paid-placeholder dialog doesn't either: lib/placeholderRunConfirm.ts).
- Nit d: the 80-character cut of a free-text model name counts code points,
  the same on the canvas (JS, which counts UTF-16 units by default) and here.
"""
from __future__ import annotations

from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_pending_nodes import pend  # noqa: F401 - fixture


def test_krea_style_search_filter_is_not_named_as_the_model(pend):  # noqa: F811
    from models.graph import GraphNode

    node = GraphNode(id="n1", definitionId="krea-style-search", params={"model": "flux"})
    assert pend.main._run_model_name(node) == "“Krea Style Search”"


def test_a_free_text_model_name_is_cut_at_80_code_points(pend):  # noqa: F811
    from models.graph import GraphNode

    node = GraphNode(id="n1", definitionId="openrouter-universal", params={"model": "𝔸" * 81})
    assert pend.main._run_model_name(node) == "𝔸" * 80
