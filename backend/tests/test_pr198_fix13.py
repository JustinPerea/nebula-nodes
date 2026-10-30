"""PR #198 fix round 13 (review 12; GM r21).

- Review 12 N-5: ids and handles take no quotes, through ``!r`` too: a card
  id already on a board, an imported node's output handle, a preview's port,
  a definition id an agent wrote, the engine's run errors.
- GM r21 answer 1: a name an agent wrote that matches nothing is shown in
  “…” (``no Style “X”``, ``no board “X”``), as the person's lines show names.
- GM r21 answer 2: a call an agent can make next stays code: in backticks,
  with its own straight quotes (```get_run('run_x')```).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]


def _source_lines():
    for path in sorted(ROOT.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith(("tests/", ".venv/")) or "/site-packages/" in rel:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            yield rel, number, line


def test_a_card_id_already_on_the_board_is_bare():
    from services.moodboard_layout import normalize_placements

    with pytest.raises(ValueError) as caught:
        normalize_placements([{"id": "card_a", "x": 0, "y": 0}], label="placements", aspect=1.0, frame_ids=[],
                             taken={"card_a"}, placed_by="person", placed_at="2026-10-28T00:00:00Z")
    assert "card_a is already a card on this board" in str(caught.value)
    assert "'card_a'" not in str(caught.value)


def test_a_preview_port_and_an_imported_handle_are_bare():
    import main

    with pytest.raises(HTTPException) as caught:
        main._preview_port("n4", {"image": {"type": "Image"}}, "video")
    assert caught.value.detail == "n4 has no output video (outputs: image)."
    with pytest.raises(ValueError) as imported:
        main._validate_imported_outputs("text-input", {"made_up": {"type": "Text"}}, node_index=0)
    assert "output handle made_up is not declared" in str(imported.value)


def test_no_id_or_handle_goes_through_repr():
    """``!r`` on an id or a handle quotes it as ``'{…}'`` does. A value that
    was refused (an invalid id, what a provider sent back, what was received)
    is shown as sent, so it keeps its repr."""
    named = re.compile(r"\{[^{}]*(?:_id|\bid|\bpid|_ids|handle|port)\]?!r\}")
    shown_as_sent = re.compile(r"invalid|received|unexpected|unknown|Unknown|must be one of|Known models|LaunchSpec")
    found = [f"{rel}:{number}: {line.strip()}" for rel, number, line in _source_lines()
             if named.search(line) and not shown_as_sent.search(line)]
    assert found == []


def test_names_an_agent_wrote_are_in_curly_quotes():
    """GM r21 answer 1: ``no Style “X”``, ``no board “X”``, the same for
    Characters, projects and looks, and when several share the name."""
    straight = re.compile(r"\b(?:no (?:Style|Character|board|project|look|frame)|(?:Styles|Characters|boards|projects) are named|"
                          r"the project|Board|Moodboard) '\{")
    found = [f"{rel}:{number}: {line.strip()}" for rel, number, line in _source_lines() if straight.search(line)]
    assert found == []


class _FakeAPI:
    """Nebula answering a by-name lookup: no project, ``styles`` everywhere."""

    def __init__(self, styles):
        self.styles = styles

    def request(self, method, path, params=None, headers=None):
        if path == "/api/projects":
            return {"projects": []}
        if path == "/api/presets":
            return list(self.styles)
        raise AssertionError(path)


def test_a_style_by_a_name_nothing_has_or_two_share():
    import style_client

    with pytest.raises(style_client.StyleError) as none:
        style_client.find_style(_FakeAPI([]), "Neon dusk")
    assert str(none.value).startswith("no Style “Neon dusk” ")
    twins = [{"id": "sty_a", "name": "Neon dusk"}, {"id": "sty_b", "name": "neon dusk"}]
    with pytest.raises(style_client.StyleError) as two:
        style_client.find_style(_FakeAPI(twins), "Neon dusk")
    assert str(two.value) == "2 Styles are named “Neon dusk” (sty_a, sty_b); use the id"


def test_calls_shown_to_agents_are_code_in_backticks():
    """GM r21 answer 2: the next call stays code, with its straight quotes,
    in backticks: never bare in a sentence."""
    call = re.compile(r"(?<!`)\b(?:get_run|open_project|rename_project|model_catalog|get_proposal)\('")
    found = [f"{rel}:{number}: {line.strip()}" for rel, number, line in _source_lines()
             if call.search(line) and ('f"' in line or "\"" in line)]
    assert found == []


def test_the_engines_run_errors_name_ports_and_definitions_bare():
    from execution import engine

    text = Path(engine.__file__).read_text(encoding="utf-8")
    assert "Required input port {port['id']} is not connected" in text
    assert "No handler registered for {node.definition_id}" in text
