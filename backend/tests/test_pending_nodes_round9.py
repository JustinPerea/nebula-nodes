"""Placeholders and statuses, round 9 (review 8 of feat/agent-presence).

- L-a: the model a node runs is named the same way on the run pill and in the
  person's paid-placeholder dialog (lib/placeholderRunConfirm.ts modelName):
  the chosen option of a select param labelled Model (``model``,
  ``model_id``, Meshy's ``ai_model``), else the model a free-text model param
  names (a universal node's model, fal's endpoint, Krea Agent's model), as the
  node card shows it, unquoted; else the node's name, quoted.
- Nit: a hard cut never splits an Indic conjunct (a consonant, a virama and
  the consonant after it: क्ष).
"""
from __future__ import annotations

import pytest

from services import agent_status
from services.text_cut import safe_cut
from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_pending_nodes import pend  # noqa: F401 - fixture


# -- L-a: the run pill names the chosen model --------------------------------------------------------------

@pytest.mark.parametrize(("definition_id", "params", "expected"), [
    ("openrouter-universal", {"model": "openai/gpt-4o-mini"}, "openai/gpt-4o-mini"),
    ("nous-portal-universal", {"model": "Hermes-4-405B"}, "Hermes-4-405B"),
    ("replicate-universal", {"model_id": "black-forest-labs/flux-schnell"}, "black-forest-labs/flux-schnell"),
    ("fal-universal", {"endpoint_id": "fal-ai/flux/dev"}, "fal-ai/flux/dev"),
    ("krea-agent", {"model": "krea-1"}, "krea-1"),
    ("meshy-text-to-image", {"ai_model": "gpt-image-2"}, "GPT Image 2"),
])
def test_the_run_pill_names_the_model_a_model_param_picks(pend, definition_id, params, expected):  # noqa: F811
    from models.graph import GraphNode

    assert pend.main._run_model_name(GraphNode(id="n1", definitionId=definition_id, params=params)) == expected


def test_no_model_chosen_yet_is_the_node_name_quoted(pend):  # noqa: F811
    from models.graph import GraphNode

    assert pend.main._run_model_name(GraphNode(id="n1", definitionId="openrouter-universal", params={"model": ""})) \
        == "“OpenRouter”"


# -- Nit: a hard cut never splits an Indic conjunct -----------------------------------------------------------

CONJUNCT = "क्ष"  # KA, VIRAMA, SSA: one character a person reads


def test_safe_cut_inside_the_conjunct_goes_back_to_its_start():
    text = "a" + CONJUNCT + "b"
    assert safe_cut(text, 3) == 1  # between the virama and SSA
    assert safe_cut(text, 2) == 1  # between KA and the virama (a combining mark)
    assert safe_cut(text, 4) == 4  # after the whole conjunct


def test_a_status_of_conjuncts_is_cut_on_whole_conjuncts():
    raw = CONJUNCT * 60  # 180 code points, no space
    out = agent_status.clean_status_text(raw)
    kept = out[:-1] if out.endswith("…") else out
    assert len(kept) % 3 == 0
    assert kept == CONJUNCT * (len(kept) // 3)
