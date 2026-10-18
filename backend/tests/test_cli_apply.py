"""`nebula apply`: the CLI twin of edit_canvas (POST /api/graph/apply).

Gap 8 in the Good Machines design-canvas log: the CLI built graphs one node
and one wire per call, so a multi-node build wasn't atomic and had no +refs.
`nebula apply` sends one plan (cli/plan.py, shared with `nebula propose`)
and the backend applies all of it or none of it.
"""
from __future__ import annotations

import argparse
import io
import json

import pytest
from fastapi.testclient import TestClient

from cli.client import NebulaClient
from cli.commands import apply as apply_cmd
from cli.commands import proposals as proposals_cmd
from cli.plan import BuildError, body_from_args, build_body
from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

PLAN = {
    "note": "Two takes from one prompt",
    "nodes": [
        {"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse at dusk"}},
        {"ref": "+wide", "definitionId": "nano-banana"},
        {"ref": "+tight", "definitionId": "nano-banana"},
    ],
    "edges": [
        {"source": "+p", "sourceHandle": "text", "target": "+wide", "targetHandle": "prompt"},
        {"source": "+p", "sourceHandle": "text", "target": "+tight", "targetHandle": "prompt"},
    ],
    "rename": {"+wide": "Wide", "+tight": "Tight"},
}


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    book = ProposalBook()

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", book)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)

    client = NebulaClient("http://testserver")
    client._client = TestClient(main_module.app)

    class Api:
        pass

    ctx = Api()
    ctx.client = client
    ctx.graph = graph
    ctx.book = book
    ctx.tmp = tmp_path
    return ctx


def _args(**overrides) -> argparse.Namespace:
    values = dict(file=None, note=None, add=[], param=[], set_params=[], wire=[], at=[], rename=[], move=[],
                  remove=[], unwire=[], json=False, agent_name="Codex")
    values.update(overrides)
    return argparse.Namespace(**values)


def _plan_file(api, body: dict) -> str:
    path = api.tmp / "plan.json"
    path.write_text(json.dumps(body))
    return str(path)


def test_a_plan_file_lands_in_one_step_and_prints_the_new_ids(api):
    api.graph.add_node("text-input", {"value": "keep"})
    out = io.StringIO()

    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, PLAN)), out=out) == 0

    lines = out.getvalue().splitlines()
    assert lines[0] == "Applied: added 3, wired 2, renamed 2."
    assert lines[1:] == ["  +p → n2  Text Input", "  +wide → n3  Wide", "  +tight → n4  Tight"]
    assert sorted(api.graph.nodes) == ["n1", "n2", "n3", "n4"]
    assert {(e["source"], e["target"]) for e in api.graph.edges} == {("n2", "n3"), ("n2", "n4")}
    assert api.graph.nodes["n2"]["params"]["value"] == "a lighthouse at dusk"


def test_a_refused_plan_changes_nothing_and_says_why(api, capsys):
    api.graph.add_node("text-input", {"value": "keep"})
    before = api.graph.get_state()
    bad = {**PLAN, "edges": [{**PLAN["edges"][0], "targetHandle": "nope"}]}

    with pytest.raises(SystemExit) as exc:
        apply_cmd.run_apply(api.client, _args(file=_plan_file(api, bad)), out=io.StringIO())

    assert exc.value.code == 1
    err = capsys.readouterr().err
    # The new node is named as the plan named it, not by a staged id it never saw.
    assert err == "error: Invalid target handle 'nope' on node '+wide' (definition 'nano-banana'). " \
                  "Valid inputPorts: ['prompt', 'images', 'moodboard']\n"
    assert api.graph.get_state() == before


def test_apply_refuses_a_run_before_sending_anything(api, capsys, monkeypatch):
    sent = []
    monkeypatch.setattr(api.client, "apply", lambda body, agent_name=None: sent.append(body))
    code = apply_cmd.run_apply(api.client, _args(file=_plan_file(api, {**PLAN, "run": ["+wide"]})))
    assert code == 1 and sent == []
    assert "apply never runs anything" in capsys.readouterr().err


def test_an_unnamed_agent_is_told_to_name_itself(api, capsys):
    with pytest.raises(SystemExit) as exc:
        apply_cmd.run_apply(api.client, _args(file=_plan_file(api, PLAN), agent_name=None), out=io.StringIO())
    assert exc.value.code == 1
    assert "Name yourself with NEBULA_AGENT_NAME or --as" in capsys.readouterr().err
    assert api.graph.nodes == {}


def test_builder_flags_make_the_same_plan_as_the_file():
    built = body_from_args(_args(
        note=PLAN["note"],
        add=["+p=text-input", "+wide=nano-banana", "+tight=nano-banana"],
        param=[["+p.value=a lighthouse at dusk"]],
        wire=[["+p:text", "+wide:prompt"], ["+p:text", "+tight:prompt"]],
        rename=["+wide=Wide", "+tight=Tight"],
    ), command="apply")
    assert built == PLAN


def test_builder_edits_existing_nodes():
    body = build_body(rename=["n4=", "n5=Hero shot"], move=["n4=400,120.5"], remove=["n7", "n8"],
                      unwire=[["n1:text", "n2:prompt"]], set_params=["n4.prompt=warmer"])
    assert body == {
        "note": "",
        "params": [{"nodeId": "n4", "params": {"prompt": "warmer"}}],
        "rename": {"n4": "", "n5": "Hero shot"},
        "move": {"n4": {"x": 400.0, "y": 120.5}},
        "remove": ["n7", "n8"],
        "unwire": [{"source": "n1", "sourceHandle": "text", "target": "n2", "targetHandle": "prompt"}],
    }
    for kwargs in ({"rename": ["n4"]}, {"rename": ["+ghost=x"]}, {"move": ["n4=1"]}, {"move": ["n4=a,b"]},
                   {"remove": ["+up"]}, {"unwire": [["n1", "n2:prompt"]]}):
        with pytest.raises(BuildError):
            build_body(**kwargs)


def test_flags_or_a_file_not_both():
    with pytest.raises(BuildError, match="not both"):
        body_from_args(_args(file="plan.json", remove=["n2"]), command="apply")


def test_a_plan_from_standard_input(api, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(PLAN)))
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(file="-", json=True), out=out) == 0
    result = json.loads(out.getvalue())
    assert result["status"] == "applied" and set(result["idMap"]) == {"+p", "+wide", "+tight"}


def test_one_plan_file_can_be_proposed_or_applied(api):
    shared = {key: PLAN[key] for key in ("note", "nodes", "edges")}
    path = _plan_file(api, shared)
    propose_args = argparse.Namespace(file=path, note=None, add=[], param=[], set_params=[], wire=[], run=[],
                                      at=[], wait=False, timeout=60.0, json=True, agent_name="Codex")

    assert proposals_cmd.run_propose(api.client, propose_args, out=io.StringIO()) == 0
    assert len(api.client.list_proposals()["proposals"]) == 1
    assert apply_cmd.run_apply(api.client, _args(file=path), out=io.StringIO()) == 0
    assert len(api.graph.nodes) == 3


def test_a_proposal_says_where_renames_and_removals_go(api, capsys):
    path = _plan_file(api, {"note": "tidy", "remove": ["n1"]})
    propose_args = argparse.Namespace(file=path, note=None, add=[], param=[], set_params=[], wire=[], run=[],
                                      at=[], wait=False, timeout=60.0, json=False, agent_name="Codex")
    assert proposals_cmd.run_propose(api.client, propose_args, out=io.StringIO()) == 1
    assert "a proposal can't remove; `nebula apply` edits the canvas directly" in capsys.readouterr().err
