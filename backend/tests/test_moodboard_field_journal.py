"""A board's own fields are journaled: one ``board.fields`` event per write (Q91).

Justin's answer to Q91: "a) Yes, every field change, with the field names but
none of your text." Before this, a Direction, Avoid, pinned colour, strength
or Send notes change made no journal event at all, so an agent waiting on a
board (wait_for_canvas_change, ``nebula watch``) heard of it only when its
wait ran out. Every writer goes through two routes (``PUT
/api/moodboards/{id}`` and ``POST .../edits``, whose ``restore`` is every
undo), and an accepted Send notes proposal calls the PUT route, so each is
tested here: the Studio (the person), MCP ``moodboard_update`` and
``moodboard_edit``, ``nebula moodboard set`` and ``--restore``, a restore by
the person (the Studio's undo) and the proposal's in-process call.

The event names fields only: never their text, colours or numbers.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest

import mcp_server
from cli.__main__ import build_parser
from cli.commands import moodboard as moodboard_cmd
from tests.conftest import PERSON
from tests.test_moodboard_board_model import BOARD_ID, LABEL, fixture_board, write_board
from tests.test_moodboard_edits import app, client, journal, root, sent  # noqa: F401 - fixtures

AGENT = {"X-Nebula-Agent": "Claude Code"}

# Text no field would hold by chance: none of it may reach the journal.
DIRECTION = "ZQXDIRECTION quiet coastal mornings"
AVOID = "ZQXAVOID neon signage"
NOTES = "ZQXNOTES warm and slow"
BRIEF = "ZQXBRIEF the person's own brief"
NAME = "ZQXNAME"  # a board's name is in every board event; only the old/new text of other fields is private
PIN = "#1A2B3C"
STRENGTH = 0.37
SENTINELS = ("ZQXDIRECTION", "ZQXAVOID", "ZQXNOTES", "ZQXBRIEF", "ZQXPRIVATE", "1a2b3c", "0.37")


def _board_events(journal) -> list[dict]:
    return journal.read(after=0, kinds={"board"}, limit=100)["events"]


def _field_events(journal) -> list[dict]:
    return [event for event in _board_events(journal) if event["kind"] == "board.fields"]


def _assert_no_values(journal) -> None:
    dumped = json.dumps(journal.read(after=0, limit=100), ensure_ascii=False).lower()
    for sentinel in SENTINELS:
        assert sentinel.lower() not in dumped, sentinel


def _ok(response) -> dict:
    assert response.status_code == 200, response.text
    return response.json()


def _put(client, headers=None, **body) -> dict:
    return _ok(client.put(f"/api/moodboards/{BOARD_ID}", json=body, headers=headers or {}))


# -- the kind ---------------------------------------------------------------------

def test_board_fields_is_a_journal_kind_in_the_board_group():
    from services.canvas_events import EVENT_GROUPS, EVENT_KINDS, parse_kinds

    assert "board.fields" in EVENT_KINDS and "board" in EVENT_GROUPS
    assert parse_kinds("board.fields") == {"board.fields"}


# -- the Studio (the person's PUT) ---------------------------------------------------

def test_the_persons_direction_edit_is_one_event_naming_the_field_and_not_its_text(client, root, journal, person):
    write_board(root, fixture_board())
    _put(client, PERSON, direction=DIRECTION)

    events = _board_events(journal)
    assert [event["kind"] for event in events] == ["board.fields"]
    event = events[0]
    assert event["actor"] == {"kind": "person"}
    assert event["data"] == {"boardId": BOARD_ID, "boardName": "Placed", "scope": "global", "fields": ["direction"]}
    assert event["summary"] == "changed Direction on board Placed"
    _assert_no_values(journal)


def test_every_board_field_is_named_in_a_fixed_order_with_no_value(client, root, journal, person):
    board = fixture_board()
    board["images"][0]["notes"] = ""  # the fixture's own note text is not this test's
    write_board(root, board)
    _put(client, PERSON, briefOverride={"text": BRIEF}, sendNotes=True, clashMode="flag",
         pinnedColors={"include": [PIN], "exclude": []}, avoid=[AVOID], direction=DIRECTION,
         strength=STRENGTH, mode="world", notes=NOTES, name="Coast")

    events = _board_events(journal)
    assert [event["kind"] for event in events] == ["board.fields"]
    assert events[0]["data"]["fields"] == ["name", "notes", "mode", "strength", "direction", "avoid",
                                           "pinnedColors", "clashMode", "sendNotes", "briefOverride"]
    assert events[0]["data"]["boardName"] == "Coast"
    _assert_no_values(journal)


def test_a_write_that_changes_no_field_journals_nothing(client, root, journal, person):
    write_board(root, fixture_board())
    _put(client, PERSON, direction="", notes="editorial warmth", strength=0.7, mode="look")
    _put(client, PERSON, avoid=[])
    _put(client, PERSON)
    assert _board_events(journal) == []


def test_the_boards_notes_are_a_field_not_an_image_note(client, root, journal, person):
    # board.noted is an image's notes; the board's own notes are board.fields.
    write_board(root, fixture_board())
    _put(client, PERSON, notes=NOTES)
    events = _board_events(journal)
    assert [(event["kind"], event["data"].get("fields")) for event in events] == [("board.fields", ["notes"])]
    assert events[0]["summary"] == "changed the board's notes on board Placed"
    _assert_no_values(journal)


def test_a_put_that_changes_images_and_fields_is_one_event_for_each(client, root, journal, person):
    write_board(root, fixture_board())
    images = client.get(f"/api/moodboards/{BOARD_ID}").json()["images"]
    body = [{k: v for k, v in image.items() if k != "placements"} for image in images]
    _put(client, PERSON, images=[body[0], {**body[1], "weight": 0.3}], direction=DIRECTION)
    events = _board_events(journal)
    assert [event["kind"] for event in events] == ["board.resized", "board.fields"]
    assert events[0]["data"]["kinds"] == ["board.resized"]
    assert events[1]["data"]["fields"] == ["direction"]


def test_a_cover_pick_stays_board_cover_and_is_not_a_field(client, root, journal, person):
    write_board(root, fixture_board())
    _put(client, PERSON, coverImageId="img-b")
    assert [event["kind"] for event in _board_events(journal)] == ["board.cover"]


# -- MCP ---------------------------------------------------------------------------

def test_mcp_moodboard_update_and_its_undo_each_journal_one_fields_event(app, root, journal, monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    write_board(root, fixture_board())
    updated = mcp_server.moodboard_update(BOARD_ID, direction=DIRECTION, avoid=[AVOID], pin_colors=[PIN])

    events = _field_events(journal)
    assert len(_board_events(journal)) == 1 and len(events) == 1
    assert events[0]["actor"]["kind"] == "agent" and events[0]["actor"]["name"] == "Claude Code"
    assert events[0]["data"]["fields"] == ["direction", "avoid", "pinnedColors"]
    assert events[0]["summary"] == "changed Direction, the Avoid list and the pinned colours on board Placed"

    # The undo (a restore of the fields slice, through /edits).
    mcp_server.moodboard_update(BOARD_ID, **updated["previous"])
    events = _field_events(journal)
    assert len(_board_events(journal)) == 2 and len(events) == 2
    assert events[1]["data"]["fields"] == ["direction", "avoid", "pinnedColors"]
    assert events[1]["actor"]["name"] == "Claude Code"
    _assert_no_values(journal)


def test_mcp_moodboard_edit_with_a_fields_restore_journals_one_fields_event(app, root, journal, monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    write_board(root, fixture_board())
    updated = mcp_server.moodboard_update(BOARD_ID, strength=STRENGTH)
    mcp_server.moodboard_edit(BOARD_ID, updated["previous"]["undo"]["ops"])
    events = _field_events(journal)
    assert [event["data"]["fields"] for event in events] == [["strength"], ["strength"]]
    assert len(_board_events(journal)) == 2
    _assert_no_values(journal)


# -- the CLI -----------------------------------------------------------------------

def _cli(client, argv, capsys) -> str:
    moodboard_cmd.run(client, build_parser().parse_args(argv))
    return capsys.readouterr().out


def test_nebula_moodboard_set_and_restore_each_journal_one_fields_event(app, root, journal, tmp_path, capsys,
                                                                        monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    write_board(root, fixture_board())
    out = _cli(app, ["moodboard", "set", BOARD_ID, "--direction", DIRECTION, "--strength", str(STRENGTH),
                     "--no-send-notes", "--json"], capsys)
    previous = json.loads(out)["previous"]
    events = _field_events(journal)
    assert len(_board_events(journal)) == 1
    assert events[0]["data"]["fields"] == ["strength", "direction"]
    assert events[0]["actor"]["name"] == "Codex"

    saved = tmp_path / "previous.json"
    saved.write_text(json.dumps(previous), encoding="utf-8")
    _cli(app, ["moodboard", "set", BOARD_ID, "--restore", str(saved)], capsys)
    events = _field_events(journal)
    assert len(_board_events(journal)) == 2
    assert events[1]["data"]["fields"] == ["strength", "direction"]
    _assert_no_values(journal)


# -- restore and undo by the person (the Studio's Cmd+Z) -----------------------------

def test_the_persons_field_undo_through_edits_journals_one_fields_event(client, root, journal, person):
    write_board(root, fixture_board())
    _put(client, PERSON, direction=DIRECTION, avoid=[AVOID])
    undo = {"op": "restore", "slices": [{"part": "fields",
                                         "before": {"direction": "", "avoid": []},
                                         "expect": {"direction": DIRECTION, "avoid": [AVOID]}}]}
    _ok(client.post(f"/api/moodboards/{BOARD_ID}/edits", json={"ops": [undo]}, headers=PERSON))
    events = _field_events(journal)
    assert [event["data"]["fields"] for event in events] == [["direction", "avoid"], ["direction", "avoid"]]
    assert all(event["actor"] == {"kind": "person"} for event in events)
    # The same restore again changes nothing: no event.
    _ok(client.post(f"/api/moodboards/{BOARD_ID}/edits", json={"ops": [undo]}, headers=PERSON))
    assert len(_board_events(journal)) == 2
    _assert_no_values(journal)


def test_a_restore_that_brings_back_settings_and_fields_names_both(client, root, journal, person):
    write_board(root, fixture_board())
    edited = _ok(client.post(f"/api/moodboards/{BOARD_ID}/edits", headers=PERSON,
                             json={"ops": [{"op": "note", "image": 1, "privateNote": "changed"}]}))
    _put(client, PERSON, direction=DIRECTION)
    fields_undo = {"part": "fields", "before": {"direction": ""}, "expect": {"direction": DIRECTION}}
    ops = [{"op": "restore", "slices": [*edited["undo"]["ops"][0]["slices"], fields_undo]}]
    _ok(client.post(f"/api/moodboards/{BOARD_ID}/edits", json={"ops": ops}, headers=PERSON))
    kinds = [event["kind"] for event in _board_events(journal)]
    assert kinds == ["board.noted", "board.fields", "board.noted", "board.fields"]
    _assert_no_values(journal)


# -- an accepted proposal (it makes the change through the PUT route, as the person) --

def test_the_put_route_called_in_process_as_the_person_journals_too(root, journal, sent, canvas_project, person):
    """An accepted asset proposal (Send notes, services/asset_proposals.py on
    its branch) calls ``update_moodboard`` in process under the person's
    headers: the journal sits in that route, so it is journaled the same way."""
    import main
    from services.agent_presence import request_headers_scope

    write_board(root, fixture_board())
    with request_headers_scope(PERSON):
        answer = asyncio.run(main.update_moodboard(BOARD_ID, main.MoodboardUpdate(sendNotes=True)))
    assert answer["sendNotes"] is True
    events = _board_events(journal)
    assert [(event["kind"], event["data"]["fields"], event["actor"]["kind"]) for event in events] == [
        ("board.fields", ["sendNotes"], "person")]
    assert events[0]["summary"] == "changed Send notes to generators on board Placed"


# -- waiters wake at once ------------------------------------------------------------

def _wait_until_waiting(journal, count: int = 1) -> None:
    deadline = time.monotonic() + 10
    while journal.waiting < count:
        assert time.monotonic() < deadline, "the waiter never started waiting"
        time.sleep(0.01)


def test_a_long_poll_on_board_events_wakes_within_a_second_of_a_field_change(client, root, journal, person):
    write_board(root, fixture_board())
    result: dict = {}

    def wait() -> None:
        response = client.get("/api/canvas/events", params={"wait": 20, "kinds": "board", "after": journal.latest},
                              headers=AGENT)
        result["at"] = time.monotonic()
        result["body"] = response.json()

    waiter = threading.Thread(target=wait)
    waiter.start()
    _wait_until_waiting(journal)
    _put(client, PERSON, direction=DIRECTION)
    written = time.monotonic()
    waiter.join(timeout=20)
    assert not waiter.is_alive()
    assert result["at"] - written < 1.0
    assert not result["body"]["timedOut"]
    assert [event["kind"] for event in result["body"]["events"]] == ["board.fields"]


def test_mcp_wait_for_canvas_change_returns_on_the_persons_field_change(app, client, root, journal, person,
                                                                        monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    write_board(root, fixture_board())
    result: dict = {}

    def wait() -> None:
        result["answer"] = mcp_server.wait_for_canvas_change(since=journal.latest, timeout_seconds=20,
                                                             kinds=["board.fields"])
        result["at"] = time.monotonic()

    waiter = threading.Thread(target=wait)
    waiter.start()
    _wait_until_waiting(journal)
    _put(client, PERSON, avoid=[AVOID])
    written = time.monotonic()
    waiter.join(timeout=20)
    assert not waiter.is_alive()
    assert result["at"] - written < 1.0
    answer = result["answer"]
    assert not answer.get("timedOut")
    [event] = answer["events"]
    assert event["kind"] == "board.fields" and event["data"]["fields"] == ["avoid"]
    assert event["actor"] == {"kind": "person"}
    assert AVOID not in json.dumps(answer, ensure_ascii=False)


def test_nebula_watch_prints_the_field_change_with_who_did_it(client, root, journal, person):
    from cli.formatter import format_event

    write_board(root, fixture_board())
    _put(client, PERSON, direction=DIRECTION, avoid=[AVOID])
    [event] = _board_events(journal)
    line = format_event(event)
    assert line.endswith("Person  changed Direction and the Avoid list on board Placed")


# -- the Agent log ---------------------------------------------------------------------

def test_an_agents_field_change_is_the_journals_line_in_the_agent_log(client, root, journal, sent):
    write_board(root, fixture_board())
    _put(client, AGENT, direction=DIRECTION, avoid=[AVOID])
    [event] = _board_events(journal)
    said = [message["say"] for message in sent if message.get("type") == "agentPresence"]
    assert said == [event["summary"][0].upper() + event["summary"][1:]]
    assert said == ["Changed Direction and the Avoid list on board Placed"]


def test_a_private_note_label_never_reaches_a_fields_event(client, root, journal, person):
    # LABEL is the fixture's private note; a field write leaves it where it is.
    write_board(root, fixture_board())
    _put(client, PERSON, direction=DIRECTION)
    assert LABEL not in json.dumps(journal.read(after=0, limit=100), ensure_ascii=False)


@pytest.mark.parametrize("field,value", [("mode", "subject"), ("clashMode", "keep-all"), ("name", NAME)])
def test_each_single_field_write_names_only_that_field(client, root, journal, person, field, value):
    write_board(root, fixture_board())
    _put(client, PERSON, **{field: value})
    assert [event["data"]["fields"] for event in _board_events(journal)] == [[field]]
