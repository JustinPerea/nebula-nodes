"""Agent support for placeholders, the node mark and done cards (Q125 item 3).

Justin's standing rule: "Every feature we add needs to make sure we include
MCP support for agents." edit_canvas gains `pending` (and `node_ids` with
`pending: false`); `nebula apply` gains --pending and --ready; run results
report skipped placeholders with a reason; the roster lists each agent's
placeholders and its running nodes; the agent reads its own done card with
list_notes. Docs and INSTRUCTIONS say so.
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
from tests.test_canvas_proposals import CLAUDE, CODEX, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _chain, pend  # noqa: F401 - fixture

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def tools(pend, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=pend.client))
    return pend


def _parse(argv: list[str]) -> argparse.Namespace:
    from cli.__main__ import build_parser

    return build_parser().parse_args(argv)


# -- MCP -------------------------------------------------------------------------------------

def test_edit_canvas_takes_pending_and_says_what_it_does():
    params = inspect.signature(mcp_server.edit_canvas).parameters
    assert "pending" in params and "node_ids" in params
    doc = " ".join((inspect.getdoc(mcp_server.edit_canvas) or "").split())
    assert "`pending`" in doc and "placeholder" in doc.lower()
    assert "node_ids" in doc and "run" in doc.lower()


def test_the_instructions_mention_pending_within_the_budget():
    text = mcp_server.INSTRUCTIONS
    assert "pending" in text
    assert len(text) <= 3000


def test_edit_canvas_pending_over_mcp(tools):
    made = mcp_server.edit_canvas(note="hero chain", nodes=[{"ref": "+p", "definitionId": "text-input"}],
                                  pending=True)
    node = made["idMap"]["+p"]
    assert made["pending"] == [node]
    assert tools.graph.nodes[node]["pending"]["agent"]["name"] == "Claude Code"
    ready = mcp_server.edit_canvas(pending=False, node_ids=[node])
    assert ready["ready"] == [node]
    assert "pending" not in tools.graph.nodes[node]


def test_edit_canvas_steps_carry_pending_per_step(tools):
    made = mcp_server.edit_canvas(steps=[
        {"nodes": [{"ref": "+p", "definitionId": "text-input"}], "pending": True},
        {"pending": False, "nodeIds": ["+p"]},
    ])
    assert made["status"] == "applied", made
    node = made["idMap"]["+p"]
    assert "pending" not in tools.graph.nodes[node]


def test_run_nodes_reports_skipped_placeholders(tools):
    import asyncio

    ids = _chain(tools, headers=CODEX)
    free = tools.graph.add_node("text-input", {"value": "free"})
    result = asyncio.run(mcp_server.run_nodes(wait_seconds=5))
    payload = json.loads(getattr(result[0], "text", result[0]))  # the run as agents read it
    assert set(payload["skipped"]) == set(ids.values())
    assert "Codex" in payload["skipped"][ids["+p"]]
    assert free in payload["outputs"]
    doc = " ".join((inspect.getdoc(mcp_server.run_nodes) or "").split())
    assert "placeholder" in doc.lower()


def test_list_agents_lists_each_agents_placeholders(tools):
    ids = _chain(tools)
    listed = tools.client.get("/api/canvas/agents", headers=CODEX).json()
    entry = next(e for e in listed["agents"] if e["agent"]["name"] == "Claude Code")
    assert sorted(entry["pending"]) == sorted(ids.values())
    assert entry["running"] == []
    doc = " ".join((inspect.getdoc(mcp_server.list_agents) or "").split())
    assert "pending" in doc


def test_look_at_canvas_names_a_placeholders_owner(tools):
    ids = _chain(tools)
    snapshot = tools.client.get("/api/canvas/snapshot", headers=CODEX).json()
    node = next(n for n in snapshot["nodes"] if n["id"] == ids["+a"])
    assert node["pending"] == {"agent": "Claude Code", "agentId": "ext:claude-code"}


def test_list_notes_doc_names_done_cards():
    doc = " ".join((inspect.getdoc(mcp_server.list_notes) or "").split())
    assert "run" in doc and "done" in doc.lower()


# -- the CLI -------------------------------------------------------------------------------------

def test_nebula_apply_pending_and_ready_build_the_body():
    from cli.plan import body_from_args

    body = body_from_args(_parse(["apply", "--add", "+p=text-input", "--pending"]), command="apply")
    assert body["pending"] is True and body["nodes"][0]["ref"] == "+p"
    body = body_from_args(_parse(["apply", "--ready", "n4", "--ready", "n5"]), command="apply")
    assert body == {"pending": False, "nodeIds": ["n4", "n5"]}


def test_nebula_apply_pending_needs_new_nodes_and_ready_needs_ids(capsys):
    from cli.plan import BuildError, body_from_args

    with pytest.raises(BuildError):
        body_from_args(_parse(["apply", "--set", "n4.value=x", "--pending"]), command="apply")
    with pytest.raises(BuildError):
        body_from_args(_parse(["apply", "--add", "+p=text-input", "--pending", "--ready", "n4"]), command="apply")


def test_nebula_apply_pending_with_a_file(tmp_path):
    from cli.plan import BuildError, body_from_args

    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"nodes": [{"ref": "+p", "definitionId": "text-input"}]}), encoding="utf-8")
    body = body_from_args(_parse(["apply", "--file", str(plan), "--pending"]), command="apply")
    assert body["pending"] is True
    steps = tmp_path / "steps.json"
    steps.write_text(json.dumps({"steps": [{"nodes": [{"ref": "+p", "definitionId": "text-input"}]}]}),
                     encoding="utf-8")
    with pytest.raises(BuildError):
        body_from_args(_parse(["apply", "--file", str(steps), "--pending"]), command="apply")


def test_nebula_apply_pending_end_to_end(pend):
    from cli.client import NebulaClient
    from cli.commands import apply as apply_cmd

    client = NebulaClient("http://testserver")
    client._client = pend.client
    out = io.StringIO()
    assert apply_cmd.run_apply(client, _parse(["apply", "--add", "+p=text-input", "--pending", "--as", "Codex"]),
                               out=out) == 0
    node = next(iter(pend.graph.nodes))
    assert pend.graph.nodes[node]["pending"]["agent"]["name"] == "Codex"
    assert "placeholder" in out.getvalue().lower()
    out = io.StringIO()
    assert apply_cmd.run_apply(client, _parse(["apply", "--ready", node, "--as", "Codex"]), out=out) == 0
    assert "pending" not in pend.graph.nodes[node]
    assert "ready" in out.getvalue().lower()


def test_nebula_agents_shows_placeholders(pend, monkeypatch):
    from cli.client import NebulaClient
    from cli.commands import agents as agents_cmd

    _chain(pend)
    client = NebulaClient("http://testserver")
    client._client = pend.client
    out = io.StringIO()
    assert agents_cmd.run_agents(client, _parse(["agents"]), out=out) == 0
    assert "3 placeholders" in out.getvalue()


def test_apply_steps_resolve_refs_in_node_ids():
    import apply_steps

    steps = apply_steps.check_steps({"steps": [
        {"nodes": [{"ref": "+p", "definitionId": "text-input"}], "pending": True},
        {"pending": False, "nodeIds": ["+p"]},
    ]})
    assert apply_steps.resolve_step(steps[1], {"+p": "n7"})["nodeIds"] == ["n7"]
    with pytest.raises(apply_steps.PlanError):
        apply_steps.check_steps({"steps": [{"pending": False, "nodeIds": ["+nope"]}]})


# -- docs ----------------------------------------------------------------------------------------

def test_the_docs_cover_pending_skips_and_done_cards():
    setup = " ".join((REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8").split())
    skill = " ".join((REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8").split())
    for text in (setup, skill):
        assert "pending" in text and "placeholder" in text.lower()
        assert "--pending" in text and "--ready" in text
        assert "skipped" in text
        assert "Show on canvas" in text
    assert "10 minutes" in setup and "node_ids" in setup
