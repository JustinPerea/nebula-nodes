"""PR #233 review round 1, backend findings.

B1  a unicode digit as an image number is a plain-words refusal, never a 500
B2  open tabs are told when a board delete or an image removal drops their cursors
B3  `nebula agents` and the roster say where a moodboard cursor is, as look and context do
"""
from __future__ import annotations

import pytest

import mcp_server
from services.agent_presence import PresenceError
from tests.test_cursor_anywhere_protocol import BOARDS, _parse
from tests.test_cursor_anywhere_writes import AGENT, LANE_A, LANE_B, _create, _cursor, _edit, api  # noqa: F401 - fixture

DIGITS = ["\u00b2", "#\u00b2", "\u2460", "\u0663", "#\u0663", "\uff11"]  # superscript two, circled one, Arabic-Indic three, fullwidth one


# -- B1 ---------------------------------------------------------------------------------

@pytest.mark.parametrize("ref", DIGITS)
def test_a_unicode_digit_is_not_an_image_number(ref):
    with pytest.raises(PresenceError) as refused:
        _parse({"surface": "moodboard", "board": "b1", "image": ref})
    assert "has no image" in str(refused.value) and "Use its number (1-12) or its id." in str(refused.value)


@pytest.mark.parametrize("ref", DIGITS)
def test_the_route_refuses_a_unicode_digit_in_plain_words(api, ref):
    client, sent, _, _ = api
    board = _create(client)
    client.raise_server_exceptions = False
    refused = client.post("/api/canvas/cursor", headers=AGENT,
                          json={"target": {"surface": "moodboard", "board": board["id"], "image": ref}})
    assert refused.status_code == 422, refused.text
    assert "has no image" in refused.json()["detail"]
    assert [event for event, _ in sent if event.get("type") == "agentPresence"] == []


def test_point_at_reaches_the_same_refusal(api, monkeypatch):
    """MCP point_at posts to the route; the refusal is the route's."""
    client, _, _, _ = api
    board = _create(client)
    client.raise_server_exceptions = False
    calls = []

    def through(method, path, ctx, **kwargs):
        response = client.request(method, path, json=kwargs["json"], headers=AGENT)
        calls.append(response)
        return response.json()

    monkeypatch.setattr(mcp_server, "_canvas_call", through)
    mcp_server.point_at(moodboard=board["id"], image="\u00b2")
    assert calls and calls[0].status_code == 422


# -- B2 ---------------------------------------------------------------------------------

@pytest.fixture
def tabs(api, monkeypatch):
    """What the person's canvas tabs hear through broadcast_browser."""
    import main as main_module

    heard: list[dict] = []

    async def capture(data):
        heard.append(data)

    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)
    return api, heard


def _point(client, sent, board, headers, **target) -> tuple[str, str]:
    """Point, and give back the (agent id, session key) the person's tabs drew it as."""
    response = client.post("/api/canvas/cursor", headers=headers,
                           json={"target": {"surface": "moodboard", "board": board, **target}})
    assert response.status_code == 200, response.text
    event = [person for person, _ in sent if person.get("type") == "agentPresence"][-1]
    return event["agent"]["id"], event["session"]["key"]


def test_deleting_a_board_tells_the_tabs_which_cursors_left(tabs):
    (client, sent, presence, _), heard = tabs
    board = _create(client)
    other = _create(client, name="Dusk", count=1)
    a = _point(client, sent, board["id"], LANE_A)
    b = _point(client, sent, board["id"], LANE_B, image=1)
    c = _point(client, sent, other["id"], {**AGENT, "X-Nebula-Agent-Session": "lane-c"})
    heard.clear()
    assert client.delete(f"/api/moodboards/{board['id']}", headers=LANE_A).status_code == 200
    (leave,) = [event for event in heard if event.get("type") == "agentPresenceLeave"]
    left = {(cursor["agentId"], cursor["key"]) for cursor in leave["cursors"] if cursor["key"] is not None}
    assert left == {a, b} and c not in left


def test_a_delete_that_drops_no_cursor_tells_no_tab(tabs):
    (client, _, _, _), heard = tabs
    board = _create(client)
    heard.clear()
    assert client.delete(f"/api/moodboards/{board['id']}", headers=LANE_A).status_code == 200
    assert [event for event in heard if event.get("type") == "agentPresenceLeave"] == []


def test_an_image_removed_elsewhere_moves_the_tabs_cursors_to_the_board(tabs):
    (client, sent, _, _), heard = tabs
    board = _create(client)
    a = _point(client, sent, board["id"], LANE_A, image=3)
    b = _point(client, sent, board["id"], LANE_B, image=1)
    heard.clear()
    _edit(client, board["id"], [{"op": "remove", "image": 3}], LANE_B)  # another session removes it
    (retarget,) = [event for event in heard if event.get("type") == "agentPresenceRetarget"]
    (moved,) = [c for c in retarget["cursors"] if (c["agentId"], c["key"]) == a]
    assert moved["target"] == {"surface": "moodboard", "itemId": board["id"]}
    assert moved["anchorNames"] == {"board": "Desert light"}
    # A cursor on another image stays where it is.
    assert all((c["agentId"], c["key"]) != b for c in retarget["cursors"])


# -- B3 ---------------------------------------------------------------------------------

def test_the_roster_and_nebula_agents_say_where_a_moodboard_cursor_is():
    from cli import formatter
    from services.agent_status import build_roster

    target = {"surface": "moodboard", "itemId": "b1/i12", "part": "note"}
    names = {"board": "Desert light", "image": 12, "part": "Note"}
    cursors = [{"agent": {"id": "claude-code", "name": "Claude", "color": "#d97757", "verified": True},
                "projectId": "p1", "target": target, "anchorNames": names, "action": "type", "secondsAgo": 2.0,
                "did": {"verb": "Typed", "label": "Note", "secondsAgo": 2.0}}]
    (entry,) = build_roster(project_id="p1", now=10.0, cursors=cursors, statuses=[], waiting=[],
                            status_view=lambda status: {})
    assert entry["cursor"]["nodeId"] is None and entry["cursor"]["surface"] == {"target": target, "anchorNames": names}
    text = formatter.format_agents({"agents": [entry]})
    assert f"cursor on {formatter._surface_words(target, names)}" in text
    assert "cursor on moodboard \u201cDesert light\u201d, image 12 (note)" in text
    # A canvas cursor has no such line.
    plain = {**cursors[0], "target": {"nodeId": "n1"}, "anchorNames": None}
    (canvas_entry,) = build_roster(project_id="p1", now=10.0, cursors=[plain], statuses=[], waiting=[],
                                   status_view=lambda status: {})
    assert "surface" not in canvas_entry["cursor"] and "cursor on" not in formatter.format_agents({"agents": [canvas_entry]})


# -- C6 (the Studio's two colour rows are two controls) -----------------------------------

def test_the_keep_out_row_is_its_own_part_in_the_studios_words():
    from services.cursor_actions import BOARD_PARTS, PART_LABELS

    assert "colors-out" in BOARD_PARTS and PART_LABELS["colors-out"] == "Colors to keep out"
    target, names = _parse({"surface": "moodboard", "board": "b1", "part": "colors-out"})
    assert target == {"surface": "moodboard", "itemId": "b1", "part": "colors-out"}
    assert names == {"board": "Desert light", "part": "Colors to keep out"}


def test_point_at_and_the_cli_name_both_colour_rows():
    from cli.__main__ import build_parser

    assert "`colors-out`" in mcp_server.point_at.__doc__
    assert "colors-out" in build_parser().format_help() or "colors-out" in build_parser()._subparsers._group_actions[0].choices["point"].format_help()


def test_a_pin_that_changes_only_the_keep_out_list_goes_to_that_row(api):
    client, sent, _, _ = api
    board = _create(client)
    both = {"include": ["#C8A27A"], "exclude": ["#2F4F4F"]}
    assert client.put(f"/api/moodboards/{board['id']}", headers=LANE_A, json={"pinnedColors": both}).status_code == 200
    # Both lists changed at once: no one row, so the board's colors.
    assert _cursor(sent)["target"]["part"] == "colors"
    more = {"include": ["#C8A27A"], "exclude": ["#2F4F4F", "#111111"]}
    assert client.put(f"/api/moodboards/{board['id']}", headers=LANE_A, json={"pinnedColors": more}).status_code == 200
    assert _cursor(sent)["target"]["part"] == "colors-out"
    again = {"include": ["#C8A27A", "#222222"], "exclude": ["#2F4F4F", "#111111"]}
    assert client.put(f"/api/moodboards/{board['id']}", headers=LANE_A, json={"pinnedColors": again}).status_code == 200
    assert _cursor(sent)["target"]["part"] == "colors"
