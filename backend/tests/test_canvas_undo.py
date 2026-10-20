"""An agent undoes its own canvas edit (POST /api/graph/apply/undo, the MCP
tool undo_canvas_edit, `nebula undo`), and the journal says whose edit an
undo reverted, for the agent's undo and for the person's Cmd+Z alike.

Every apply that changes something hands back ``undo: {token, editId,
expiresInSeconds, summary}``. The server keeps the inverse (memory-only,
bounded): undo checks each part against how the edit left it and leaves a
part someone changed since as it is, reporting it, as a moodboard restore
does. The inverse may hold the canvas's own ``_`` params (an uploaded
image's preview, a painted mask, a Paper source) because the server wrote
it; an agent still can't send ``_`` params itself.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_arrange import ArrangeBook
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.canvas_undo import CanvasUndoBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Code"}
OTHER = {"X-Nebula-Agent": "Codex"}
TAB = "tab-0123456789abcdef"
CANVAS = {**PERSON, "X-Nebula-Tab": TAB}


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        other = make_project("Other")
        catalog["projects"][project["id"]] = project
        catalog["projects"][other["id"]] = other
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    journal = CanvasEventJournal()
    clock = Clock()
    book = CanvasUndoBook(clock=clock)
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "canvas_undo_book", book)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.journal = journal
    ctx.book = book
    ctx.clock = clock
    ctx.sent = sent
    ctx.store = store
    ctx.project_id = project["id"]
    ctx.other_project_id = other["id"]
    return ctx


def _seed(api) -> tuple[str, str]:
    """n1 text-input wired into n2 nano-banana."""
    prompt = api.graph.add_node("text-input", {"value": "a lighthouse"}, position={"x": 0, "y": 0})
    image = api.graph.add_node("nano-banana", {"aspect_ratio": "1:1"}, position={"x": 400, "y": 0})
    api.graph.connect(prompt, "text", image, "prompt")
    return prompt, image


def _apply(api, body, headers=AGENT) -> dict:
    response = api.client.post("/api/graph/apply", headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _undo(api, token, headers=AGENT):
    return api.client.post("/api/graph/apply/undo", headers=headers, json={"token": token})


def _undone(api, token, headers=AGENT) -> dict:
    response = _undo(api, token, headers)
    assert response.status_code == 200, response.text
    return response.json()


def _wires(api) -> set[tuple[str, str, str, str]]:
    return {(e["source"], e["sourceHandle"], e["target"], e["targetHandle"]) for e in api.graph.edges}


def _syncs(api) -> list[dict]:
    return [event for event in api.sent if event.get("type") == "graphSync"]


def _events(api, after=0) -> list[dict]:
    return api.journal.read(after=after, limit=100)["events"]


# -- the token --------------------------------------------------------------

def test_an_edit_hands_back_an_undo_token(api):
    prompt, _ = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    undo = applied["undo"]
    assert isinstance(undo["token"], str) and len(undo["token"]) >= 32
    assert undo["editId"].startswith("ed_") and undo["editId"] != undo["token"]
    assert undo["expiresInSeconds"] == 3600
    assert prompt in undo["summary"]
    # The token is the agent's alone: it never rides on a sync or the journal.
    assert undo["token"] not in repr(api.sent) and undo["token"] not in repr(_events(api))


def test_an_edit_that_changes_nothing_has_no_undo(api):
    prompt, _ = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a lighthouse"}}]})
    assert applied["summary"] == "no change"
    assert applied["undo"] is None


# -- what undo puts back ----------------------------------------------------

def test_undo_puts_params_back(api):
    prompt, image = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}},
                                    {"nodeId": image, "params": {"aspect_ratio": "16:9", "model": "gemini-3-pro-image"}}]})["undo"]["token"]
    result = _undone(api, token)
    assert result["status"] == "undone"
    assert sorted(result["changed"]) == sorted([prompt, image]) and result["skipped"] == []
    assert api.graph.nodes[prompt]["params"] == {"value": "a lighthouse"}
    # A key the edit added is taken away again.
    assert api.graph.nodes[image]["params"] == {"aspect_ratio": "1:1"}


def test_undo_puts_names_and_positions_back(api):
    prompt, image = _seed(api)
    api.graph.set_label(image, "Hero")
    token = _apply(api, {"rename": {prompt: "Brief", image: ""},
                         "move": {prompt: {"x": 800, "y": 300}}})["undo"]["token"]
    assert api.graph.nodes[prompt]["label"] == "Brief" and not api.graph.nodes[image].get("label")
    result = _undone(api, token)
    assert sorted(result["renamed"]) == sorted([prompt, image]) and result["moved"] == [prompt]
    assert not api.graph.nodes[prompt].get("label")
    assert api.graph.nodes[image]["label"] == "Hero"
    assert api.graph.nodes[prompt]["position"] == {"x": 0.0, "y": 0.0}


def test_undo_takes_away_the_nodes_and_wires_an_edit_added(api):
    prompt, image = _seed(api)
    token = _apply(api, {
        "nodes": [{"ref": "+alt", "definitionId": "nano-banana", "params": {"aspect_ratio": "4:5"}}],
        "edges": [{"source": prompt, "sourceHandle": "text", "target": "+alt", "targetHandle": "prompt"}],
    })["undo"]["token"]
    assert len(api.graph.nodes) == 3
    result = _undone(api, token)
    assert len(result["removed"]) == 1
    assert set(api.graph.nodes) == {prompt, image}
    assert _wires(api) == {(prompt, "text", image, "prompt")}


def test_undo_unwires_a_wire_the_edit_added_between_existing_nodes(api):
    prompt, image = _seed(api)
    other = api.graph.add_node("text-input", {"value": "b"})
    token = _apply(api, {"edges": [{"source": other, "sourceHandle": "text",
                                    "target": image, "targetHandle": "prompt"}],
                         "unwire": [{"source": prompt, "sourceHandle": "text",
                                     "target": image, "targetHandle": "prompt"}]})["undo"]["token"]
    assert _wires(api) == {(other, "text", image, "prompt")}
    _undone(api, token)
    assert _wires(api) == {(prompt, "text", image, "prompt")}


def test_undo_brings_a_removed_node_back_with_its_outputs_wires_name_and_internal_params(api):
    """An uploaded image (``_previewUrl``), a painted mask (``_maskData``) and a
    Paper source (``_paperSource``): agents can't send those params, so an
    agent couldn't put such a node back through /api/graph/restore."""
    import main as main_module

    picture = main_module.OUTPUT_ROOT / "undo-upload.png"
    picture.write_bytes(b"\x89PNG\r\n\x1a\n")
    try:
        upload = api.graph.add_node("image-input", {"filePath": str(picture),
                                                    "_previewUrl": "/api/outputs/undo-upload.png"},
                                    position={"x": 0, "y": 300},
                                    outputs={"image": {"type": "Image", "value": "/api/outputs/undo-upload.png"}})
        mask = api.graph.add_node("mask-painter", {"polarity": "black-edit",
                                                   "_maskData": "data:image/png;base64,iVBORw0KGgo="},
                                  position={"x": 400, "y": 300})
        paper = api.graph.add_node("paper-source", {"_paperSource": {"id": "src_1", "sequence": 3,
                                                                     "fileId": "f1", "objectId": "o1"}},
                                   position={"x": 0, "y": 600})
        api.graph.connect(upload, "image", mask, "image")
        api.graph.set_label(mask, "Sky mask")
        before = {node_id: dict(api.graph.nodes[node_id]) for node_id in (upload, mask, paper)}

        applied = _apply(api, {"remove": [upload, mask, paper]})
        assert set(applied["removed"]) == {upload, mask, paper} and api.graph.edges == []

        result = _undone(api, applied["undo"]["token"])
        assert sorted(result["added"]) == sorted([upload, mask, paper]) and result["skipped"] == []
        for node_id, node in before.items():
            now = api.graph.nodes[node_id]
            assert now["params"] == node["params"], node_id
            assert now["position"] == node["position"]
            assert now.get("outputs", {}) == node.get("outputs", {})
        assert api.graph.nodes[mask]["label"] == "Sky mask"
        assert _wires(api) == {(upload, "image", mask, "image")}
    finally:
        picture.unlink(missing_ok=True)


def test_an_agent_still_cannot_send_internal_params_itself(api):
    _seed(api)
    sneaky = api.client.post("/api/graph/restore", headers=AGENT, json={
        "nodes": [{"id": "n9", "definitionId": "mask-painter", "params": {"_maskData": "data:image/png;base64,AA=="}}]})
    assert sneaky.status_code == 422
    # The undo route takes a token and nothing else: no body to smuggle params in.
    smuggled = api.client.post("/api/graph/apply/undo", headers=AGENT, json={
        "token": "x" * 32, "nodes": [{"id": "n9", "definitionId": "mask-painter"}]})
    assert smuggled.status_code == 400 and "n9" not in api.graph.nodes


def test_a_removed_node_comes_back_with_the_persons_billing_choice(api):
    flux = api.graph.add_node("flux-2-pro", {"_provider": "fal"}, position={"x": 0, "y": 0})
    applied = _apply(api, {"remove": [flux]})
    result = _undone(api, applied["undo"]["token"])
    assert result["added"] == [flux]
    assert api.graph.nodes[flux]["params"]["_provider"] == "fal"


# -- parts changed since stay as they are -----------------------------------

def test_a_node_the_person_changed_since_is_skipped_and_reported(api):
    prompt, image = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}},
                                    {"nodeId": image, "params": {"aspect_ratio": "16:9"}}],
                         "move": {image: {"x": 900, "y": 0}}})["undo"]["token"]
    changed = api.client.put(f"/api/graph/node/{prompt}", headers=PERSON, json={"params": {"value": "a castle"}})
    assert changed.status_code == 200, changed.text
    moved = api.client.put("/api/graph/layout", headers=PERSON, json={"positions": {image: {"x": 50, "y": 50}}})
    assert moved.status_code == 200, moved.text

    result = _undone(api, token)
    assert result["status"] == "undone"
    assert api.graph.nodes[prompt]["params"]["value"] == "a castle"
    assert api.graph.nodes[image]["params"]["aspect_ratio"] == "1:1"
    assert api.graph.nodes[image]["position"] == {"x": 50.0, "y": 50.0}
    skipped = {(item["nodeId"], item["part"]): item for item in result["skipped"]}
    assert set(skipped) == {(prompt, "params"), (image, "position")}
    assert skipped[(prompt, "params")]["keys"] == ["value"]
    assert skipped[(prompt, "params")]["reason"] == "changed since"
    assert "changed since" in skipped[(prompt, "params")]["message"]


def test_only_the_changed_param_stays_when_the_person_changed_another(api):
    prompt, image = _seed(api)
    token = _apply(api, {"params": [{"nodeId": image, "params": {"aspect_ratio": "16:9", "model": "gemini-3-pro-image"}}]})["undo"]["token"]
    assert api.client.put(f"/api/graph/node/{image}", headers=PERSON, json={"params": {"model": "gemini-2.5-flash-image"}}).status_code == 200
    result = _undone(api, token)
    assert api.graph.nodes[image]["params"] == {"aspect_ratio": "1:1", "model": "gemini-2.5-flash-image"}
    assert [(item["nodeId"], item["keys"]) for item in result["skipped"]] == [(image, ["model"])]


def test_an_added_node_the_person_changed_or_wired_since_stays(api):
    prompt, image = _seed(api)
    applied = _apply(api, {"nodes": [{"ref": "+a", "definitionId": "text-input", "params": {"value": "fog"}},
                                     {"ref": "+b", "definitionId": "text-input", "params": {"value": "rain"}},
                                     {"ref": "+c", "definitionId": "text-input", "params": {"value": "snow"}}]})
    a, b, c = (applied["idMap"][ref] for ref in ("+a", "+b", "+c"))
    assert api.client.put(f"/api/graph/node/{a}", headers=PERSON, json={"params": {"value": "mist"}}).status_code == 200
    assert api.client.request("DELETE", "/api/graph/edge", headers=PERSON, json={
        "source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}).status_code == 200
    assert api.client.post("/api/graph/connect", headers=PERSON, json={
        "source": b, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}).status_code == 200

    result = _undone(api, applied["undo"]["token"])
    assert result["removed"] == [c]
    assert set(api.graph.nodes) == {prompt, image, a, b}
    reasons = {item["nodeId"]: item["reason"] for item in result["skipped"]}
    assert reasons == {a: "changed since", b: "wired since"}


def test_a_wire_that_cannot_go_back_is_skipped_and_the_rest_is_undone(api):
    board = api.graph.add_node("text-input", {"value": "board"}, position={"x": 0, "y": 0})
    flux = api.graph.add_node("flux-2-pro", {}, position={"x": 400, "y": 0})
    api.graph.connect(board, "text", flux, "prompt")
    applied = _apply(api, {"remove": [board]})
    # The person wires another prompt into the single prompt input since.
    other = api.graph.add_node("text-input", {"value": "other"})
    assert api.client.post("/api/graph/connect", headers=PERSON, json={
        "source": other, "sourceHandle": "text", "target": flux, "targetHandle": "prompt"}).status_code == 200
    result = _undone(api, applied["undo"]["token"])
    assert result["added"] == [board]
    assert (other, "text", flux, "prompt") in _wires(api)
    assert (board, "text", flux, "prompt") not in _wires(api)
    wires = [item for item in result["skipped"] if item["part"] == "wire"]
    assert len(wires) == 1 and wires[0]["wire"] == {"source": board, "sourceHandle": "text",
                                                    "target": flux, "targetHandle": "prompt"}


def test_a_param_only_the_person_may_open_again_stays_closed(api):
    """An agent may close a Moodboard node's send_notes; undoing that would
    open it again, which only the person may do (as a board restore keeps)."""
    import main as main_module

    board = main_module._moodboard_store().create(name="Undo board")
    node = api.graph.add_node("nebula-moodboard", {"moodboard": board["id"], "send_notes": "yes"})
    token = _apply(api, {"params": [{"nodeId": node, "params": {"send_notes": "no"}}]})["undo"]["token"]
    result = _undone(api, token)
    assert api.graph.nodes[node]["params"]["send_notes"] == "no"
    assert [(item["nodeId"], item["keys"], item["reason"]) for item in result["skipped"]] == [
        (node, ["send_notes"], "the person's to change")]


def test_nothing_left_to_undo_keeps_the_token(api):
    prompt, _ = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})["undo"]["token"]
    assert api.client.put(f"/api/graph/node/{prompt}", headers=PERSON, json={"params": {"value": "x"}}).status_code == 200
    result = _undone(api, token)
    assert result["status"] == "skipped" and api.graph.nodes[prompt]["params"]["value"] == "x"
    # The person puts it back the way the edit left it: now the undo goes through.
    assert api.client.put(f"/api/graph/node/{prompt}", headers=PERSON,
                          json={"params": {"value": "a fort"}}).status_code == 200
    assert _undone(api, token)["status"] == "undone"
    assert api.graph.nodes[prompt]["params"]["value"] == "a lighthouse"


def test_undoing_twice_changes_nothing_the_second_time(api):
    prompt, _ = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})["undo"]["token"]
    first = _undone(api, token)
    assert first["status"] == "undone"
    assert api.client.put(f"/api/graph/node/{prompt}", headers=PERSON, json={"params": {"value": "z"}}).status_code == 200
    again = _undone(api, token)
    assert again["status"] == "already-undone" and again["undoneBy"]["kind"] == "agent"
    assert api.graph.nodes[prompt]["params"]["value"] == "z"


# -- tokens that don't work -------------------------------------------------

def test_an_unknown_token_is_404_and_an_expired_one_410(api):
    prompt, _ = _seed(api)
    unknown = _undo(api, "f" * 32)
    assert unknown.status_code == 404 and "undo token" in unknown.json()["detail"]
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})["undo"]["token"]
    api.clock.now += 3601
    expired = _undo(api, token)
    assert expired.status_code == 410 and "expired" in expired.json()["detail"]
    assert api.graph.nodes[prompt]["params"]["value"] == "a fort"


def test_a_token_from_another_agent_is_refused(api):
    prompt, _ = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})["undo"]["token"]
    refused = _undo(api, token, headers=OTHER)
    assert refused.status_code == 403 and "Claude Code" in refused.json()["detail"]
    person = _undo(api, token, headers=PERSON)
    assert person.status_code == 403  # the canvas undoes with Cmd+Z
    assert api.graph.nodes[prompt]["params"]["value"] == "a fort"
    assert _undone(api, token)["status"] == "undone"


def test_a_token_from_another_project_is_refused_until_it_is_open_again(api):
    import main as main_module

    prompt, _ = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})["undo"]["token"]
    monkey = main_module.project_store
    with monkey.transaction() as catalog:
        catalog["activeProjectId"] = api.other_project_id
        monkey.commit(catalog)
    refused = _undo(api, token)
    assert refused.status_code == 409 and "Active" in refused.json()["detail"]
    with monkey.transaction() as catalog:
        catalog["activeProjectId"] = api.project_id
        monkey.commit(catalog)
    assert _undone(api, token)["status"] == "undone"


def test_clearing_the_canvas_ends_its_undo_tokens(api):
    prompt, _ = _seed(api)
    token = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})["undo"]["token"]
    assert api.client.delete("/api/graph?force=true", headers=AGENT).status_code == 200
    gone = _undo(api, token)
    assert gone.status_code == 410 and "cleared" in gone.json()["detail"]


def test_the_book_is_bounded(api):
    import services.canvas_undo as canvas_undo

    prompt, _ = _seed(api)
    tokens = [_apply(api, {"params": [{"nodeId": prompt, "params": {"value": f"v{i}"}}]})["undo"]["token"]
              for i in range(canvas_undo.MAX_EDITS + 1)]
    oldest = _undo(api, tokens[0])
    assert oldest.status_code == 410 and "oldest" in oldest.json()["detail"]
    assert _undo(api, tokens[-1]).status_code == 200


# -- the journal and the canvas ----------------------------------------------

def test_an_edits_events_and_sync_carry_its_edit_id(api):
    prompt, _ = _seed(api)
    cursor = api.journal.latest
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}],
                           "nodes": [{"ref": "+x", "definitionId": "text-input"}]})
    edit_id = applied["undo"]["editId"]
    events = _events(api, cursor)
    assert events and all(event["edit"] == {"id": edit_id} for event in events)
    assert _syncs(api)[-1]["edit"]["id"] == edit_id


def test_an_agents_undo_says_what_it_undid(api):
    prompt, _ = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    edit_id = applied["undo"]["editId"]
    edit_events = [event["seq"] for event in _events(api) if (event.get("edit") or {}).get("id") == edit_id]
    cursor = api.journal.latest
    result = _undone(api, applied["undo"]["token"])
    events = _events(api, cursor)
    assert [event["kind"] for event in events] == ["node.params", "edit.undone"]
    for event in events:
        assert event["actor"]["name"] == "Claude Code"
        assert event["edit"]["undoes"] == edit_id and event["edit"]["id"] == result["undoId"]
        assert event["edit"]["of"]["name"] == "Claude Code"
    assert events[0]["summary"].endswith("(undo)")
    summary = events[-1]
    assert summary["data"]["editId"] == edit_id and summary["data"]["events"] == edit_events
    assert "undid its own edit" in summary["summary"]
    sync = _syncs(api)[-1]["edit"]
    assert sync["undoes"] == edit_id and sync["actor"]["name"] == "Claude Code"


def test_the_persons_cmd_z_of_an_agent_edit_is_linked_and_the_agent_sees_it(api):
    prompt, _ = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    edit_id = applied["undo"]["editId"]
    me = next(event["actor"]["id"] for event in _events(api) if event["actor"].get("kind") == "agent")
    cursor = api.journal.latest
    # The canvas's undo step came from that edit's graphSync, which named the edit.
    response = api.client.post("/api/graph/restore", headers=CANVAS, json={
        "action": "undo", "edit": edit_id,
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "a lighthouse"}}]})
    assert response.status_code == 200, response.text
    seen = api.journal.read(after=cursor, limit=50, exclude_actor_id=me)["events"]
    assert [event["kind"] for event in seen] == ["node.params", "edit.undone"]
    for event in seen:
        assert event["actor"] == {"kind": "person"}
        assert event["edit"]["undoes"] == edit_id and event["edit"]["of"]["id"] == me
    assert seen[-1]["summary"] == "undid Claude Code's edit (Cmd+Z on the canvas)"
    # Its token now says the person undid it, and changes nothing.
    again = _undone(api, applied["undo"]["token"])
    assert again["status"] == "already-undone" and again["undoneBy"] == {"kind": "person", "name": "You"}

    # Redo on the canvas puts the edit back, and the token works again.
    cursor = api.journal.latest
    redo = api.client.post("/api/graph/restore", headers=CANVAS, json={
        "action": "redo", "edit": edit_id,
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "a fort"}}]})
    assert redo.status_code == 200, redo.text
    kinds = [event["kind"] for event in _events(api, cursor)]
    assert kinds == ["node.params", "edit.redone"]
    assert _undone(api, applied["undo"]["token"])["status"] == "undone"


def test_cmd_z_of_an_agents_undo_puts_its_edit_back_in_reach(api):
    prompt, _ = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    first = _undone(api, applied["undo"]["token"])
    undo_id = first["undoId"]
    assert _syncs(api)[-1]["edit"]["id"] == undo_id
    cursor = api.journal.latest
    response = api.client.post("/api/graph/restore", headers=CANVAS, json={
        "action": "undo", "edit": undo_id,
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "a fort"}}]})
    assert response.status_code == 200, response.text
    summary = _events(api, cursor)[-1]
    assert summary["kind"] == "edit.undone" and summary["data"]["editId"] == undo_id
    assert summary["data"]["undid"] == applied["undo"]["editId"]
    assert summary["summary"] == "undid Claude Code's undo (Cmd+Z on the canvas)"
    assert _undone(api, applied["undo"]["token"])["status"] == "undone"
    assert api.graph.nodes[prompt]["params"]["value"] == "a lighthouse"


def test_only_the_persons_canvas_can_link_a_restore_to_an_edit(api):
    prompt, _ = _seed(api)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    cursor = api.journal.latest
    response = api.client.post("/api/graph/restore", headers=OTHER, json={
        "action": "undo", "edit": applied["undo"]["editId"],
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "a lighthouse"}}]})
    assert response.status_code == 200, response.text
    events = _events(api, cursor)
    assert [event["kind"] for event in events] == ["node.params"]
    assert "edit" not in events[0]
    # The other agent's restore didn't mark the edit undone.
    assert _undo(api, applied["undo"]["token"]).json()["status"] in ("undone", "skipped")


def test_a_malformed_edit_link_is_refused(api):
    prompt, _ = _seed(api)
    response = api.client.post("/api/graph/restore", headers=CANVAS, json={
        "action": "undo", "edit": "<script>",
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "b"}}]})
    assert response.status_code == 400
    assert api.graph.nodes[prompt]["params"]["value"] == "a lighthouse"


def test_an_unknown_edit_id_is_still_named_without_guessing_whose(api):
    prompt, _ = _seed(api)
    cursor = api.journal.latest
    response = api.client.post("/api/graph/restore", headers=CANVAS, json={
        "action": "undo", "edit": "ed_00000000000000aa",
        "nodes": [{"id": prompt, "definitionId": "text-input", "params": {"value": "b"}}]})
    assert response.status_code == 200, response.text
    events = _events(api, cursor)
    assert events[0]["edit"]["undoes"] == "ed_00000000000000aa" and "of" not in events[0]["edit"]
    assert events[-1]["summary"] == "undid an edit Nebula no longer knows (Cmd+Z on the canvas)"


# -- a change that lands while the edit's request is still finishing ---------

def test_a_change_that_lands_during_the_edits_own_broadcast_is_not_part_of_its_undo(api, monkeypatch):
    """apply awaits (graphSync, pins, the agent's cursor) after it commits.
    Another request (the person's canvas, another agent) can land in between;
    what it changed is theirs, so undoing the agent's edit must leave it."""
    import main as main_module

    prompt, image = _seed(api)
    spare = api.graph.add_node("text-input", {"value": "b"}, position={"x": 0, "y": 300})
    other = api.graph.add_node("nano-banana", {"aspect_ratio": "1:1"}, position={"x": 400, "y": 300})
    landed = {"done": False}
    original = main_module.manager.broadcast_raw

    async def broadcast_then_the_person_edits(data):
        await original(data)
        if data.get("type") == "graphSync" and not landed["done"]:
            landed["done"] = True
            # The person's own edits, landing while apply is still awaiting.
            api.graph.connect(spare, "text", other, "prompt")
            api.graph.set_params(image, {**api.graph.nodes[image]["params"], "model": "gemini-2.5-flash-image"})

    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast_then_the_person_edits)
    token = _apply(api, {"params": [{"nodeId": image, "params": {"aspect_ratio": "16:9"}}]})["undo"]["token"]
    assert landed["done"]
    monkeypatch.setattr(main_module.manager, "broadcast_raw", original)

    result = _undone(api, token)
    assert result["status"] == "undone"
    # The agent's change goes back; the person's wire and param stay.
    assert api.graph.nodes[image]["params"] == {"aspect_ratio": "1:1", "model": "gemini-2.5-flash-image"}
    assert (spare, "text", other, "prompt") in _wires(api)
    assert result["unwired"] == []


def test_an_edit_whose_canvas_is_cleared_while_it_finishes_gets_no_token(api, monkeypatch):
    """Clearing the canvas ends its tokens because node ids start again; an
    edit still finishing when that happens must not keep one either."""
    import main as main_module

    prompt, _ = _seed(api)
    original = main_module.manager.broadcast_raw
    cleared = {"done": False}

    async def broadcast_then_clear(data):
        await original(data)
        if data.get("type") == "graphSync" and not cleared["done"]:
            cleared["done"] = True
            api.graph.clear()
            main_module._forget_canvas_undo("the canvas was cleared since")

    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast_then_clear)
    applied = _apply(api, {"params": [{"nodeId": prompt, "params": {"value": "a fort"}}]})
    assert cleared["done"]
    assert applied["undo"]["token"] is None
    assert "cleared" in applied["undo"]["reason"]
