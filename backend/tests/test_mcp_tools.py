"""The MCP server's build-and-run tools, called the way a client calls them,
with their HTTP routed into the FastAPI app."""
from __future__ import annotations

import asyncio
import io
import json
import threading
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from mcp.server.fastmcp import Image
from PIL import Image as PILImage

import mcp_server
from services.canvas_proposals import MAX_NODES
from models.events import ExecutedEvent, SkippedEvent
from nebula_api import NebulaAPI, NebulaAPIError
from services import agent_spend, node_readiness, output_preview



class _Krea:
    def status(self):
        return {"status": "disconnected"}


@pytest.fixture
def nebula(monkeypatch):
    """mcp_server talking to the app in-process; execute_graph waits for `release`."""
    import main

    release = threading.Event()
    release.set()
    picture = f"mcp-{uuid4().hex}.png"
    PILImage.new("RGB", (1200, 800), (30, 120, 200)).save(main.OUTPUT_ROOT / picture)

    async def fake_execute_graph(*, nodes, emit, run_id, **kwargs):
        for node in nodes:
            if node.definition_id == "text-input":
                outputs = {"text": {"type": "Text", "value": node.params.get("value", "")}}
            else:
                outputs = {"image": {"type": "Image", "value": f"/api/outputs/{picture}"}}
            await emit(ExecutedEvent(node_id=node.id, outputs=outputs, run_id=run_id))
        while not release.is_set():
            await asyncio.sleep(0.01)

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    monkeypatch.setattr(main, "execute_graph", fake_execute_graph)
    # The fake engine never calls a provider, so these keyless runs may start;
    # the tests of a run the pre-call check refuses put the real one back.
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "_krea_connector", lambda: _Krea())
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    with TestClient(main.app) as http:
        http.delete("/api/graph?force=true")
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
        yield http, release
        release.set()
        http.delete("/api/graph?force=true")
    (main.OUTPUT_ROOT / picture).unlink(missing_ok=True)


def _text(parts: list) -> dict:
    return json.loads(parts[0])


def _build(prompt: str = "a fox") -> dict:
    return mcp_server.edit_canvas(
        note="Prompt into an image",
        nodes=[{"ref": "+p", "definitionId": "text-input", "params": {"value": prompt}},
               {"ref": "+img", "definitionId": "nano-banana"}],
        edges=[{"source": "+p", "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
    )


def test_find_and_describe_follow_the_readiness_rule(nebula):
    import main

    found = mcp_server.find_nodes(limit=100)
    keys = node_readiness.configured_keys(main.load_settings())
    for row in found["nodes"]:
        definition = main.node_registry.get(row["id"])
        assert row["runsWith"] == node_readiness.node_access(definition, keys, False, main.node_registry.get_all())
    # Looked up by name: unfiltered, rows are ready-first then by name, so with
    # keys left in the session's settings "Text Input" can sit past row 100.
    text_input = mcp_server.find_nodes(query="text input")["nodes"]
    assert any(row["id"] == "text-input" and row["price"] == "free" for row in text_input)

    everything = mcp_server.find_nodes(query="nano banana", ready_only=False)
    assert all("nano" in row["id"] or "nano" in row["name"].lower() for row in everything["nodes"])

    described = mcp_server.describe_node("nano-banana")
    assert [port["id"] for port in described["inputs"]] == ["prompt", "images", "moodboard"]
    assert any(param["key"] == "aspect_ratio" and "16:9" in param["options"] for param in described["params"])
    with pytest.raises(NebulaAPIError, match="Close matches: nano-banana"):
        mcp_server.describe_node("nano-bananna")


def test_local_nodes_that_call_a_provider_say_what_they_need(nebula, monkeypatch):
    """`utility` isn't "free": Cinema Scene runs its base model, and a QC node's
    vision-llm mode calls a vision model with no list price."""
    import main

    real = main.load_settings
    keys: dict = {}
    monkeypatch.setattr(main, "load_settings", lambda: {**real(), "apiKeys": dict(keys)})

    assert "cinema-scene" not in {row["id"] for row in mcp_server.find_nodes(query="cinema scene")["nodes"]}
    rows = {row["id"]: row for row in mcp_server.find_nodes(query="cinema scene", ready_only=False)["nodes"]}
    assert rows["cinema-scene"]["runsWith"] is None and rows["cinema-scene"]["price"] is None
    assert "FAL_KEY" in rows["cinema-scene"]["missing"] and "GOOGLE_API_KEY" in rows["cinema-scene"]["missing"]

    qc_row = next(row for row in mcp_server.find_nodes(query="qc frame")["nodes"] if row["id"] == "qc-frame-review")
    assert qc_row["runsWith"] == "free" and qc_row["price"] == "free"
    assert "mode=vision-llm" in qc_row["needsKeyFor"] and "no list price" in qc_row["needsKeyFor"]
    assert "mode=jev needs TYPESAFE_API_KEY and is priced per run" in qc_row["needsKeyFor"]
    qc = mcp_server.describe_node("qc-frame-review")
    assert qc["runsWith"] == "free" and qc["price"] == "free" and "no list price" in qc["priceNote"]
    assert qc["runsWithOptions"]["options"] == {"heuristic": "free", "vision-llm": None, "opencv": "free",
                                                "jev": None}
    assert qc["pricedWhen"]["rows"] == [{"mode": "jev", "usd": [0.0000128, 0.0027]}]

    keys.update({"GOOGLE_API_KEY": "g"})
    cinema = mcp_server.describe_node("cinema-scene")
    assert cinema["runsWith"] == "key" and "missing" not in cinema
    assert cinema["runsWithOptions"]["options"]["seedream-4-5"] is None
    assert "set scene.base.model to nano-banana" in cinema["runsWithOptions"]["note"]
    assert mcp_server.describe_node("qc-frame-review")["runsWithOptions"]["options"]["vision-llm"] == "key"


def test_edit_canvas_applies_everything_or_nothing(nebula):
    http, _ = nebula
    built = _build()
    assert built["status"] == "applied" and set(built["idMap"]) == {"+p", "+img"}
    before = http.get("/api/graph").json()

    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.edit_canvas(
            nodes=[{"ref": "+x", "definitionId": "nano-banana"}],
            edges=[{"source": built["idMap"]["+p"], "sourceHandle": "text", "target": "+x", "targetHandle": "nope"}],
        )
    assert refused.value.status == 400
    assert http.get("/api/graph").json() == before

    removed = mcp_server.remove_from_canvas(node_ids=[built["idMap"]["+img"]])
    assert removed["removed"] == [built["idMap"]["+img"]]


def test_edit_canvas_can_ask_the_canvas_to_arrange(nebula):
    built = mcp_server.edit_canvas(
        nodes=[{"ref": f"+t{i}", "definitionId": "text-input"} for i in range(MAX_NODES + 2)],
        arrange={"direction": "down", "gap": 60},
    )
    assert built["summary"] == f"added {MAX_NODES + 2}"
    assert built["arrange"]["nodeIds"] == [built["idMap"][f"+t{i}"] for i in range(MAX_NODES + 2)]
    assert (built["arrange"]["direction"], built["arrange"]["gap"]) == ("down", 60.0)


def test_run_previews_images_and_reports_text(nebula):
    built = _build("a lighthouse")
    parts = asyncio.run(mcp_server.run_nodes(built["idMap"]["+img"], wait_seconds=10))
    result = _text(parts)
    assert result["status"] == "finished"
    assert result["outputs"][built["idMap"]["+p"]]["text"]["value"] == "a lighthouse"
    image_url = result["outputs"][built["idMap"]["+img"]]["image"]["value"]
    assert image_url.startswith("http://testserver/api/outputs/")
    images = [part for part in parts if isinstance(part, Image)]
    assert len(images) == 1
    assert len(images[0].data) <= output_preview.MAX_BYTES
    assert max(PILImage.open(io.BytesIO(images[0].data)).size) <= output_preview.SIZES["small"]


def test_run_reports_skipped_nodes_and_describe_marks_gate_ports(nebula, monkeypatch):
    import main

    async def gated_execute_graph(*, nodes, emit, run_id, **kwargs):
        for node in nodes:
            if node.definition_id == "text-input":
                await emit(ExecutedEvent(node_id=node.id, run_id=run_id,
                                         outputs={"text": {"type": "Text", "value": "x"}}))
            else:
                await emit(SkippedEvent(node_id=node.id, run_id=run_id, gate_node_id="g",
                                        reason="Jev Decide failed (answered no, 0.12)"))

    monkeypatch.setattr(main, "execute_graph", gated_execute_graph)
    built = _build()
    image = built["idMap"]["+img"]
    parts = asyncio.run(mcp_server.run_nodes(image, wait_seconds=10))
    result = _text(parts)
    assert result["skipped"] == {image: "Jev Decide failed (answered no, 0.12)"}
    assert image not in result["outputs"] and len(parts) == 1  # nothing to preview

    described = mcp_server.describe_node("jev-decide")
    gates = [port for port in described["outputs"] if port.get("gate")]
    assert gates == [{"id": "on_pass", "type": "Any", "gate": True}, {"id": "on_fail", "type": "Any", "gate": True}]
    assert {"id": "through", "type": "Any"} in described["inputs"]


def test_a_long_run_comes_back_running_then_get_run_collects_it(nebula):
    _, release = nebula
    built = _build()
    release.clear()
    running = _text(asyncio.run(mcp_server.run_nodes(built["idMap"]["+p"], wait_seconds=0.1)))
    assert running["status"] == "running" and "get_run" in running["next"]
    release.set()
    done = _text(asyncio.run(mcp_server.get_run(running["runId"], wait_seconds=5)))
    assert done["status"] == "finished"


def test_cancel_run_keeps_what_finished(nebula):
    _, release = nebula
    built = _build()
    release.clear()
    run_id = _text(asyncio.run(mcp_server.run_nodes(built["idMap"]["+p"], wait_seconds=0.1)))["runId"]
    mcp_server.cancel_run(run_id)
    outcome = _text(asyncio.run(mcp_server.get_run(run_id, wait_seconds=5)))
    assert outcome["status"] == "cancelled"
    assert built["idMap"]["+p"] in outcome["outputs"]


def test_a_run_over_the_limit_points_at_propose_change(nebula, monkeypatch, person):
    import main

    http, _ = nebula
    pricing = {"nodes": {"nano-banana": {"currency": "usd", "rows": [{"match": {}, "price": 5.0}]}}}
    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: pricing)
    reset = {"runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": None, "models": {}}}
    assert http.put("/api/settings", json=reset, headers=person.headers).status_code == 200
    built = _build()
    with pytest.raises(NebulaAPIError) as refused:
        asyncio.run(mcp_server.run_nodes(built["idMap"]["+img"]))
    assert refused.value.status == 403
    assert "propose_change" in refused.value.detail

    limits = mcp_server.get_spend_limits()
    assert limits["limited"] is True and limits["budget"] == "shared"
    assert limits["limits"]["perRunUsd"] == 1


def test_view_output_shows_images_and_text(nebula):
    built = _build("hello there")
    asyncio.run(mcp_server.run_nodes(built["idMap"]["+img"], wait_seconds=10))
    picture = mcp_server.view_output(built["idMap"]["+img"], size="large")
    assert isinstance(picture[0], Image)
    assert max(PILImage.open(io.BytesIO(picture[0].data)).size) <= output_preview.SIZES["large"]
    text = json.loads(mcp_server.view_output(built["idMap"]["+p"])[0])
    assert text["outputs"]["text"]["value"] == "hello there"
    with pytest.raises(ValueError):
        mcp_server.view_output(built["idMap"]["+p"], size="huge")


def test_an_agent_starts_a_new_project_and_can_name_the_way_back(nebula):
    mcp_server.new_project("Before")
    _build("kept in Before")
    made = mcp_server.new_project("Agent sketches")
    assert made["project"]["name"] == "Agent sketches" and made["project"]["nodes"] == 0
    back = made["previousProject"]
    assert back["name"] == "Before" and f"open_project('{back['id']}')" in made["note"]
    listed = mcp_server.list_projects()
    assert listed["openProjectId"] == made["project"]["id"]
    assert next(p for p in listed["projects"] if p["id"] == back["id"])["nodes"] == 2
    returned = mcp_server.open_project(back["id"])
    assert returned["project"]["nodes"] == 2 and returned["previousProject"]["name"] == "Agent sketches"
    # Clearing a project with nodes needs force: the refusal says what to do.
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server._canvas_call("DELETE", "/api/graph", None)
    assert refused.value.status == 409 and "new_project" in refused.value.detail
    assert "--force" in refused.value.detail


def test_every_tool_is_annotated_and_the_instructions_name_real_tools():
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    assert {"find_nodes", "describe_node", "edit_canvas", "remove_from_canvas", "run_nodes", "get_run",
            "cancel_run", "view_output", "get_spend_limits", "list_projects", "open_project", "new_project"} <= set(tools)
    assert all(tool.annotations is not None for tool in tools.values())
    assert tools["remove_from_canvas"].annotations.destructiveHint is True
    assert tools["run_nodes"].annotations.openWorldHint is True
    import re

    named = set(re.findall(r"\b([a-z]+(?:_[a-z]+)+)\b", mcp_server.INSTRUCTIONS))
    assert named - {"ready_only"} <= set(tools) | {"wait_seconds"}


def test_a_run_that_fails_tells_the_agent_why_everywhere_it_looks(nebula, monkeypatch):
    """run_nodes reports "failed" with the node's message; look_at_canvas and
    view_output give that message instead of a bare error state or "no output yet"."""
    import main
    from execution.engine import validate_graph

    monkeypatch.setattr(main, "validate_graph", validate_graph)
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    built = _build()
    image = built["idMap"]["+img"]
    result = _text(asyncio.run(mcp_server.run_nodes(image, wait_seconds=10)))
    assert result["status"] == "failed" and result["nodesExecuted"] == 0
    message = result["errors"][image]
    assert "GOOGLE_API_KEY" in message and result["error"].startswith("Nothing ran, so nothing was spent.")

    looked = next(node for node in mcp_server.look_at_canvas()["nodes"] if node["id"] == image)
    assert looked["error"] == message
    answer = mcp_server.view_output(image)
    assert len(answer) == 1
    assert json.loads(answer[0]) == {"nodeId": image, "state": "error",
                                     "error": f"{image} has no output: its last run failed: {message}"}


def test_view_output_says_when_an_output_is_from_before_a_failed_run(nebula):
    import main
    from models.events import ErrorEvent

    built = _build()
    image = built["idMap"]["+img"]
    asyncio.run(mcp_server.run_nodes(image, wait_seconds=10))
    main.node_errors.observe(ErrorEvent(node_id=image, error="HTTP 429: rate limited"))
    try:
        note, picture = mcp_server.view_output(image)
    finally:
        main.node_errors.forget_all()
    assert isinstance(picture, Image)
    assert json.loads(note)["note"] == "This output is from before its last run, which failed: HTTP 429: rate limited"


def test_view_output_says_when_a_value_is_from_before_a_failed_run(nebula):
    """A text or data output (no picture to preview) gets the same note: the
    live check's Moodboard node kept its old value after its board was deleted."""
    import main
    from models.events import ErrorEvent

    built = _build("hello there")
    prompt = built["idMap"]["+p"]
    asyncio.run(mcp_server.run_nodes(built["idMap"]["+img"], wait_seconds=10))
    main.node_errors.observe(ErrorEvent(node_id=prompt, error="Moodboard 'b1' is in Recently deleted."))
    try:
        answer = json.loads(mcp_server.view_output(prompt)[0])
    finally:
        main.node_errors.forget_all()
    assert answer["note"] == "This output is from before its last run, which failed: Moodboard 'b1' is in Recently deleted."
    assert answer["outputs"]["text"]["value"] == "hello there"


def test_propose_change_warns_about_run_nodes_that_cannot_run(nebula, monkeypatch):
    import main

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    prompt = mcp_server.edit_canvas(nodes=[{"ref": "+p", "definitionId": "text-input", "params": {"value": "a"}}])
    response = mcp_server.propose_change(
        note="Make the hero image",
        nodes=[{"ref": "+img", "definitionId": "gpt-image-2-generate"}],
        edges=[{"source": prompt["idMap"]["+p"], "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}],
        run=["+img"],
    )
    assert response["proposal"]["cost"]["notReady"][0]["missing"] == "needs OPENAI_API_KEY in Settings > Providers"
    assert "+img (GPT Image 2) needs OPENAI_API_KEY" in response["warning"]
    mcp_server.withdraw_proposal(response["proposal"]["id"])
