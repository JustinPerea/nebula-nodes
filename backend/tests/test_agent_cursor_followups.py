"""Agent cursors, the #211 follow-up (review 9, GM - Design r23).

- r23 item 2, as GM r24 Q2 rules it (#219): a node move is an arrival for a
  cursor on it only when it changes the cursor's target chain (the other
  cursors linked to it through targets 16 canvas units apart). The backend
  gives it a new arrival time, keeps the order of the cursors one move
  carries, and tells the person's tabs (only them), so every tab and a
  reload stack it the same way. Every route that moves nodes does it
  (#219 review 1, MEDIUM-1): the layout route, apply and undo/redo.
- LOW-1: the arrival radius is measured from where the cursor arrived, so a
  run of small moves can't keep an early arrival over any distance.
- LOW-2 / NIT-3: arrivals strictly increase, so two sessions never tie and a
  clock stepped back never puts a new arrival first.
- LOW-5: each person form has an id the Agent log de-dupes on; agents read
  exactly what they read before.
"""
from __future__ import annotations

import json

from services.agent_presence import ARRIVAL_RADIUS, AgentPresence
from tests.conftest import PERSON
from tests.test_agent_cursor_sessions import (  # noqa: F401 - fixtures
    AGENT,
    CLAUDE,
    Clock,
    _event,
    _presence_frames,
    api,
    sockets,
)


def _form(presence: AgentPresence, raw: str, target: dict, say: str = "") -> dict:
    return presence.person_form(_event(presence, target, say=say), AGENT, session=raw)


# -- LOW-1: no creep -----------------------------------------------------------

def test_small_moves_cannot_keep_an_arrival_over_any_distance():
    """Review 9's probe: 29 moves of 15 px kept the first arrival over 435 px.
    Each move is measured from where the cursor arrived, so it arrives again
    once it is more than ARRIVAL_RADIUS from there."""
    clock = Clock()
    presence = AgentPresence(clock)
    first = _form(presence, "s1", {"x": 0, "y": 0})["since"]
    arrivals = {first}
    anchor = 0.0
    for step in range(1, 30):
        clock.now += 1
        x = 15.0 * step
        since = _form(presence, "s1", {"x": x, "y": 0})["since"]
        if x - anchor > ARRIVAL_RADIUS:
            assert since > max(arrivals - {since})  # arrived again here
            anchor = x
        arrivals.add(since)
    # 435 px in 15 px steps: a new arrival every second step, never the first.
    assert len(arrivals) == 15
    assert _form(presence, "s1", {"x": 435, "y": 0})["since"] != first
    # It last arrived at x=420: nudges either way within the radius of that
    # spot keep it.
    assert anchor == 420
    kept = _form(presence, "s1", {"x": 420 - ARRIVAL_RADIUS, "y": 0})["since"]
    assert _form(presence, "s1", {"x": 420 + ARRIVAL_RADIUS, "y": 0})["since"] == kept


# -- LOW-2 / NIT-3: strictly increasing ----------------------------------------

def test_arrivals_in_one_millisecond_or_after_the_clock_steps_back_still_come_in_order():
    clock = Clock()
    presence = AgentPresence(clock)
    sinces = [_form(presence, f"s{i}", {"nodeId": "n1"})["since"] for i in range(5)]
    assert sinces == sorted(sinces) and len(set(sinces)) == 5
    clock.now -= 60  # an NTP step back
    later = _form(presence, "s5", {"nodeId": "n2"})["since"]
    assert later > max(sinces)
    replayed = sorted(c["since"] for c in presence.replay())
    assert replayed == sorted([*sinces, later])


# -- r24 Q2: a carry is an arrival when it changes the target chain --------------

def _boxes(**nodes: tuple[float, float]) -> dict:
    return {node_id: {"x": x, "y": y} for node_id, (x, y) in nodes.items()}


def test_a_whole_node_moving_with_its_cursors_keeps_their_places_however_far():
    clock = Clock()
    presence = AgentPresence(clock)
    assert presence.carry_nodes(_boxes(n1=(0, 0), n2=(600, 0))) == []  # the first sync: nothing to compare
    a = _form(presence, "a", {"nodeId": "n1"})["since"]
    clock.now += 1
    b = _form(presence, "b", {"nodeId": "n1"})["since"]
    for x in (200, 420, 30):  # far, farther, back: always the same chain {a, b}
        assert presence.carry_nodes(_boxes(n1=(x, 0), n2=(600, 0))) == []
    assert {r["session"]["ordinal"]: r["since"] for r in presence.replay()} == {1: a, 2: b}


def test_a_move_into_another_chain_makes_the_carried_cursors_arrive_now_in_their_order_and_leaving_it_again():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.carry_nodes(_boxes(n1=(0, 0), n2=(600, 0)))
    a = _form(presence, "a", {"nodeId": "n1"})["since"]
    clock.now += 1
    b = _form(presence, "b", {"nodeId": "n1"})["since"]
    clock.now += 1
    c = _form(presence, "c", {"nodeId": "n2"})["since"]
    clock.now += 1
    # n1 onto n2's spot (10 units off): a and b now chain with c. They
    # arrive now, a still before b; c, not carried, keeps its arrival.
    updates = presence.carry_nodes(_boxes(n1=(590, 0), n2=(600, 0)))
    assert [u["ordinal"] for u in updates] == [1, 2]
    assert updates[0]["since"] < updates[1]["since"]
    assert all(u["since"] > c > b > a for u in updates)
    assert {tuple(sorted(u)) for u in updates} == {("agentId", "key", "ordinal", "since")}
    # The replay (a reload) has the same.
    replayed = {r["session"]["ordinal"]: r["since"] for r in presence.replay()}
    assert replayed == {1: updates[0]["since"], 2: updates[1]["since"], 3: c}
    # Its own next event on the node keeps the new arrival.
    assert _form(presence, "a", {"nodeId": "n1"}, say="Still here")["since"] == updates[0]["since"]
    # A nudge within the chain: nothing.
    assert presence.carry_nodes(_boxes(n1=(596, 0), n2=(600, 0))) == []
    # Dragged away again: the chain loses c, so they arrive again.
    clock.now += 1
    again = presence.carry_nodes(_boxes(n1=(0, 0), n2=(600, 0)))
    assert [u["ordinal"] for u in again] == [1, 2] and again[0]["since"] > updates[1]["since"]
    # n2 moved: c is carried out of no chain into none, so it keeps its place.
    assert presence.carry_nodes(_boxes(n1=(0, 0), n2=(900, 0))) == []


def test_a_move_onto_a_point_cursor_joins_its_chain():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.carry_nodes(_boxes(n1=(0, 0)))
    _form(presence, "p", {"x": 300.0, "y": 0.0})
    clock.now += 1
    _form(presence, "a", {"nodeId": "n1"})
    clock.now += 1
    # 20 units off p: past the 16-unit link, still no chain.
    assert presence.carry_nodes(_boxes(n1=(280, 0))) == []
    # 10 units off: it joins p's chain.
    (update,) = presence.carry_nodes(_boxes(n1=(290, 0)))
    assert update["ordinal"] == 2


def test_a_drag_its_undo_and_the_drag_again_is_no_arrival():
    """Review 1, MEDIUM-1's side effect: the old running total of carried
    distance went stale across an undo (+10, -10 uncounted, +10 = 20 > 16).
    The chain is read from where things are, so nothing builds up."""
    clock = Clock()
    presence = AgentPresence(clock)
    presence.carry_nodes(_boxes(n1=(0, 0)))
    _form(presence, "q", {"x": 40.0, "y": 0.0})  # 40 units away: no chain
    clock.now += 1
    _form(presence, "a", {"nodeId": "n1"})
    for x in (10, 0, 10):  # drag, undo, drag again: 30 units from q at the most
        assert presence.carry_nodes(_boxes(n1=(x, 0))) == []


def test_a_replaced_or_cleared_graph_forgets_the_positions():
    clock = Clock()
    presence = AgentPresence(clock)
    presence.carry_nodes(_boxes(n1=(0, 0), n2=(600, 0)))
    _form(presence, "c", {"nodeId": "n2"})
    _form(presence, "a", {"nodeId": "n1"})
    assert presence.carry_nodes(None) == []
    # The next graph's n1 sits on n2: that is no move of the old n1.
    assert presence.carry_nodes(_boxes(n1=(600, 0), n2=(600, 0))) == []
    # forget_graph (a project opened) forgets them too.
    presence.carry_nodes(_boxes(n1=(0, 0), n2=(600, 0)))
    _form(presence, "a", {"nodeId": "n1"})
    presence.forget_graph()
    _form(presence, "c", {"nodeId": "n2"})
    _form(presence, "a", {"nodeId": "n1"})
    assert presence.carry_nodes(_boxes(n1=(600, 0), n2=(600, 0))) == []


def test_a_node_target_is_its_header_middle_as_the_tab_draws_it():
    """With the view report's size, a node points where the tab points:
    across its middle, 44 down (agentCursorMotion.resolveAnchor)."""
    clock = Clock()
    presence = AgentPresence(clock)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1},
                          "nodes": [{"id": "n1", "x": 0, "y": 0, "width": 200, "height": 120}]})
    presence.carry_nodes(_boxes(n1=(0, 0)))
    _form(presence, "p", {"x": 400.0, "y": 44.0})
    clock.now += 1
    _form(presence, "a", {"nodeId": "n1"})
    clock.now += 1
    # The corner 110 units right of n1's old corner: its middle is at 310 +
    # 100 = 410, 10 from p. Measured from its corner it would be 90 away.
    (update,) = presence.carry_nodes(_boxes(n1=(310, 0)))
    assert update["ordinal"] == 2


def test_a_deleted_nodes_cursor_keeps_its_arrival_at_the_point_it_falls_back_to():
    """Review 1, LOW-2: forget_node moves the anchor to the fallback point,
    so the next event there is no new arrival."""
    clock = Clock()
    presence = AgentPresence(clock)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1},
                          "nodes": [{"id": "n1", "x": 0, "y": 0, "width": 200, "height": 120}]})
    since = _form(presence, "a", {"nodeId": "n1"})["since"]
    presence.forget_node("n1")
    clock.now += 1
    assert _form(presence, "a", {"x": 100.0, "y": 60.0})["since"] == since


def _timeless(value):
    if isinstance(value, dict):
        return {k: _timeless(v) for k, v in value.items() if k not in ("secondsAgo", "activeSecondsAgo")}
    if isinstance(value, list):
        return [_timeless(v) for v in value]
    return value


def _agent_reads(api) -> list[str]:
    """The cursors as agents read them (the nodes moved, and time passed:
    those parts are left out; so is the moving agent's own cursor, "Mover",
    which its apply shows as it would on main)."""
    snapshot = api.client.get("/api/canvas/snapshot", headers=CLAUDE).json()
    agents = api.client.get("/api/canvas/agents", headers=CLAUDE).json()
    for text in (json.dumps(snapshot), json.dumps(agents)):
        assert '"since"' not in text and '"eventId"' not in text and '"ordinal"' not in text

    def others(value):
        if isinstance(value, list):
            return [others(v) for v in value if '"Mover"' not in json.dumps(v)]
        if isinstance(value, dict):
            return {k: others(v) for k, v in value.items()}
        return value

    return [json.dumps(_timeless(others(snapshot.get("agents"))), sort_keys=True),
            json.dumps(_timeless(others(agents)), sort_keys=True)]


def _two_nodes_with_cursors(api) -> tuple[str, str]:
    """n1 at (0, 0) with lane-a and lane-b on it, n2 at (600, 0) with lane-c."""
    n1 = api.graph.add_node("text-input", {"value": "hi"})
    n2 = api.graph.add_node("text-input", {"value": "hi"})
    laid = api.client.put("/api/graph/layout", headers=PERSON,
                          json={"positions": {n1: {"x": 0, "y": 0}, n2: {"x": 600, "y": 0}}})
    assert laid.status_code == 200, laid.text
    for lane, node in (("lane-a", n1), ("lane-b", n1), ("lane-c", n2)):
        api.client.post("/api/canvas/cursor", headers={**CLAUDE, "X-Nebula-Agent-Session": lane},
                        json={"target": {"nodeId": node}, "action": "look"})
        api.presence_clock.now += 1
    return n1, n2


def _sessions(api) -> dict[int, int]:
    return {c["session"]["ordinal"]: c["since"] for c in api.main.agent_presence.replay()
            if c.get("session") and c["agent"]["name"] != "Mover"}


def _moved_carries_n1_onto_n2(api, move) -> None:
    """``move`` puts n1 next to n2 by some route. lane-a and lane-b arrive
    now, in their order, after lane-c; only the person's tabs hear it; agents
    read what they did; and the replay (a reload) agrees."""
    before = _agent_reads(api)
    before_replay = _sessions(api)
    api.person_socket.sent.clear()
    api.listener.sent.clear()
    api.presence_clock.now += 1
    move()
    person = [json.loads(t) for t in api.person_socket.sent]
    (arrival,) = [m for m in person if m["type"] == "agentPresenceArrival"]
    assert [c["ordinal"] for c in arrival["cursors"]] == [1, 2]
    assert all(c["since"] > before_replay[3] for c in arrival["cursors"])
    assert all(json.loads(t)["type"] != "agentPresenceArrival" for t in api.listener.sent)
    for text in api.listener.sent:
        assert '"since"' not in text and '"eventId"' not in text
    assert _agent_reads(api) == before
    after = _sessions(api)
    assert after[1] == arrival["cursors"][0]["since"] and after[2] == arrival["cursors"][1]["since"]
    assert after[3] == before_replay[3]


def test_the_layout_route_carries_tells_only_the_persons_tabs_and_agents_read_what_they_did(sockets):
    """The person's drop, an arrange, `nebula move`: PUT /api/graph/layout."""
    api = sockets
    n1, n2 = _two_nodes_with_cursors(api)
    # A whole-node move far from n2 first: no chain changes, no arrival.
    api.person_socket.sent.clear()
    assert api.client.put("/api/graph/layout", headers=PERSON,
                          json={"positions": {n1: {"x": 0, "y": 300}}}).status_code == 200
    assert all(json.loads(t)["type"] != "agentPresenceArrival" for t in api.person_socket.sent)
    _moved_carries_n1_onto_n2(api, lambda: api.client.put(
        "/api/graph/layout", headers=PERSON, json={"positions": {n1: {"x": 590, "y": 0}}}).raise_for_status())


def test_an_apply_move_carries_too(sockets):
    """An agent's `nebula apply` or edit_canvas move: POST /api/graph/apply."""
    api = sockets
    n1, _ = _two_nodes_with_cursors(api)
    _moved_carries_n1_onto_n2(api, lambda: api.client.post(
        "/api/graph/apply", headers={"X-Nebula-Agent": "Mover"},
        json={"move": {n1: {"x": 590, "y": 0}}}).raise_for_status())


def test_an_undo_or_redo_that_moves_a_node_carries_too(sockets):
    """The person's Cmd+Z or redo of a move: POST /api/graph/restore."""
    api = sockets
    n1, _ = _two_nodes_with_cursors(api)
    _moved_carries_n1_onto_n2(api, lambda: api.client.post(
        "/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
            {"id": n1, "definitionId": "text-input", "params": {"value": "hi"}, "position": {"x": 590, "y": 0}}]}).raise_for_status())


def test_every_position_write_in_main_goes_out_in_a_graph_sync_that_carries():
    """The carry has one home, _broadcast_graph_sync: a new route that moves
    nodes can't miss it. Each update_positions caller syncs, and no route
    calls the carry itself."""
    import inspect

    import main

    source = inspect.getsource(main)
    assert source.count("await _carry_cursors(") == 1
    assert "await _carry_cursors(" in inspect.getsource(main._broadcast_graph_sync)
    callers = [name for name, fn in vars(main).items()
               if inspect.iscoroutinefunction(fn) and getattr(fn, "__module__", "") == "main"
               and "update_positions(" in inspect.getsource(fn)]
    assert sorted(callers) == ["_restore_graph", "apply_graph_edit", "update_graph_layout"]
    for name in callers:
        assert "_broadcast_graph_sync(" in inspect.getsource(getattr(main, name))


# -- LOW-5: the log's event id ---------------------------------------------------

def test_each_person_form_has_its_own_id_the_replay_keeps_it_and_agents_never_see_it(sockets):
    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    body = {"target": {"nodeId": node}, "action": "look", "say": "Added “Image”"}
    for _ in range(2):  # a real repeat, same words, same millisecond
        assert api.client.post("/api/canvas/cursor", headers=CLAUDE, json=body).status_code == 200
    forms = [json.loads(t) for t in _presence_frames(api.person_socket)]
    ids = [f["eventId"] for f in forms]
    assert len(ids) == 2 and ids[0] != ids[1]
    assert forms[0]["at"] == forms[1]["at"] and forms[0]["say"] == forms[1]["say"]
    (replayed,) = api.main.agent_presence.replay()
    assert replayed["eventId"] == ids[1]
    for text in _presence_frames(api.listener):
        assert "eventId" not in json.loads(text)
    # Two boots never share an id.
    assert AgentPresence(Clock())._event_id() != AgentPresence(Clock())._event_id()


# -- #219 r47 copy: an apply's say on the person's tabs ------------------------

def test_an_edits_say_names_what_each_count_is_of():
    from main import _edit_say

    assert _edit_say([("moved", 1, "node")]) == "Moved 1 node"
    assert _edit_say([("moved", 3, "node")]) == "Moved 3 nodes"
    assert _edit_say([("added", 2, "node"), ("added", 1, "connection"), ("moved", 1, "node"),
                      ("removed", 0, "node"), ("removed", 2, "connection")]) == \
        "Added 2 nodes and 1 connection, moved 1 node, removed 2 connections"
    assert _edit_say([("made", 1, "placeholder"), ("made", 2, "node", " ready")]) == "Made 1 placeholder and 2 nodes ready"
    assert _edit_say([("moved", 0, "node")]) == "No change"


def test_an_apply_says_moved_1_node_to_the_person_and_agents_read_what_they_did(sockets):
    """GM r47's copy check: the bubble after an agent's apply is Nebula's
    own words, so the person's tabs (and a reload) get person copy. Agents
    still read the apply's summary, word for word."""
    api = sockets
    n1 = api.graph.add_node("text-input", {"value": "hi"})
    api.person_socket.sent.clear()
    api.listener.sent.clear()
    reply = api.client.post("/api/graph/apply", headers=CLAUDE, json={"move": {n1: {"x": 300, "y": 40}}})
    assert reply.status_code == 200, reply.text
    assert reply.json()["summary"] == "moved 1"
    (person,) = [json.loads(t) for t in _presence_frames(api.person_socket)]
    (agent,) = [json.loads(t) for t in _presence_frames(api.listener)]
    # The Agent log keeps the line naming the node (#225, GM r83.1); the
    # bubble has the person's words.
    assert person["say"] == "Moved 1 node" and person["log"] == "Moved “Text Input”"
    assert agent["say"] == "moved 1"
    (replayed,) = api.main.agent_presence.replay()
    assert replayed["say"] == "Moved 1 node"


def test_the_shared_chain_fixture_backend_side():
    """GM r47: one chain definition. The same cases run through the tab's
    chainPoint and targetChains (frontend/tests/agentCursorLook.test.ts).
    Each target goes through the backend's own _target_point, with the
    nodes' sizes from a view report at the case's zoom: a port counts as its
    node's header middle (r62), and the zoom changes no chain."""
    from pathlib import Path

    from services.agent_presence import _target_chains

    cases = json.loads((Path(__file__).parent / "fixtures" / "cursor_chains.json").read_text())["cases"]
    assert len(cases) >= 11
    assert any("handle" in t for c in cases for t in c["targets"].values())
    assert {c.get("zoom", 1) for c in cases} >= {0.5, 1, 2}
    for case in cases:
        presence = AgentPresence(Clock())
        boxes, seen, targets = {}, [], {}
        for key, target in case["targets"].items():
            node = target.get("node")
            if node is None:
                targets[key] = {"x": target["x"], "y": target["y"]}
                continue
            node_id = f"node-{key}"
            boxes[node_id] = {"x": float(node["x"]), "y": float(node["y"])}
            seen.append({"id": node_id, "x": node["x"], "y": node["y"], "width": node["width"], "height": node["height"]})
            targets[key] = {"nodeId": node_id, **({"handle": target["handle"]} if "handle" in target else {})}
        presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": case.get("zoom", 1)}, "nodes": seen})
        points = {key: presence._target_point(target, boxes) for key, target in targets.items()}
        chains = {key: sorted(chain) for key, chain in _target_chains(points).items()}
        assert chains == case["chains"], case["name"]


def test_the_shared_carry_traces_backend_side():
    """GM r75.3: the drop's arrival on the traces the tab runs too
    (frontend/tests/agentCursorLayer.test.tsx). a, arrived first, rides n2;
    h, arrived second, points at a port on n1. Dropped at each point of the
    path, a arrives (its chain changes) exactly from ``arrivalFrom`` on: never
    onto h's drawn tip, which counts at n1's header (r62), and onto the header
    once within ARRIVAL_RADIUS of it. h never arrives (n1 didn't move). With no
    arrival a keeps its place: plain arrival order, which is what the tab
    lays out for a drawn overlap during the drag too."""
    from pathlib import Path

    traces = json.loads((Path(__file__).parent / "fixtures" / "cursor_chains.json").read_text())["traces"]
    assert {t["zoom"] for t in traces} == {0.1, 0.25, 0.5, 1, 2}
    # r85: a left input near the header (y 62) at 0.25, 0.5 and 1.
    assert sorted(t["zoom"] for t in traces if t["h"]["port"]["x"] < 0 and t["h"]["port"]["y"] == 62) == [0.25] * 3 + [0.5] * 3 + [1] * 3
    assert sum(t["arrivalFrom"] is None for t in traces) >= 9
    assert sum(t["arrivalFrom"] is not None for t in traces) >= 3
    for trace in traces:
        h_node, carry, path = trace["h"]["node"], trace["carry"], trace["path"]
        arrived_at = []
        for i, (x, y) in enumerate(path):
            clock = Clock()
            presence = AgentPresence(clock)
            presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": trace["zoom"]}, "nodes": [
                {"id": "n1", "x": h_node["x"], "y": h_node["y"], "width": h_node["width"], "height": h_node["height"]},
                {"id": "n2", "x": path[0][0], "y": path[0][1], "width": carry["width"], "height": carry["height"]},
            ]})
            assert presence.carry_nodes(_boxes(n1=(h_node["x"], h_node["y"]), n2=tuple(path[0]))) == []
            a = _form(presence, "a", {"nodeId": "n2"})
            clock.now += 1
            h = _form(presence, "h", {"nodeId": "n1", "handle": trace["h"]["handle"]})
            clock.now += 1
            updates = presence.carry_nodes(_boxes(n1=(h_node["x"], h_node["y"]), n2=(x, y)))
            keys = {u["key"] for u in updates}
            assert h["session"]["key"] not in keys, trace["name"]
            if a["session"]["key"] in keys:
                arrived_at.append(i)
        expected = [] if trace["arrivalFrom"] is None else list(range(trace["arrivalFrom"], len(path)))
        assert arrived_at == expected, trace["name"]


# -- #219 review 2 (round 3c) ----------------------------------------------------

def test_an_expired_cursor_joins_no_chain():
    """Review 2, LOW-2 B5: a cursor past PRESENCE_TTL_SECONDS is gone from
    every tab, so a carry onto where it was is no arrival, even before any
    new event clears its slot."""
    from services.agent_presence import PRESENCE_TTL_SECONDS

    clock = Clock()
    presence = AgentPresence(clock)
    presence.carry_nodes(_boxes(n1=(0, 0)))
    _form(presence, "q", {"x": 300.0, "y": 0.0})
    clock.now += 100
    _form(presence, "a", {"nodeId": "n1"})
    # q's last event is now past the TTL, a's isn't; no event since.
    clock.now += PRESENCE_TTL_SECONDS - 90
    # 10 units off q's old point: q expired, so a's chain is still empty.
    assert presence.carry_nodes(_boxes(n1=(290, 0))) == []
    # A live q there links (the same move, the control).
    assert presence.carry_nodes(_boxes(n1=(0, 0))) == []  # back out of its reach
    _form(presence, "q", {"x": 300.0, "y": 0.0})
    clock.now += 1
    (update,) = presence.carry_nodes(_boxes(n1=(290, 0)))
    assert update["key"] == next(c["session"]["key"] for c in presence.replay() if c["target"] == {"nodeId": "n1"})


def test_a_node_with_no_stored_position_keeps_its_box_when_its_siblings_shift_it():
    """Review 2, LOW-3: main._display_positions puts a node with no stored
    position right of the others, so its computed spot shifts when a sibling
    gets a position or is deleted. An open canvas doesn't move it for that,
    so the carry doesn't either: no false arrival. Its first stored position
    is a move like any other."""
    clock = Clock()
    presence = AgentPresence(clock)
    # B and C unplaced, at 300 and 600 (y 100).
    presence.carry_nodes(_boxes(n0=(0, 900), B=(300, 100), C=(600, 100)), placed={"n0"})
    _form(presence, "c", {"nodeId": "C"})
    clock.now += 1
    _form(presence, "q", {"x": 355.0, "y": 100.0})  # 5 from where C would be computed next
    clock.now += 1
    # B placed at (50, 500): C's computed spot is now 350. Not a move.
    assert presence.carry_nodes(_boxes(n0=(0, 900), B=(50, 500), C=(350, 100)), placed={"n0", "B"}) == []
    # B deleted: still not a move.
    assert presence.carry_nodes(_boxes(n0=(0, 900), C=(300, 100)), placed={"n0"}) == []
    # C's first stored position, next to q: a move into q's chain.
    (update,) = presence.carry_nodes(_boxes(n0=(0, 900), C=(350, 100)), placed={"n0", "C"})
    assert update["ordinal"] == 1
    # Without `placed` (every position stored, the old call), a box moves as given.
    assert presence.carry_nodes(_boxes(n0=(0, 900), C=(600, 100))) != []


def test_a_sibling_placed_by_the_layout_route_moves_no_unplaced_node(sockets):
    """LOW-3 through main: the person's first drag of agent-made node B
    stores its position; agent-made C, never placed, is computed 250 units
    left now, next to q. No arrival: the canvas never moved C."""
    api = sockets
    n0 = api.graph.add_node("text-input", {"value": "hi"})
    b = api.graph.add_node("text-input", {"value": "hi"})
    c = api.graph.add_node("text-input", {"value": "hi"})
    assert api.client.put("/api/graph/layout", headers=PERSON,
                          json={"positions": {n0: {"x": 0, "y": 900}}}).status_code == 200
    shown = api.main._display_positions(list(api.main.cli_graph.nodes.values()))
    assert shown[c] == {"x": 600.0, "y": 100.0}
    for lane, target in (("lane-c", {"nodeId": c}), ("lane-q", {"x": 355.0, "y": 100.0})):
        api.client.post("/api/canvas/cursor", headers={**CLAUDE, "X-Nebula-Agent-Session": lane},
                        json={"target": target, "action": "look"})
        api.presence_clock.now += 1
    api.person_socket.sent.clear()
    assert api.client.put("/api/graph/layout", headers=PERSON,
                          json={"positions": {b: {"x": 50, "y": 500}}}).status_code == 200
    assert api.main._display_positions(list(api.main.cli_graph.nodes.values()))[c] == {"x": 350.0, "y": 100.0}
    assert all(json.loads(t)["type"] != "agentPresenceArrival" for t in api.person_socket.sent)


def test_a_person_say_takes_the_log_out_of_the_person_form_only(sockets):
    """Review 2, LOW-2 B7: with ``person_say``, the person's tabs show it as
    the bubble; agents read ``say`` and ``log`` as before. The person's form
    keeps a ``log`` that says something else (the nodes an edit named, #225
    GM r83.1) and drops one that would repeat the bubble."""
    import asyncio

    from services.agent_presence import request_headers_scope

    api = sockets
    node = api.graph.add_node("text-input", {"value": "hi"})
    with request_headers_scope(CLAUDE):
        asyncio.run(api.main._show_agent({"nodeId": node}, say="moved 1", log="Moved the prompt",
                                         person_say="Moved 1 node"))
        asyncio.run(api.main._show_agent({"nodeId": node}, say="moved 1", log="Moved 1 node",
                                         person_say="Moved 1 node"))
    kept, same = [json.loads(t) for t in _presence_frames(api.person_socket)]
    agent = json.loads(_presence_frames(api.listener)[0])
    assert kept["say"] == "Moved 1 node" and kept["log"] == "Moved the prompt"
    assert same["say"] == "Moved 1 node" and "log" not in same
    assert agent["say"] == "moved 1" and agent["log"] == "Moved the prompt"
