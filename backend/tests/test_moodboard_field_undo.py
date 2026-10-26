"""A board field's undo comes from the server (Q83).

Moodboard Studio makes each board field change one undo step (Direction,
Avoid, pinned colours, notes, strength...). Its undo must be the server's
own data, never a value the Studio guessed: the ``PUT`` that saved the
change answers with ``undo``, a ``restore`` built from the board before and
after, the same shape a ``/edits`` batch answers with (contract 07, 1.12).
Sent back to ``/edits`` it puts the field back unless it changed since, and
then it is left and named, as for a card step.
"""
from __future__ import annotations

import moodboard_client as boards
from tests.conftest import PERSON
from tests.test_moodboard_board_model import BOARD_ID, fixture_board, write_board
from tests.test_moodboard_edits import (  # noqa: F401 (fixtures)
    _edit,
    _ok,
    app,
    client,
    journal,
    root,
    sent,
)


def _put(client, fields, *, version=None, headers=PERSON):
    if version is None:
        version = client.get(f"/api/moodboards/{BOARD_ID}", headers=PERSON).json()["version"]
    return _ok(client.put(f"/api/moodboards/{BOARD_ID}", json={**fields, "baseVersion": version}, headers=headers))


def test_a_put_answers_with_the_undo_of_what_it_changed(client, root):
    write_board(root, fixture_board())
    answer = _put(client, {"direction": "warm dusk", "strength": 0.4})
    # Still the board, as before.
    assert answer["id"] == BOARD_ID and answer["direction"] == "warm dusk" and answer["version"] == 4
    assert answer["undo"] == {"ops": [{"op": "restore", "slices": [
        {"part": "fields", "before": {"strength": 0.7, "direction": ""},
         "expect": {"strength": 0.4, "direction": "warm dusk"}}]}]}
    # The saved board holds no undo.
    assert "undo" not in client.get(f"/api/moodboards/{BOARD_ID}", headers=PERSON).json()


def test_a_put_that_changes_nothing_has_nothing_to_undo(client, root):
    write_board(root, fixture_board())
    answer = _put(client, {"direction": ""})
    assert answer["undo"] == {"ops": []}


def test_the_puts_undo_puts_the_field_back_and_its_answer_redoes_it(client, root):
    write_board(root, {**fixture_board(), "pinnedColors": {"include": ["#112233"], "exclude": []}})
    answer = _put(client, {"pinnedColors": {"include": ["#112233", "#e8593c"], "exclude": []}})
    undone = _ok(_edit(client, answer["undo"]["ops"], headers=PERSON))
    assert undone["board"]["pinnedColors"] == {"include": ["#112233"], "exclude": []}
    assert undone["applied"][0].get("skipped") in (None, [])
    redone = _ok(_edit(client, undone["undo"]["ops"], headers=PERSON))
    assert redone["board"]["pinnedColors"] == {"include": ["#112233", "#e8593c"], "exclude": []}


def test_a_field_changed_since_is_left_and_named(client, root):
    write_board(root, fixture_board())
    answer = _put(client, {"direction": "warm dusk", "avoid": ["neon"]})
    # An agent (or another window, or an accepted proposal) changes Direction after it.
    _put(client, {"direction": "agent dawn"}, headers={"X-Nebula-Agent": "Claude Code"})
    undone = _ok(_edit(client, answer["undo"]["ops"], headers=PERSON))
    assert undone["board"]["direction"] == "agent dawn"
    assert undone["board"]["avoid"] == []
    assert [item["message"] for item in undone["applied"][0]["skipped"]] == ["Direction changed since, left as is"]


def test_two_puts_of_one_field_undo_in_order_in_one_batch(client, root):
    """Typing that saved twice before the field lost focus is one step: the
    Studio sends both answers' undos, the later first, as one batch."""
    write_board(root, fixture_board())
    first = _put(client, {"direction": "warm"})
    second = _put(client, {"direction": "warm editorial"})
    undone = _ok(_edit(client, [*second["undo"]["ops"], *first["undo"]["ops"]], headers=PERSON))
    assert undone["board"]["direction"] == ""
    assert all(not entry.get("skipped") for entry in undone["applied"])
    redone = _ok(_edit(client, undone["undo"]["ops"], headers=PERSON))
    assert redone["board"]["direction"] == "warm editorial"


def test_update_board_takes_the_undo_from_the_put_and_hands_back_a_board_without_it(app, client, root):
    write_board(root, fixture_board())
    board, _removed, previous = boards.update_board(app.api, BOARD_ID, direction="cli dusk", strength=0.5)
    assert "undo" not in board
    assert previous["undo"] == {"ops": [{"op": "restore", "slices": [
        {"part": "fields", "before": {"strength": 0.7, "direction": ""},
         "expect": {"strength": 0.5, "direction": "cli dusk"}}]}]}
