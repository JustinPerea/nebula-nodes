"""Cursor Phase 3 ("Anywhere"), slice 3: the protocol.

A cursor can point at a moodboard item (the Moodboard panel and Studio, one
surface): ``{"surface": "moodboard", "itemId": "<board>" | "<board>/<image>",
"part"?}``, with ``anchorNames`` beside it. These tests pin every form
``parse_target`` takes and refuses (the refusal text too), what each
``AgentPresence`` method does with a surface anchor, the HTTP route, the MCP
tool, the CLI and the formatter's lines.
"""
from __future__ import annotations

import io
import sys
from contextlib import redirect_stderr, redirect_stdout

import pytest

import mcp_server
from services.agent_presence import AgentPresence, PresenceError, identify, parse_surface_target, parse_target
from services.cursor_actions import BOARD_PARTS, IMAGE_PARTS, PART_LABELS
from tests.test_moodboard_agent_actions import AGENT, _create, api  # noqa: F401 - fixture
from tests.test_agent_presence import Clock

BOARDS = [
    {"id": "b1", "name": "Desert light", "images": [{"id": f"i{n}"} for n in range(1, 13)]},
    {"id": "b2", "name": "Dusk", "images": []},
    {"id": "b3", "name": "Twin", "images": [{"id": "x1"}]},
    {"id": "b4", "name": "Twin", "images": []},
]


def _parse(raw, label="target"):
    return parse_surface_target(raw, BOARDS, label)


# -- parse_target: every form ----------------------------------------------------

def test_a_board_by_id_or_exact_name_and_an_image_by_id_or_number_become_ids():
    board = {"surface": "moodboard", "itemId": "b1"}
    assert _parse({"surface": "moodboard", "board": "b1"}) == (board, {"board": "Desert light"})
    assert _parse({"surface": "moodboard", "board": "Desert light"})[0] == board
    assert _parse({"surface": "moodboard", "board": "  Desert   light "})[0] == board  # whitespace folded
    image = {"surface": "moodboard", "itemId": "b1/i12"}
    names = {"board": "Desert light", "image": 12}
    for ref in ("i12", "12", "#12", 12):
        assert _parse({"surface": "moodboard", "board": "b1", "image": ref}) == (image, names), ref
    # An id wins over a number that reads the same (moodboard_client.find_image).
    odd = [{"id": "b9", "name": "Odd", "images": [{"id": "2"}, {"id": "1"}]}]
    assert parse_surface_target({"surface": "moodboard", "board": "b9", "image": "2"}, odd)[0]["itemId"] == "b9/2"


def test_parts_go_with_their_item_and_their_label_is_the_studios():
    for part in BOARD_PARTS:
        target, names = _parse({"surface": "moodboard", "board": "b1", "part": part})
        assert target == {"surface": "moodboard", "itemId": "b1", "part": part}
        assert names == {"board": "Desert light", "part": PART_LABELS[part]}
    for part in IMAGE_PARTS:
        target, names = _parse({"surface": "moodboard", "board": "b1", "image": 3, "part": part})
        assert target == {"surface": "moodboard", "itemId": "b1/i3", "part": part}
        assert names == {"board": "Desert light", "image": 3, "part": PART_LABELS[part]}
    assert PART_LABELS == {"name": "Name", "direction": "Direction", "avoid": "Avoid", "colors": "Colors",
                           "colors-out": "Colors to keep out", "note": "Note", "weight": "Weight"}


def test_the_anchors_own_item_id_round_trips():
    assert _parse({"surface": "moodboard", "itemId": "b1/i4", "part": "note"})[0] == {
        "surface": "moodboard", "itemId": "b1/i4", "part": "note"}
    assert _parse({"surface": "moodboard", "itemId": "b1"})[0] == {"surface": "moodboard", "itemId": "b1"}


def test_parse_target_takes_the_surface_form_beside_the_other_two():
    nodes = {"n1": {}}
    assert parse_target({"surface": "moodboard", "board": "Dusk"}, nodes, boards=BOARDS) == {
        "surface": "moodboard", "itemId": "b2"}
    assert parse_target({"nodeId": "n1"}, nodes, boards=BOARDS) == {"nodeId": "n1"}
    assert parse_target({"x": 1, "y": 2}, nodes) == {"x": 1.0, "y": 2.0}


# -- parse_target: every refusal, in the house voice -------------------------------

@pytest.mark.parametrize("raw, said", [
    ({"surface": "characters", "board": "b1"},
     "“characters” isn’t a surface Nebula knows. Use moodboard."),
    ({"surface": "moodboard"}, "A moodboard target needs `board`: a board's id or its exact name."),
    ({"surface": "moodboard", "board": 4}, "A moodboard target needs `board`: a board's id or its exact name."),
    ({"surface": "moodboard", "board": "Nope"},
     "No moodboard “Nope” here. The boards here: “Desert light”, “Dusk”, "
     "“Twin”, “Twin”."),
    ({"surface": "moodboard", "board": "Twin"}, "“Twin” names 2 moodboards. Use an id: b3, b4."),
    ({"surface": "moodboard", "board": "b2", "image": 1},
     "Board “Dusk” has no images, so there is no image “1”."),
    ({"surface": "moodboard", "board": "b1", "image": 13},
     "Board “Desert light” has no image “13”. Use its number (1-12) or its id."),
    ({"surface": "moodboard", "board": "b1", "image": 0},
     "Board “Desert light” has no image “0”. Use its number (1-12) or its id."),
    ({"surface": "moodboard", "board": "b1", "image": True}, "target.image must be an image's number or id"),
    ({"surface": "moodboard", "board": "b1", "part": "tint"},
     "“tint” isn’t a part of a board. Use name, direction, avoid, colors or colors-out."),
    ({"surface": "moodboard", "board": "b1", "image": 1, "part": "colors"},
     "“colors” isn’t a part of an image. Use note or weight."),
    ({"surface": "moodboard", "board": "b1", "part": "note"},
     "“note” isn’t a part of a board. Use name, direction, avoid, colors or colors-out."),
    ({"surface": "moodboard", "board": "b1", "nodeId": "n1"},
     "target is a moodboard or a node or a spot, not more than one"),
    ({"surface": "moodboard", "itemId": "b1/i1/x"}, "target.itemId is invalid"),
    ({"surface": "moodboard", "itemId": "b 1"}, "target.itemId is invalid"),
    ({"surface": "moodboard", "itemId": 5}, "target.itemId is invalid"),
])
def test_a_surface_target_refusal_says_what_to_use(raw, said):
    with pytest.raises(PresenceError) as refused:
        _parse(raw)
    assert str(refused.value) == said


def test_a_drag_never_starts_on_a_moodboard():
    with pytest.raises(PresenceError, match="from can't be a moodboard: a drag starts at a node or a spot"):
        parse_target({"surface": "moodboard", "board": "b1"}, {}, "from", boards=BOARDS)


def test_with_no_boards_there_is_nothing_to_point_at():
    with pytest.raises(PresenceError, match="No moodboard “b1” here. There are no moodboards yet."):
        parse_target({"surface": "moodboard", "board": "b1"}, {})


def test_a_long_or_odd_name_is_echoed_cut_and_cleaned():
    with pytest.raises(PresenceError) as refused:
        _parse({"surface": "moodboard", "board": "x" * 200 + "\x1b[31m"})
    assert len(str(refused.value)) < 200 and "\x1b" not in str(refused.value) and "…" in str(refused.value)


# -- AgentPresence with a surface anchor ----------------------------------------------

CLAUDE = identify({"X-Nebula-Agent": "Claude Code"})
BOARD = {"surface": "moodboard", "itemId": "b1"}
IMAGE = {"surface": "moodboard", "itemId": "b1/i3", "part": "note"}
NAMES = {"board": "Desert light", "image": 3, "part": "Note"}


def test_the_event_carries_names_beside_the_anchor_and_active_lists_them():
    presence = AgentPresence(clock=Clock())
    event = presence.point(CLAUDE, target=IMAGE, action="type", names=NAMES)
    assert event["target"] == IMAGE and event["anchorNames"] == NAMES
    row = presence.active()[0]
    assert row["target"] == IMAGE and row["anchorNames"] == NAMES
    # A canvas target never carries names, even if some were given.
    assert "anchorNames" not in presence.point(CLAUDE, target={"nodeId": "n1"}, names=NAMES)
    assert "anchorNames" not in presence.active()[0]


def test_a_surface_anchor_has_no_canvas_point():
    presence = AgentPresence(clock=Clock())
    assert presence._target_point(BOARD, {"b1": {"x": 0.0, "y": 0.0}}) is None
    assert presence._target_point(IMAGE, {}) is None


def test_the_same_spot_is_the_same_anchor():
    from services.agent_presence import _same_spot

    assert _same_spot(BOARD, dict(BOARD))
    assert _same_spot(IMAGE, dict(IMAGE))
    assert not _same_spot(BOARD, IMAGE)  # another item
    assert not _same_spot(IMAGE, {**IMAGE, "part": "weight"})  # another control
    assert not _same_spot(BOARD, {"nodeId": "b1"}) and not _same_spot({"nodeId": "b1"}, BOARD)
    assert not _same_spot({"x": 0.0, "y": 0.0}, BOARD) and not _same_spot(BOARD, {"x": 0.0, "y": 0.0})


def _person(presence, event, session="lane-a"):
    return presence.person_form(event, CLAUDE, session=session)


def test_surface_cursors_are_numbered_like_any_other_and_keep_their_arrival():
    clock = Clock()
    presence = AgentPresence(clock=clock)
    first = _person(presence, presence.point(CLAUDE, target=BOARD, names={"board": "Desert light"}), "lane-a")
    clock.now += 1
    second = _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES), "lane-b")
    assert (first["session"]["ordinal"], second["session"]["ordinal"]) == (1, 2)
    clock.now += 1
    again = _person(presence, presence.point(CLAUDE, target=BOARD, names={"board": "Desert light"}), "lane-a")
    assert again["since"] == first["since"]  # the same anchor: its arrival stays
    moved = _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES), "lane-a")
    assert moved["since"] > first["since"]  # another anchor: it arrives again


def test_a_node_move_leaves_a_surface_cursors_arrival_alone():
    clock = Clock()
    presence = AgentPresence(clock=clock)
    presence.carry_nodes({"n1": {"x": 0, "y": 0}, "n2": {"x": 400, "y": 0}})
    surface = _person(presence, presence.point(CLAUDE, target=BOARD, names={"board": "Desert light"}), "lane-a")
    on_n1 = _person(presence, presence.point(CLAUDE, target={"nodeId": "n1"}), "lane-b")
    _person(presence, presence.point(CLAUDE, target={"nodeId": "n2"}), "lane-c")
    clock.now += 5
    # n1 moves next to n2: the node cursor's chain changes, so it arrives; the surface cursor doesn't.
    updates = presence.carry_nodes({"n1": {"x": 410, "y": 0}, "n2": {"x": 400, "y": 0}})
    assert [update["key"] for update in updates] == [on_n1["session"]["key"]]
    kept = {cursor["session"]["key"]: cursor["since"] for cursor in presence.replay()}
    assert kept[surface["session"]["key"]] == surface["since"]
    # Nothing but a surface cursor: a node move carries nothing at all.
    other = AgentPresence(clock=clock)
    other.carry_nodes({"n1": {"x": 0, "y": 0}})
    _person(other, other.point(CLAUDE, target=BOARD, names={"board": "Desert light"}), "lane-a")
    assert other.carry_nodes({"n1": {"x": 50, "y": 0}}) == []


def test_a_graph_change_leaves_surface_cursors_where_they_are():
    presence = AgentPresence(clock=Clock())
    presence.carry_nodes({"n1": {"x": 0, "y": 0}})
    presence.point(CLAUDE, target=BOARD, names={"board": "Desert light"})
    _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES), "lane-a")
    presence.forget_node("n1")
    presence.forget_graph()
    assert presence.active()[0]["target"] == IMAGE
    assert [cursor["target"] for cursor in presence.replay()] == [IMAGE]


def test_a_line_said_in_place_keeps_the_cursors_surface_names():
    presence = AgentPresence(clock=Clock())
    _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES))
    target, placed = presence.here(CLAUDE)
    assert placed == "cursor" and target == IMAGE
    assert presence.here_names(CLAUDE) == NAMES
    spoken = presence.person_form(presence.point(CLAUDE, target=target, say="Hm", names=NAMES), CLAUDE,
                                  session="lane-a", in_place=True)
    assert spoken["target"] == IMAGE and spoken["anchorNames"] == NAMES
    # A cursor on the canvas has no surface names.
    other = AgentPresence(clock=Clock())
    other.point(CLAUDE, target={"nodeId": "n1"})
    assert other.here_names(CLAUDE) is None


def test_a_replayed_surface_cursor_has_its_anchor_and_names():
    presence = AgentPresence(clock=Clock())
    _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES))
    cursor = presence.replay()[0]
    assert cursor["target"] == IMAGE and cursor["anchorNames"] == NAMES


def test_deleting_a_board_sends_every_cursor_on_it_away_and_frees_their_numbers():
    presence = AgentPresence(clock=Clock())
    _person(presence, presence.point(CLAUDE, target=BOARD, names={"board": "Desert light"}), "lane-a")
    _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES), "lane-b")
    elsewhere = {"surface": "moodboard", "itemId": "b2"}
    kept = _person(presence, presence.point(CLAUDE, target=elsewhere, names={"board": "Dusk"}), "lane-c")
    # The agent's own record (its last event) is on the other board: it stays; both sessions on b1 go.
    assert presence.forget_board("b1") == 0
    assert presence.active()[0]["target"] == elsewhere
    assert [cursor["target"] for cursor in presence.replay()] == [elsewhere]
    assert [number for _, number in presence.live_sessions(CLAUDE.id)] == [3]
    # The first new session takes the lowest free number again.
    fresh = _person(presence, presence.point(CLAUDE, target=BOARD, names={"board": "Desert light"}), "lane-d")
    assert fresh["session"]["ordinal"] == 1 and kept["session"]["ordinal"] == 3
    assert [row["target"] for row in presence.active()] == [BOARD]
    # The agent's own record leaves too when its last event was on the board.
    assert presence.forget_board("b1") == 1 and presence.active() == []


def test_an_image_removed_elsewhere_drops_cursors_to_the_board_and_the_removers_holds():
    clock = Clock()
    presence = AgentPresence(clock=clock)
    codex = identify({"X-Nebula-Agent": "Codex"})
    mine = _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES), "lane-a")
    theirs = presence.person_form(presence.point(codex, target={**IMAGE, "part": "weight"}, names=NAMES), codex,
                                  session="lane-x")
    other_image = {"surface": "moodboard", "itemId": "b1/i7"}
    unrelated = _person(presence, presence.point(CLAUDE, target=other_image, names={"board": "Desert light",
                                                                                      "image": 7}), "lane-b")
    # The Claude lane-a cursor made the removal: it holds. Codex's falls back; lane-b's image stays.
    fell = presence.forget_image("b1", ["i3"], holder=(CLAUDE.id, "lane-a"))
    assert fell == 2  # the codex cursor, and Claude's agent form (a different session than the holder's)
    byKey = {cursor["session"]["key"]: cursor for cursor in presence.replay()}
    assert byKey[mine["session"]["key"]]["target"] == IMAGE
    fallen = byKey[theirs["session"]["key"]]
    assert fallen["target"] == BOARD and fallen["anchorNames"] == {"board": "Desert light"}
    assert byKey[unrelated["session"]["key"]]["target"] == other_image


def test_the_removers_own_agent_form_holds_the_removed_image_too():
    presence = AgentPresence(clock=Clock())
    presence.point(CLAUDE, target=IMAGE, names=NAMES)
    assert presence.forget_image("b1", ["i3"], holder=(CLAUDE.id, "lane-a")) == 0
    assert presence.active()[0]["target"] == IMAGE
    # The same removal made elsewhere drops it to the board.
    assert presence.forget_image("b1", ["i3"], holder=None) == 1
    assert presence.active()[0]["target"] == BOARD


def test_a_removal_by_the_person_drops_every_cursor_on_the_image_to_the_board():
    presence = AgentPresence(clock=Clock())
    first = _person(presence, presence.point(CLAUDE, target=IMAGE, names=NAMES), "lane-a")
    assert presence.forget_image("b1", ["i3"], holder=None) >= 1
    cursor = presence.replay()[0]
    assert cursor["session"]["key"] == first["session"]["key"]
    assert cursor["target"] == BOARD and cursor["anchorNames"] == {"board": "Desert light"}
    # Its arrival stays: where the image was is where the board is.
    assert cursor["since"] == first["since"]
    assert presence.active()[0]["target"] == BOARD


# -- the HTTP route ----------------------------------------------------------------------

def _point(client, target, **body):
    return client.post("/api/canvas/cursor", json={"target": target, **body}, headers=AGENT)


def test_the_route_turns_a_name_and_a_number_into_the_canonical_anchor(api):
    client, sent, presence, _ = api
    board = _create(client)
    image = board["images"][1]
    ok = _point(client, {"surface": "moodboard", "board": "Dusk dunes", "image": "#2", "part": "note"},
                action="type", say="Noting the blue")
    assert ok.status_code == 200, ok.text
    assert ok.json()["target"] == {"surface": "moodboard", "itemId": f"{board['id']}/{image['id']}", "part": "note"}
    assert ok.json()["anchorNames"] == {"board": "Dusk dunes", "image": 2, "part": "Note"}
    event = [event for event in sent if event.get("type") == "agentPresence"][-1]
    assert event["target"] == ok.json()["target"] and event["anchorNames"] == ok.json()["anchorNames"]
    assert event["session"]["ordinal"] == 1 and event["action"] == "type"
    assert presence.active()[0]["target"] == ok.json()["target"]
    # The Agents panel's line: Looked at the board, by name.
    assert _point(client, {"surface": "moodboard", "board": board["id"]}, action="look").status_code == 200
    assert presence.active()[0]["did"]["verb"] == "Looked at" and presence.active()[0]["did"]["label"] == "Dusk dunes"


def test_the_route_refuses_in_the_house_voice(api):
    client, sent, _, _ = api
    _create(client)
    for target, said in [
        ({"surface": "characters", "board": "x"}, "“characters” isn’t a surface Nebula knows. Use moodboard."),
        ({"surface": "moodboard", "board": "Nope"}, "No moodboard “Nope” here. The boards here: “Dusk dunes”."),
        ({"surface": "moodboard", "board": "Dusk dunes", "part": "weight"},
         "“weight” isn’t a part of a board. Use name, direction, avoid, colors or colors-out."),
    ]:
        refused = _point(client, target)
        assert refused.status_code == 422 and refused.json()["detail"] == said, refused.text
    # A drag can't start on a board.
    drag = client.post("/api/canvas/cursor", headers=AGENT, json={
        "target": {"x": 1, "y": 2}, "from": {"surface": "moodboard", "board": "Dusk dunes"}, "action": "drag"})
    assert drag.status_code == 422 and "from can't be a moodboard" in drag.json()["detail"]
    assert [event for event in sent if event.get("type") == "agentPresence"] == []


def test_a_line_said_in_place_on_a_board_keeps_the_cursor_and_its_names(api):
    client, sent, _, _ = api
    _create(client)
    assert _point(client, {"surface": "moodboard", "board": "Dusk dunes"}).status_code == 200
    said = client.post("/api/canvas/cursor", headers=AGENT, json={"say": "Still here"})
    assert said.status_code == 200 and said.json()["placed"] == "cursor"
    assert said.json()["target"] == {"surface": "moodboard", "itemId": _create_id(client)}
    event = [event for event in sent if event.get("type") == "agentPresence"][-1]
    assert event["target"]["surface"] == "moodboard" and event["anchorNames"] == {"board": "Dusk dunes"}


def _create_id(client) -> str:
    return client.get("/api/moodboards").json()[0]["id"]


# -- MCP --------------------------------------------------------------------------------

@pytest.fixture
def mcp_calls(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(mcp_server, "_canvas_call",
                        lambda method, path, ctx, **kwargs: calls.append(kwargs["json"]) or {"placed": "target"})
    return calls


def test_point_at_a_moodboard_sends_one_surface_target(mcp_calls):
    mcp_server.point_at(moodboard="Desert light", image=12, part="note", say="Noting", action="type")
    mcp_server.point_at(moodboard="Desert light")
    mcp_server.point_at(moodboard="b1", image="#3", part="weight", action="click")
    assert mcp_calls == [
        {"target": {"surface": "moodboard", "board": "Desert light", "image": 12, "part": "note"},
         "say": "Noting", "action": "type"},
        {"target": {"surface": "moodboard", "board": "Desert light"}, "say": "", "action": "move"},
        {"target": {"surface": "moodboard", "board": "b1", "image": "#3", "part": "weight"}, "say": "",
         "action": "click"},
    ]


@pytest.mark.parametrize("kwargs, said", [
    ({"moodboard": "b1", "node_id": "n1"}, "point_at: moodboard can't be combined with node_id."),
    ({"moodboard": "b1", "x": 1.0, "y": 2.0}, "point_at: moodboard can't be combined with x, y."),
    ({"moodboard": "b1", "node_id": "n1", "port": "text"}, "point_at: moodboard can't be combined with node_id, port."),
    ({"moodboard": "b1", "from_node_id": "n1", "action": "drag"},
     "point_at: moodboard can't be combined with from_node_id."),
    ({"image": 3}, "point_at: image and part need moodboard (its id or exact name)"),
    ({"part": "note"}, "point_at: image and part need moodboard (its id or exact name)"),
])
def test_point_at_a_moodboard_is_exclusive_with_a_node_or_a_spot(mcp_calls, kwargs, said):
    with pytest.raises(ValueError) as refused:
        mcp_server.point_at(**kwargs)
    assert str(refused.value).startswith(said)
    assert mcp_calls == []


def test_point_at_says_it_never_opens_or_scrolls():
    doc = mcp_server.point_at.__doc__
    assert "never opens a panel or scrolls" in doc and "moodboard" in doc and "`part`" in doc


def test_the_in_app_agents_get_the_same_tool():
    """krea_agent_mcp.NEBULA_MCP_TOOLS lists point_at, and the tool it names is the one that takes these."""
    from services.krea_agent_mcp import NEBULA_MCP_TOOLS

    import asyncio

    assert "point_at" in NEBULA_MCP_TOOLS
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    assert {"moodboard", "image", "part"} <= set(tools["point_at"].inputSchema["properties"])


# -- CLI --------------------------------------------------------------------------------

def _cli(monkeypatch, *argv):
    from cli import __main__ as cli_main

    monkeypatch.setattr(sys, "argv", ["nebula", "point", *argv])
    err = io.StringIO()
    with redirect_stderr(err), pytest.raises(SystemExit) as stopped:
        cli_main.main()
    assert stopped.value.code == 2
    return err.getvalue().strip().splitlines()[-1]


def test_nebula_point_moodboard_with_a_target_is_a_parser_error(monkeypatch):
    last = _cli(monkeypatch, "n2", "--moodboard", "Desert light")
    assert last.startswith("nebula point: error: --moodboard is a target of its own") and "'n2'" in last
    assert _cli(monkeypatch, "--moodboard", "Desert light", "--from", "n2").endswith(
        "--from can't go with --moodboard: a drag starts at a node or a spot")
    assert _cli(monkeypatch, "--image", "12").endswith("--image and --part go with --moodboard BOARD (its id or exact name)")
    assert _cli(monkeypatch, "--part", "note").startswith("nebula point: error: --image and --part go with")


def test_nebula_point_moodboard_sends_the_surface_target_and_prints_where(monkeypatch):
    from cli.__main__ import build_parser
    from cli.commands import canvas

    args = build_parser().parse_args(["point", "--moodboard", "Desert light", "--image", "12", "--part", "note",
                                      "--action", "type", "--say", "Noting"])
    assert (args.moodboard, args.image, args.part, args.target) == ("Desert light", "12", "note", None)

    class Client:
        body = None

        def point_cursor(self, body, agent_name=None):
            Client.body = body
            return {"agent": {"name": "Claude"}, "say": "Noting",
                    "anchorNames": {"board": "Desert light", "image": 12, "part": "Note"}}

    out = io.StringIO()
    with redirect_stdout(out):
        canvas.run_point(Client(), None, say="Noting", action="type", moodboard="Desert light", image="12",
                         part="note")
    assert Client.body == {"target": {"surface": "moodboard", "board": "Desert light", "image": "12",
                                      "part": "note"}, "say": "Noting", "action": "type"}
    assert out.getvalue().strip() == "Claude → moodboard “Desert light”, image 12 (note): Noting"


# -- the formatter ------------------------------------------------------------------------

def test_look_and_start_name_a_cursor_on_a_moodboard_item():
    from cli import formatter

    target = {"surface": "moodboard", "itemId": "b1/i12", "part": "note"}
    names = {"board": "Desert light", "image": 12, "part": "Note"}
    assert formatter._surface_words(target, names) == "moodboard “Desert light”, image 12 (note)"
    assert formatter._surface_words({"surface": "moodboard", "itemId": "b1"}, {"board": "Desert light"}) == \
        "moodboard “Desert light”"
    # Without names (an older backend), the ids.
    assert formatter._surface_words(target, None) == "moodboard b1, image i12 (note)"

    start = formatter.format_start({"canvas": {"project": {"id": "p", "name": "P"}, "nodeCount": 0,
                                               "agents": [{"name": "Claude", "target": target, "anchorNames": names}]}}) \
        if hasattr(formatter, "format_start") else None
    if start is not None:
        assert "  Claude's cursor is on moodboard “Desert light”, image 12 (note)" in start


def test_agent_start_passes_the_names_along():
    from services import agent_start

    part = agent_start.canvas_part(
        {"agents": [{"id": "x", "name": "Claude", "target": BOARD, "anchorNames": {"board": "Desert light"},
                     "secondsAgo": 1.0},
                    {"id": "y", "name": "Codex", "target": {"nodeId": "n1"}, "secondsAgo": 2.0}]},
        project=None, caller_id=None, via="mcp")
    assert part["agents"][0]["anchorNames"] == {"board": "Desert light"}
    assert "anchorNames" not in part["agents"][1]
