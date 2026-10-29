"""PR #199 fix round 12 (GM r16).

- GM r16, 1: a name made from one in another family names its source ("Alpha
  (recovered) copy", then "copy 2"); a family never repeats.
- GM r16, 3: a lost row's own name is reused only when it is free, and free
  counts Recently deleted: "Beta" still there gives "Beta (recovered)".
- GM r16, 5: the person-facing lines the backend writes (the agent's
  saved-canvas reply the CLI prints, the copy-waits sentence) use the curly ’.
- GM r16 (MCP): while the person's tab keeps edits Nebula couldn't save after
  a restore, an agent's canvas write, run or project switch is refused with
  409 canvas_kept_in_tab, and MCP, the CLI and the graph-file tools say the
  code; the person's own requests pass.
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import graph_file_client  # noqa: E402
import main as main_module  # noqa: E402
import mcp_server  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from nebula_api import AGENT_REFUSAL_CODES, NebulaAPIError  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON, PERSON_HELLO  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix9 import _drain  # noqa: E402

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}


def _named(*names: str, trash: tuple[str, ...] = ()) -> dict:
    return {"projects": {f"{i:032x}": {"name": name} for i, name in enumerate(names)},
            "trash": {f"{i + 100:032x}": {"name": name} for i, name in enumerate(trash)}}


# -- GM r16, 1: a copy names its source; a family never repeats -----------------------------

@pytest.mark.parametrize(("source", "names", "want"), [
    ("Alpha (recovered)", (), "Alpha (recovered) copy"),
    ("Alpha (recovered)", ("Alpha (recovered) copy",), "Alpha (recovered) copy 2"),
    ("Alpha (recovered) copy", ("Alpha (recovered) copy",), "Alpha (recovered) copy 2"),
    ("Alpha (recovered 2)", (), "Alpha (recovered 2) copy"),
    ("Recovered canvas", (), "Recovered canvas copy"),
    ("Alpha copy", ("Alpha copy",), "Alpha copy 2"),
])
def test_r16_1_a_copy_names_its_source_and_never_says_copy_twice(source, names, want):
    got = store_module.duplicate_name(source, _named(*names))
    assert got == want
    assert "copy copy" not in got


@pytest.mark.parametrize(("source", "names", "want"), [
    ("Alpha (recovered)", ("Alpha (recovered)",), "Alpha (recovered 2)"),
    ("Alpha copy", (), "Alpha copy (recovered)"),
    ("Alpha copy 2", ("Alpha copy 2 (recovered)",), "Alpha copy 2 (recovered 2)"),
    ("Recovered canvas", ("Recovered canvas",), "Recovered canvas 2"),
])
def test_r16_1_a_recovered_copy_never_says_recovered_twice_in_a_row(source, names, want):
    got = store_module.recovered_name(source, _named(*names))
    assert got == want
    assert not re.search(r"\(recovered(?: \d+)?\) \(recovered", got)


# -- GM r16, 3: free counts Recently deleted --------------------------------------------------

@pytest.mark.parametrize(("lost", "names", "trash", "want"), [
    ("Beta", (), ("Beta",), "Beta (recovered)"),
    ("Beta", (), ("Beta", "Beta (recovered)"), "Beta (recovered 2)"),
    ("Beta", ("Beta (recovered)",), ("Beta",), "Beta (recovered 2)"),
    # Only the "(recovered)" name is in Recently deleted: "Beta" itself is free.
    ("Beta", (), ("Beta (recovered)",), "Beta"),
    ("Recovered canvas", (), ("Recovered canvas",), "Recovered canvas 2"),
    ("Alpha copy", (), ("Alpha copy",), "Alpha copy (recovered)"),
])
def test_r16_3_a_lost_rows_name_is_free_only_when_recently_deleted_doesnt_have_it(lost, names, trash, want):
    assert store_module.lost_row_name(lost, _named(*names, trash=trash)) == want


def test_r16_3_the_live_canvas_of_a_project_in_recently_deleted_is_filed_as_recovered(app):
    """main's filing of the live canvas whose project is in Recently deleted
    (_filed_canvas_name): "Beta" is still there, so not free."""
    owner = "b" * 32
    catalog = {"projects": {"a" * 32: {"name": "Alpha"}}, "trash": {owner: {"name": "Beta"}}}
    assert main_module._filed_canvas_name(catalog, owner) == "Beta (recovered)"
    catalog["trash"]["c" * 32] = {"name": "Beta (recovered)"}
    assert main_module._filed_canvas_name(catalog, owner) == "Beta (recovered 2)"


# -- GM r16, 5: the backend's person-facing lines use ’ ---------------------------------------

STRAIGHT = re.compile(r"[A-Za-z]'[A-Za-z]")


def test_r16_5_the_lines_the_cli_prints_to_people_use_curly_apostrophes():
    lines = [*main_module.CANVAS_SAVED_FOR_AGENT.values(), *main_module.CANVAS_KEPT_FOR_AGENT.values(),
             *main_module.CANVAS_COPY_WAITS.values()]
    for action in ("clear", "replace", "change"):
        for kept in (False, True):
            lines.append(main_module.canvas_saved_for_agent(action, "Nebula's film", None, kept))
            lines.append(main_module.canvas_saved_for_agent(action, "X", "film.json", kept))
    offenders = [line for line in lines if STRAIGHT.search(line.replace("Nebula's film", "N"))]
    assert offenders == []
    assert main_module.CANVAS_COPY_WAITS == {
        "projects": "The copy isn’t saved as a project yet because the project limit is reached.",
        "storage": "The copy isn’t saved as a project yet because Nebula’s project list is full.",
    }


# -- GM r16 (MCP): agents wait while the person's tab keeps edits -----------------------------

def _settles(check, seconds: float = 3.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.02)
    return check()


def _kept(socket, kept: bool) -> None:
    socket.send_json({"type": "keptEdits", "kept": kept})
    assert _settles(lambda: main_module.manager.kept_in_tab() is kept)


def _rev(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]


AGENT_WRITES = {
    "add": lambda client: client.post("/api/graph/node", headers=CODEX,
                                      json={"definitionId": "text-input", "params": {"value": "codex"}}),
    "clear": lambda client: client.delete("/api/graph?force=true", headers=CODEX),
    "load": lambda client: client.post("/api/graph/import", headers=CODEX, json={
        "nodes": [{"id": "x1", "definitionId": "text-input", "params": {"value": "imported"}}], "edges": []}),
    "set": lambda client: client.put("/api/graph/node/n1", headers=CODEX, json={"params": {"value": "codex-set"}}),
    "run": lambda client: client.post("/api/execute", headers=CODEX, json={}),
    "create": lambda client: client.post("/api/projects", headers=CODEX, json={"name": "Codex's", "workspaceRevision": _rev(client)}),
    "open": lambda client: client.post(f"/api/projects/{client.app.state.fix12_other}/open", headers=CODEX,
                                       json={"workspaceRevision": _rev(client)}),
}


@pytest.mark.parametrize("write", list(AGENT_WRITES))
def test_r16_mcp_an_agents_write_while_the_tab_keeps_edits_is_refused_with_its_code(app, write):
    client, store, _graph, _state = app
    other = _create(client, "Other")
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.app.state.fix12_other = other
    before = client.get("/api/graph", headers=PERSON).json()
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        _kept(socket, True)
        refused = AGENT_WRITES[write](client)
        assert refused.status_code == 409, refused.text
        body = refused.json()
        assert body["code"] == "canvas_kept_in_tab"
        assert body["detail"] == main_module.CANVAS_KEPT_IN_TAB_DETAIL
        after = client.get("/api/graph", headers=PERSON).json()
        assert [n["id"] for n in after["nodes"]] == [n["id"] for n in before["nodes"]]
        assert store.workspace()["activeProjectId"] == before.get("activeProjectId", store.workspace()["activeProjectId"])
        # Released: the same write goes (a run isn't sent: no paid start here).
        _kept(socket, False)
        if write in ("add", "set"):
            assert AGENT_WRITES[write](client).status_code == 200


def _active(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["activeProjectId"]


def test_r16_mcp_the_persons_own_requests_pass_and_reads_pass(app):
    client, _store, _graph, _state = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        _kept(socket, True)
        assert client.get("/api/graph", headers=CODEX).status_code == 200
        assert client.get("/api/projects", headers=CODEX).status_code == 200
        snapshot = client.get(f"/api/projects/{_active(client)}", headers=PERSON).json()["snapshot"]
        recovered = client.post("/api/projects/recover", headers=PERSON, json={
            "sourceProjectId": "f" * 32, "snapshot": snapshot, "recoveryId": "e" * 32,
            "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
        assert recovered.status_code == 200, recovered.text
        opened = client.post(f"/api/projects/{recovered.json()['project']['id']}/open", headers=PERSON,
                             json={"workspaceRevision": _rev(client)})
        assert opened.status_code == 200, opened.text


def test_r16_mcp_a_closed_tab_or_an_agents_socket_never_holds_agents_back(app):
    client, _store, _graph, _state = app
    _create(client, "Delta")
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        _kept(socket, True)
    assert _settles(lambda: not main_module.manager.kept_in_tab())
    assert AGENT_WRITES["add"](client).status_code == 200
    # An unpromoted socket (no person hello) can't say it: an agent can't
    # lock the canvas against other agents.
    with client.websocket_connect("/ws", headers=CODEX) as agent_socket:
        agent_socket.receive_json()
        agent_socket.send_json({"type": "keptEdits", "kept": True})
        time.sleep(0.2)
        assert not main_module.manager.kept_in_tab()
        assert AGENT_WRITES["add"](client).status_code == 200


def test_r16_mcp_cli_and_graph_tools_say_the_code():
    assert "canvas_kept_in_tab" in AGENT_REFUSAL_CODES
    payload = {"detail": main_module.CANVAS_KEPT_IN_TAB_DETAIL, "code": "canvas_kept_in_tab"}
    error = NebulaAPIError(main_module.CANVAS_KEPT_IN_TAB_DETAIL, status=409, kind="http", payload=payload)
    assert graph_file_client._refused(error) == f"{main_module.CANVAS_KEPT_IN_TAB_DETAIL} (409, canvas_kept_in_tab)"
    with pytest.raises(NebulaAPIError) as said:
        with mcp_server._canvas_waiting_said():
            raise error
    assert str(said.value).endswith("(409, canvas_kept_in_tab)")
    printed: list[str] = []
    cli = NebulaClient.__new__(NebulaClient)
    cli.base_url = "http://127.0.0.1:8799"
    with pytest.raises(SystemExit):
        import builtins
        real = builtins.print
        builtins.print = lambda *a, **k: printed.append(" ".join(map(str, a)))
        try:
            cli._fail(error, "x")
        finally:
            builtins.print = real
    assert printed == [f"error: {main_module.CANVAS_KEPT_IN_TAB_DETAIL} (canvas_kept_in_tab)"]
