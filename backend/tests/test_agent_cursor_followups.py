"""Agent cursors, the #211 follow-up (review 9, GM - Design r23).

- r23 item 2: a node move that carries a cursor past its arrival radius is
  an arrival: the backend gives it a new arrival time, keeps the order of
  the cursors one move carries, and tells the person's tabs (only them), so
  every tab and a reload stack it the same way.
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


# -- r23 item 2: a carry is an arrival ------------------------------------------

def test_a_node_carrying_its_cursors_past_the_radius_makes_them_arrive_now_in_their_order():
    clock = Clock()
    presence = AgentPresence(clock)
    a = _form(presence, "a", {"nodeId": "n1"})["since"]
    clock.now += 1
    b = _form(presence, "b", {"nodeId": "n1"})["since"]
    clock.now += 1
    c = _form(presence, "c", {"nodeId": "n2"})["since"]  # already on the other node
    clock.now += 1
    # A small nudge (and another) within the radius: nothing arrives.
    assert presence.carry_nodes({"n1": (6.0, 0.0)}) == []
    assert presence.carry_nodes({"n1": (6.0, 0.0)}) == []
    # Past it in all (12 + 8 = 20 > 16): both arrive now, a still before b.
    updates = presence.carry_nodes({"n1": (8.0, 0.0)})
    assert [u["ordinal"] for u in updates] == [1, 2]
    assert updates[0]["since"] < updates[1]["since"]
    assert all(u["since"] > c > b > a for u in updates)
    assert {tuple(sorted(u)) for u in updates} == {("agentId", "key", "ordinal", "since")}
    # The replay (a reload) has the same: n1's cursors now come after c.
    replayed = {r["session"]["ordinal"]: r["since"] for r in presence.replay()}
    assert replayed == {1: updates[0]["since"], 2: updates[1]["since"], 3: c}
    # Its own next event on the node keeps the new arrival.
    assert _form(presence, "a", {"nodeId": "n1"}, say="Still here")["since"] == updates[0]["since"]
    # Other nodes' cursors and points are never carried.
    assert presence.carry_nodes({"n9": (500.0, 0.0)}) == []


def test_a_cursor_that_arrives_again_starts_its_carry_from_zero():
    clock = Clock()
    presence = AgentPresence(clock)
    _form(presence, "a", {"nodeId": "n1"})
    assert presence.carry_nodes({"n1": (12.0, 0.0)}) == []
    clock.now += 1
    _form(presence, "a", {"nodeId": "n2"})  # somewhere new: carry starts again
    _form(presence, "a", {"nodeId": "n1"})
    assert presence.carry_nodes({"n1": (12.0, 0.0)}) == []


def test_the_layout_route_tells_only_the_persons_tabs_and_agents_read_what_they_did(sockets):
    """A drop through PUT /api/graph/layout (the person's drag, an arrange,
    `nebula move`) carries the cursors on the node: the person's canvas gets
    their new arrivals, no other socket does, and every agent read is the
    same as before."""
    api = sockets
    n1 = api.graph.add_node("text-input", {"value": "hi"})
    n2 = api.graph.add_node("text-input", {"value": "hi"})
    laid = api.client.put("/api/graph/layout", headers=PERSON,
                          json={"positions": {n1: {"x": 0, "y": 0}, n2: {"x": 600, "y": 0}}})
    assert laid.status_code == 200, laid.text
    for lane in ("lane-a", "lane-b"):
        api.client.post("/api/canvas/cursor", headers={**CLAUDE, "X-Nebula-Agent-Session": lane},
                        json={"target": {"nodeId": n1}, "action": "look"})
        api.presence_clock.now += 1
    api.client.post("/api/canvas/cursor", headers={**CLAUDE, "X-Nebula-Agent-Session": "lane-c"},
                    json={"target": {"nodeId": n2}, "action": "look"})

    def timeless(value):
        if isinstance(value, dict):
            return {k: timeless(v) for k, v in value.items() if k not in ("secondsAgo", "activeSecondsAgo")}
        if isinstance(value, list):
            return [timeless(v) for v in value]
        return value

    def reads() -> list[str]:
        """The cursors as agents read them (the node itself moved, and time
        passed: those parts are left out)."""
        snapshot = api.client.get("/api/canvas/snapshot", headers=CLAUDE).json()
        agents = api.client.get("/api/canvas/agents", headers=CLAUDE).json()
        texts = [json.dumps(api.client.get(path, headers=CLAUDE).json())
                 for path in ("/api/canvas/snapshot", "/api/canvas/agents")]
        for text in texts:
            assert '"since"' not in text and '"eventId"' not in text and '"ordinal"' not in text
        return [json.dumps(timeless(snapshot.get("agents")), sort_keys=True), json.dumps(timeless(agents), sort_keys=True)]

    before = reads()
    before_replay = {c["session"]["ordinal"]: c["since"] for c in api.main.agent_presence.replay()}
    at = {"x": 0, "y": 0}
    api.person_socket.sent.clear()
    api.listener.sent.clear()
    api.presence_clock.now += 1
    moved = api.client.put("/api/graph/layout", headers=PERSON,
                           json={"positions": {n1: {"x": at["x"] + 120, "y": at["y"]}}})
    assert moved.status_code == 200, moved.text
    person = [json.loads(t) for t in api.person_socket.sent]
    (arrival,) = [m for m in person if m["type"] == "agentPresenceArrival"]
    assert [c["ordinal"] for c in arrival["cursors"]] == [1, 2]
    assert all(c["since"] > before_replay[3] for c in arrival["cursors"])
    # No other socket hears of it, and agents read the same as before.
    assert all(json.loads(t)["type"] != "agentPresenceArrival" for t in api.listener.sent)
    for text in api.listener.sent:
        assert '"since"' not in text and '"eventId"' not in text
    assert reads() == before
    # A reload agrees: the replay has the new arrivals.
    after = {c["session"]["ordinal"]: c["since"] for c in api.main.agent_presence.replay()}
    assert after == {1: arrival["cursors"][0]["since"], 2: arrival["cursors"][1]["since"], 3: before_replay[3]}


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
