"""Error copy, round 3 (GM - Design's heading review of #167).

GM, verbatim, on the backend's part:

1. "World Labs delete refusal: 'settle' and 'start' are internal. Write it as:
   'This node is still waiting on World Labs. Check the job in Marble, then
   {the node's actual button label} before you delete it.' Fill in the real
   label."
5. "Backend 404 details: do the copy pass to one pattern: 'That {thing} isn't
   there anymore. Reload to get the latest {things}.', matching your
   unknown_collection line. Agents keep the specific text, as in round 2."
6. "Blind labeling refusals: say what's needed in plain words, give the
   count, then what to do."
   And: folders.py:96 "Choose a real folder, not a symlink." -> "Choose the
   folder itself, not a shortcut to it."

The person is a browser page with no agent marker (main's routes: Origin or
Sec-Fetch-Site) or the Commons UI session (a Bearer actor); everyone else
(MCP, the CLI, scripts, an agent header) keeps the specific text it fixes its
call with. One helper makes that choice: services/refusal_copy.py.
"""
from __future__ import annotations

import io
import secrets

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.conftest import CANVAS_PARAMS_VERSION, FORGED_ORIGIN, PERSON

AGENT = {"X-Nebula-Agent": "Claude"}
CLI = {"X-Nebula-Client": "nebula-cli"}
DESKTOP = {"Sec-Fetch-Site": "same-site", **CANVAS_PARAMS_VERSION}


def gone(thing: str, things: str) -> str:
    return f"That {thing} isn't there anymore. Reload to get the latest {things}."


NODE_GONE = "That node isn't on the canvas anymore."
WAITING = "This node is still waiting on World Labs."


# -- 1. World Labs: the node's real button, per state ----------------------------

@pytest.fixture
def canvas(tmp_path, monkeypatch, person):
    import main as main_module
    from services.agent_presence import AgentPresence
    from services.canvas_events import CanvasEventJournal
    from services.canvas_pins import CanvasPins
    from services.canvas_proposals import ProposalBook
    from services.cli_graph import CLIGraph
    from services.project_store import ProjectStore, make_project
    from services.provider_recovery import ProviderRecoveryStore
    from services.provider_start_guard import ProviderStartGuard

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    guard = ProviderStartGuard(tmp_path / "paid-starts.json")
    recoveries = ProviderRecoveryStore(None)

    async def capture(_data):
        return None

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", recoveries)
    monkeypatch.setattr(main_module, "provider_start_guard", guard)
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.guard = guard
    ctx.recoveries = recoveries
    return ctx


def _node(canvas) -> str:
    return canvas.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})


def _delete(canvas, node, headers=PERSON):
    return canvas.client.delete(f"/api/graph/node/{node}", headers=headers)


def test_a_start_in_flight_says_to_let_the_run_finish(canvas, monkeypatch):
    node = _node(canvas)
    monkeypatch.setattr(canvas.guard, "has_active_node", lambda node_id: node_id == node)
    response = _delete(canvas, node)
    assert response.status_code == 409
    assert response.json()["detail"] == f"{WAITING} Let its run finish, then delete it."


def test_an_ambiguous_start_names_the_unlock_button(canvas, monkeypatch):
    node = _node(canvas)
    monkeypatch.setattr(canvas.guard, "list", lambda: [{"nodeId": node, "runId": "r1", "kind": "worldlabs"}])
    response = _delete(canvas, node)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"{WAITING} Check the job in Marble, then use “Checked Marble — unlock” before you delete it.")


def test_a_recovery_record_names_the_forget_button_in_run_history(canvas, monkeypatch):
    node = _node(canvas)
    monkeypatch.setattr(canvas.recoveries, "list", lambda: [{"nodeId": node, "runId": "r1"}])
    response = _delete(canvas, node)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"{WAITING} Check the job in Marble, then use “Checked Marble — forget” in Run History "
        "before you delete it.")


def test_a_recovery_id_in_the_node_names_its_fields(canvas, monkeypatch):
    import main as main_module

    node = _node(canvas)
    monkeypatch.setattr(main_module, "has_recovery_identity", lambda definition_id, params: True)
    response = _delete(canvas, node)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"{WAITING} Check the job in Marble, then clear the node's Resume Operation ID and Existing World ID "
        "before you delete it.")


@pytest.mark.parametrize("headers", [AGENT, CLI, {}], ids=["agent", "cli", "script"])
def test_agents_keep_the_specific_world_labs_detail(canvas, monkeypatch, headers):
    node = _node(canvas)
    monkeypatch.setattr(canvas.guard, "list", lambda: [{"nodeId": node, "runId": "r1", "kind": "worldlabs"}])
    response = _delete(canvas, node, headers)
    assert response.json()["detail"] == (
        f"Cannot delete {node}: it has unresolved World Labs paid state. "
        "Check Marble, then resolve its exact recovery/ambiguity record first.")


def test_no_line_the_person_reads_says_settle_or_start(canvas, monkeypatch):
    node = _node(canvas)
    monkeypatch.setattr(canvas.guard, "has_active_node", lambda node_id: node_id == node)
    for headers in (PERSON, FORGED_ORIGIN, DESKTOP):
        text = _delete(canvas, node, headers).json()["detail"]
        assert "settle" not in text and " start " not in text, text


# Review of round 3: the line names the fields the node actually has. A World
# export node's only recovery field is "Resume Export Operation ID"
# (node_definitions.json); "Resume Operation ID" and "Existing World ID" are
# the World node's.
def test_a_world_export_node_names_its_own_recovery_field(canvas, monkeypatch):
    import main as main_module

    # "Checked Marble — forget" cleared the record; the ID is still in the node.
    monkeypatch.setattr(main_module, "_seed_shared_graph_recoveries_for_api", lambda nodes, *, source: [])
    node = canvas.graph.add_node("worldlabs-world-export", {"resume_operation_id": "op-export-1"},
                                 position={"x": 0, "y": 0})
    response = _delete(canvas, node)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"{WAITING} Check the job in Marble, then clear the node's Resume Export Operation ID before you delete it.")


def test_a_world_node_names_only_the_fields_it_holds(canvas, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "_seed_shared_graph_recoveries_for_api", lambda nodes, *, source: [])
    both = canvas.graph.add_node("worldlabs-environment", {"resume_operation_id": "op-1", "existing_world_id": "w-1"},
                                 position={"x": 0, "y": 0})
    assert _delete(canvas, both).json()["detail"] == (
        f"{WAITING} Check the job in Marble, then clear the node's Resume Operation ID and Existing World ID "
        "before you delete it.")
    world_only = canvas.graph.add_node("worldlabs-environment", {"existing_world_id": "w-2"},
                                       position={"x": 0, "y": 0})
    assert _delete(canvas, world_only).json()["detail"] == (
        f"{WAITING} Check the job in Marble, then clear the node's Existing World ID before you delete it.")


# Review of round 3: Clear canvas, opening a project, replacing the graph and
# restoring a bundle refuse for the same World Labs state, and the person read
# "Cannot clear the canvas while a World Labs paid start is settling. ..."
# (GM: "'settle' and 'start' are internal."). The person's line leaves the
# action out: the screen's own heading ("Couldn't clear the canvas.") names it.
A_NODE_WAITING = "A node is still waiting on World Labs."
# Round 12 of PR #114 (GM), wherever _reject_graph_replacement_during_paid_start
# refuses: "Couldn't <action>. A World Labs start needs checking. Open Run
# History and choose “Check Marble”." (an unresolved record) and "Couldn't
# <action>. A World Labs start is still settling. Try again in a moment." (a
# start settling); the screen's heading says "Couldn't <action>.". Before
# round 12 these were the node lines ("A node is still waiting on World Labs.
# Let its run finish, then try again." and the "Checked Marble — …" ones).
GRAPH_PAID_CHECK = "A World Labs start needs checking. Open Run History and choose “Check Marble”."
GRAPH_PAID_SETTLING = "A World Labs start is still settling. Try again in a moment."
GRAPH_PAID_STATE_PERSON = {
    "active": GRAPH_PAID_SETTLING,
    "ambiguity": GRAPH_PAID_CHECK,
    "recovery": GRAPH_PAID_CHECK,
}


def _hold(canvas, monkeypatch, state, node):
    if state == "active":
        monkeypatch.setattr(canvas.guard, "has_active", lambda: True)
    elif state == "ambiguity":
        monkeypatch.setattr(canvas.guard, "list", lambda: [{"nodeId": node, "runId": "r1", "kind": "worldlabs"}])
    else:
        monkeypatch.setattr(canvas.recoveries, "list", lambda: [{"nodeId": node, "runId": "r1"}])


def _other_project(canvas) -> str:
    from services.project_store import make_project

    import main as main_module

    with main_module.project_store.transaction() as catalog:
        project = make_project("Other")
        catalog["projects"][project["id"]] = project
        main_module.project_store.commit(catalog)
    return project["id"]


def _clear(canvas, headers):
    return canvas.client.delete("/api/graph?force=true", headers=headers)


def _open(canvas, headers):
    return canvas.client.post(f"/api/projects/{_other_project(canvas)}/open", json={}, headers=headers)


def _import(canvas, headers):
    return canvas.client.post("/api/graph/import", headers=headers, json={
        "nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "x"}}], "edges": []})


def _delete_open(canvas, headers):
    import main as main_module

    catalog = main_module.project_store.read()
    return canvas.client.request("DELETE", f"/api/projects/{catalog['activeProjectId']}", headers=headers,
                                 json={"workspaceRevision": catalog["workspaceRevision"]})


@pytest.mark.parametrize("state", list(GRAPH_PAID_STATE_PERSON))
@pytest.mark.parametrize("call", [_clear, _open, _import, _delete_open],
                         ids=["clear-canvas", "open-project", "load-graph", "delete-open-project"])
def test_replacing_the_canvas_tells_the_person_what_holds_it(canvas, monkeypatch, state, call):
    node = _node(canvas)
    _hold(canvas, monkeypatch, state, node)
    for headers in (PERSON, FORGED_ORIGIN, DESKTOP):
        response = call(canvas, headers)
        assert response.status_code == 409
        assert response.json()["detail"] == GRAPH_PAID_STATE_PERSON[state]
    assert node in canvas.graph.nodes


@pytest.mark.parametrize("state,specific", [
    ("active", "Cannot {action} while a World Labs paid start is settling. "
               "Stop the run and wait for its terminal state first."),
    ("ambiguity", "Cannot {action} while unresolved World Labs paid state exists. "
                  "Check Marble and resolve the exact recovery/ambiguity record first."),
    ("recovery", "Cannot {action} while unresolved World Labs paid state exists. "
                 "Check Marble and resolve the exact recovery/ambiguity record first."),
])
@pytest.mark.parametrize("call,action", [(_clear, "clear the canvas"), (_open, "switch projects"),
                                         (_import, "replace the graph"), (_delete_open, "delete the open project")],
                         ids=["clear-canvas", "open-project", "load-graph", "delete-open-project"])
@pytest.mark.parametrize("headers", [AGENT, CLI, {}], ids=["agent", "cli", "script"])
def test_agents_keep_the_specific_canvas_replacement_detail(canvas, monkeypatch, state, specific, call, action,
                                                            headers):
    node = _node(canvas)
    _hold(canvas, monkeypatch, state, node)
    response = call(canvas, headers)
    assert response.status_code == 409
    assert response.json()["detail"] == specific.format(action=action)


def test_a_start_settling_inside_the_lifecycle_fence_says_the_same_line(canvas, monkeypatch):
    """The fence itself (a start another process holds) refuses with the same words."""
    from contextlib import contextmanager

    from services.provider_start_guard import ProviderStartConflictError

    @contextmanager
    def busy():
        raise ProviderStartConflictError("held")
        yield  # pragma: no cover

    _node(canvas)
    monkeypatch.setattr(canvas.guard, "exclusive_lifecycle", busy)
    assert _clear(canvas, PERSON).json()["detail"] == GRAPH_PAID_STATE_PERSON["active"]
    assert _clear(canvas, AGENT).json()["detail"] == (
        "Cannot clear the canvas while a World Labs paid start is settling. "
        "Stop the run and wait for its terminal state first.")


def test_forgetting_a_recovery_while_its_start_runs_says_to_let_it_finish(canvas, monkeypatch):
    """Run History's "Checked Marble — forget" refuses for a start still in
    flight; its line said "settling" too."""
    node = _node(canvas)
    monkeypatch.setattr(canvas.guard, "has_active_node", lambda node_id: node_id == node)
    path = f"/api/provider-recoveries/r1/{node}?resume_operation_id=op-1"
    person = canvas.client.delete(path, headers=PERSON)
    assert person.status_code == 409
    assert person.json()["detail"] == f"{WAITING} Let its run finish, then try again."
    agent = canvas.client.delete(path, headers=AGENT)
    assert agent.json()["detail"] == ("Cannot delete a World Labs recovery checkpoint while that "
                                      "node's paid start is still settling")


def test_restoring_a_bundle_over_recovery_ids_says_a_start_needs_checking(canvas, monkeypatch):
    canvas.graph.add_node("worldlabs-world-export", {"resume_operation_id": "op-export-1"}, position={"x": 0, "y": 0})
    response = canvas.client.post("/api/outputs/restore", content=b"", headers=PERSON)
    assert response.status_code == 409
    assert response.json()["detail"] == GRAPH_PAID_CHECK
    agent = canvas.client.post("/api/outputs/restore", content=b"", headers=AGENT)
    assert agent.json()["detail"] == (
        "Cannot restore a graph bundle while unresolved World Labs paid state exists. "
        "Check Marble and resolve the exact recovery/ambiguity record first.")


# -- 5. 404s on main's routes ---------------------------------------------------

@pytest.fixture
def app_client(canvas_project, person):
    from main import app

    return TestClient(app)


MISSING_PROJECT = "0" * 32

# (method, path, body, the person's line, a piece of the agent's specific text)
MAIN_404S = [
    ("PUT", "/api/characters/ch_missing", {"name": "x"}, gone("character", "characters"), "Character 'ch_missing'"),
    ("DELETE", "/api/characters/ch_missing", None, gone("character", "characters"), "Character 'ch_missing'"),
    ("POST", "/api/characters/ch_missing/move", {"projectId": None}, gone("character", "characters"), "Character 'ch_missing'"),
    ("PUT", "/api/moodboards/mb_missing", {"name": "x"}, gone("board", "boards"), "Moodboard 'mb_missing'"),
    ("POST", "/api/moodboards/mb_missing/edits", {"ops": [{"op": "note", "image": "i1", "notes": "x"}]},
     gone("board", "boards"), "Moodboard 'mb_missing'"),
    ("POST", "/api/moodboards/mb_missing/analyze", None, gone("board", "boards"), "Moodboard 'mb_missing'"),
    ("POST", "/api/moodboards/mb_missing/brief-override/keep", None, gone("board", "boards"), "Moodboard 'mb_missing'"),
    ("DELETE", "/api/moodboards/mb_missing", None, gone("board", "boards"), "Moodboard 'mb_missing'"),
    ("POST", "/api/moodboards/mb_missing/move", {"projectId": None}, gone("board", "boards"), "Moodboard 'mb_missing'"),
    ("DELETE", "/api/presets/st_missing", None, gone("style", "styles"), "Style 'st_missing'"),
    ("POST", "/api/trash/moodboard/mb_missing/restore", None,
     "That board isn't in Recently deleted anymore. Reload to get the latest list.", "Moodboard 'mb_missing'"),
    ("POST", "/api/trash/character/ch_missing/restore", None,
     "That character isn't in Recently deleted anymore. Reload to get the latest list.", "Character 'ch_missing'"),
    ("GET", f"/api/projects/{MISSING_PROJECT}", None, gone("project", "projects"), "Project not found"),
    ("PUT", f"/api/projects/{MISSING_PROJECT}", {"name": "x"}, gone("project", "projects"), "Project not found"),
    ("GET", "/api/executions/run_missing", None, gone("run", "runs"), "run 'run_missing'"),
    ("PUT", "/api/graph/node/n404", {"params": {"value": "x"}}, NODE_GONE, "Node 'n404'"),
    ("PUT", "/api/graph/node/n404/label", {"label": "x"}, NODE_GONE, "Node 'n404'"),
    ("GET", "/api/render-jobs/job_missing", None, gone("render", "renders"), "render job not found"),
    ("DELETE", "/api/render-jobs/job_missing", None, gone("render", "renders"), "render job not found"),
]


@pytest.mark.parametrize("method,path,body,person_line,specific", MAIN_404S,
                         ids=[f"{m} {p}" for m, p, *_ in MAIN_404S])
def test_a_404_the_person_reads_says_gms_pattern(app_client, method, path, body, person_line, specific):
    for headers in (PERSON, DESKTOP):
        response = app_client.request(method, path, json=body, headers=headers)
        assert response.status_code == 404, response.text
        assert response.json()["detail"] == person_line


@pytest.mark.parametrize("method,path,body,person_line,specific", MAIN_404S,
                         ids=[f"{m} {p}" for m, p, *_ in MAIN_404S])
def test_an_agent_keeps_the_specific_404_text(app_client, method, path, body, person_line, specific):
    for headers in (AGENT, CLI, {}):
        response = app_client.request(method, path, json=body, headers=headers)
        assert response.status_code == 404, response.text
        assert specific in response.json()["detail"]
        assert response.json()["detail"] != person_line


# Person-only routes (require_person): no agent reaches their 404, so the
# written line is the only text.
PERSON_ONLY_404S = [
    ("DELETE", "/api/trash/moodboard/mb_missing", None,
     "That board isn't in Recently deleted anymore. Reload to get the latest list."),
    ("DELETE", "/api/trash/style/st_missing", None,
     "That style isn't in Recently deleted anymore. Reload to get the latest list."),
    ("POST", f"/api/projects/{MISSING_PROJECT}/restore", None,
     "That project isn't in Recently deleted anymore. Reload to get the latest list."),
    ("DELETE", f"/api/projects/trash/{MISSING_PROJECT}", None,
     "That project isn't in Recently deleted anymore. Reload to get the latest list."),
    ("PUT", "/api/personal-agents/custom-missing", {"enabled": False}, gone("agent", "agents")),
    ("DELETE", "/api/personal-agents/custom-missing", None, gone("agent", "agents")),
    ("PUT", "/api/agent/spend/apps/app_missing", {"dailyUsd": None}, gone("app", "apps")),
    ("DELETE", "/api/agent/spend/apps/app_missing", None, gone("app", "apps")),
    ("POST", "/api/canvas/proposals/prop_missing/accept", {}, gone("proposal", "proposals")),
    ("POST", "/api/canvas/proposals/prop_missing/reject", {}, gone("proposal", "proposals")),
    ("POST", "/api/asset-proposals/prop_missing/accept", {}, gone("proposal", "proposals")),
    ("POST", "/api/asset-proposals/prop_missing/reject", {}, gone("proposal", "proposals")),
    ("DELETE", "/api/canvas/pins/pin_missing", None, gone("note", "notes")),
    ("POST", "/api/canvas/pins", {"text": "look", "nodeId": "n404"}, NODE_GONE),
    ("POST", "/api/canvas/agent-notes/note_missing/dismiss", None, gone("update", "updates")),
]


@pytest.mark.parametrize("method,path,body,person_line", PERSON_ONLY_404S,
                         ids=[f"{m} {p}" for m, p, *_ in PERSON_ONLY_404S])
def test_a_person_only_404_says_gms_pattern(app_client, method, path, body, person_line):
    response = app_client.request(method, path, json=body, headers=PERSON)
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == person_line


def test_a_board_in_recently_deleted_tells_the_person_to_restore_it(app_client, canvas_project):
    created = app_client.post("/api/moodboards", headers=PERSON, json={
        "name": "Warm", "projectId": canvas_project,
        "images": [{"url": __import__("tests.conftest", fromlist=["x"]).stored_image_urls(1, name="r3")[0]}]})
    assert created.status_code == 200, created.text
    board_id = created.json()["id"]
    assert app_client.delete(f"/api/moodboards/{board_id}", headers=PERSON).status_code == 200
    person = app_client.post(f"/api/moodboards/{board_id}/analyze", headers=PERSON)
    assert person.status_code == 404
    assert person.json()["detail"] == "That board is in Recently deleted. Restore it, then try again."
    assert person.json()["code"] == "in_trash"  # the Studio's own reason still keys on it
    agent = app_client.post(f"/api/moodboards/{board_id}/analyze", headers=AGENT)
    assert "nebula trash restore moodboard" in agent.json()["detail"]
    moved = app_client.post(f"/api/moodboards/{board_id}/move", headers=PERSON, json={"projectId": None})
    assert moved.status_code == 409
    assert moved.json()["detail"] == "That board is in Recently deleted. Restore it first, then move it."
    assert "nebula trash restore" in app_client.post(f"/api/moodboards/{board_id}/move", headers=AGENT,
                                                     json={"projectId": None}).json()["detail"]


def test_one_helper_chooses_for_every_router():
    """main.py and routes/commons.py ask services/refusal_copy, not a copy of their own."""
    from pathlib import Path

    backend = Path(__file__).resolve().parent.parent
    main_text = (backend / "main.py").read_text()
    commons_text = (backend / "routes" / "commons.py").read_text()
    assert "def _person_reads_reply" not in main_text
    assert "refusal_copy" in main_text and "refusal_copy" in commons_text


# -- 5. 404s on the Commons routes ----------------------------------------------

@pytest.fixture()
def commons(tmp_path, monkeypatch, fresh_person_session):
    from commons import runtime

    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    from main import app

    yield TestClient(app)
    runtime.reset_for_tests()


def human() -> dict:
    from services import person_session

    token = secrets.token_urlsafe(32)
    person_session.current().set(token)
    return {"Authorization": f"Bearer {token}"}


COMMONS_AGENT = {"X-Nebula-Client": "cursor"}


def png(seed=1) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (24, 24, 3), dtype=np.uint8)).save(buf, "PNG")
    return buf.getvalue()


COMMONS_404S = [
    ("GET", "/api/commons/assets/ast_missing", None, gone("reference", "references"), "asset not found"),
    ("PATCH", "/api/commons/collections/col_missing", {"name": "x"}, gone("collection", "collections"),
     "collection not found"),
    ("POST", "/api/commons/assets/ast_missing/corrections", {"field_path": "summary", "op": "replace", "value": "x"},
     gone("reference", "references"), "asset not found"),
    ("POST", "/api/commons/assets/ast_missing/regions", {"box": [0.1, 0.1, 0.2, 0.2], "label": "x"},
     gone("reference", "references"), "asset not found"),
]


@pytest.mark.parametrize("method,path,body,person_line,specific", COMMONS_404S,
                         ids=[f"{m} {p}" for m, p, *_ in COMMONS_404S])
def test_a_commons_404_says_gms_pattern_to_the_person_and_the_detail_to_agents(
        commons, method, path, body, person_line, specific):
    person = commons.request(method, path, json=body, headers=human())
    assert person.status_code == 404, person.text
    assert person.json()["detail"] == person_line
    agent = commons.request(method, path, json=body, headers=COMMONS_AGENT)
    if agent.status_code == 403:  # a person-only route: no agent reaches its 404
        return
    assert agent.status_code == 404, agent.text
    assert agent.json()["detail"] == specific


def test_commons_person_only_404s(commons):
    h = human()
    folder = commons.patch("/api/commons/folders/fld_missing", json={"ignores": []}, headers=h)
    assert folder.status_code == 404
    assert folder.json()["detail"] == "That folder isn't linked anymore. Reload to get the latest folders."
    rescan = commons.post("/api/commons/folders/fld_missing/rescan", headers=h)
    assert rescan.json()["detail"] == "That folder isn't linked anymore. Reload to get the latest folders."
    region = commons.patch("/api/commons/regions/reg_missing", json={"label": "x"}, headers=h)
    assert region.status_code == 404
    assert region.json()["detail"] == "That region isn't on this reference anymore. Reload to get the latest version."


# -- folders.py:96, GM verbatim ---------------------------------------------------

def test_a_linked_folder_shortcut_says_gms_line(commons, tmp_path):
    h = human()
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    link = commons.post("/api/commons/folders", json={"path": str(tmp_path / "link")}, headers=h)
    assert link.status_code == 422
    assert link.json()["detail"] == "Choose the folder itself, not a shortcut to it."


# -- 6. Blind labeling: what's needed, the count, then what to do -----------------

def test_too_few_distinct_references_says_gms_line_with_the_count(commons, tmp_path):
    h = human()
    folder = tmp_path / "set"
    folder.mkdir()
    for seed in range(3):
        (folder / f"{seed}.png").write_bytes(png(seed + 10))
    r = commons.post("/api/commons/evaluation/prepare", json={"path": str(folder)}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == (
        "Blind labeling needs at least 45 references that look different from each other. "
        "You have 3. Add more, then try again.")


def test_a_shortcut_as_the_blind_labeling_folder_says_gms_folder_line(commons, tmp_path):
    h = human()
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    r = commons.post("/api/commons/evaluation/prepare", json={"path": str(tmp_path / "link")}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == "Choose the folder itself, not a shortcut to it."


def test_a_shortcut_inside_the_folder_says_so_in_plain_words(commons, tmp_path):
    h = human()
    folder = tmp_path / "set"
    folder.mkdir()
    (folder / "a.png").write_bytes(png(1))
    (folder / "b.png").symlink_to(folder / "a.png")
    r = commons.post("/api/commons/evaluation/prepare", json={"path": str(folder)}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == "A file in that folder is a shortcut. Replace it with the file itself, then scan again."


def test_a_relative_path_says_what_to_enter(commons):
    r = commons.post("/api/commons/evaluation/prepare", json={"path": "relative/path"}, headers=human())
    assert r.status_code == 409
    assert r.json()["detail"] == "Enter the folder's full path, starting with /."


def test_a_library_with_references_says_how_many(commons, tmp_path):
    h = human()
    col = commons.post("/api/commons/collections", json={"name": "refs"}, headers=h).json()["id"]
    for seed in range(2):
        commons.post("/api/commons/intake/files", headers=h, data={"collection_id": col},
                     files=[("files", (f"{seed}.png", png(seed + 30), "image/png"))])
    folder = tmp_path / "set"
    folder.mkdir()
    r = commons.post("/api/commons/evaluation/prepare", json={"path": str(folder)}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == (
        "Blind labeling has to choose its references before any are added. This library already has 2. "
        "Prepare the held-out set in a library with no references yet.")


def _shown(exc) -> str:
    """What the person's UI reads for an EvaluationError (routes/commons.py _evaluation_refused)."""
    return exc.person or str(exc)


def test_pure_labeling_checks_say_whats_needed_with_the_count():
    from commons import evaluation

    with pytest.raises(evaluation.EvaluationError) as keywords:
        evaluation.validate_labels({"tags": {}, "axes": {}, "palette_roles": {}, "keywords": [f"k{i}" for i in range(14)],
                                    "no_keywords": False, "flagged": False}, [], vocabulary=[f"k{i}" for i in range(20)])
    assert _shown(keywords.value) == ("Each reference can have up to 12 keywords. This one has 14. "
                                      "Remove some, then save again.")
    with pytest.raises(evaluation.EvaluationError) as accents:
        evaluation.lock_accents(None, 0, 1, [], False)
    assert _shown(accents.value) == "Mark between 1 and 100 accent points, or check \u201cI don\u2019t see any accent colors\u201d."
    with pytest.raises(evaluation.EvaluationError) as close:
        evaluation.close(None, 1, actor="human", acknowledge=False)
    assert _shown(close.value) == "Confirm that these labels become assisted review, then close the batch."


def test_a_broken_clients_labels_get_the_fallback_line_and_keep_the_detail_for_the_log():
    from commons import evaluation, person_copy

    with pytest.raises(evaluation.EvaluationError) as bad:
        evaluation.validate_labels({"tags": {}}, [], vocabulary=[])
    assert _shown(bad.value) == person_copy.FALLBACK
    assert str(bad.value) == "Invalid ground-truth label fields."
