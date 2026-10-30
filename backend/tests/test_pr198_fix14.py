"""PR #198 fix round 14 (review 13 NITs 2-4; GM r23 answer 3).

- GM r23 answer 3: a refused node definition is bare when id-shaped, in
  “…” when it has a space or a character no id has. None at all (missing,
  null, empty) is GM's own line for the person, "No node definition was
  given.", while an agent's detail keeps the raw value
  (`unknown node definition ""`); the answer carries ``code:
  "unknown_definition"`` and ``definitionId`` (the raw value).
- Review 13 NIT 2: the wrong-argument refusal's next call is in backticks.
- Review 13 NIT 3: a name the agent wrote that matches nothing (an Avoid
  item, a model) is in “…”.
"""
from __future__ import annotations

import pytest

from services import node_lookup
from tests.test_pr198_fix9 import CODEX
from tests.test_round19_fence import _canvas, _tab, api  # noqa: F401 - fixture


def test_a_definition_is_bare_when_id_shaped_and_in_curly_quotes_otherwise():
    import main

    definitions = main.node_registry.get_all()
    assert node_lookup.unknown_definition("moodboard", definitions).startswith("unknown node definition moodboard")
    spaced = node_lookup.unknown_definition("GPT Image 2", definitions)
    assert spaced.startswith("unknown node definition “GPT Image 2”")
    assert node_lookup.unknown_definition("gpt image!", definitions).startswith("unknown node definition “gpt image!”")
    assert node_lookup.unknown_definition("", definitions) == 'unknown node definition ""'
    assert node_lookup.NO_DEFINITION == "No node definition was given."
    assert "(" not in node_lookup.NO_DEFINITION


@pytest.mark.parametrize("sent", [{"definitionId": ""}, {"definitionId": None}, {}])
def test_no_definition_the_person_reads_gms_line_and_an_agent_the_raw_value(api, sent):  # noqa: F811
    person = api.client.post("/api/graph/node", json={**sent, "params": {}}, headers=_tab(api, _canvas(api)))
    assert person.status_code == 400, person.text
    assert person.json() == {"detail": "No node definition was given.", "code": "unknown_definition", "definitionId": ""}
    agent = api.client.post("/api/graph/node", json={**sent, "params": {}}, headers=CODEX)
    assert agent.status_code == 400, agent.text
    assert agent.json() == {"detail": 'unknown node definition ""', "code": "unknown_definition", "definitionId": ""}


def test_a_definition_with_spaces_is_quoted_and_coded(api):  # noqa: F811
    answer = api.client.post("/api/graph/node", json={"definitionId": "GPT Image 2", "params": {}}, headers=CODEX)
    assert answer.status_code == 400, answer.text
    body = answer.json()
    assert body["code"] == "unknown_definition"
    assert body["definitionId"] == "GPT Image 2"
    assert body["detail"].startswith("unknown node definition “GPT Image 2”")


def test_the_next_call_in_a_wrong_argument_refusal_is_in_backticks():
    import mcp_server

    assert mcp_server._example("moodboard_get", {"properties": {"board": {}}, "required": ["board"]}) \
        == " Call `moodboard_get(board=...)`."


def test_names_the_agent_wrote_are_in_curly_quotes():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    assert "“{item}” isn't on the Avoid list" in (root / "moodboard_client.py").read_text(encoding="utf-8")
    assert "has no model “{model[:120]}”" in (root / "mcp_server.py").read_text(encoding="utf-8")
