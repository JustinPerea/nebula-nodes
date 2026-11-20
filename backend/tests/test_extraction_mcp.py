"""The four extraction MCP tools: registered, annotated, path-checked and working in process."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

import mcp_server
from services import krea_agent_mcp

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
TOOLS = ("extraction_measure", "extraction_list", "extraction_show", "extraction_correct")


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


@pytest.fixture
def image(tmp_path):
    path = tmp_path / "hero.png"
    path.write_bytes((FIXTURES / "gradient_accent.png").read_bytes())
    return path


def _tools():
    return {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}


def test_the_tools_are_registered_annotated_and_listed_for_agents():
    tools = _tools()
    for name in TOOLS:
        assert name in tools and name in krea_agent_mcp.NEBULA_MCP_TOOLS
        assert tools[name].annotations.openWorldHint is False
    assert tools["extraction_list"].annotations.readOnlyHint is True
    assert tools["extraction_show"].annotations.readOnlyHint is True
    for name in ("extraction_measure", "extraction_correct"):
        assert tools[name].annotations.readOnlyHint is False and tools[name].annotations.destructiveHint is False
    assert set(tools["extraction_measure"].inputSchema["properties"]) == {"image_path", "folder", "replace"}
    assert set(tools["extraction_correct"].inputSchema["properties"]) == {"record", "corrections"}


def test_the_tools_are_documented():
    repo = Path(__file__).resolve().parents[2]
    setup = (repo / "docs" / "MCP-SETUP.md").read_text()
    skill = (repo / "skills" / "nebula" / "SKILL.md").read_text()
    for name in TOOLS:
        assert f"`{name}`" in setup, name
        assert name in skill, name
    assert "not an agent tool yet" in setup and "not an agent tool yet" in skill


def test_measure_list_show_correct_in_process(image, folder):
    measured = mcp_server.extraction_measure(str(image), str(folder))
    record_id = measured["record"]["id"]
    assert measured["existed"] is False and measured["record"]["source"]["name"] == "hero.png"
    assert measured["record"]["source"]["kind"] == "file" and measured["record"]["source"]["path"] == str(image.resolve())
    assert mcp_server.extraction_measure(str(image), str(folder))["existed"] is True

    listed = mcp_server.extraction_list(str(folder))["records"]
    assert [r["id"] for r in listed] == [record_id] and listed[0]["name"] == "hero.png"

    shown = mcp_server.extraction_show(str(folder / record_id))
    assert shown["record"] == shown["effective"] == measured["record"]

    done = mcp_server.extraction_correct(str(folder / record_id), [
        {"path": "brand", "op": "set", "value": "acme", "reason": "named in the brief"}])
    assert done["id"] == record_id and done["effective"]["brand"] == "acme"
    assert done["added"][0]["actor"] == "agent" and done["added"][0]["reason"] == "named in the brief"
    again = mcp_server.extraction_show(str(folder / record_id / "record.json"))
    assert again["record"]["brand"] is None and again["effective"]["brand"] == "acme"
    assert len(again["record"]["corrections"]) == 1
    assert json.loads((folder / record_id / "record.json").read_text())["corrections"][0]["actor"] == "agent"

    second = mcp_server.extraction_correct(str(folder / record_id), [{"path": "brand", "op": "set", "value": "beta"}])
    assert len(second["added"]) == 1 and second["effective"]["brand"] == "beta"


def test_an_agent_cant_approve_or_touch_facts(image, folder):
    record_id = mcp_server.extraction_measure(str(image), str(folder))["record"]["id"]
    for path in ("status", "approved_by", "structure.measured.palette", "rendering.width", "source.name", "id"):
        with pytest.raises(RuntimeError):
            mcp_server.extraction_correct(str(folder / record_id), [{"path": path, "op": "set", "value": "x"}])
    with pytest.raises(RuntimeError, match="Approval isn't a correction"):
        mcp_server.extraction_correct(str(folder / record_id), [{"path": "status", "op": "set", "value": "approved"}])
    assert mcp_server.extraction_show(str(folder / record_id))["record"]["corrections"] == []


def test_a_path_require_allowed_path_refuses_is_refused(image, folder, tmp_path):
    twin = tmp_path / "twin.png"
    twin.write_bytes(image.read_bytes())
    linked = tmp_path / "hardlink.png"
    os.link(twin, linked)  # a file with two names is refused (it could be the protected store)
    with pytest.raises(RuntimeError, match="multiple hard links"):
        mcp_server.extraction_measure(str(linked), str(folder))
    with pytest.raises(RuntimeError, match="device paths"):
        mcp_server.extraction_list("/dev/null")
    with pytest.raises(RuntimeError, match="device paths"):
        mcp_server.extraction_measure(str(image), "/dev/null")
    with pytest.raises(RuntimeError, match="device paths"):
        mcp_server.extraction_show("/dev/null")
    assert list(folder.iterdir()) == []


def test_the_stores_own_refusals_come_back_as_plain_errors(image, tmp_path, folder, monkeypatch):
    with pytest.raises(RuntimeError, match="doesn't exist"):
        mcp_server.extraction_measure(str(image), str(tmp_path / "nope"))
    with pytest.raises(RuntimeError, match="image file doesn't exist"):
        mcp_server.extraction_measure(str(tmp_path / "gone.png"), str(folder))
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    with pytest.raises(RuntimeError, match="Videos aren't supported"):
        mcp_server.extraction_measure(str(video), str(folder))
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    with pytest.raises(RuntimeError, match="state folder"):
        mcp_server.extraction_measure(str(image), str(state))
    assert list(folder.iterdir()) == []


def test_calls_go_through_the_server_as_a_client_would(image, folder):
    from mcp.shared.memory import create_connected_server_and_client_session

    async def run():
        async with create_connected_server_and_client_session(mcp_server.mcp._mcp_server) as session:
            ok = await session.call_tool("extraction_measure", {"image_path": str(image), "folder": str(folder)})
            bad = await session.call_tool("extraction_list", {"folder": "/dev/null"})
            return ok, bad

    ok, bad = asyncio.run(run())
    assert not ok.isError and ok.structuredContent["record"]["id"].startswith("ex_")
    assert bad.isError and "device paths" in bad.content[0].text


def test_a_turn_with_a_workspace_reaches_only_its_own_files(image, folder, tmp_path, monkeypatch):
    from services import agent_workspaces

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(agent_workspaces, "active_workspace", lambda: workspace)
    with pytest.raises(RuntimeError, match="outside this chat's workspace"):
        mcp_server.extraction_measure(str(image), str(folder))
    (workspace / "records").mkdir()
    (workspace / "hero.png").write_bytes(image.read_bytes())
    # A relative path means the workspace, not this process's folder.
    saved = mcp_server.extraction_measure("hero.png", "records")
    record_id = saved["record"]["id"]
    assert record_id.startswith("ex_")
    assert (workspace / "records" / record_id / "record.json").is_file()


def test_a_symlinked_or_hard_linked_image_is_not_read(image, folder, tmp_path):
    link = tmp_path / "link.png"
    link.symlink_to(image)
    hard = tmp_path / "hard.png"
    os.link(image, hard)
    with pytest.raises(RuntimeError, match="hard link"):
        mcp_server.extraction_measure(str(hard), str(folder))
    # A symlink is resolved by the path check first, so the read opens the
    # real file; a link swapped in after the check fails the no-follow open.
    from moodboard_client import _open_no_follow
    with pytest.raises(OSError):
        _open_no_follow(Path(str(link)))
