"""Q118's agent support: MCP project_size and its `nebula project size` twin.

Read-only: the open project's size (with the live canvas in it), the save
limit, whether the person's canvas has paused saving, and what is large,
largest first, with node ids (agents need ids; the person's panel shows
none). Agents trim with the tools they already have, under the person's
existing approvals: nothing here deletes or trims.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import mcp_server
from tests.test_cli_project_reads import _json, _run, cli  # noqa: F401 (fixtures by name)
from tests.test_mcp_projects_and_reads import nebula  # noqa: F401

ROOT = Path(__file__).resolve().parents[2]


def test_project_size_reads_the_open_project_and_its_twin_prints_the_same(cli, monkeypatch):
    import main

    monkeypatch.setattr(main, "MAX_PROJECT_BYTES", 4096)
    mcp_server.new_project("Glass campaign")
    big = mcp_server.edit_canvas(nodes=[{"ref": "+brief", "definitionId": "text-input",
                                         "params": {"value": "w" * 3000}}])["idMap"]["+brief"]
    # The person's own Load graph took it over the limit.
    main.cli_graph.update_params(big, {"value": "w" * 5000})

    result = mcp_server.project_size()
    assert result["project"]["name"] == "Glass campaign" and result["project"]["open"] is True
    assert result["savingPaused"] is True and result["overLimit"] is True
    assert result["limitBytes"] == 4096 and result["sizeBytes"] > 4096
    assert result["largest"][0]["nodeId"] == big and result["largest"][0]["part"] == "Text"
    assert "remove_from_canvas" in result["note"]

    by_cli = _json(["project", "size", "current", "--json"])
    assert by_cli == mcp_server.project_size("current")
    code, out, err = _run(["project", "size"])
    assert code == 0, err
    assert "saving paused" in out.lower() and big in out

    # A project under the limit.
    mcp_server.new_project("Small")
    small = mcp_server.project_size()
    assert small["savingPaused"] is False and small["overLimit"] is False


def test_project_size_is_registered_read_only_and_documented():
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    assert "project_size" in tools
    annotations = tools["project_size"].annotations
    assert annotations.readOnlyHint is True and annotations.openWorldHint is False
    assert "project_size" in mcp_server.INSTRUCTIONS
    assert "`project_size`" in (ROOT / "docs" / "MCP-SETUP.md").read_text()
    skill = (ROOT / "skills" / "nebula" / "SKILL.md").read_text()
    assert "nebula project size" in skill
