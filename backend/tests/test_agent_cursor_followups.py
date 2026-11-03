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
