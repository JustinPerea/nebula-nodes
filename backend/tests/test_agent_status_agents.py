"""Agent support for the Agents panel (Q125 item 2): MCP, the `nebula` CLI and docs.

Justin's standing rule: "Every feature we add needs to make sure we include
MCP support for agents." Agents set their own status line (set_status,
`nebula status`) and read the roster (list_agents, `nebula agents`), which
is the same read the person's panel makes. Counts only: no surface shows
another agent's questions, answers or proposals.
"""
from __future__ import annotations

import argparse
import inspect
import io
import json
from pathlib import Path

import pytest

import mcp_server
from nebula_api import NebulaAPI
from services import krea_agent_mcp
from tests.test_agent_questions import SECRET_ANSWER, TWO, _answer, asked  # noqa: F401 - fixture
from tests.test_agent_status import PROPOSAL_NOTE, _canvas_proposal, roster  # noqa: F401 - fixture
from tests.test_canvas_proposals import CLAUDE, CODEX, api  # noqa: F401 - fixture

REPO = Path(__file__).resolve().parents[2]
TOOLS = ("set_status", "list_agents")


@pytest.fixture
def tools(roster, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=roster.client))
    return roster


def _registered():
    return {tool.name: tool for tool in mcp_server.mcp._tool_manager.list_tools()}


# -- MCP ----------------------------------------------------------------------------

def test_the_tools_are_registered_listed_and_annotated():
    registered = _registered()
    for name in TOOLS:
        assert name in registered, name
        assert name in krea_agent_mcp.NEBULA_MCP_TOOLS, name
    assert registered["list_agents"].annotations.readOnlyHint is True
    status = registered["set_status"].annotations
    assert status.readOnlyHint is False and status.destructiveHint is False and status.openWorldHint is False


def test_the_instructions_name_the_tools_and_set_status_says_when_to_use_it():
    text = mcp_server.INSTRUCTIONS
    assert "set_status" in text and "list_agents" in text
    doc = " ".join((inspect.getdoc(mcp_server.set_status) or "").split())
    # Against point_at's say and post_note, and clear it when done.
    assert "point_at" in doc and "say" in doc and "post_note" in doc
    assert "clear" in doc.lower() and "finish" in doc.lower()
    assert "10 minutes" in doc
    listed = " ".join((inspect.getdoc(mcp_server.list_agents) or "").split())
    assert "counts" in listed.lower()


def test_in_app_guidance_names_set_status():
    from services.chat_session import NEBULA_MCP_PRIMER

    assert "set_status" in NEBULA_MCP_PRIMER


def test_set_status_and_list_agents_over_mcp(tools):
    n1 = tools.graph.add_node("text-input", {"value": "a cat"})
    made = mcp_server.set_status("Rendering the hero shots", node_id=n1)
    assert made["status"]["text"] == "Rendering the hero shots" and made["status"]["nodeId"] == n1
    listed = mcp_server.list_agents()
    (entry,) = listed["agents"]
    assert entry["agent"]["name"] == "Claude Code" and entry["status"]["nodeId"] == n1
    # The same read the person's panel makes.
    assert listed == tools.client.get("/api/canvas/agents").json()
    cleared = mcp_server.set_status("")
    assert cleared["status"] is None
    assert mcp_server.list_agents()["agents"] == []


# -- the CLI ------------------------------------------------------------------------

def _cli_client(api):
    from cli.client import NebulaClient

    client = NebulaClient("http://testserver")
    client._client = api.client
    return client


def _parse(argv: list[str]) -> argparse.Namespace:
    from cli.__main__ import build_parser

    return build_parser().parse_args(argv)


def test_cli_status_sets_clears_and_agents_lists(roster, monkeypatch):  # noqa: F811
    from cli.commands import agents as agents_cmd

    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    client = _cli_client(roster)
    n1 = roster.graph.add_node("text-input", {"value": "a cat"})
    out = io.StringIO()
    args = _parse(["status", "Rendering the hero shots", "--node", n1, "--as", "Claude Code"])
    assert agents_cmd.run_status(client, args, out=out) == 0
    assert "Rendering the hero shots" in out.getvalue()

    out = io.StringIO()
    assert agents_cmd.run_agents(client, _parse(["agents", "--json"]), out=out) == 0
    as_cli = json.loads(out.getvalue())
    # MCP and the CLI read the same thing.
    assert as_cli == roster.client.get("/api/canvas/agents").json()
    out = io.StringIO()
    assert agents_cmd.run_agents(client, _parse(["agents"]), out=out) == 0
    text = out.getvalue()
    assert "Claude Code" in text and "Rendering the hero shots" in text and "Working" in text

    out = io.StringIO()
    assert agents_cmd.run_status(client, _parse(["status", "--clear", "--as", "Claude Code"]), out=out) == 0
    assert roster.client.get("/api/canvas/agents").json()["agents"] == []


def test_cli_status_needs_text_or_clear(roster, capsys):  # noqa: F811
    from cli.commands import agents as agents_cmd

    client = _cli_client(roster)
    for argv in (["status", "--node", "n1", "--as", "Codex"], ["status", "Working", "--clear", "--as", "Codex"]):
        assert agents_cmd.run_status(client, _parse(argv), out=io.StringIO()) == 2
        assert "nebula status" in capsys.readouterr().err
    assert roster.client.get("/api/canvas/agents").json()["agents"] == []


def test_bare_nebula_status_still_shows_the_run_state():
    args = _parse(["status"])
    assert args.text is None and not args.clear


def test_the_cli_shows_counts_never_another_agents_content(roster, monkeypatch):  # noqa: F811
    from cli.commands import agents as agents_cmd

    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    asked_set = roster.client.post("/api/canvas/questions", headers=CLAUDE, json=TWO).json()["questions"]
    answered = roster.client.post("/api/canvas/questions", headers=CLAUDE,
                                  json={"questions": [{"text": "Anything else?"}]}).json()["questions"]
    assert _answer(roster, answered["id"], {"answers": [{"questionId": "q1", "text": SECRET_ANSWER}]}
                   ).status_code == 200
    _canvas_proposal(roster, CODEX)
    client = _cli_client(roster)
    for argv in (["agents"], ["agents", "--json"]):
        out = io.StringIO()
        monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
        assert agents_cmd.run_agents(client, _parse(argv), out=out) == 0
        text = out.getvalue()
        for secret in ("Which crop for the hero?", "Anything to avoid?", SECRET_ANSWER, PROPOSAL_NOTE,
                       TWO["note"], asked_set["id"]):
            assert secret not in text, (argv, secret)
    out = io.StringIO()
    agents_cmd.run_agents(client, _parse(["agents"]), out=out)
    # Questions, not sets: TWO is one set of 2 questions (review).
    assert "2 questions" in out.getvalue() and "1 proposal" in out.getvalue()


# -- docs -----------------------------------------------------------------------------

def test_the_docs_cover_the_tools_and_the_cli():
    setup = (REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8")
    skill = (REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8")
    for name in (*TOOLS, "nebula status", "nebula agents", "/api/canvas/status", "/api/canvas/agents"):
        assert name in setup, name
    for name in (*TOOLS, "nebula status", "nebula agents"):
        assert name in skill, name
    flat = " ".join(setup.split())
    assert "10 minutes" in flat and "counts only" in flat.lower()
