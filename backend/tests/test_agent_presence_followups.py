"""Follow-ups to PR #195 (agent presence), review 23 L-1.

The pin routes relied on the fence middleware's check alone. Between that
check and the route body the event loop turns a few times, and an agent's
project open waiting at its last await could commit there: the person's note,
written for A's n1, was then pinned to B's n1 and journaled to the agent
working in B (review 23, be/test_r23_pins.py).

Now every FENCE_BEFORE_ROUTE route checks again as its body starts, in the
same synchronous step (``graph_write`` wraps it), so no route can rely on the
middleware's check alone, and the pin routes write with no await between that
check and ``canvas_pins.add_in`` / ``remove_in``.
"""
from __future__ import annotations

import ast
import asyncio
import inspect
import textwrap

import httpx
import pytest

from services.project_store import make_project
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, api  # noqa: F401 - fixture

TAB = {**PERSON, "X-Nebula-Tab": "tab-presence-followups"}


def _hdr(main) -> dict[str, str]:
    ctx = main._workspace_context()
    return {**TAB, "X-Nebula-Workspace-Revision": ctx["workspaceRevision"],
            "X-Nebula-Canvas-Revision": main._canvas_revision()}


def _add_project(main, name: str, with_n1: bool = False) -> str:
    with main.project_store.transaction() as catalog:
        other = make_project(name)
        if with_n1:
            other["snapshot"]["nodes"] = [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                                           "data": {"definitionId": "text-input", "label": "B prompt",
                                                    "params": {"value": "B"}}}]
            other["_nodeCounter"] = 1
        catalog["projects"][other["id"]] = other
        main.project_store.commit(catalog)
    return other["id"]


def _park_the_open_until_the_fence_passes(main, monkeypatch, b: str):
    """An agent's /open parked at its last await (``_projects_live_export``)
    and let go the moment a tab request passes the middleware's check."""
    gate = asyncio.Event()
    parked = asyncio.Event()
    real_export = main._projects_live_export

    async def parked_export():
        parked.set()
        await gate.wait()
        return await real_export()

    monkeypatch.setattr(main, "_projects_live_export", parked_export)
    real_check = main._check_workspace_revision
    seen = {"fence_passed": False}

    def check(revision=None):
        real_check(revision)
        if revision is None and not seen["fence_passed"] and main._request_from_tab.get():
            seen["fence_passed"] = True
            gate.set()

    monkeypatch.setattr(main, "_check_workspace_revision", check)
    return parked


@pytest.mark.asyncio
async def test_L1_a_switch_that_commits_between_the_fence_and_the_route_refuses_the_note(api, monkeypatch):
    """Review 23's WINDOW probe: the note is refused (409), pinned nowhere and journaled nowhere."""
    main = api.main
    api.client.post("/api/graph/apply", headers=CLAUDE,
                    json={"nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "A"}}]})
    a_headers = _hdr(main)
    b = _add_project(main, "Beta", with_n1=True)
    rev = main._workspace_context()["workspaceRevision"]
    parked = _park_the_open_until_the_fence_passes(main, monkeypatch, b)
    journaled: list[str] = []
    real_journal = main._journal

    def journal(kind, **kwargs):
        journaled.append(kind)
        return real_journal(kind, **kwargs)

    monkeypatch.setattr(main, "_journal", journal)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as http:
        opening = asyncio.create_task(http.post(f"/api/projects/{b}/open", headers=CODEX,
                                                json={"workspaceRevision": rev}))
        await asyncio.wait_for(parked.wait(), 10)
        pin = await http.post("/api/canvas/pins", headers=a_headers, json={"text": "Make the sky warmer", "nodeId": "n1"})
        opened = await opening
    assert opened.status_code == 200, opened.text
    assert main._workspace_context()["activeProjectId"] == b
    assert pin.status_code == 409, pin.text
    assert pin.json()["detail"] == main.CANVAS_OUT_OF_DATE
    assert main.canvas_pins.list().get("pins", []) == []
    assert "pin.added" not in journaled


@pytest.mark.asyncio
async def test_L1_a_delete_in_the_same_window_is_refused_and_deletes_nothing(api, monkeypatch):
    main = api.main
    api.client.post("/api/graph/apply", headers=CLAUDE,
                    json={"nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "A"}}]})
    created = api.client.post("/api/canvas/pins", headers=_hdr(main), json={"text": "keep me", "nodeId": "n1"})
    assert created.status_code == 201, created.text
    pin_id = created.json()["pin"]["id"]
    a = main._workspace_context()["activeProjectId"]
    a_headers = _hdr(main)
    b = _add_project(main, "Beta")
    rev = main._workspace_context()["workspaceRevision"]
    parked = _park_the_open_until_the_fence_passes(main, monkeypatch, b)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as http:
        opening = asyncio.create_task(http.post(f"/api/projects/{b}/open", headers=CODEX,
                                                json={"workspaceRevision": rev}))
        await asyncio.wait_for(parked.wait(), 10)
        deleted = await http.delete(f"/api/canvas/pins/{pin_id}", headers=a_headers)
        assert (await opening).status_code == 200
    assert deleted.status_code == 409, deleted.text
    # Still in A: open A again and list.
    rev_b = main._workspace_context()["workspaceRevision"]
    assert api.client.post(f"/api/projects/{a}/open", headers=CODEX, json={"workspaceRevision": rev_b}).status_code == 200
    assert [pin["id"] for pin in main.canvas_pins.list().get("pins", [])] == [pin_id]


def test_L1_every_before_route_write_checks_again_as_its_body_starts():
    """No FENCE_BEFORE_ROUTE route relies on the middleware's marker alone:
    graph_write wraps each one in the check (and refuses to mark a sync route,
    which would run on another thread after an unknown wait)."""
    import main
    from fastapi.routing import APIRoute

    checked = []
    for route in main.app.routes:
        if not isinstance(route, APIRoute):
            continue
        fence = getattr(route.endpoint, main.GRAPH_FENCE_ATTR, None)
        if fence != main.FENCE_BEFORE_ROUTE:
            continue
        assert getattr(route.endpoint, main.GRAPH_FENCE_RECHECK_ATTR, False) is True, route.path
        assert inspect.iscoroutinefunction(route.endpoint), route.path
        checked.append(route.path)
    assert "/api/canvas/pins" in checked and "/api/canvas/pins/{pin_id}" in checked
    assert len(checked) >= 25

    with pytest.raises(TypeError):
        main.graph_write(lambda: None)


def test_L1_the_pin_routes_write_with_no_await_before_the_write():
    """The check runs as the body starts; nothing in create/delete awaits
    before canvas_pins.add_in / remove_in, so nothing can run between."""
    import main

    for function, write in [(main.create_canvas_pin, "add_in"), (main.delete_canvas_pin, "remove_in")]:
        source = textwrap.dedent(inspect.getsource(inspect.unwrap(function)))
        body = ast.parse(source).body[0]
        write_line = next(node.lineno for node in ast.walk(body)
                          if isinstance(node, ast.Attribute) and node.attr == write)
        awaits_before = [node.lineno for node in ast.walk(body) if isinstance(node, ast.Await) and node.lineno < write_line]
        assert awaits_before == [], (function.__name__, awaits_before)


def test_L1_agents_and_the_person_still_write_through_the_recheck(api):
    """The recheck changes nothing for a request made for the open canvas, or
    for agents (no revision headers)."""
    main = api.main
    r = api.client.post("/api/graph/apply", headers=CLAUDE,
                        json={"nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "A"}}]})
    assert r.status_code == 200, r.text
    r = api.client.post("/api/canvas/pins", headers=_hdr(main), json={"text": "warmer", "nodeId": "n1"})
    assert r.status_code == 201, r.text
    pin = r.json()["pin"]["id"]
    r = api.client.post(f"/api/canvas/pins/{pin}/resolve", headers=CODEX, json={"reply": "Warmed it"})
    assert r.status_code == 200, r.text
    r = api.client.put("/api/graph/node/n1", headers=_hdr(main), json={"params": {"value": "typed"}})
    assert r.status_code == 200, r.text
    r = api.client.put("/api/graph/node/n1", headers=CODEX, json={"params": {"value": "agent"}})
    assert r.status_code == 200, r.text
    r = api.client.delete(f"/api/canvas/pins/{pin}", headers=_hdr(main))
    assert r.status_code == 200, r.text


# -- Fix round 2 of PR #200 (review 2 L-2, GM 2026-10-28 answer 5) ---------------
# Shift+Enter makes lines in the note dialog; agents get the note exactly as
# written: its newlines kept end to end (the store, look_at_canvas and
# start_here, `nebula pins`), every other control character still dropped.

def test_L2_a_note_keeps_its_newlines_and_drops_every_other_control_character():
    from services.canvas_pins import clean_text

    note = "first line\r\n\tsecond line\x00\x1b[31m‮\rthird  line  \n"
    assert clean_text(note, limit=280, multiline=True) == "first line\n second line[31m\nthird  line"
    # One line stays one line: a reply, and every caller that doesn't ask for lines.
    assert clean_text("warmer\nplease", limit=280) == "warmer please"
    for bad in ("\n\n", " \r\n\t"):
        with pytest.raises(Exception):
            clean_text(bad, limit=280, multiline=True)


def test_L2_the_pin_store_keeps_the_lines_and_a_reply_stays_one_line(tmp_path):
    from services.canvas_pins import CanvasPins
    from services.project_store import ProjectStore

    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Lines")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    pins = CanvasPins(store)
    pin = pins.add("first line\nsecond line", node_id="n1", graph_nodes={"n1": {}})
    assert pin["text"] == "first line\nsecond line"
    assert [p["text"] for p in pins.list()["pins"]] == ["first line\nsecond line"]


def test_L2_agents_read_the_lines_in_start_here_mcp_and_the_cli():
    from cli.formatter import format_pin, format_start
    from services import agent_start

    pin = {"id": "pin_1", "anchor": {"nodeId": "n4"}, "text": "first line\nsecond line", "status": "open",
           "createdAt": "2026-10-28T10:00:00Z"}
    for via in ("mcp", "cli"):
        part = agent_start.pins_part([pin], via=via)
        assert part["open"][0]["text"] == "first line\nsecond line", via
        assert "more" not in part, via
    # `nebula pins`: the second line under the first, inside the quotes.
    assert format_pin(pin, now=None).startswith('pin_1 on n4: "first line\n    second line"')
    start = {"pins": agent_start.pins_part([pin], via="cli")}
    text = format_start(start)
    assert '  pin_1 on n4: "first line\n    second line"' in text
