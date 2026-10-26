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
        main.node_errors.forget_canvas()
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
        main.node_errors.forget_canvas()
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
    # Named the MCP way, not the CLI's or the HTTP route's.
    proposal_id = response["proposal"]["id"]
    assert response["warning"].endswith(
        "(find_nodes lists them). If you propose something else instead, withdraw this one first: "
        f'`withdraw_proposal(proposal_id="{proposal_id}")`.')
    assert response["withdrawWith"] == f'withdraw_proposal(proposal_id="{proposal_id}")'
    assert "nebula context" not in response["warning"] and "/api/agent/nodes" not in response["warning"]
    assert "DELETE" not in json.dumps(response)
    mcp_server.withdraw_proposal(proposal_id)


def test_propose_change_reminds_the_agent_its_unrunnable_proposal_is_still_open(nebula, monkeypatch):
    """Q109: FLUX.2 with only an OpenAI key is kept with its warning; the next
    proposal (GPT Image 2) says the first is still open and names withdraw_proposal."""
    import main

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {"OPENAI_API_KEY": "sk-test"}})
    prompt = mcp_server.edit_canvas(nodes=[{"ref": "+p", "definitionId": "text-input", "params": {"value": "a"}}])
    wire = [{"source": prompt["idMap"]["+p"], "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}]

    def propose(definition_id: str) -> dict:
        return mcp_server.propose_change(note=f"Hero with {definition_id}",
                                         nodes=[{"ref": "+img", "definitionId": definition_id}],
                                         edges=wire, run=["+img"])

    first = propose("flux-2-pro")
    first_id = first["proposal"]["id"]
    assert first["proposal"]["status"] == "open" and first["warning"]
    second = propose("gpt-image-2-generate")
    call = f'withdraw_proposal(proposal_id="{first_id}")'
    assert "warning" not in second
    assert second["stillOpen"] == [{"id": first_id, "note": "Hero with flux-2-pro", "withdrawWith": call}]
    assert second["reminder"] == (f"Your proposal {first_id} is still open and can't run here; "
                                  f"withdraw it if this one replaces it: `{call}`.")
    assert mcp_server.withdraw_proposal(first_id)["proposal"]["status"] == "withdrawn"
    third = propose("gpt-image-2-generate")
    assert "stillOpen" not in third and "reminder" not in third
    for answer in (second, third):
        mcp_server.withdraw_proposal(answer["proposal"]["id"])


# -- the moodboard adapter table, as agents read it (contract 07 section 1.16) --------------------------

def _call_tool(name: str, arguments: dict) -> dict:
    """A tool called the way a client calls it, through FastMCP."""
    result = asyncio.run(mcp_server.mcp.call_tool(name, arguments))
    if isinstance(result, tuple):
        structured = result[1]
        return structured.get("result", structured) if isinstance(structured, dict) else structured
    return json.loads(result[0].text)


def test_describe_node_says_what_a_wired_moodboard_does(nebula):
    """describe_node carries the node's adapter entry, resolved at its defaults
    on the route a run takes here: the facts behind the card's Moodboard line."""
    krea = _call_tool("describe_node", {"definition_id": "krea-2-generate"})["moodboardAdapter"]
    assert krea["line"] == "Board images: on · up to 10 to Image Style Refs"
    assert krea["channel"] == "weighted-style" and krea["default"] == "images" and krea["handler"] == "reads-board"
    assert krea["slots"] == [{"port": "image_style_references", "label": "Image Style Refs", "max": 10,
                              "sharesLimitWith": ["style_images"]}]
    assert krea["never"] == ["style_images", "styles"]
    assert krea["weight"]["mode"] == "native" and krea["weight"]["range"] == [0, 1]
    assert krea["weight"]["field"] == "strength" and "schema" not in krea["weight"]
    assert krea["text"] == "brief" and krea["unconfirmed"]
    for internal in ("sources", "checked", "byModel", "byRoute"):
        assert internal not in krea

    edit = _call_tool("describe_node", {"definition_id": "gpt-image-2-edit"})["moodboardAdapter"]
    assert edit["line"] == "Board images: off · the brief goes as text"
    assert edit["channel"] == "refs" and edit["default"] == "text"
    assert edit["slots"] == [{"port": "images", "label": "Images", "max": 16}]
    assert edit["needsWired"] == ["images"] and edit["never"] == ["mask"]
    assert "variants" not in edit and "route" not in edit

    text_only = mcp_server.describe_node("gpt-image-2-generate")["moodboardAdapter"]
    assert text_only["line"] == "This model takes the brief as text." and text_only["channel"] == "text-only"
    assert "slots" not in text_only and text_only["reason"].startswith("Text to image")

    # No Moodboard port: nothing about boards.
    assert "moodboardAdapter" not in _call_tool("describe_node", {"definition_id": "flux-schnell"})
    assert "moodboardAdapter" not in mcp_server.describe_node("text-input")


def test_describe_node_lists_the_params_and_routes_that_change_the_board(nebula, monkeypatch):
    import main

    banana = mcp_server.describe_node("nano-banana")["moodboardAdapter"]
    assert banana["slots"][0]["max"] == 14
    variants = {json.dumps(variant["when"], sort_keys=True): variant for variant in banana["variants"]}
    small = variants['{"model": "gemini-2.5-flash-image"}']
    assert small["slots"] == [{"port": "images", "label": "Images", "max": 3}]
    assert small["line"] == banana["line"]
    later = variants['{"model": "gemini-nano-banana-2.1"}']
    assert later["channel"] == "text-only" and later["line"] == "This model takes the brief as text."
    assert later["slots"] is None and "Nano Banana 2.1" in later["reason"]

    # The route a run takes here is the one the entry resolves on.
    real = main.load_settings
    keys: dict = {}
    monkeypatch.setattr(main, "load_settings", lambda: {**real(), "apiKeys": dict(keys)})
    assert "route" not in mcp_server.describe_node("gpt-image-2-fal-edit")["moodboardAdapter"]
    keys.update({"FAL_KEY": "f"})
    assert mcp_server.describe_node("gpt-image-2-fal-edit")["moodboardAdapter"]["route"] == "fal"
    keys.update({"OPENAI_API_KEY": "o"})
    assert mcp_server.describe_node("gpt-image-2-fal-edit")["moodboardAdapter"]["route"] == "openai"


def test_nebula_info_prints_what_a_wired_moodboard_does(nebula, capsys):
    from cli.client import NebulaClient
    from cli.commands import nodes

    http, _ = nebula
    client = NebulaClient("http://testserver")
    client._client = http

    nodes.run_info(client, "krea-2-generate")
    out = capsys.readouterr().out
    board = [line for line in out.splitlines() if line.startswith("MOODBOARD")]
    assert board == ["MOODBOARD: Board images: on · up to 10 to Image Style Refs"]
    detail = out.splitlines()[out.splitlines().index(board[0]) + 1]
    assert "weighted-style" in detail and "weight native strength 0-1" in detail
    assert "never style_images, styles" in detail

    nodes.run_info(client, "nano-banana")
    out = capsys.readouterr().out
    assert "MOODBOARD: Board images: off · the brief goes as text" in out
    assert "model=gemini-2.5-flash-image: up to 3" in out
    assert "model=gemini-nano-banana-2.1: This model takes the brief as text." in out

    nodes.run_info(client, "flux-schnell")
    assert "MOODBOARD" not in capsys.readouterr().out


def test_get_node_reads_settings_only_for_a_moodboard_node(nebula, monkeypatch):
    """/api/nodes/{id} (`nebula info`, `nebula create`) answered without
    settings before the adapter field: a node without a Moodboard port still
    does, and one with it leaves the field out when settings can't be read."""
    import main

    http, _ = nebula

    def broken():
        raise ValueError("settings.json is not valid JSON")

    monkeypatch.setattr(main, "load_settings", broken)
    plain = http.get("/api/nodes/flux-schnell")
    assert plain.status_code == 200 and "moodboardAdapter" not in plain.json()
    board = http.get("/api/nodes/krea-2-generate")
    assert board.status_code == 200 and "moodboardAdapter" not in board.json()
    assert board.json()["id"] == "krea-2-generate"


# -- U1: edit_canvas at apply parity, and undo_canvas_edit ------------------------

def test_edit_canvas_removes_and_unwires_like_apply(nebula):
    http, _ = nebula
    built = _build()
    prompt, image = built["idMap"]["+p"], built["idMap"]["+img"]
    spare = mcp_server.edit_canvas(nodes=[{"ref": "+s", "definitionId": "text-input"}])["idMap"]["+s"]
    edited = mcp_server.edit_canvas(
        note="Tidy up",
        unwire=[{"source": prompt, "sourceHandle": "text", "target": image, "targetHandle": "prompt"}],
        remove=[spare],
        rename={image: "Hero"},
    )
    assert edited["removed"] == [spare] and edited["unwired"][0]["target"] == image
    graph = http.get("/api/graph").json()
    assert spare not in {node["id"] for node in graph["nodes"]} and graph["edges"] == []


def test_edit_canvas_runs_steps_and_stops_and_reports_like_nebula_apply(nebula):
    http, _ = nebula
    result = mcp_server.edit_canvas(note="Board, then takes", steps=[
        {"nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse"}}]},
        {"nodes": [{"ref": "+img", "definitionId": "nano-banana"}],
         "edges": [{"source": "+p", "sourceHandle": "text", "target": "+img", "targetHandle": "prompt"}]},
    ])
    assert result["status"] == "applied" and len(result["steps"]) == 2
    assert set(result["idMap"]) == {"+p", "+img"}
    assert result["undo"]["tokens"] == [step["undo"]["token"] for step in reversed(result["steps"])]

    stopped = mcp_server.edit_canvas(steps=[
        {"nodes": [{"ref": "+q", "definitionId": "text-input"}]},
        {"edges": [{"source": "+q", "sourceHandle": "text", "target": result["idMap"]["+img"],
                    "targetHandle": "nope"}]},
    ])
    assert (stopped["status"], stopped["failedStep"], stopped["steps"]) == ("stopped", 2, 2)
    assert "nope" in stopped["error"] and len(stopped["applied"]) == 1
    assert stopped["undo"]["tokens"] == [stopped["applied"][0]["undo"]["token"]]
    # A plan that can't be sent is refused before step 1 lands.
    before = http.get("/api/graph").json()
    with pytest.raises(ValueError, match="step 2 uses \\+ghost"):
        mcp_server.edit_canvas(steps=[{"nodes": [{"ref": "+a", "definitionId": "text-input"}]},
                                      {"remove": ["+ghost"]}])
    with pytest.raises(ValueError, match="run_nodes"):
        mcp_server.edit_canvas(steps=[{"nodes": [{"ref": "+a", "definitionId": "text-input"}], "run": ["+a"]}])
    with pytest.raises(ValueError, match="move 'nodes' into a step"):
        mcp_server.edit_canvas(nodes=[{"ref": "+a", "definitionId": "text-input"}],
                               steps=[{"remove": [result["idMap"]["+p"]]}])
    assert http.get("/api/graph").json() == before


def test_undo_canvas_edit_puts_back_what_edit_and_remove_did(nebula):
    http, _ = nebula
    built = _build()
    image = built["idMap"]["+img"]
    removed = mcp_server.remove_from_canvas(node_ids=[image])
    assert removed["undo"]["token"] and image in removed["undo"]["summary"]
    back = mcp_server.undo_canvas_edit(removed["undo"]["token"])
    assert back["status"] == "undone" and back["added"] == [image]
    graph = http.get("/api/graph").json()
    assert {node["id"] for node in graph["nodes"]} == set(built["idMap"].values()) and len(graph["edges"]) == 1
    gone = mcp_server.undo_canvas_edit(built["undo"]["token"])
    assert sorted(gone["removed"]) == sorted(built["idMap"].values())
    assert http.get("/api/graph").json()["nodes"] == []
    # A token another agent holds is refused for this one.
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server._canvas_call("POST", "/api/graph/apply/undo", None, json={"token": "0" * 40})
    assert refused.value.status == 404


def test_undo_canvas_edit_takes_a_steps_plans_tokens_newest_first(nebula):
    http, _ = nebula
    result = mcp_server.edit_canvas(steps=[
        {"nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "a"}}]},
        {"params": [{"nodeId": "+p", "params": {"value": "b"}}], "rename": {"+p": "Brief"}},
    ])
    undone = mcp_server.undo_canvas_edit(result["undo"]["tokens"])
    assert undone["status"] == "undone" and len(undone["undone"]) == 2
    assert http.get("/api/graph").json()["nodes"] == []
    stopped = mcp_server.undo_canvas_edit(["f" * 40, result["undo"]["tokens"][0]])
    assert stopped["status"] == "stopped" and stopped["failedToken"] == 1 and stopped["undone"] == []


def test_wait_for_canvas_change_says_the_person_undid_your_edit(nebula, person):
    http, _ = nebula
    built = _build()
    prompt = built["idMap"]["+p"]
    cursor = mcp_server.look_at_canvas()["events"]["cursor"]
    response = http.post("/api/graph/restore", headers=person.headers, json={
        "action": "undo", "edit": built["undo"]["editId"], "remove": list(built["idMap"].values())})
    assert response.status_code == 200, response.text
    changed = mcp_server.wait_for_canvas_change(since=cursor, timeout_seconds=1)
    undone = [event for event in changed["events"] if event["kind"] == "edit.undone"]
    assert len(undone) == 1 and undone[0]["actor"] == {"kind": "person"}
    assert undone[0]["data"]["editId"] == built["undo"]["editId"]
    assert undone[0]["data"]["of"]["name"] == "MCP agent"
    assert all(event["edit"]["undoes"] == built["undo"]["editId"] for event in changed["events"])
    assert prompt not in {node["id"] for node in http.get("/api/graph").json()["nodes"]}


def test_undo_canvas_edit_is_annotated_as_destructive_and_idempotent():
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    hints = tools["undo_canvas_edit"].annotations
    assert (hints.readOnlyHint, hints.destructiveHint, hints.idempotentHint, hints.openWorldHint) == (
        False, True, True, False)
    assert {"remove", "unwire", "steps"} <= set(tools["edit_canvas"].inputSchema["properties"])


# -- universal nodes take their ports from the model (services/universal_ports.py) ---------------

def test_an_agent_builds_universal_nodes_whose_ports_come_from_the_model(nebula):
    from services.model_cache import model_cache

    model_cache.set("openrouter:models", {"models": [
        {"id": "openai/gpt-4o", "name": "GPT-4o", "input_modalities": ["text", "image"], "output_modalities": ["text"]},
        {"id": "google/gemini-2.5-flash-image", "name": "Nano Banana", "input_modalities": ["text", "image"],
         "output_modalities": ["image", "text"]}], "count": 2}, ttl=300)
    model_cache.set("replicate:schema:black-forest-labs/flux-kontext-pro", {
        "version_id": "v1", "model_id": "black-forest-labs/flux-kontext-pro", "description": "",
        "input_schema": {"type": "object", "properties": {"prompt": {"type": "string"},
                                                          "input_image": {"type": "string", "format": "uri"}}},
        "output_schema": {"type": "string", "format": "uri"}}, ttl=300)
    try:
        assert "modelPorts" in _call_tool("describe_node", {"definition_id": "openrouter-universal"})
        built = _call_tool("edit_canvas", {
            "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                      {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}},
                      {"ref": "+paint", "definitionId": "openrouter-universal",
                       "params": {"model": "google/gemini-2.5-flash-image"}},
                      {"ref": "+edit", "definitionId": "replicate-universal",
                       "params": {"model_id": "black-forest-labs/flux-kontext-pro"}}],
            "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+eye", "targetHandle": "images"},
                      {"source": "+eye", "sourceHandle": "text", "target": "+paint", "targetHandle": "messages"},
                      {"source": "+paint", "sourceHandle": "image", "target": "+edit", "targetHandle": "input_image"}],
        })
        ids = built["idMap"]
        assert built["summary"] == "added 4, connected 3"
        assert built["modelPorts"][ids["+edit"]]["inputs"] == ["input_image"]
        canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
        assert canvas[ids["+paint"]]["ports"] == {"inputs": ["messages", "images"], "outputs": ["text", "image"]}
    finally:
        model_cache.clear()
