"""Agents move cards on a board (moodboard canvas PR5, plan section 6.0).

MCP ``moodboard_edit(board, ops, base_version?, say?)`` and CLI ``nebula
moodboard edit <board> --place 12=x,y --resize 12=0.6 --in 12=Dither --link
12=Glass --set-aside 12 --note 12=...`` send the section 5.1 ops through the
same ``POST /api/moodboards/{id}/edits`` the Studio uses, so they get its
checks, its ``undo``, ``baseVersion`` conflicts, the broadcast an open Studio
follows and the journal event. Both are undoable: sending the ``undo`` back
puts the board back, skipping what changed since.
"""
from __future__ import annotations

import io
import json
import sys

import pytest

import moodboard_client as boards
from tests.conftest import PERSON
from tests.test_moodboard_board_model import BOARD_ID, fixture_board, write_board
from tests.test_moodboard_edits import (  # noqa: F401 (fixtures)
    AGENT,
    _board_events,
    _changes,
    _edit,
    _ok,
    app,
    client,
    journal,
    root,
    sent,
)


def _cards(board: dict) -> dict[str, tuple[int, int]]:
    return {p["id"]: (p["x"], p["y"]) for image in board["images"] for p in image.get("placements") or []}


def _cli(app, capsys, *argv: str) -> str:
    from cli.__main__ import build_parser
    from cli.commands import moodboard as moodboard_cmd

    moodboard_cmd.run(app, build_parser().parse_args(["moodboard", "edit", *argv]))
    return capsys.readouterr().out


# -- MCP ------------------------------------------------------------------------------

def test_mcp_moodboard_edit_moves_a_card_and_its_undo_puts_it_back(app, client, root, sent, journal, monkeypatch):
    import mcp_server

    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude")
    write_board(root, fixture_board())
    done = mcp_server.moodboard_edit(BOARD_ID, [{"op": "place", "placement": "pl-b", "x": 900, "y": 40}],
                                     say="Moved #2 right")
    assert done["version"] == 4
    assert [entry["status"] for entry in done["applied"]] == ["applied"]
    # The answer has the layout, so the agent sees where the card went.
    assert _cards(done)["pl-b"] == (900, 40)
    assert done["undo"]["ops"][0]["op"] == "restore"

    # An open Studio follows it: the broadcast names the agent, the version and the card.
    message = _changes(sent)[-1]
    assert message["version"] == 4
    assert message["edit"]["actor"]["kind"] == "agent" and message["edit"]["actor"]["name"] == "Claude"
    assert "tab" not in message["edit"] and message["touched"]["images"] == ["img-b"]
    event = _board_events(journal)[-1]
    assert event["kind"] == "board.moved" and event["data"]["say"] == "Moved #2 right"

    undone = mcp_server.moodboard_edit(BOARD_ID, done["undo"]["ops"])
    assert _cards(undone)["pl-b"] == (504, 0) and undone["version"] == 5
    assert _cards(boards.get_board(app.api, BOARD_ID))["pl-b"] == (504, 0)


def test_mcp_moodboard_edit_undo_skips_what_the_person_moved_since(app, client, root):
    import mcp_server

    write_board(root, fixture_board())
    done = mcp_server.moodboard_edit(BOARD_ID, [{"op": "place", "placement": "pl-a", "x": 0, "y": 600},
                                                {"op": "place", "placement": "pl-b", "x": 900, "y": 600}])
    # The person drags #2 after the agent's batch.
    _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 1200, "y": 1200}], headers=PERSON))
    undone = mcp_server.moodboard_edit(BOARD_ID, done["undo"]["ops"])
    assert _cards(undone) == {"pl-a": (0, 0), "pl-b": (1200, 1200)}
    skipped = undone["applied"][0]["skipped"]
    assert [item["message"] for item in skipped] == ["#2 changed since, left as is"]


def test_mcp_moodboard_edit_refuses_a_stale_base_version_and_a_bad_batch_whole(app, client, root):
    import mcp_server

    path = write_board(root, fixture_board())  # version 3
    before = path.read_bytes()
    with pytest.raises(RuntimeError, match="changed since you read it"):
        mcp_server.moodboard_edit(BOARD_ID, [{"op": "place", "placement": "pl-a", "x": 1, "y": 1}], base_version=2)
    with pytest.raises(RuntimeError, match=r"ops\[1\]"):
        mcp_server.moodboard_edit(BOARD_ID, [{"op": "place", "placement": "pl-a", "x": 50, "y": 50},
                                             {"op": "resize", "placement": "pl-b", "weight": 7}])
    assert path.read_bytes() == before
    # moodboard_get says which version it read, for base_version.
    read = mcp_server.moodboard_get(BOARD_ID)["version"]
    assert read == 3
    assert mcp_server.moodboard_edit(BOARD_ID, [{"op": "resize", "placement": "2", "weight": 0.5}],
                                     base_version=read)["version"] == 4


def test_moodboard_edit_is_an_agent_tool_in_app(app):
    from services import agent_profiles
    from services.krea_agent_mcp import NEBULA_MCP_TOOLS
    import mcp_server

    assert "moodboard_edit" in NEBULA_MCP_TOOLS
    assert "mcp__nebula__moodboard_edit" in agent_profiles.CLAUDE_ALLOW_RULES
    assert "moodboard_edit" in mcp_server.INSTRUCTIONS


# -- CLI ------------------------------------------------------------------------------

def test_cli_edit_sends_the_flags_as_one_checked_batch(app, client, root, capsys, journal):
    write_board(root, fixture_board())
    out = _cli(app, capsys, BOARD_ID, "--place", "2=900,40", "--resize", "1=0.5", "--set-aside", "2",
               "--note", "1=teal now", "--say", "Tidied the board", "--json")
    result = json.loads(out)
    board = boards.get_board(app.api, BOARD_ID)
    assert _cards(board)["pl-b"] == (900, 40)
    a, b = board["images"]
    assert a["placements"][0]["weight"] == 0.5 and a["weight"] == 0.5 and a["notes"] == "teal now"
    assert b["excluded"] is True
    assert result["version"] == 4 and len(result["applied"]) == 4 and result["undo"]["ops"]
    assert _board_events(journal)[-1]["data"]["say"] == "Tidied the board"

    # The printed output undoes it in one checked write.
    saved = root / "edit.json"
    saved.write_text(out)
    out = _cli(app, capsys, BOARD_ID, "--undo", str(saved))
    assert "Put Placed (placedboard01) back." in out and "Redo it: echo " in out
    board = boards.get_board(app.api, BOARD_ID)
    assert _cards(board)["pl-b"] == (504, 0)
    assert board["images"][0]["weight"] == 1.0 and board["images"][0]["notes"] == "the orange accent"
    assert board["images"][1]["excluded"] is False


def test_cli_edit_says_what_it_did_and_how_to_undo_it(app, client, root, capsys, monkeypatch):
    write_board(root, fixture_board())
    out = _cli(app, capsys, BOARD_ID, "--place", "1=10,600")
    assert "Edited Placed (placedboard01): 1 change." in out
    assert "| nebula moodboard edit placedboard01 --undo -" in out

    # An undo that finds a card moved since leaves it and says so.
    first = json.loads(_cli(app, capsys, BOARD_ID, "--place", "2=900,600", "--json"))
    _ok(_edit(client, [{"op": "place", "placement": "pl-b", "x": 1500, "y": 0}], headers=PERSON))
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(first)))
    out = _cli(app, capsys, BOARD_ID, "--undo", "-")
    assert "Nothing on Placed (placedboard01) was put back:" in out
    assert "#2 changed since, left as is." in out
    assert _cards(boards.get_board(app.api, BOARD_ID))["pl-b"] == (1500, 0)


def test_cli_edit_and_moodboard_edit_send_the_same_ops(app, client, root, capsys, monkeypatch):
    import mcp_server

    seen: list[list[dict]] = []
    real = boards.edit_board

    def spy(api, ref, ops, **kwargs):
        seen.append(ops)
        return real(api, ref, ops, **kwargs)

    monkeypatch.setattr(boards, "edit_board", spy)
    write_board(root, fixture_board())
    _cli(app, capsys, BOARD_ID, "--place", "2=900,40", "--resize", "1=240x135", "--use", "2",
         "--private-note", "1=liked")
    mcp_server.moodboard_edit(BOARD_ID, seen[0])
    assert seen[0] == [
        {"op": "place", "placement": "2", "x": 900, "y": 40},
        {"op": "resize", "placement": "1", "w": 240, "h": 135},
        {"op": "setAside", "image": "2", "value": False},
        {"op": "note", "image": "1", "privateNote": "liked"},
    ]
    assert seen[1] == seen[0]


def test_cli_edit_puts_a_card_in_a_look_and_links_a_copy(app, client, root, capsys):
    write_board(root, fixture_board())
    _ok(_edit(client, [{"op": "frame.create", "name": "Dither", "x": 0, "y": 2000, "w": 600, "h": 400},
                       {"op": "frame.create", "name": "Glass", "x": 1000, "y": 2000, "w": 600, "h": 400}]))
    frames = {f["name"]: f["id"] for f in boards.get_board(app.api, BOARD_ID)["frames"]}

    # A loose card goes into the look.
    _cli(app, capsys, BOARD_ID, "--in", "1=Dither")
    a = boards.get_board(app.api, BOARD_ID)["images"][0]
    assert [p["frameId"] for p in a["placements"]] == [frames["Dither"]]

    # A copy in a second look. Moving the Dither copy into Glass, where #1 already has one, is refused.
    _cli(app, capsys, BOARD_ID, "--link", "1=Glass")
    a = boards.get_board(app.api, BOARD_ID)["images"][0]
    assert sorted(p["frameId"] for p in a["placements"]) == sorted(frames.values())
    with pytest.raises(SystemExit):
        _cli(app, capsys, BOARD_ID, "--in", "1@Dither=Glass")
    assert "Already in Glass" in capsys.readouterr().err

    # A card in one look moves to another: the copy there replaces it.
    _cli(app, capsys, BOARD_ID, "--in", "2=Dither")
    _cli(app, capsys, BOARD_ID, "--in", "2=Glass")
    b = boards.get_board(app.api, BOARD_ID)["images"][1]
    assert [p["frameId"] for p in b["placements"]] == [frames["Glass"]]


def test_cli_edit_takes_raw_ops_and_refuses_bad_flags(app, client, root, capsys, monkeypatch):
    write_board(root, fixture_board())
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(
        {"ops": [{"op": "frame.create", "name": "Dusk", "around": ["pl-a"]}]})))
    _cli(app, capsys, BOARD_ID, "--ops", "-")
    assert [f["name"] for f in boards.get_board(app.api, BOARD_ID)["frames"]] == ["Dusk"]

    for argv, message in (
        (["--place", "2=900"], "--place takes CARD=X,Y"),
        (["--resize", "1=big"], "--resize takes CARD=WEIGHT or CARD=WxH"),
        ([], "nothing to change"),
        (["--undo", "-", "--place", "1=0,0"], "--undo"),
    ):
        with pytest.raises(SystemExit):
            _cli(app, capsys, BOARD_ID, *argv)
        assert message in capsys.readouterr().err
