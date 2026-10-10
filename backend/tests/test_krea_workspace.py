"""Krea workspace nodes: job history, node apps, Files, Krea Nodes, Agent, desktop apps, usage.

Each case pins the exact Krea request made and that a control the chosen
path cannot honor, or an unsafe target, fails before anything is sent.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
import respx
from mcp.types import CallToolResult, ImageContent, TextContent, Tool
from PIL import Image

from handlers import krea as legacy
from handlers import krea_workspace as workspace
from models.graph import GraphNode, PortValueDict
from services import krea_account, output

TOOLS = Path(__file__).with_name("fixtures") / "krea_mcp_tools.json"
UPLOAD = "https://api.krea.ai/assets/presigned?sig=fixture"
ASSET = "https://assets.krea.ai/uploaded.png"
CDN = "https://media.example.test/out.png"
JOB = "633d1ed4-7fff-45cb-8588-8413a1cd58f5"
JOB2 = "7a1c2e9b-55aa-4c1e-9f3d-2b8e4f6a0c11"
VERSION = "nav_8f2e1c"
APP = "5d0a6c4e-2b1f-4e7a-9c3d-8e6f1a2b3c4d"
SESSION = "2c9e7f1a-3b4d-4e5f-8a6b-7c8d9e0f1a2b"
RUN = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f"
FILE_A = "file:11111111-2222-4333-8444-555555555555"
FILE_B = "file:66666666-7777-4888-9999-aaaaaaaaaaaa"
FOLDER = "folder:bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
KEYS = {"KREA_API_TOKEN": "fixture"}


def png():
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (30, 120, 220)).save(buffer, format="PNG")
    return buffer.getvalue()


class Session:
    """Fake Krea MCP session: answers are values or callables of the arguments."""

    def __init__(self):
        self.calls = []
        self.definitions = [Tool.model_validate(value) for value in json.loads(TOOLS.read_text())]
        self.answers = {"get_upload_url": {"url": UPLOAD}}

    async def list_tools(self):
        return SimpleNamespace(tools=self.definitions)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        answer = self.answers.get(name, {"ok": True})
        if callable(answer):
            answer = answer(arguments)
        if isinstance(answer, CallToolResult):
            return answer
        return CallToolResult(content=[], structuredContent=answer)

    def names(self):
        return [name for name, _ in self.calls]

    def args(self, name):
        return [arguments for called, arguments in self.calls if called == name]


@pytest.fixture
def session(monkeypatch, tmp_path):
    from services import krea_connector
    active = Session()

    class Connector:
        async def list_tools(self, current):
            return (await current.list_tools()).tools

        @asynccontextmanager
        async def session(self, **_kwargs):
            yield active

    real_sleep = asyncio.sleep

    async def no_wait(_seconds, *args, **kwargs):
        await real_sleep(0)

    active.cancelled = []
    monkeypatch.setattr(krea_connector, "get_connector", Connector)
    monkeypatch.setattr(krea_connector, "connection_revision", lambda: "fixture-workspace")
    monkeypatch.setattr(workspace, "get_run_dir", lambda: tmp_path)
    monkeypatch.setattr(output, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(legacy, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(legacy.asyncio, "sleep", no_wait)
    for module in (krea_account, workspace):
        monkeypatch.setattr(module, "schedule_detached_cancel", lambda factory: active.cancelled.append(factory))
    active.root = tmp_path
    return active


def node(definition_id, **params):
    return GraphNode(id=f"{definition_id}-node", definitionId=definition_id, params=params)


def port(value, kind="Any"):
    return PortValueDict(type=kind, value=value)


def local_png(root: Path, name="input.png") -> Path:
    path = root / name
    path.write_bytes(png())
    return path


def job(job_id, status="completed", urls=None):
    return {"job_id": job_id, "status": status, "type": "image", "created_at": "2026-10-09T10:00:00Z",
            **({"result": {"urls": urls}} if urls is not None else {})}


# ---------------------------------------------------------------------------
# Job history
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_api_job_history_lists_with_filters_and_saves_completed_media(session):
    with respx.mock as router:
        listing = router.get("https://api.krea.ai/jobs").respond(200, json={"items": [
            job(JOB, urls=[CDN]), job(JOB2, status="failed")]})
        router.get(CDN).respond(200, content=png(), headers={"content-type": "image/png"})
        result = await workspace.handle_krea_job_history(
            node("krea-job-history", limit=5, status="completed", types="any", download=True), {}, KEYS)
    params = dict(listing.calls[0].request.url.params)
    assert params == {"limit": "5", "status": "completed"}
    assert listing.calls[0].request.headers["authorization"] == "Bearer fixture"
    assert len(result["jobs"]["value"]) == 2
    assert Path(result["image"]["value"]).read_bytes() == png()
    assert [item["key"] for item in result["media"]["value"]] == [JOB]
    assert JOB in result["text"]["value"] and "failed" in result["text"]["value"]
    assert session.calls == []


@pytest.mark.asyncio
async def test_account_job_history_fetches_one_job_by_id(session):
    session.answers["get_job"] = job(JOB, urls=[CDN])
    result = await workspace.handle_krea_job_history(
        node("krea-job-history", _kreaAuth="mcp"), {"job": port({"job_id": JOB})}, {})
    assert session.args("get_job") == [{"jobId": JOB}]
    assert result["job"]["value"]["job_id"] == JOB
    assert result["image"]["value"] is None  # media is saved only when asked


@pytest.mark.asyncio
@pytest.mark.parametrize("params,match", [
    ({"_kreaAuth": "mcp"}, "needs a Krea API token"),
    ({"job_id": "../usage"}, "valid Krea job ID"),
])
async def test_job_history_refusals_send_nothing(session, params, match):
    with respx.mock(assert_all_called=False) as router:
        api = router.route(host="api.krea.ai").respond(500)
        with pytest.raises(ValueError, match=match):
            await workspace.handle_krea_job_history(node("krea-job-history", **params), {}, KEYS)
        assert not api.called
    assert session.calls == []


# ---------------------------------------------------------------------------
# Node apps
# ---------------------------------------------------------------------------

SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string", "format": "uri", "x-krea-wire-type": "image"},
        "style": {"type": "string", "format": "uri", "x-krea-wire-type": "image"},
        "prompt": {"type": "string", "x-krea-wire-type": "text"},
        "strength": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["subject", "prompt"],
}


def test_node_app_input_fills_explicit_then_images_then_text():
    body = workspace.node_app_input(SCHEMA, {"style": "https://x.test/s.png"}, ["https://x.test/a.png"], "a cat")
    assert body == {"style": "https://x.test/s.png", "subject": "https://x.test/a.png", "prompt": "a cat"}
    with pytest.raises(ValueError, match="no input named mood"):
        workspace.node_app_input(SCHEMA, {"mood": 1}, [], None)
    with pytest.raises(ValueError, match="takes 2 more image"):
        workspace.node_app_input(SCHEMA, {}, ["a", "b", "c"], None)


@pytest.mark.asyncio
async def test_api_node_app_checks_schema_runs_and_saves_outputs(session):
    with respx.mock as router:
        lookup = router.get(f"https://api.krea.ai/node-apps/{VERSION}").respond(200, json={
            "node_app_version_id": VERSION, "input_openapi_schema": SCHEMA})
        execute = router.post(f"https://api.krea.ai/node-apps/{VERSION}/execute").respond(
            200, json=[{"job_id": JOB, "status": "queued"}])
        router.get(f"https://api.krea.ai/jobs/{JOB}").respond(200, json=job(JOB, urls={"image": [CDN]}))
        router.get(CDN).respond(200, content=png(), headers={"content-type": "image/png"})
        result = await workspace.handle_krea_node_app(
            node("krea-node-app", node_app_version_id=VERSION, input='{"strength": 0.4}'),
            {"images": port(["https://x.test/a.png"], "Image"), "text": port("a cat", "Text")}, KEYS)
    assert lookup.called
    assert json.loads(execute.calls[0].request.content) == {
        "strength": 0.4, "subject": "https://x.test/a.png", "prompt": "a cat"}
    assert result["outputs"]["value"]["image"]["type"] == "Image"
    assert Path(result["image"]["value"]).read_bytes() == png()


@pytest.mark.asyncio
async def test_node_app_inputs_that_break_the_schema_are_never_run(session):
    with respx.mock(assert_all_called=False) as router:
        router.get(f"https://api.krea.ai/node-apps/{VERSION}").respond(200, json={"input_openapi_schema": SCHEMA})
        execute = router.post(f"https://api.krea.ai/node-apps/{VERSION}/execute").respond(500)
        with pytest.raises(ValueError, match="strength.*nothing was sent"):
            await workspace.handle_krea_node_app(
                node("krea-node-app", node_app_version_id=VERSION, input={"strength": 3}),
                {"images": port(["https://x.test/a.png"]), "text": port("a cat")}, KEYS)
        assert not execute.called


@pytest.mark.asyncio
async def test_account_node_app_pages_to_the_version_uploads_local_media_and_runs(session):
    session.answers["get_node_apps"] = lambda arguments: (
        {"node_apps": [{"node_app_version_id": "other"}], "next_cursor": "2026-10-01T00:00:00Z"}
        if "cursor" not in arguments else
        {"node_apps": [{"node_app_version_id": VERSION, "input_openapi_schema": SCHEMA}], "next_cursor": None})
    session.answers["execute_node_app"] = {"jobs": [job(JOB, urls={"image": [CDN]})]}
    source = local_png(session.root)
    with respx.mock as router:
        upload = router.post(UPLOAD).respond(200, content=ASSET.encode())
        router.get(CDN).respond(200, content=png(), headers={"content-type": "image/png"})
        result = await workspace.handle_krea_node_app(
            node("krea-node-app", _kreaAuth="mcp", node_app_version_id=VERSION),
            {"images": port([str(source)], "Image"), "text": port("a cat", "Text")}, {})
    assert upload.called
    assert len(session.args("get_node_apps")) == 2
    assert session.args("execute_node_app") == [{
        "nodeAppVersionId": VERSION, "input": {"subject": ASSET, "prompt": "a cat"}, "sync": False}]
    assert Path(result["image"]["value"]).exists()


@pytest.mark.asyncio
async def test_account_node_app_cancels_jobs_still_running_when_one_fails(session):
    session.answers["get_node_apps"] = {"node_apps": [{"node_app_version_id": VERSION, "input_openapi_schema": SCHEMA}]}
    session.answers["execute_node_app"] = {"jobs": [job(JOB, status="queued"), job(JOB2, status="queued")]}
    session.answers["get_job"] = job(JOB, status="failed")
    with pytest.raises(RuntimeError, match="failed"):
        await workspace.handle_krea_node_app(
            node("krea-node-app", _kreaAuth="mcp", node_app_version_id=VERSION),
            {"images": port(["https://x.test/a.png"]), "text": port("a cat")}, {})
    assert len(session.cancelled) == 1  # JOB failed on its own; only JOB2 is cancelled


@pytest.mark.asyncio
async def test_account_node_app_refuses_versions_the_account_cannot_run(session):
    session.answers["get_node_apps"] = {"node_apps": [{"node_app_version_id": "other"}], "next_cursor": None}
    with pytest.raises(ValueError, match="not runnable"):
        await workspace.handle_krea_node_app(
            node("krea-node-app", _kreaAuth="mcp", node_app_version_id=VERSION), {}, {})
    assert "execute_node_app" not in session.names()


# ---------------------------------------------------------------------------
# Krea Files
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_files_lists_and_reads_media_svg_and_text(session):
    session.answers["list_files"] = {"files": [
        {"file_uri": FILE_A, "name": "hero.png"}, {"file_uri": FILE_B, "name": "notes.md"},
        {"file_uri": "file:00000000-1111-4222-8333-444444444444", "name": "logo.svg"},
        {"file_uri": FOLDER, "name": "Launch"}]}
    session.answers["read_files"] = {"files": [
        {"uri": FILE_A, "name": "hero.png", "mimeType": "image/png", "url": CDN},
        {"uri": FILE_B, "name": "notes.md", "mimeType": "text/markdown", "content": "# Launch notes"},
        {"uri": "file:00000000-1111-4222-8333-444444444444", "name": "logo.svg", "mimeType": "image/svg+xml",
         "content": "<svg xmlns='http://www.w3.org/2000/svg'/>"}]}
    with respx.mock as router:
        router.get(CDN).respond(200, content=png(), headers={"content-type": "image/png"})
        result = await workspace.handle_krea_files(node("krea-files", tags="launch, hero", limit=10), {}, {})
    assert session.args("list_files") == [{"scope": "user", "limit": 10, "all_tags": ["launch", "hero"],
                                           "any_tags": [], "without_tags": [], "type": "file"}]
    assert FOLDER not in session.args("read_files")[0]["uris"]
    assert Path(result["image"]["value"]).read_bytes() == png()
    assert result["text"]["value"] == "# Launch notes"
    assert {item["type"] for item in result["media"]["value"]} == {"Image", "SVG"}


@pytest.mark.asyncio
async def test_files_refuses_a_folder_that_is_not_a_krea_uri(session):
    with pytest.raises(ValueError, match="folder:<uuid>"):
        await workspace.handle_krea_files(node("krea-files", folder_uri="https://evil.test/x"), {}, {})
    assert session.calls == []


# ---------------------------------------------------------------------------
# Save to Krea Files
# ---------------------------------------------------------------------------

def _save_answers(session, grant):
    session.answers["create_folders"] = {"folders": [{"uri": FOLDER, "name": "Launch"}]}
    session.answers["write_files_upload"] = {"files": [grant]}
    session.answers["write_files_inline"] = {"files": [{"uri": FILE_B}]}


@pytest.mark.asyncio
async def test_files_save_uploads_raw_bytes_into_a_folder_and_tags_only_uploads(session):
    _save_answers(session, {"uri": FILE_A, "uploadUrl": "https://uploads.example.test/put?sig=1",
                            "method": "PUT", "headers": {"x-amz-acl": "private"}})
    source = local_png(session.root)
    with respx.mock as router:
        put = router.put("https://uploads.example.test/put?sig=1").respond(200)
        result = await workspace.handle_krea_files_save(
            node("krea-files-save", folder="Launch", tags="nebula, launch", name="hero"),
            {"media": port([str(source)], "Image"), "text": port("Launch copy", "Text")}, {})
    request = put.calls[0].request
    assert request.content == png()
    assert request.headers["content-type"] == "image/png" and request.headers["x-amz-acl"] == "private"
    assert "authorization" not in request.headers
    assert session.args("create_folders") == [{"folders": [{"scope": "user", "name": "Launch"}]}]
    assert session.args("write_files_upload") == [{"files": [
        {"scope": "user", "name": "hero.png", "mime_type": "image/png", "parent_uri": FOLDER}]}]
    assert session.args("write_files_inline")[0]["files"][0]["tags"] == ["nebula", "launch"]
    assert session.args("tag_files") == [{"uris": [FILE_A], "add": ["nebula", "launch"], "remove": []}]
    assert result["uris"]["value"] == [FILE_A, FILE_B]


@pytest.mark.asyncio
@pytest.mark.parametrize("grant,match", [
    ({"uri": FILE_A, "uploadUrl": "https://uploads.example.test/put", "multipart": {"parts": 3}}, "multipart"),
    ({"uri": FILE_A, "uploadUrl": "http://uploads.example.test/put"}, "unexpected upload URL"),
    ({"uri": FILE_A, "uploadUrl": "https://uploads.example.test/put", "method": "DELETE"}, "upload method"),
])
async def test_files_save_refuses_grants_it_cannot_honor_safely(session, grant, match):
    _save_answers(session, grant)
    source = local_png(session.root)
    with respx.mock(assert_all_called=False) as router:
        sink = router.route(host="uploads.example.test").respond(200)
        with pytest.raises(RuntimeError, match=match):
            await workspace.handle_krea_files_save(node("krea-files-save"), {"media": port([str(source)])}, {})
        assert not sink.called


@pytest.mark.asyncio
async def test_files_save_takes_only_local_media(session):
    with pytest.raises(ValueError, match="not remote URLs"):
        await workspace.handle_krea_files_save(node("krea-files-save"), {"media": port(["https://x.test/a.png"])}, {})
    with pytest.raises(ValueError, match="Wire media or text"):
        await workspace.handle_krea_files_save(node("krea-files-save"), {}, {})
    assert session.calls == []


# ---------------------------------------------------------------------------
# Krea Nodes workflows
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_nodes_workflow_create_returns_an_open_in_krea_link(session):
    spec = {"nodes": [{"id": "a", "node_type": "image"}], "edges": []}
    session.answers["create_node_workflow"] = {"id": "wf1", "url": "/nodes/wf1"}
    result = await workspace.handle_krea_nodes_workflow(
        node("krea-nodes-workflow", name="Launch board", spec=json.dumps(spec)), {}, {})
    assert session.args("create_node_workflow") == [{"name": "Launch board", "nodes": spec["nodes"]}]
    assert result["url"]["value"] == "https://www.krea.ai/nodes/wf1"


@pytest.mark.asyncio
async def test_nodes_workflow_edits_need_a_typed_workflow_id(session):
    with pytest.raises(ValueError, match="workflow ID"):
        await workspace.handle_krea_nodes_workflow(
            node("krea-nodes-workflow", action="update", operations='[{"type": "delete_node", "id": "a"}]'),
            {"workflow": port({"id": "someone-elses"})}, {})
    assert session.calls == []
    await workspace.handle_krea_nodes_workflow(
        node("krea-nodes-workflow", action="update", workflow_id="wf1",
             operations='[{"type": "delete_node", "id": "a"}]'), {}, {})
    assert session.args("update_node_workflow") == [
        {"workflow": "wf1", "operations": [{"type": "delete_node", "id": "a"}]}]


# ---------------------------------------------------------------------------
# Krea Agent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_agent_sends_waits_through_timeouts_and_saves_deliverables(session):
    views = iter([{"timedOut": True, "finished": False},
                  {"finished": True, "status": "idle", "latestAssistantText": "Here is the hero image.",
                   "deliverables": [{"name": "hero", "url": CDN, "contentType": "image/png"}]}])
    session.answers["send_agent_message"] = {"sessionId": SESSION, "runId": RUN, "url": "https://www.krea.ai/agent/x"}
    session.answers["wait_for_agent_session"] = lambda _arguments: next(views)
    with respx.mock as router:
        router.get(CDN).respond(200, content=png(), headers={"content-type": "image/png"})
        result = await workspace.handle_krea_agent(
            node("krea-agent", prompt="Make a hero image", effort="high", wait_seconds=600), {}, {})
    assert session.args("send_agent_message") == [{"prompt": "Make a hero image", "effort": "high"}]
    assert session.args("wait_for_agent_session") == [
        {"sessionId": SESSION, "timeoutSeconds": 300, "runId": RUN}] * 2
    assert result["text"]["value"] == "Here is the hero image."
    assert Path(result["image"]["value"]).read_bytes() == png()
    assert result["session"]["value"]["sessionId"] == SESSION


@pytest.mark.asyncio
async def test_agent_reports_a_turn_that_outlives_the_wait(session):
    session.answers["send_agent_message"] = {"sessionId": SESSION, "url": "https://www.krea.ai/agent/x"}
    session.answers["wait_for_agent_session"] = {"timedOut": True, "finished": False}
    with pytest.raises(RuntimeError, match="still working after 30s"):
        await workspace.handle_krea_agent(node("krea-agent", prompt="Make a video", wait_seconds=30), {}, {})
    assert session.args("wait_for_agent_session") == [{"sessionId": SESSION, "timeoutSeconds": 30}]


@pytest.mark.asyncio
async def test_agent_needs_a_prompt(session):
    with pytest.raises(ValueError, match="needs a prompt"):
        await workspace.handle_krea_agent(node("krea-agent"), {}, {})
    assert session.calls == []


# ---------------------------------------------------------------------------
# Desktop apps
# ---------------------------------------------------------------------------

DESKTOP_TOOLS = {"tools": [{"name": "import_krea_job", "description": "Place a Krea output in the project",
                            "inputSchema": {"type": "object", "required": ["jobId"], "additionalProperties": False,
                                            "properties": {"jobId": {"type": "string"},
                                                           "outputIndex": {"type": "integer"}}}}]}


@pytest.mark.asyncio
async def test_desktop_call_fills_the_wired_job_validates_and_saves_the_frame(session):
    session.answers["get_desktop_tools"] = DESKTOP_TOOLS
    session.answers["call_desktop_tool"] = CallToolResult(content=[
        TextContent(type="text", text="Placed on layer 3"),
        ImageContent(type="image", data=base64.b64encode(png()).decode(), mimeType="image/png")])
    result = await workspace.handle_krea_desktop(
        node("krea-desktop", action="call-tool", app_id=APP, tool="import_krea_job"),
        {"job": port({"job_id": JOB})}, {})
    assert session.args("call_desktop_tool") == [
        {"appId": APP, "tool": "import_krea_job", "input": {"jobId": JOB, "outputIndex": 0}}]
    assert Path(result["image"]["value"]).read_bytes() == png()
    assert result["text"]["value"] == "Placed on layer 3"


@pytest.mark.asyncio
@pytest.mark.parametrize("params,match", [
    ({"app_id": "photoshop"}, "app ID from Krea Desktop Apps"),
    ({"app_id": APP, "tool": "delete_everything"}, "no tool named delete_everything"),
    ({"app_id": APP, "tool": "import_krea_job", "input": '{"jobId": 7}'}, "nothing was sent"),
])
async def test_desktop_refusals_never_touch_the_project(session, params, match):
    session.answers["get_desktop_tools"] = DESKTOP_TOOLS
    with pytest.raises(ValueError, match=match):
        await workspace.handle_krea_desktop(node("krea-desktop", action="call-tool", **params), {}, {})
    assert "call_desktop_tool" not in session.names()


@pytest.mark.asyncio
async def test_desktop_failures_say_to_inspect_the_project(session):
    session.answers["get_desktop_tools"] = DESKTOP_TOOLS
    session.answers["call_desktop_tool"] = CallToolResult(content=[], isError=True)
    with pytest.raises(RuntimeError, match="inspect the project"):
        await workspace.handle_krea_desktop(
            node("krea-desktop", action="call-tool", app_id=APP, tool="import_krea_job", input={"jobId": JOB}), {}, {})


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_usage_uses_the_workspace_service_key_and_totals_units():
    with respx.mock as router:
        usage = router.get("https://api.krea.ai/usage").respond(200, json={
            "start_date": "2026-10-01T00:00:00Z", "end_date": "2026-10-09T00:00:00Z",
            "jobs": [{"job_id": JOB, "type": "image", "compute_units": 1.25},
                     {"job_id": JOB2, "type": "video", "compute_units": 2.25}]})
        result = await workspace.handle_krea_usage(
            node("krea-usage", start_date="2026-10-01"), {}, {**KEYS, "KREA_USAGE_KEY": "service"})
    request = usage.calls[0].request
    assert request.headers["authorization"] == "Bearer service"
    assert dict(request.url.params) == {"start_date": "2026-10-01"}
    assert result["total"]["value"] == "3.5"
    assert "video: 2.25" in result["text"]["value"]


@pytest.mark.asyncio
async def test_usage_without_a_service_key_sends_nothing():
    with respx.mock(assert_all_called=False) as router:
        api = router.route(host="api.krea.ai").respond(500)
        with pytest.raises(ValueError, match="KREA_USAGE_KEY"):
            await workspace.handle_krea_usage(node("krea-usage"), {}, KEYS)
        assert not api.called
