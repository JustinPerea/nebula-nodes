"""A Replicate node's output port is typed from the model's own metadata, and
its run fills that port (2026-10-21, the gap #143 named).

A Replicate model's output schema for a file is a plain `uri` string whether
the file is an image, a video or an audio clip, so every file-output model
used to get an Image `image` port while its run named the output by the
returned file's extension (`video`, `audio`, ...). The engine passes outputs
by handle name, so the declared port got nothing on a video or audio model,
and since #132 a wire from `video`/`audio` was refused because the node
didn't declare it.

Now services/universal_ports decides the file's type before the run, from the
schema's content hints, then the model's `default_example` output (already in
the model data the schema route reads; no extra call), else `image` marked
`typeUnconfirmed`. The handler puts the output under the declared port and
fails clearly when the returned file contradicts it.

Model data is made-up Replicate API JSON (tests/fixtures/replicate_media_models.json)
served by a fake httpx client in routes/replicate_proxy: no network, nothing billed.
"""
from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import mcp_server
from execution.engine import execute_graph
from handlers.replicate_universal import handle_replicate_universal
from models.graph import GraphEdge, GraphNode, PortValueDict
from nebula_api import NebulaAPI
from services import universal_ports
from services.model_cache import model_cache
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Desktop"}
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "replicate_media_models.json").read_text())
MODELS = FIXTURE["models"]
API = "https://api.replicate.com/v1/models/"


# -- the model data, through the real schema route ---------------------------

class _Resp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeReplicate:
    """httpx.AsyncClient for routes/replicate_proxy: answers the two reads the
    schema route makes (model, version) from the fixture, and nothing else."""

    seen: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None):
        _FakeReplicate.seen.append(url)
        assert url.startswith(API), url
        rest = url[len(API):]
        owner, name, *tail = rest.split("/")
        entry = MODELS.get(f"{owner}/{name}")
        if entry is None:
            return _Resp({"detail": "Not found"}, 404)
        if not tail:
            return _Resp(copy.deepcopy(entry["model"]))
        assert tail == ["versions", entry["version"]["id"]], url
        return _Resp(copy.deepcopy(entry["version"]))


@pytest.fixture
def replicate(monkeypatch):
    from routes import replicate_proxy

    _FakeReplicate.seen = []
    monkeypatch.setattr(replicate_proxy, "httpx", SimpleNamespace(AsyncClient=_FakeReplicate))
    monkeypatch.setattr(replicate_proxy, "load_settings",
                        lambda: {"apiKeys": {"REPLICATE_API_TOKEN": "fixture-not-a-token"}})
    model_cache.clear()
    yield _FakeReplicate
    model_cache.clear()


def _schema(model: str) -> dict:
    from routes.replicate_proxy import get_model_schema

    owner, name = model.split("/", 1)
    return asyncio.run(get_model_schema(owner, name))


def _output(model: str) -> dict:
    return universal_ports.configure("replicate-universal", {}, model, _schema(model)).outputs[0]


# -- 1. the type comes from the model's metadata -------------------------------

def test_the_schema_route_carries_the_models_example_output_from_the_same_reads(replicate):
    data = _schema("acme/clipmaker")
    assert data["default_example_output"] == "https://replicate.delivery/xezq/abc123/output.mp4"
    # The route's two reads, as before: no extra call to type a port.
    assert replicate.seen == [API + "acme/clipmaker", API + "acme/clipmaker/versions/v-clip"]
    assert _schema("acme/mystery")["default_example_output"] is None


def test_a_big_example_output_is_cut_down_before_it_is_cached(replicate, monkeypatch):
    big = copy.deepcopy(MODELS["acme/painter"])
    big["model"]["default_example"]["output"] = ["data:image/png;base64," + "A" * 200_000] * 50
    monkeypatch.setitem(MODELS, "acme/big", big)
    kept = _schema("acme/big")["default_example_output"]
    assert isinstance(kept, list) and len(kept) <= 8
    assert all(len(item) < 100 for item in kept) and kept[0].startswith("data:image/png")
    assert _output("acme/big")["dataType"] == "Image"


@pytest.mark.parametrize("model,port_id,data_type", [
    ("acme/clipmaker", "video", "Video"),   # example .mp4
    ("acme/voicebox", "audio", "Audio"),    # example .mp3
    ("acme/songsmith", "audio", "Audio"),   # example .wav, with a query string
    ("acme/painter", "image", "Image"),     # example [.webp]: a list, typed by its items
    ("acme/reels", "video", "Video"),       # a list of .mp4
    ("acme/vectorist", "svg", "SVG"),
    ("acme/sculptor", "mesh", "Mesh"),
    ("acme/hinted", "audio", "Audio"),      # the schema's contentMediaType wins over the example's .png
])
def test_a_file_output_is_typed_from_the_models_metadata(replicate, model, port_id, data_type):
    assert _output(model) == {"id": port_id, "label": "Output", "dataType": data_type, "required": False}


def test_with_nothing_to_tell_it_stays_image_marked_unconfirmed(replicate):
    assert _output("acme/mystery") == {"id": "image", "label": "Output", "dataType": "Image", "required": False,
                                       "typeUnconfirmed": True}


def test_a_text_model_stays_text(replicate):
    assert _output("acme/chatter") == {"id": "text", "label": "Output", "dataType": "Text", "required": False}


@pytest.mark.parametrize("hint", [
    {"contentMediaType": "video/mp4"},
    {"x-content-type": "video/webm"},
    {"description": "The generated clip (video/mp4)"},
])
def test_schema_content_hints_type_the_output(hint):
    schema = {"output_schema": {"type": "array", "items": {"type": "string", "format": "uri", **hint}}}
    assert universal_ports.replicate_output(schema)["dataType"] == "Video"


def test_words_alone_do_not_type_a_port():
    # "video" as a word isn't a content hint: Nebula doesn't guess from words.
    schema = {"output_schema": {"type": "string", "format": "uri", "description": "A video of the scene"},
              "description": "Text to video"}
    assert universal_ports.replicate_output(schema)["typeUnconfirmed"] is True


def test_the_stamp_says_its_output_was_typed(replicate):
    params = universal_ports.configure("replicate-universal", {}, "acme/clipmaker", _schema("acme/clipmaker")).params
    assert params[universal_ports.PORTS_PARAM]["rev"] == universal_ports.PORTS_REV
    assert not universal_ports.untyped_output_stamp("replicate-universal", params)
    legacy = copy.deepcopy(params)
    legacy[universal_ports.PORTS_PARAM].pop("rev")
    legacy[universal_ports.PORTS_PARAM]["outputs"] = [
        {"id": "image", "label": "Output", "dataType": "Image", "required": False}]
    assert universal_ports.untyped_output_stamp("replicate-universal", legacy)


# -- agents see the right port -------------------------------------------------

@pytest.fixture
def nebula(monkeypatch, person, replicate):
    import main

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    with TestClient(main.app, client=("127.0.0.1", 50000)) as http:
        http.delete("/api/graph?force=true", headers=PERSON)
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
        yield http
        http.delete("/api/graph?force=true", headers=PERSON)


def _call_tool(name: str, arguments: dict) -> dict:
    result = asyncio.run(mcp_server.mcp.call_tool(name, arguments))
    if isinstance(result, tuple):
        structured = result[1]
        return structured.get("result", structured) if isinstance(structured, dict) else structured
    return json.loads(result[0].text)


def _drawn(http, node_id: str) -> dict:
    exported = http.get("/api/graph/export", headers=PERSON).json()
    node = next(node for node in exported["nodes"] if node["id"] == node_id)
    return {"inputs": node["data"]["dynamicInputPorts"], "outputs": node["data"]["dynamicOutputPorts"]}


def test_model_schema_shows_a_video_models_video_output(nebula):
    read = _call_tool("model_schema", {"provider": "replicate", "model_id": "acme/clipmaker"})
    assert read["ports"]["outputs"] == [{"id": "video", "label": "Output", "dataType": "Video", "required": False}]
    assert read["ports"] == {k: v for k, v in _function_ports("acme/clipmaker").items()}
    assert "note" not in read
    voice = _call_tool("model_schema", {"provider": "replicate", "model_id": "acme/voicebox"})
    assert voice["ports"]["outputs"][0]["id"] == "audio" and voice["ports"]["outputs"][0]["dataType"] == "Audio"


def test_model_schema_says_when_the_output_type_is_unconfirmed(nebula):
    read = _call_tool("model_schema", {"provider": "replicate", "model_id": "acme/mystery"})
    assert read["ports"]["outputs"][0]["typeUnconfirmed"] is True
    assert "unconfirmed" in read["note"] and "acme/mystery" in read["note"]


def _function_ports(model: str) -> dict:
    configured = universal_ports.configure("replicate-universal", {}, model, _schema(model))
    return {"inputs": configured.inputs, "outputs": configured.outputs}


def test_an_agent_wires_a_video_models_video_output_in_the_edit_that_sets_it(nebula):
    built = _call_tool("edit_canvas", {
        "nodes": [{"ref": "+clip", "definitionId": "replicate-universal",
                   "params": {"model_id": "acme/clipmaker", "prompt": "a fox in snow"}},
                  {"ref": "+frames", "definitionId": "frame-extractor"},
                  {"ref": "+look", "definitionId": "preview"}],
        "edges": [{"source": "+clip", "sourceHandle": "video", "target": "+frames", "targetHandle": "video"},
                  {"source": "+clip", "sourceHandle": "video", "target": "+look", "targetHandle": "input"}],
    })
    assert built["summary"] == "added 3, connected 2"
    clip = built["idMap"]["+clip"]
    assert built["modelPorts"][clip] == {"model": "acme/clipmaker", "inputs": ["first_frame"], "outputs": ["video"]}
    canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
    assert canvas[clip]["ports"] == {"inputs": ["first_frame"], "outputs": ["video"]}
    # The canvas draws a Video handle, the one model_schema named.
    drawn = _drawn(nebula, clip)
    assert drawn["outputs"] == [{"id": "video", "label": "Output", "dataType": "Video", "required": False}]
    edges = nebula.get("/api/graph/export", headers=PERSON).json()["edges"]
    assert {(e["sourceHandle"], e["targetHandle"]) for e in edges if e["source"] == clip} == {
        ("video", "video"), ("video", "input")}


def test_a_video_output_still_cannot_go_into_an_image_input(nebula):
    refused = nebula.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+clip", "definitionId": "replicate-universal", "params": {"model_id": "acme/clipmaker"}},
                  {"ref": "+compare", "definitionId": "image-compare"}],
        "edges": [{"source": "+clip", "sourceHandle": "video", "target": "+compare", "targetHandle": "imageA"}],
    })
    assert refused.status_code == 400, refused.text
    assert "Incompatible" in refused.json()["detail"] or "Video" in refused.json()["detail"]
    # And the old `image` port isn't there to wire.
    gone = nebula.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+clip", "definitionId": "replicate-universal", "params": {"model_id": "acme/clipmaker"}},
                  {"ref": "+frames", "definitionId": "frame-extractor"}],
        "edges": [{"source": "+clip", "sourceHandle": "image", "target": "+frames", "targetHandle": "video"}],
    })
    assert gone.status_code == 400, gone.text


def test_the_edit_reply_and_the_cli_say_when_the_output_type_is_unconfirmed(nebula):
    from cli.formatter import format_applied

    built = nebula.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+m", "definitionId": "replicate-universal", "params": {"model_id": "acme/mystery"}}]})
    assert built.status_code == 200, built.text
    body = built.json()
    node_id = body["idMap"]["+m"]
    assert body["modelPorts"][node_id]["outputs"] == ["image"]
    assert "unconfirmed" in body["modelPortNotes"][node_id]
    text = format_applied(body, undo=False)
    assert any(line.startswith(f"  Ports of {node_id}:") and "unconfirmed" in line for line in text.splitlines())
    canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
    assert canvas[node_id]["ports"]["unconfirmed"] == ["image"]


# -- 3. the run fills the declared port --------------------------------------

def _configured(model: str) -> dict:
    return universal_ports.configure("replicate-universal", {}, model, _schema(model)).params


class _Run:
    """httpx.AsyncClient for the handler: submit, then one poll answering ``output``."""

    def __init__(self, output):
        self.output = output

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        return _Resp({"id": "pred-1", "status": "starting", "urls": {}}, 201)

    async def get(self, url, headers=None):
        return _Resp({"id": "pred-1", "status": "succeeded", "output": self.output})


async def _run(params: dict, output) -> dict:
    node = GraphNode(id="r1", definitionId="replicate-universal", params=params)
    with patch("handlers.replicate_universal.httpx.AsyncClient", new=_Run(output)), \
            patch("execution.async_poll_runner.asyncio.sleep", new=AsyncMock()):
        return await handle_replicate_universal(node, {}, {"REPLICATE_API_TOKEN": "fixture-not-a-token"},
                                                emit=AsyncMock())


def test_a_video_models_run_fills_its_video_port(replicate):
    params = _configured("acme/clipmaker")
    out = asyncio.run(_run(params, "https://replicate.delivery/x/out.mp4"))
    assert out == {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    audio = asyncio.run(_run(_configured("acme/voicebox"), "https://replicate.delivery/x/a.wav"))
    assert audio == {"audio": {"type": "Audio", "value": "https://replicate.delivery/x/a.wav"}}
    # A file with no telling extension can't contradict the declared type.
    plain = asyncio.run(_run(params, "https://replicate.delivery/x/output"))
    assert plain == {"video": {"type": "Video", "value": "https://replicate.delivery/x/output"}}


def test_a_returned_file_that_contradicts_the_declared_port_fails_the_run_naming_both(replicate):
    with pytest.raises(RuntimeError) as failed:
        asyncio.run(_run(_configured("acme/clipmaker"), "https://replicate.delivery/x/out.png"))
    message = str(failed.value)
    assert "Video" in message and "Image" in message and "acme/clipmaker" in message
    assert "pred-1" in message  # where the person can still find the file
    with pytest.raises(RuntimeError, match="Text"):
        asyncio.run(_run(_configured("acme/clipmaker"), "just some words"))


def test_a_text_port_takes_a_url_string_as_text(replicate):
    out = asyncio.run(_run(_configured("acme/chatter"), "https://example.com/some-page"))
    assert out == {"text": {"type": "Text", "value": "https://example.com/some-page"}}


def test_a_downstream_video_node_receives_the_replicate_video(replicate, monkeypatch, tmp_path):
    received: dict = {}

    async def frames(node, inputs, api_keys, emit=None):
        received.update(inputs)
        return {"frame": {"type": "Image", "value": str(tmp_path / "f.png")}}

    async def materialize(value, media_type, run_dir):
        path = Path(run_dir) / ("clip.mp4" if media_type == "Video" else "x.bin")
        path.write_bytes(b"\x00\x00\x00\x18ftypmp42")
        return path

    monkeypatch.setattr("execution.engine.materialize_media_value", materialize)
    events: list = []

    async def emit(event):
        events.append(event)

    nodes = [GraphNode(id="r1", definitionId="replicate-universal", params=_configured("acme/clipmaker")),
             GraphNode(id="f1", definitionId="frame-extractor", params={})]
    edges = [GraphEdge(id="e1", source="r1", sourceHandle="video", target="f1", targetHandle="video")]
    # The URL has no extension, so only the declared port can type it: naming
    # the output by the file (the old way) would put it under `image`, and
    # f1's `video` would get nothing.
    with patch("handlers.replicate_universal.httpx.AsyncClient", new=_Run("https://replicate.delivery/x/output")), \
            patch("execution.async_poll_runner.asyncio.sleep", new=AsyncMock()):
        asyncio.run(execute_graph(nodes=nodes, edges=edges, api_keys={"REPLICATE_API_TOKEN": "fixture-not-a-token"},
                                  handler_registry={"replicate-universal": handle_replicate_universal,
                                                    "frame-extractor": frames},
                                  emit=emit, run_id="replicate-video-downstream"))
    errors = [event for event in events if event.type == "error"]
    assert not errors, errors
    assert received["video"].type == "Video" and received["video"].value.endswith("clip.mp4")


# -- old saved nodes -----------------------------------------------------------

def _legacy(params: dict) -> dict:
    """A node configured by #132 (2026-10-20): every file output stamped
    Image `image`, no `rev`."""
    old = copy.deepcopy(params)
    stamp = old[universal_ports.PORTS_PARAM]
    stamp.pop("rev", None)
    stamp["outputs"] = [{"id": "image", "label": "Output", "dataType": "Image", "required": False}]
    return old


def test_an_old_stamped_video_node_runs_as_it_did(replicate):
    # Its card showed the video under `video`; it still does.
    old = _legacy(_configured("acme/clipmaker"))
    out = asyncio.run(_run(old, "https://replicate.delivery/x/out.mp4"))
    assert out == {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    image = asyncio.run(_run(_legacy(_configured("acme/painter")), ["https://replicate.delivery/x/o.webp"]))
    assert image == {"image": {"type": "Image", "value": "https://replicate.delivery/x/o.webp"}}


def test_a_node_never_configured_runs_as_it_did(replicate):
    out = asyncio.run(_run({"model_id": "acme/clipmaker", "_version_id": "v-clip"}, "https://replicate.delivery/x/o.mp4"))
    assert out == {"video": {"type": "Video", "value": "https://replicate.delivery/x/o.mp4"}}


def test_an_old_stamp_is_read_again_when_its_model_is_sent_again(nebula):
    import main

    node_id = main.cli_graph.add_node("replicate-universal", _legacy(_configured("acme/clipmaker")))
    assert universal_ports.stored_ports("replicate-universal", main.cli_graph.nodes[node_id]["params"])[1][0]["id"] == "image"
    again = nebula.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"model_id": "acme/clipmaker"}})
    assert again.status_code == 200, again.text
    stored = universal_ports.stored_ports("replicate-universal", main.cli_graph.nodes[node_id]["params"])
    assert universal_ports.port_ids(stored[1]) == ["video"]
    # An edit naming the model again re-reads it too.
    other = main.cli_graph.add_node("replicate-universal", _legacy(_configured("acme/voicebox")))
    edited = nebula.post("/api/graph/apply", headers=AGENT, json={
        "params": [{"nodeId": other, "params": {"model_id": "acme/voicebox"}}]})
    assert edited.status_code == 200, edited.text
    assert edited.json()["modelPorts"][other]["outputs"] == ["audio"]


# -- 4. docs -------------------------------------------------------------------

def test_the_docs_say_file_outputs_are_typed_from_the_models_metadata():
    repo = Path(__file__).resolve().parents[2]
    skills = [repo / ".agents" / "skills" / "replicate" / "SKILL.md",
              repo / ".claude" / "skills" / "replicate" / "SKILL.md"]
    assert skills[0].read_text() == skills[1].read_text()
    docs = [*skills, repo / "docs" / "api-guides" / "replicate.md", repo / "docs" / "MCP-SETUP.md",
            repo / "skills" / "nebula" / "SKILL.md"]
    for path in docs:
        text = path.read_text()
        assert "Open issue: a video or audio model" not in text, path
        assert "Don't rely on chaining from video/audio" not in text, path
        assert "There is no `video`, `audio`" not in text, path
        assert "default_example" in text, path
        assert "typeUnconfirmed" in text, path
    assert "default_example" in (mcp_server.model_schema.__doc__ or "")
    assert "`video`" in (mcp_server.model_schema.__doc__ or "")


def test_an_old_stamped_video_node_that_ran_still_saves_and_opens(replicate):
    """#132's stamp said `image`; its run put the file under `video`. The
    project must still save and open with that output (its port was a guess)."""
    import main

    old = _legacy(_configured("acme/clipmaker"))
    snapshot = {"nodes": [{"id": "n1", "type": "dynamic", "position": {"x": 0, "y": 0},
                           "data": {"definitionId": "replicate-universal", "params": old,
                                    "outputs": {"video": {"type": "Video",
                                                          "value": "https://replicate.delivery/x/out.mp4"}}}}],
                "edges": []}
    _result, graph = main._stage_project_snapshot(snapshot)
    assert graph.nodes["n1"]["outputs"]["video"]["type"] == "Video"
    # A typed node gets no such leeway: an output its port doesn't declare is refused.
    typed = {**snapshot, "nodes": [{**snapshot["nodes"][0], "data": {
        **snapshot["nodes"][0]["data"], "params": _configured("acme/clipmaker"),
        "outputs": {"image": {"type": "Image", "value": "https://replicate.delivery/x/out.png"}}}}]}
    with pytest.raises(Exception) as refused:
        main._stage_project_snapshot(typed)
    assert "image" in str(getattr(refused.value, "detail", refused.value))


# -- review (2026-10-21): the confirmed findings -------------------------------

def _bare(model: str = "acme/bare", output_schema: dict | None = None, example=None) -> dict:
    """A node configured for a model whose data is made up here (no route)."""
    data = {"version_id": "v-bare", "model_id": model, "description": "", "input_schema": {},
            "output_schema": {} if output_schema is None else output_schema, "default_example_output": example}
    return universal_ports.configure("replicate-universal", {}, model, data).params


def _without_rev(params: dict) -> dict:
    old = copy.deepcopy(params)
    old[universal_ports.PORTS_PARAM].pop("rev", None)
    return old


def test_an_old_stamps_file_port_is_shown_as_a_guess_with_what_to_do(nebula):
    """Finding 1: a #132 stamp's `image` was a guess; agents see it as one."""
    import main

    old = _legacy(_configured("acme/clipmaker"))
    stored = universal_ports.stored_ports("replicate-universal", old)
    assert stored[1] == [{"id": "image", "label": "Output", "dataType": "Image", "required": False,
                          "typeUnconfirmed": True}]
    # A Text output was never a file guess.
    assert "typeUnconfirmed" not in universal_ports.stored_ports(
        "replicate-universal", _without_rev(_configured("acme/chatter")))[1][0]
    node_id = main.cli_graph.add_node("replicate-universal", old)
    canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
    ports = canvas[node_id]["ports"]
    assert ports["outputs"] == ["image"] and ports["unconfirmed"] == ["image"]
    assert "model_id" in ports["note"] and "again" in ports["note"]
    # An edit that wires from it says so too.
    wired = nebula.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+look", "definitionId": "preview"}],
        "edges": [{"source": node_id, "sourceHandle": "image", "target": "+look", "targetHandle": "input"}]})
    assert wired.status_code == 200, wired.text
    assert "model_id" in wired.json()["modelPortNotes"][node_id]
    # The run is unchanged: the file names its output, as before.
    out = asyncio.run(_run(old, "https://replicate.delivery/x/out.mp4"))
    assert out == {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}


def test_a_text_port_given_a_media_file_url_fails_naming_both(replicate):
    """Finding 2: a URL that names a media type isn't text."""
    with pytest.raises(RuntimeError) as failed:
        asyncio.run(_run(_configured("acme/chatter"), "https://replicate.delivery/x/out.mp4"))
    assert "Video" in str(failed.value) and "Text" in str(failed.value)
    # An old stamp's Text port names it by the file, as before (saved, shown).
    old = asyncio.run(_run(_without_rev(_configured("acme/chatter")), "https://replicate.delivery/x/out.mp4"))
    assert old == {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    # A URL that names no media type is still text.
    plain = asyncio.run(_run(_configured("acme/chatter"), "https://example.com/some-page"))
    assert plain == {"text": {"type": "Text", "value": "https://example.com/some-page"}}


def test_an_output_schema_that_says_nothing_is_typed_from_the_example_else_unconfirmed():
    """A model with no Output schema: its Text port is a guess too, and its
    example run's file types it when there is one."""
    assert universal_ports.replicate_output({"output_schema": {}}) == {
        "id": "text", "label": "Output", "dataType": "Text", "required": False, "typeUnconfirmed": True}
    assert universal_ports.replicate_output(
        {"output_schema": {}, "default_example_output": "https://replicate.delivery/x/o.mp4"}) == {
        "id": "video", "label": "Output", "dataType": "Video", "required": False}
    # A stated plain string stays confirmed text.
    assert "typeUnconfirmed" not in universal_ports.replicate_output({"output_schema": {"type": "string"}})


def test_an_unconfirmed_port_delivers_the_file_under_its_own_type(replicate):
    """Finding 5: when the port was a guess, the returned file says what it
    is, so a paid result is kept (saved, shown) rather than failed."""
    mystery = _configured("acme/mystery")
    out = asyncio.run(_run(mystery, "https://replicate.delivery/x/out.mp4"))
    assert out == {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    wav = asyncio.run(_run(mystery, ["https://replicate.delivery/x/a.wav"]))
    assert wav == {"audio": {"type": "Audio", "value": "https://replicate.delivery/x/a.wav"}}
    # Text from a port the schema said is a file still fails.
    with pytest.raises(RuntimeError, match="Image"):
        asyncio.run(_run(mystery, "just some words"))
    # A model with no Output schema (an unconfirmed Text port) keeps its file too.
    bare = asyncio.run(_run(_bare(), "https://replicate.delivery/x/out.mp4"))
    assert bare == {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    assert asyncio.run(_run(_bare(), "hello")) == {"text": {"type": "Text", "value": "hello"}}
    # And the note tells agents so, rather than that the run fails.
    note = universal_ports.unconfirmed_note("acme/mystery", universal_ports.stored_ports(
        "replicate-universal", mystery)[1])
    assert "fails" not in note


def test_an_unconfirmed_node_that_kept_another_file_type_still_saves(replicate):
    """The run put an .mp4 under `video` on a node whose guessed port is
    `image`: the project must save and open with it."""
    import main

    snapshot = {"nodes": [{"id": "n1", "type": "dynamic", "position": {"x": 0, "y": 0},
                           "data": {"definitionId": "replicate-universal", "params": _configured("acme/mystery"),
                                    "outputs": {"video": {"type": "Video",
                                                          "value": "https://replicate.delivery/x/out.mp4"}}}}],
                "edges": []}
    _result, graph = main._stage_project_snapshot(snapshot)
    assert graph.nodes["n1"]["outputs"]["video"]["type"] == "Video"
    # The leeway is media types under their own ports only.
    forged = copy.deepcopy(snapshot)
    forged["nodes"][0]["data"]["outputs"] = {"video": {"type": "Audio", "value": "https://x/a.wav"}}
    with pytest.raises(Exception):
        main._stage_project_snapshot(forged)


def _saves(main_module) -> None:
    """Each node's saved outputs pass the check a project save makes."""
    for index, node in enumerate(main_module.cli_graph.nodes.values()):
        main_module._validate_imported_outputs(str(node["definitionId"]), node.get("outputs") or {},
                                               node_index=index, params=node.get("params"))


@pytest.mark.parametrize("path", ["edit", "put", "picker"])
def test_a_retyped_node_drops_a_saved_output_its_new_ports_dont_declare(nebula, path):
    """Finding 3: a node that ran (`video`) and is set to a model whose port is
    `audio` keeps no `video` output, so its project still saves."""
    import main

    ran = {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    node_id = main.cli_graph.add_node("replicate-universal", _configured("acme/clipmaker"), outputs=ran)
    if path == "edit":
        response = nebula.post("/api/graph/apply", headers=AGENT, json={
            "params": [{"nodeId": node_id, "params": {"model_id": "acme/voicebox"}}]})
    elif path == "put":
        response = nebula.put(f"/api/graph/node/{node_id}", headers=AGENT,
                              json={"params": {"model_id": "acme/voicebox"}})
    else:
        response = nebula.post(f"/api/graph/node/{node_id}/model", headers=PERSON, json={"model": "acme/voicebox"})
    assert response.status_code == 200, response.text
    node = main.cli_graph.nodes[node_id]
    assert universal_ports.port_ids(universal_ports.stored_ports("replicate-universal", node["params"])[1]) == ["audio"]
    assert "video" not in (node.get("outputs") or {})
    _saves(main)


def test_an_old_stamped_node_that_ran_retypes_and_still_saves(nebula):
    """Finding 3's scenario: a #132 node with no model metadata ran a video;
    sending its model again (as the docs say) leaves a saveable node."""
    import main

    ran = {"video": {"type": "Video", "value": "https://replicate.delivery/x/out.mp4"}}
    node_id = main.cli_graph.add_node("replicate-universal", _legacy(_configured("acme/mystery")), outputs=ran)
    again = nebula.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"model_id": "acme/mystery"}})
    assert again.status_code == 200, again.text
    assert not universal_ports.untyped_output_stamp("replicate-universal", main.cli_graph.nodes[node_id]["params"])
    _saves(main)
