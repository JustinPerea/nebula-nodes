"""MCP parity for projects (audit U3, without delete) and the reads agents
lacked (audit U6): rename_project, get_project, list_projects' cover, the
project.* and provider.hold journal kinds, get_settings, provider_status,
list_trash's scope, wait_for_canvas_change's journal, get_run for canvas runs
and look_at_canvas's providerHolds.

Every tool is called the way a client calls it, with its HTTP routed into the
FastAPI app, against an isolated project store. Every result is scanned for
the test keys: no tool result may hold a key or any part of one.
"""
from __future__ import annotations

import asyncio
import json
import threading
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import mcp_server
from models.events import (
    ErrorEvent,
    ExecutedEvent,
    ExecutingEvent,
    ProgressEvent,
    ProviderRecoveryEvent,
    ProviderStartAmbiguousEvent,
    StreamDeltaEvent,
)
from nebula_api import NebulaAPI, NebulaAPIError
from services import agent_spend
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

# Every window of these keys has an upper-case letter, so none of them can
# turn up by chance in ids, hex file names or node ids.
OPENAI_KEY = "sk-QzX9vW7pLm4T"
FAL_KEY = "ZpQ8RW2NQ5YTkx"
KEYS = (OPENAI_KEY, FAL_KEY)


def _no_key(result) -> None:
    """No key, no masked suffix (`***` + the last 4) and no 4-character run of a key."""
    text = json.dumps(result, default=str) if not isinstance(result, str) else result
    for key in KEYS:
        for start in range(len(key) - 3):
            assert key[start:start + 4] not in text, f"{key[start:start + 4]!r} of a test key is in {text[:400]}"


class _Krea:
    def __init__(self) -> None:
        self.state = {"status": "disconnected"}

    def status(self):
        return dict(self.state)


@pytest.fixture
def nebula(tmp_path, monkeypatch):
    """mcp_server against the app in-process, with its own projects and graph;
    execute_graph waits for `release`."""
    import main
    import routes.krea_connector as krea_routes

    release = threading.Event()
    release.set()
    script: dict = {"events": None}

    async def fake_execute_graph(*, nodes, emit, run_id, **kwargs):
        if script["events"] is not None:
            for event in script["events"](nodes, run_id):
                await emit(event)
        else:
            for node in nodes:
                await emit(ExecutedEvent(node_id=node.id, run_id=run_id,
                                         outputs={"text": {"type": "Text", "value": node.params.get("value", "")}}))
        while not release.is_set():
            await asyncio.sleep(0.01)

    settings = {
        "apiKeys": {"OPENAI_API_KEY": OPENAI_KEY, "FAL_KEY": FAL_KEY, "GOOGLE_API_KEY": ""},
        "routing": {"nano-banana": "direct"}, "outputPath": None, "executionMode": "auto",
        "batchSizeCap": 12, "exportFolder": "/tmp/nebula-exports", "zoomTelemetryEnabled": False,
        "kreaConnectionMode": "mcp", "favorites": ["nano-banana"],
    }
    krea = _Krea()
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    # Styles, boards and characters this file makes and deletes stay in this
    # test's own roots, not the session-wide ones (conftest) that other files'
    # exact Recently deleted listings read.
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path / "characters"))
    monkeypatch.setattr(main, "cli_graph", CLIGraph(persist_path=tmp_path / "state.json"))
    monkeypatch.setattr(main, "project_store", ProjectStore(tmp_path / "projects"))
    monkeypatch.setattr(main, "provider_recovery_store", ProviderRecoveryStore(tmp_path / "recoveries.json"))
    monkeypatch.setattr(main, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main, "execute_graph", fake_execute_graph)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "load_settings", lambda: json.loads(json.dumps(settings)))
    monkeypatch.setattr(main, "_krea_connector", lambda: krea)
    monkeypatch.setattr(krea_routes, "get_connector", lambda: krea)
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    # A loopback client, as an agent on this machine is: the Krea connection
    # route refuses any other (routes/krea_connector.local_origin).
    with TestClient(main.app, client=("127.0.0.1", 54321)) as http:
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
        yield {"http": http, "release": release, "script": script, "krea": krea, "settings": settings}
        release.set()


def _cursor() -> tuple[str, int]:
    events = mcp_server.look_at_canvas()["events"]
    return events["journal"], events["cursor"]


def _events(since: int, kinds: list[str], *, include_self: bool = True) -> list[dict]:
    result = mcp_server.wait_for_canvas_change(since=since, kinds=kinds, include_self=include_self, timeout_seconds=1)
    _no_key(result)
    return result.get("events") or []


def _revision(http) -> str:
    return http.get("/api/projects").json()["workspaceRevision"]


def _save(http, project_id: str, snapshot: dict, person) -> None:
    """The person's tab autosaving the open project."""
    response = http.put(f"/api/projects/{project_id}", json={"snapshot": snapshot, "workspaceRevision": _revision(http)},
                        headers=person.headers)
    assert response.status_code == 200, response.text


# -- projects ---------------------------------------------------------------------

def test_rename_project_returns_the_previous_name_and_renaming_back_undoes_it(nebula):
    first = mcp_server.new_project("Moodboards for Ana")["project"]
    mcp_server.new_project("Second")
    renamed = mcp_server.rename_project(first["id"], "  Ana: spring looks ")
    _no_key(renamed)
    assert renamed["project"] == {"id": first["id"], "name": "Ana: spring looks"}
    assert renamed["previousName"] == "Moodboards for Ana"
    assert f"rename_project('{first['id']}', 'Moodboards for Ana')" in renamed["note"]
    listed = {row["id"]: row["name"] for row in mcp_server.list_projects()["projects"]}
    assert listed[first["id"]] == "Ana: spring looks"

    back = mcp_server.rename_project(first["id"], renamed["previousName"])
    assert back["project"]["name"] == "Moodboards for Ana" and back["previousName"] == "Ana: spring looks"
    # "current" is the project open on the canvas.
    current = mcp_server.rename_project("current", "Second, renamed")
    assert current["project"]["name"] == "Second, renamed" and current["previousName"] == "Second"

    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.rename_project(first["id"], "   ")
    assert refused.value.status == 400
    with pytest.raises(NebulaAPIError) as missing:
        mcp_server.rename_project(uuid4().hex, "Nope")
    assert missing.value.status == 404


def test_a_rename_is_journaled_whoever_makes_it_and_only_when_the_name_changes(nebula, person):
    http = nebula["http"]
    project = mcp_server.new_project("Before")["project"]
    _, cursor = _cursor()
    mcp_server.rename_project(project["id"], "After")
    # The person's own rename, from the canvas header.
    assert http.put(f"/api/projects/{project['id']}", json={"name": "Person's name"},
                    headers=person.headers).status_code == 200
    # Saving the same name again changes nothing, so nothing is journaled.
    assert http.put(f"/api/projects/{project['id']}", json={"name": "Person's name"},
                    headers=person.headers).status_code == 200

    renames = _events(cursor, ["project.renamed"])
    assert [(event["data"]["from"], event["data"]["to"], event["actor"]["kind"]) for event in renames] == [
        ("Before", "After", "agent"), ("After", "Person's name", "person")]
    assert all(event["data"]["projectId"] == project["id"] for event in renames)
    assert renames[0]["summary"] == 'renamed project "Before" to "After"'
    # An agent waiting on the canvas sees the person's rename, not its own.
    theirs = _events(cursor, ["project"], include_self=False)
    assert [event["kind"] for event in theirs] == ["project.renamed"]
    assert theirs[0]["actor"]["kind"] == "person"


def test_projects_made_deleted_and_restored_are_journaled(nebula, person):
    http = nebula["http"]
    _, cursor = _cursor()
    made = mcp_server.new_project("Agent sketches")["project"]
    other = mcp_server.new_project("Keep open")["project"]
    gone = http.request("DELETE", f"/api/projects/{made['id']}", json={"workspaceRevision": _revision(http)},
                        headers=person.headers)
    assert gone.status_code == 200
    mcp_server.restore_from_trash("project", made["id"])

    events = _events(cursor, ["project"])
    assert [(event["kind"], event["data"]["projectId"]) for event in events] == [
        ("project.created", made["id"]), ("project.created", other["id"]),
        ("project.deleted", made["id"]), ("project.restored", made["id"])]
    assert events[0]["data"]["name"] == "Agent sketches" and events[0]["actor"]["kind"] == "agent"
    assert events[2]["actor"]["kind"] == "person" and events[2]["data"]["wasOpen"] is False
    assert events[3]["summary"] == 'restored project "Agent sketches" from Recently deleted'
    # `kinds` takes the group, like node or pin.
    assert {event["kind"] for event in _events(cursor, ["project.deleted"])} == {"project.deleted"}


def _seed_project_with_a_run(nebula, person) -> dict:
    """A project with a wired pair, a finished CLI run, an error on one node
    and a saved run-history record; then another project opened over it."""
    http = nebula["http"]
    project = mcp_server.new_project("Lighthouse")["project"]
    built = mcp_server.edit_canvas(
        nodes=[{"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse at dusk"}},
               {"ref": "+q", "definitionId": "text-input", "params": {"value": "second"}}],
        rename={"+p": "Hero prompt"},
    )
    prompt, second = built["idMap"]["+p"], built["idMap"]["+q"]
    asyncio.run(mcp_server.run_nodes(prompt, wait_seconds=10))
    looked = mcp_server.look_at_canvas()
    saved = http.get(f"/api/projects/{project['id']}").json()["snapshot"]
    saved["runHistory"] = [{
        "id": "run-1", "trigger": "node", "startedAt": 1_760_000_000_000, "status": "complete",
        "targetNodeId": prompt, "durationSec": 1.5, "nodesExecuted": 1, "statusNote": "done",
        "snapshot": {"nodes": [{"id": prompt, "definitionId": "text-input",
                                "params": {"value": "a lighthouse at dusk"}, "outputs": {}}], "edges": []},
        "resultOutputs": {prompt: {"text": {"type": "Text", "value": "a lighthouse at dusk"}}},
    }]
    assert http.put(f"/api/projects/{project['id']}",
                    json={"snapshot": saved, "workspaceRevision": _revision(http)},
                    headers=person.headers).status_code == 200
    mcp_server.new_project("Something else")
    return {"project": project, "prompt": prompt, "second": second, "looked": looked}


def test_get_project_reads_a_closed_project_redacted_like_look_at_canvas(nebula, person):
    seeded = _seed_project_with_a_run(nebula, person)
    project, prompt = seeded["project"], seeded["prompt"]
    read = mcp_server.get_project(project["id"])
    _no_key(read)
    assert read["id"] == project["id"] and read["name"] == "Lighthouse" and read["open"] is False
    assert read["nodeCount"] == 2 and read["edgeCount"] == 0 and read["truncated"] is False

    # Each node exactly as look_at_canvas showed it while the project was open.
    fields = ("id", "definitionId", "name", "model", "params", "outputs", "inputsFrom")
    looked = {node["id"]: {key: node.get(key) for key in fields} for node in seeded["looked"]["nodes"]}
    got = {node["id"]: {key: node.get(key) for key in fields} for node in read["nodes"]}
    assert got == looked
    hero = next(node for node in read["nodes"] if node["id"] == prompt)
    assert hero["name"] == "Hero prompt" and hero["model"] == "Text Input"
    assert hero["outputs"] == {"text": {"type": "Text", "available": True}}
    assert hero["state"] == "complete" and isinstance(hero["position"], dict)

    # Run history: what ran and what it made, never the values.
    [record] = read["runHistory"]
    assert record["id"] == "run-1" and record["status"] == "complete" and record["targetNodeId"] == prompt
    assert record["nodeIds"] == [prompt]
    assert record["outputs"] == {prompt: {"text": {"type": "Text", "available": True}}}
    assert "a lighthouse at dusk" not in json.dumps(record)
    assert read["runHistoryCount"] == 1

    with pytest.raises(NebulaAPIError) as missing:
        mcp_server.get_project(uuid4().hex)
    assert missing.value.status == 404


def test_get_project_redacts_secrets_and_internal_params(nebula, person):
    """A saved snapshot can hold anything the canvas wrote; the agent view
    goes through the same redaction as look_at_canvas."""
    http = nebula["http"]
    project = mcp_server.new_project("Secrets")["project"]
    saved = http.get(f"/api/projects/{project['id']}").json()["snapshot"]
    saved["nodes"] = [
        {"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
         "data": {"definitionId": "text-input", "label": "Text Input",
                  "params": {"value": f"https://cdn.example.com/a.png?sig={FAL_KEY}"},
                  "outputs": {"text": {"type": "Text", "value": f"made with {OPENAI_KEY}"}}}},
        {"id": "n2", "type": "model-node", "position": {"x": 400, "y": 0},
         "data": {"definitionId": "image-input", "label": "Image Input",
                  "params": {"filePath": "", "_previewUrl": f"data:image/png;base64,{FAL_KEY}"}, "outputs": {}}},
    ]
    _save(http, project["id"], saved, person)
    read = mcp_server.get_project("current")
    _no_key(read)
    link, image = read["nodes"]
    # A link keeps its path, never its query; outputs say only what exists.
    assert link["params"] == {"value": "https://cdn.example.com/a.png"}
    assert link["outputs"] == {"text": {"type": "Text", "available": True}}
    # Editor bookkeeping (`_` keys) never reaches an agent.
    assert "_previewUrl" not in image["params"]
    assert read["open"] is True


def test_get_project_hides_a_key_a_provider_quoted_in_a_saved_error(nebula, person):
    """The card keeps the provider's raw error, and providers quote keys:
    OpenAI's 401 shows the first and last characters ("sk-QzX9****Lm4T"),
    a bad header shows all of it. get_project hands back the error without them."""
    http = nebula["http"]
    project = mcp_server.new_project("Failed")["project"]
    saved = http.get(f"/api/projects/{project['id']}").json()["snapshot"]
    quoted = (f"Error code: 401 - Incorrect API key provided: {OPENAI_KEY[:7]}{'*' * 20}{OPENAI_KEY[-4:]}. "
              f"You can find your API key at https://platform.openai.com/account/api-keys. (sent Key {FAL_KEY})")
    saved["nodes"] = [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                       "data": {"definitionId": "text-input", "label": "Text Input", "params": {"value": "x"},
                                "outputs": {}, "state": "error", "error": quoted}}]
    _save(http, project["id"], saved, person)
    [node] = mcp_server.get_project("current")["nodes"]
    _no_key(node)
    assert node["state"] == "error"
    assert node["error"].startswith("Error code: 401 - Incorrect API key provided: ")
    assert "You can find your API key" in node["error"]


def test_get_project_shows_a_universal_nodes_ports_as_look_at_canvas_does(nebula, person):
    """Merge with main (#132): look_at_canvas gives a universal node configured
    for a model its `ports` and leaves `_model_ports` out of params. A saved
    project's nodes go through the same redacted_node, so get_project shows
    the same ports, and still hides a key a provider quoted in its error."""
    from services import universal_ports
    from services.model_cache import model_cache

    http = nebula["http"]
    model_cache.set("openrouter:models", {"models": [
        {"id": "openai/gpt-4o", "name": "GPT-4o", "input_modalities": ["text", "image"],
         "output_modalities": ["text"]}], "count": 1}, ttl=300)
    try:
        project = mcp_server.new_project("Universal")["project"]
        built = mcp_server.edit_canvas(nodes=[{"ref": "+eye", "definitionId": "openrouter-universal",
                                               "params": {"model": "openai/gpt-4o"}}])
        eye = built["idMap"]["+eye"]
        looked = next(node for node in mcp_server.look_at_canvas()["nodes"] if node["id"] == eye)
        assert looked["ports"] == {"inputs": ["messages", "images"], "outputs": ["text"]}
        assert universal_ports.PORTS_PARAM not in looked["params"]

        # The person's tab autosaves the card with the error a failed run left on it.
        saved = http.get(f"/api/projects/{project['id']}").json()["snapshot"]
        [rf] = [node for node in saved["nodes"] if node["id"] == eye]
        assert universal_ports.PORTS_PARAM in rf["data"]["params"]  # the saved card keeps its record
        rf["data"]["error"] = f"Error code: 401 - Incorrect API key provided: {OPENAI_KEY[:7]}****{OPENAI_KEY[-4:]}"
        _save(http, project["id"], saved, person)

        read = mcp_server.get_project("current")
        _no_key(read)
        [node] = [node for node in read["nodes"] if node["id"] == eye]
        fields = ("id", "definitionId", "name", "params", "outputs", "inputsFrom", "ports")
        assert {key: node.get(key) for key in fields} == {key: looked.get(key) for key in fields}
        assert node["error"].startswith("Error code: 401 - Incorrect API key provided: ")
    finally:
        model_cache.clear()


def test_list_trash_narrows_styles_by_scope_too(nebula, person):
    """Merge with main (#130): Styles are in Recently deleted, and list_trash's
    scope (#121) narrows them as it narrows boards and characters."""
    project = mcp_server.new_project("Looks")["project"]
    mine = mcp_server.style_create("Project look", prompt="warm", project_id="current")
    everyone = mcp_server.style_create("Global look", prompt="cool")
    for style in (mine, everyone):
        mcp_server.style_delete(style["id"])

    def listed(**kwargs) -> set[str]:
        result = mcp_server.list_trash(kind="style", **kwargs)
        _no_key(result)
        assert all(item["kind"] == "style" for item in result["items"])
        return {item["id"] for item in result["items"]}

    assert listed() >= {mine["id"], everyone["id"]}
    assert listed(project_id="current") == {mine["id"]}
    assert listed(scope="project", project_id=project["id"]) == {mine["id"]}
    assert mine["id"] not in listed(scope="global") and everyone["id"] in listed(scope="global")


def test_get_run_hides_a_key_a_provider_quoted_in_a_node_error(nebula, person):
    http, script = nebula["http"], nebula["script"]
    mcp_server.new_project("Quoted")
    a = mcp_server.edit_canvas(nodes=[{"ref": "+a", "definitionId": "text-input", "params": {"value": "x"}}])["idMap"]["+a"]

    def failing(graph_nodes, run_id):
        # A handler's own ErrorEvent: no friendly reading, the raw text only.
        yield ErrorEvent(node_id=a, run_id=run_id,
                         error=f"401: Incorrect API key provided: {OPENAI_KEY[:7]}****{OPENAI_KEY[-4:]}; header Key {FAL_KEY}")

    script["events"] = failing
    run_id = _canvas_run(http, person, [{"id": a, "definitionId": "text-input", "params": {"value": "x"}}])
    failed = json.loads(asyncio.run(mcp_server.get_run(run_id, wait_seconds=5))[0])
    _no_key(failed)
    _no_key(http.get(f"/api/graph/runs/{run_id}").json())
    assert failed["status"] == "failed" and failed["errors"][a].startswith("401: Incorrect API key provided: ")
    # look_at_canvas shows the card's message the same way.
    [node] = [node for node in mcp_server.look_at_canvas()["nodes"] if node["id"] == a]
    _no_key(node)
    assert node["error"].startswith("401: Incorrect API key provided: ")


def test_the_journal_and_view_output_hide_a_key_a_provider_quoted(nebula, person):
    """Review of #121: a failed run's journal event (wait_for_canvas_change,
    `nebula watch`) and view_output's failure answers (its 409 and the
    X-Nebula-Last-Run-Error header beside an older output; `nebula path`)
    are agent reads of the same raw error, so they hide keys too."""
    from models.events import SkippedEvent

    http, script = nebula["http"], nebula["script"]
    mcp_server.new_project("Quoted elsewhere")
    built = mcp_server.edit_canvas(nodes=[{"ref": "+a", "definitionId": "text-input", "params": {"value": "x"}},
                                          {"ref": "+b", "definitionId": "text-input", "params": {"value": "y"}},
                                          {"ref": "+c", "definitionId": "text-input", "params": {"value": "z"}}])
    a, b, c = (built["idMap"][ref] for ref in ("+a", "+b", "+c"))
    nodes = [{"id": node, "definitionId": "text-input", "params": {"value": "x"}} for node in (a, b, c)]
    quoted = f"401: Incorrect API key provided: {OPENAI_KEY[:7]}****{OPENAI_KEY[-4:]}; header Key {FAL_KEY}"

    # a has an output from an earlier run that worked.
    def worked(graph_nodes, run_id):
        yield ExecutedEvent(node_id=a, run_id=run_id, outputs={"text": {"type": "Text", "value": "earlier"}})

    script["events"] = worked
    first = _canvas_run(http, person, nodes[:1])
    assert json.loads(asyncio.run(mcp_server.get_run(first, wait_seconds=5))[0])["status"] == "finished"

    journal, cursor = _cursor()

    def failing(graph_nodes, run_id):
        yield ErrorEvent(node_id=a, run_id=run_id, error=quoted)
        yield ErrorEvent(node_id=b, run_id=run_id, error=quoted)
        yield SkippedEvent(node_id=c, run_id=run_id, reason=f"upstream said {quoted}")

    script["events"] = failing
    failed = _canvas_run(http, person, nodes)
    assert json.loads(asyncio.run(mcp_server.get_run(failed, wait_seconds=5))[0])["status"] == "failed"

    changed = mcp_server.wait_for_canvas_change(since=cursor, journal=journal, timeout_seconds=2,
                                                kinds=["run"], include_self=True)
    raw = http.get("/api/canvas/events", params={"after": cursor, "journal": journal, "wait": 0,
                                                 "self": 1}).json()  # `nebula watch`
    for result in (changed, raw):
        _no_key(result)
        failures = [event for event in result["events"] if event["kind"] == "run.failed"]
        assert {event["nodeId"] for event in failures} >= {a, b}
        for event in failures:
            assert "<key hidden>" in event["data"]["error"] and "****" not in event["data"]["error"]
    skipped = [event for event in changed["events"] if event["nodeId"] == c and event["kind"] == "run.skipped"]
    assert skipped and "<key hidden>" in skipped[0]["data"]["reason"]

    # b made nothing: view_output (and `nebula path`, the same 409) gives the error.
    no_output = json.loads(mcp_server.view_output(b)[0])
    _no_key(no_output)
    assert no_output["state"] == "error" and "<key hidden>" in no_output["error"]
    path = http.get(f"/api/graph/node/{b}/path")
    _no_key(path.text)
    # a still has its earlier value: view_output notes the failure beside it.
    older = json.loads(mcp_server.view_output(a)[0])
    _no_key(older)
    assert older["outputs"]["text"]["value"] == "earlier" and "<key hidden>" in older["note"]
    preview = http.get(f"/api/graph/node/{a}/preview")
    assert preview.status_code == 415
    _no_key(preview.headers.get("x-nebula-last-run-error") or "")


def test_list_projects_and_get_project_carry_the_cover(nebula, person, monkeypatch):
    import main
    from services import project_cover

    picture = f"cover-{uuid4().hex}.png"
    (main.OUTPUT_ROOT / picture).write_bytes(b"\x89PNG\r\n\x1a\n")
    http = nebula["http"]
    try:
        project = mcp_server.new_project("Covered")["project"]
        saved = http.get(f"/api/projects/{project['id']}").json()["snapshot"]
        saved["nodes"] = [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                           "data": {"definitionId": "nano-banana", "label": "Nano Banana", "params": {},
                                    "outputs": {"image": {"type": "Image", "value": f"/api/outputs/{picture}"}}}}]
        assert http.put(f"/api/projects/{project['id']}",
                        json={"snapshot": saved, "workspaceRevision": _revision(http)},
                        headers=person.headers).status_code == 200
        row = next(row for row in mcp_server.list_projects()["projects"] if row["id"] == project["id"])
        assert row["cover"] == {"source": "output", "images": [f"http://testserver/api/outputs/{picture}"]}
        assert mcp_server.get_project(project["id"])["cover"] == row["cover"]
        # A signed link keeps its path only, as look_at_canvas shows links.
        monkeypatch.setattr(project_cover, "cover", lambda snapshot, pin=None: {
            "source": "output", "images": [f"https://cdn.example.com/x.png?token={FAL_KEY}"]})
        saved["nodes"][0]["position"] = {"x": 5, "y": 5}
        http.put(f"/api/projects/{project['id']}", json={"snapshot": saved, "workspaceRevision": _revision(http)},
                 headers=person.headers)
        listed = mcp_server.list_projects()
        _no_key(listed)
        row = next(row for row in listed["projects"] if row["id"] == project["id"])
        assert row["cover"]["images"] == ["https://cdn.example.com/x.png"]
    finally:
        (main.OUTPUT_ROOT / picture).unlink(missing_ok=True)


# -- settings and providers ----------------------------------------------------------

def test_get_settings_says_which_keys_are_set_and_never_any_part_of_one(nebula, person):
    result = mcp_server.get_settings()
    _no_key(result)
    assert result == {
        "configured": {"OPENAI_API_KEY": True, "FAL_KEY": True, "GOOGLE_API_KEY": False},
        "routing": {"nano-banana": "direct"},
        "executionMode": "auto",
        "batchSizeCap": 12,
        "exportFolder": "/tmp/nebula-exports",
        "kreaConnectionMode": "mcp",
    }
    # GET /api/settings (Justin, Q55 a): "Only the app (your person token)
    # gets the endings. Everything else learns which providers are set, and
    # nothing more." An agent's curl or `nebula keys` gets a bare "***".
    http = nebula["http"]
    anyone = http.get("/api/settings").json()["apiKeys"]
    _no_key(anyone)
    assert anyone == {"OPENAI_API_KEY": "***", "FAL_KEY": "***", "GOOGLE_API_KEY": ""}
    app = http.get("/api/settings", headers=person.headers).json()["apiKeys"]
    assert app == {"OPENAI_API_KEY": "***" + OPENAI_KEY[-4:], "FAL_KEY": "***" + FAL_KEY[-4:], "GOOGLE_API_KEY": ""}


def test_provider_status_reads_the_health_probes_and_the_krea_connection(nebula, monkeypatch):
    import main

    calls: list[bool] = []

    async def fake_validate(*, force_refresh: bool = False, **kwargs):
        calls.append(force_refresh)
        return {"OpenAI": {"configured": True, "status": "valid", "last_checked": "2026-10-20T10:00:00+00:00"},
                "FAL": {"configured": True, "status": "invalid", "last_checked": "2026-10-20T10:00:00+00:00",
                        "detail": "authentication rejected (HTTP 401)"},
                "Google": {"configured": False, "status": "not_configured", "last_checked": "x"}}

    monkeypatch.setattr(main, "validate_provider_keys", fake_validate)
    nebula["krea"].state = {"status": "needs_auth", "authorizationUrl": "https://krea.ai/oauth?state=abc&code_challenge=xyz",
                            "error": "Krea sign-in expired", "tools": ["list_models"]}
    result = mcp_server.provider_status()
    _no_key(result)
    assert calls == [False]
    assert result["providers"]["FAL"] == {"configured": True, "status": "invalid", "lastChecked": "2026-10-20T10:00:00+00:00",
                                          "detail": "authentication rejected (HTTP 401)"}
    assert result["providers"]["Google"]["status"] == "not_configured"
    # The person's sign-in link stays with the person: the agent learns one is waiting.
    assert result["krea"] == {"status": "needs_auth", "signInPending": True, "error": "Krea sign-in expired",
                              "tools": ["list_models"]}
    assert "oauth" not in json.dumps(result)
    mcp_server.provider_status(refresh=True)
    assert calls == [False, True]


def test_provider_status_never_hands_back_a_key_a_failed_probe_quoted(nebula, monkeypatch):
    """A key saved with its line break (pasted from a file) can't go in a
    header, and httpx's error quotes the whole header: the real probe's
    detail must not carry it to an agent, or to the Settings panel."""
    import socket

    from services import settings as settings_module

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    pasted = {"apiKeys": {"OPENAI_API_KEY": OPENAI_KEY + "\n", "FAL_KEY": FAL_KEY + " "}}
    monkeypatch.setattr(settings_module, "load_settings", lambda: json.loads(json.dumps(pasted)))
    monkeypatch.setattr(settings_module, "PROVIDER_CHECKS", {
        "OpenAI": settings_module.ProviderCheck(("OPENAI_API_KEY",), f"http://127.0.0.1:{port}/v1/models",
                                                lambda key: {"Authorization": f"Bearer {key}"}),
        "FAL": settings_module.ProviderCheck(("FAL_KEY",), f"http://127.0.0.1:{port}/v1/models",
                                             lambda key: {"Authorization": f"Key {key}\r\nX: y"}),
    })
    settings_module.clear_provider_validation_cache()
    try:
        result = mcp_server.provider_status(refresh=True)
        _no_key(result)
        _no_key(nebula["http"].get("/api/health/providers", params={"refresh": "true"}).json())
        for name in ("OpenAI", "FAL"):
            row = result["providers"][name]
            assert row["status"] == "error" and row["configured"] is True
            assert "line break" in row["detail"], row
    finally:
        listener.close()
        settings_module.clear_provider_validation_cache()


# -- Recently deleted, journal, runs -------------------------------------------------

def test_list_trash_narrows_to_global_or_one_project(nebula, person):
    http = nebula["http"]
    project = mcp_server.new_project("Boards")["project"]
    ids = {}
    for name, scope in (("Theirs", project["id"]), ("Everyone's", None)):
        made = http.post("/api/moodboards", json={"name": name, "projectId": scope}, headers=person.headers)
        assert made.status_code in (200, 201), made.text
        ids[name] = made.json()["id"]
        assert http.delete(f"/api/moodboards/{ids[name]}", headers=person.headers).status_code == 200

    def listed(**kwargs) -> set[str]:
        result = mcp_server.list_trash(kind="moodboard", **kwargs)
        _no_key(result)
        return {item["id"] for item in result["items"]}

    assert listed() >= {ids["Theirs"], ids["Everyone's"]}
    assert ids["Theirs"] in listed(scope="project", project_id=project["id"])
    assert ids["Everyone's"] not in listed(scope="project", project_id=project["id"])
    # project_id alone means that project; "current" is the open one.
    assert ids["Theirs"] in listed(project_id="current")
    assert ids["Theirs"] not in listed(scope="global") and ids["Everyone's"] in listed(scope="global")
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.list_trash(scope="project")
    assert refused.value.status == 400


def test_wait_for_canvas_change_takes_the_journal_its_cursor_belongs_to(nebula):
    journal, cursor = _cursor()
    mcp_server.edit_canvas(nodes=[{"ref": "+p", "definitionId": "text-input"}])
    same = mcp_server.wait_for_canvas_change(since=cursor, journal=journal, include_self=True, timeout_seconds=1)
    assert same["reset"] is False and [event["kind"] for event in same["events"]] == ["node.added"]
    # A cursor from a backend that restarted since: Nebula says so instead of
    # reading the new journal from that cursor.
    old = "0" * 12 if journal != "0" * 12 else "1" * 12
    moved = mcp_server.wait_for_canvas_change(since=cursor, journal=old, include_self=True, timeout_seconds=1)
    assert moved["reset"] is True and moved["journal"] == journal


def _canvas_run(http, person, nodes: list[dict]) -> str:
    response = http.post("/api/execute", headers=person.headers, json={"nodes": nodes, "edges": []})
    assert response.status_code == 200, response.text
    return response.json()["runId"]


def test_get_run_reads_a_run_the_person_started_on_the_canvas(nebula, person):
    http, release, script = nebula["http"], nebula["release"], nebula["script"]
    mcp_server.new_project("Canvas run")
    built = mcp_server.edit_canvas(nodes=[{"ref": "+a", "definitionId": "text-input", "params": {"value": "hello"}},
                                          {"ref": "+b", "definitionId": "text-input", "params": {"value": "next"}}])
    a, b = built["idMap"]["+a"], built["idMap"]["+b"]
    nodes = [{"id": a, "definitionId": "text-input", "params": {"value": "hello"}},
             {"id": b, "definitionId": "text-input", "params": {"value": "next"}}]

    def events(graph_nodes, run_id):
        yield ExecutedEvent(node_id=a, run_id=run_id, outputs={"text": {"type": "Text", "value": "hello"}})
        yield ExecutingEvent(node_id=b, run_id=run_id)
        yield ProgressEvent(node_id=b, run_id=run_id, value=0.25)
        yield ProgressEvent(node_id=b, run_id=run_id, value=0.5)
        yield StreamDeltaEvent(node_id=b, run_id=run_id, delta="lo", accumulated="Hello")

    script["events"] = events
    release.clear()
    run_id = _canvas_run(http, person, nodes)
    running = json.loads(asyncio.run(mcp_server.get_run(run_id, wait_seconds=0.2))[0])
    _no_key(running)
    assert running["status"] == "running" and running["runId"] == run_id
    assert running["source"] == "canvas" and running["startedBy"] == {"kind": "person", "name": "You"}
    assert running["nodes"][a]["state"] == "complete"
    assert running["nodes"][b] == {"state": "executing", "progress": 0.5, "partialText": "Hello"}
    assert running["outputs"][a]["text"]["value"] == "hello"
    assert "get_run" in running["next"]

    release.set()
    done = json.loads(asyncio.run(mcp_server.get_run(run_id, wait_seconds=5))[0])
    assert done["status"] == "finished" and done["nodesExecuted"] == 1

    # A failed node: the run is "failed", with the card's message.
    def failing(graph_nodes, run_id):
        yield ErrorEvent(node_id=a, run_id=run_id, error="HTTP 500", friendly="The provider had an error")

    script["events"] = failing
    failed_run = _canvas_run(http, person, nodes[:1])
    failed = json.loads(asyncio.run(mcp_server.get_run(failed_run, wait_seconds=5))[0])
    assert failed["status"] == "failed" and failed["errors"] == {a: "The provider had an error"}
    assert failed["nodes"][a]["state"] == "error"
    assert failed["error"] == f"{a} failed: The provider had an error"

    # The run itself raised before any node reported: still "failed", with
    # a message an agent can pass on (never the exception's own text).
    def crashing(graph_nodes, run_id):
        raise RuntimeError(f"engine broke with {OPENAI_KEY}")
        yield  # pragma: no cover - a generator

    script["events"] = crashing
    crashed_run = _canvas_run(http, person, nodes[:1])
    crashed = json.loads(asyncio.run(mcp_server.get_run(crashed_run, wait_seconds=5))[0])
    _no_key(crashed)
    assert crashed["status"] == "failed" and not crashed.get("errors")
    assert "before any node" in crashed["error"]

    with pytest.raises(NebulaAPIError) as missing:
        asyncio.run(mcp_server.get_run("no-such-run", wait_seconds=0))
    assert missing.value.status == 404


def test_get_run_on_a_running_agent_run_says_how_far_each_node_got(nebula):
    release, script = nebula["release"], nebula["script"]
    mcp_server.new_project("Agent run")
    built = mcp_server.edit_canvas(nodes=[{"ref": "+a", "definitionId": "text-input", "params": {"value": "x"}}])
    a = built["idMap"]["+a"]

    def events(graph_nodes, run_id):
        yield ExecutingEvent(node_id=a, run_id=run_id)
        yield ProgressEvent(node_id=a, run_id=run_id, value=0.75)

    script["events"] = events
    release.clear()
    running = json.loads(asyncio.run(mcp_server.run_nodes(a, wait_seconds=0.2))[0])
    assert running["status"] == "running"
    later = json.loads(asyncio.run(mcp_server.get_run(running["runId"], wait_seconds=0.1))[0])
    assert later["nodes"][a] == {"state": "executing", "progress": 0.75}
    assert later["startedBy"]["kind"] == "agent"
    release.set()
    done = json.loads(asyncio.run(mcp_server.get_run(running["runId"], wait_seconds=5))[0])
    assert done["status"] == "finished" and "nodes" not in done  # as its start answered

    # The route keeps the last 50 agent runs; one it forgot still answers
    # from its events, and says it was an agent's.
    import main

    main._cli_runs._runs.pop(running["runId"])
    forgotten = json.loads(asyncio.run(mcp_server.get_run(running["runId"], wait_seconds=0))[0])
    assert forgotten["source"] == "agent" and forgotten["startedBy"]["kind"] == "agent"


def test_look_at_canvas_lists_held_paid_starts_and_the_journal_says_when_one_is_held(nebula, person):
    import main

    http = nebula["http"]
    mcp_server.new_project("World")
    node = mcp_server.edit_canvas(nodes=[{"ref": "+w", "definitionId": "text-input"}])["idMap"]["+w"]
    _, cursor = _cursor()
    assert mcp_server.look_at_canvas()["providerHolds"] == {"recoveries": [], "startAmbiguities": []}

    async def emit_holds():
        await main._emit_and_sync(ProviderStartAmbiguousEvent(run_id="run-held", node_id=node,
                                                              kind="worldlabs-environment", message="x"))
        await main._emit_and_sync(ProviderRecoveryEvent(run_id="run-rec", node_id=node, resume_operation_id="op-123"))

    asyncio.run(emit_holds())
    holds = mcp_server.look_at_canvas()["providerHolds"]
    _no_key(holds)
    [ambiguity] = holds["startAmbiguities"]
    assert (ambiguity["runId"], ambiguity["nodeId"], ambiguity["kind"]) == ("run-held", node, "worldlabs-environment")
    assert ambiguity["durable"] is True and ambiguity["message"]
    assert holds["recoveries"] == [{"runId": "run-rec", "nodeId": node, "resumeOperationId": "op-123",
                                    "existingWorldId": None}]

    held = _events(cursor, ["provider"])
    assert [(event["kind"], event["data"]["hold"], event["data"]["change"]) for event in held] == [
        ("provider.hold", "startAmbiguity", "held"), ("provider.hold", "recovery", "held")]
    assert held[0]["nodeId"] == node and held[0]["data"]["runId"] == "run-held"

    # The person clears it (agents have no tool for that: audit question 2).
    cleared = http.delete(f"/api/provider-start-ambiguities/worldlabs-environment/{node}/run-held",
                          headers=person.headers)
    assert cleared.status_code == 200, cleared.text
    after = _events(held[-1]["seq"], ["provider.hold"])
    assert [(event["data"]["hold"], event["data"]["change"], event["actor"]["kind"]) for event in after] == [
        ("startAmbiguity", "cleared", "person")]
    assert mcp_server.look_at_canvas()["providerHolds"]["startAmbiguities"] == []


# -- registration and wording ------------------------------------------------------

def test_the_new_tools_are_registered_annotated_and_documented():
    from pathlib import Path

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    new = {"rename_project", "get_project", "get_settings", "provider_status"}
    assert new <= set(tools)
    for name in ("get_project", "get_settings", "provider_status"):
        assert tools[name].annotations.readOnlyHint is True
    assert tools["provider_status"].annotations.openWorldHint is True
    assert tools["get_settings"].annotations.openWorldHint is False
    rename = tools["rename_project"].annotations
    assert rename.readOnlyHint is False and rename.destructiveHint is False and rename.idempotentHint is True
    assert {"journal"} <= set(tools["wait_for_canvas_change"].inputSchema["properties"])
    assert {"scope", "project_id"} <= set(tools["list_trash"].inputSchema["properties"])

    doc = mcp_server.look_at_canvas.__doc__ or ""
    assert "proposals" in doc and "providerHolds" in doc
    for name in new:
        assert name in mcp_server.INSTRUCTIONS
    setup = (Path(__file__).resolve().parents[2] / "docs" / "MCP-SETUP.md").read_text()
    for name in new | {"project.renamed", "provider.hold"}:
        assert f"`{name}`" in setup
