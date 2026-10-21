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
import re

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
    from services.canvas_arrange import ArrangeBook

    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
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
    from services.canvas_undo import CanvasUndoBook

    monkeypatch.setattr(main_module, "canvas_undo_book", CanvasUndoBook())
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
                  remove=[], unwire=[], arrange=None, json=False, agent_name="Codex")
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
    assert lines[1:4] == ["  +p → n2  Text Input", "  +wide → n3  Wide", "  +tight → n4  Tight"]
    # The last line says how to take it back.
    assert re.fullmatch(r"  Undo: nebula undo [0-9a-f]{40}  \(for 60 minutes; parts changed since stay\)", lines[4])
    assert len(lines) == 5
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
                   {"remove": ["+up"]}, {"unwire": [["n1:", "n2:prompt"]]}):
        with pytest.raises(BuildError):
            build_body(**kwargs)
    # A bare end has no port: it goes without one, and the backend names the ports n1 has (PR26b review).
    assert build_body(unwire=[["n1", "n2:prompt"]])["unwire"] == [
        {"source": "n1", "target": "n2", "targetHandle": "prompt"}]


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


# -- plans of steps (decision C2) and arrange (C3) -------------------------------

STEPS = {
    "note": "Board, then takes",
    "steps": [
        {"nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse"}}]},
        {"note": "Two takes",
         "nodes": [{"ref": "+a", "definitionId": "combine-text"}, {"ref": "+b", "definitionId": "combine-text"}],
         "edges": [{"source": "+p", "sourceHandle": "text", "target": "+a", "targetHandle": "text1"},
                   {"source": "+p", "sourceHandle": "text", "target": "+b", "targetHandle": "text1"}],
         "rename": {"+p": "Prompt"}},
    ],
}


def test_a_later_step_wires_refs_an_earlier_step_created(api):
    api.graph.add_node("text-input", {"value": "keep"})
    out = io.StringIO()

    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, STEPS)), out=out) == 0

    lines = out.getvalue().splitlines()
    assert lines[0] == "Step 1 of 2. Applied: added 1."
    assert lines[1] == "  +p → n2  Text Input"
    assert lines[2] == "Step 2 of 2. Applied: added 2, wired 2, renamed 1."
    assert {(e["source"], e["target"]) for e in api.graph.edges} == {("n2", "n3"), ("n2", "n4")}
    assert api.graph.nodes["n2"]["label"] == "Prompt"


def test_a_refused_step_says_which_and_what_earlier_steps_applied(api, capsys):
    bad = {"steps": [STEPS["steps"][0], {**STEPS["steps"][1], "edges": [
        {"source": "+p", "sourceHandle": "text", "target": "+a", "targetHandle": "nope"}]}]}
    out = io.StringIO()

    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, bad)), out=out) == 1

    err = capsys.readouterr().err.splitlines()
    assert err[0].startswith("error: step 2 of 2 was refused, so it and the steps after it weren't applied: "
                             "Invalid target handle 'nope' on node '+a'")
    assert err[1] == "Step 1 was applied and stays on the canvas:"
    assert err[2] == "  step 1: added 1 (+p → n1)"
    assert err[3] == "To finish, fix step 2 and apply step 2 on their own, using the node ids above in place of those +refs."
    # Step 1 stayed; nothing of step 2 landed.
    assert list(api.graph.nodes) == ["n1"] and api.graph.edges == []


def test_a_refused_step_in_json(api):
    bad = {"steps": [{"remove": ["n9"]}, STEPS["steps"][0]]}
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, bad), json=True), out=out) == 1
    result = json.loads(out.getvalue())
    assert (result["status"], result["failedStep"], result["steps"], result["applied"]) == ("stopped", 1, 2, [])
    assert "n9 is not on the canvas" in result["error"]


def test_steps_in_json(api):
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, STEPS), json=True), out=out) == 0
    result = json.loads(out.getvalue())
    assert result["status"] == "applied" and len(result["steps"]) == 2
    assert result["idMap"] == {"+p": "n1", "+a": "n2", "+b": "n3"}


def test_a_steps_plan_is_checked_before_anything_is_sent(api, capsys, monkeypatch):
    sent = []
    monkeypatch.setattr(api.client, "apply_step", lambda body, agent_name=None: sent.append(body))
    for plan, words in (
        ({"steps": [{"edges": [{"source": "+ghost", "sourceHandle": "text", "target": "n1",
                                "targetHandle": "prompt"}]}]}, "step 1 uses +ghost"),
        ({"steps": [STEPS["steps"][0], STEPS["steps"][0]]}, "step 2 creates +p, which step 1 already created"),
        ({"steps": [{**STEPS["steps"][0], "run": ["+p"]}]}, "step 1 has run"),
        ({"steps": [{"steps": []}]}, "steps don't nest"),
        ({"steps": []}, "non-empty list"),
        ({"steps": [STEPS["steps"][0]], "nodes": []}, "holds only note and steps"),
        # These would be refused by the server only after step 1 had landed.
        ({"steps": [STEPS["steps"][0], {"note": "only a note"}]}, "step 2 changes nothing"),
        ({"steps": [STEPS["steps"][0], {"rename": {"+p": "P"}, "arrange": True}]},
         "step 2 has arrange but adds no nodes"),
    ):
        assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, plan))) == 1
        assert words in capsys.readouterr().err, plan
    assert sent == [] and api.graph.nodes == {}


def test_notes_fill_in_steps_without_one():
    path_note = {"note": "Board", "steps": [{"remove": ["n1"]}, {"note": "Mine", "remove": ["n2"]}]}
    from cli.plan import check_steps, resolve_step
    steps = check_steps(path_note)
    assert [step.get("note") for step in steps] == ["Board", "Mine"]
    assert [step.get("note") for step in check_steps(path_note, note="Flag")] == ["Flag", "Mine"]
    resolved = resolve_step({"nodes": [{"ref": "+x", "definitionId": "text-input"}],
                             "edges": [{"source": "+p", "sourceHandle": "text", "target": "+x", "targetHandle": "a"}],
                             "params": [{"nodeId": "+p", "params": {"value": "v"}}],
                             "rename": {"+p": "P", "+x": "X"}, "move": {"+p": {"x": 1, "y": 2}},
                             "remove": ["+q"], "unwire": [{"source": "+q", "target": "+p"}]},
                            {"+p": "n4", "+q": "n5", "+x": "n99"})
    assert resolved["edges"][0]["source"] == "n4" and resolved["edges"][0]["target"] == "+x"
    assert resolved["params"][0]["nodeId"] == "n4"
    assert resolved["rename"] == {"n4": "P", "+x": "X"} and resolved["move"] == {"n4": {"x": 1, "y": 2}}
    assert resolved["remove"] == ["n5"] and resolved["unwire"][0] == {"source": "n5", "target": "n4"}


def test_a_proposal_takes_one_plan_not_steps(api, capsys):
    path = _plan_file(api, STEPS)
    propose_args = argparse.Namespace(file=path, note=None, add=[], param=[], set_params=[], wire=[], run=[],
                                      at=[], wait=False, timeout=60.0, json=False, agent_name="Codex")
    assert proposals_cmd.run_propose(api.client, propose_args, out=io.StringIO()) == 1
    assert "send steps with `nebula apply`" in capsys.readouterr().err
    arranged = _plan_file(api, {key: PLAN[key] for key in ("note", "nodes", "edges")} | {"arrange": True})
    propose_args.file = arranged
    assert proposals_cmd.run_propose(api.client, propose_args, out=io.StringIO()) == 1
    assert "a proposal can't arrange" in capsys.readouterr().err


def test_arrange_from_the_builder_and_in_the_reply(api):
    assert build_body(add=["+a=text-input"], arrange="right")["arrange"] is True
    assert build_body(add=["+a=text-input"], arrange="down")["arrange"] == {"direction": "down"}
    with pytest.raises(BuildError, match="none"):
        build_body(remove=["n1"], arrange="right")
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(add=["+a=text-input", "+b=text-input"], arrange="right"),
                               out=out) == 0
    # The arrange line, then the undo line.
    assert out.getvalue().splitlines()[-2] == (
        "  Arrange: No canvas is open, so the 2 new nodes stay where they were placed. "
        "The first canvas that opens lays them out.")
    assert out.getvalue().splitlines()[-1].startswith("  Undo: nebula undo ")


def test_arrange_works_with_a_plan_file(api):
    plain = {key: PLAN[key] for key in ("note", "nodes", "edges")}
    assert body_from_args(_args(file=_plan_file(api, plain), arrange="down"), command="apply")["arrange"] == {
        "direction": "down"}
    assert "arrange" not in body_from_args(_args(file=_plan_file(api, plain)), command="apply")
    # With steps, arrange belongs to the step whose nodes it lays out.
    with pytest.raises(BuildError, match="in each step"):
        body_from_args(_args(file=_plan_file(api, STEPS), arrange="right"), command="apply")


# -- undo (U1): `nebula undo` takes an apply's token -------------------------------

def _undo_args(*tokens: str, json_out: bool = False) -> argparse.Namespace:
    return argparse.Namespace(tokens=list(tokens), json=json_out, agent_name="Codex")


def _applied_json(api, body: dict) -> dict:
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, body), json=True), out=out) == 0
    return json.loads(out.getvalue())


def test_nebula_undo_puts_an_apply_back(api):
    keep = api.graph.add_node("text-input", {"value": "keep"})
    applied = _applied_json(api, {**PLAN, "params": [{"nodeId": keep, "params": {"value": "changed"}}]})
    out = io.StringIO()
    assert apply_cmd.run_undo(api.client, _undo_args(applied["undo"]["token"]), out=out) == 0
    assert out.getvalue().splitlines()[0] == "Undone: removed 3, reset 1."
    assert list(api.graph.nodes) == [keep] and api.graph.nodes[keep]["params"]["value"] == "keep"


def test_nebula_undo_lists_what_it_left_as_is(api):
    keep = api.graph.add_node("text-input", {"value": "keep"})
    applied = _applied_json(api, {"params": [{"nodeId": keep, "params": {"value": "changed"}}],
                                  "nodes": [{"ref": "+n", "definitionId": "text-input"}]})
    api.graph.update_params(keep, {"value": "the person's"})
    out = io.StringIO()
    assert apply_cmd.run_undo(api.client, _undo_args(applied["undo"]["token"]), out=out) == 0
    lines = out.getvalue().splitlines()
    assert lines[0] == "Undone: removed 1."
    assert lines[1] == "  Left as is: n1's value changed since, left as is"
    assert api.graph.nodes[keep]["params"]["value"] == "the person's"


def test_nebula_undo_of_a_steps_plan_goes_newest_first_and_stops_at_a_refusal(api, capsys):
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, STEPS)), out=out) == 0
    last = out.getvalue().splitlines()[-1]
    match = re.fullmatch(r"Undo these 2 steps: nebula undo ([0-9a-f]{40}) ([0-9a-f]{40})", last)
    assert match
    newest, oldest = match.groups()
    assert apply_cmd.run_undo(api.client, _undo_args(newest, "f" * 40, oldest), out=io.StringIO()) == 1
    err = capsys.readouterr().err
    assert "token 2 of 3 was refused" in err and "Token 1 was undone" in err
    # Step 2 is undone; step 1's node stays, since the run stopped before its token.
    assert list(api.graph.nodes) == ["n1"]
    assert apply_cmd.run_undo(api.client, _undo_args(oldest), out=io.StringIO()) == 0
    assert api.graph.nodes == {}


def test_steps_json_lists_undo_tokens_newest_first(api):
    out = io.StringIO()
    assert apply_cmd.run_apply(api.client, _args(file=_plan_file(api, STEPS), json=True), out=out) == 0
    result = json.loads(out.getvalue())
    assert result["undo"]["tokens"] == [step["undo"]["token"] for step in reversed(result["steps"])]


def test_nebula_undo_json(api):
    applied = _applied_json(api, PLAN)
    out = io.StringIO()
    assert apply_cmd.run_undo(api.client, _undo_args(applied["undo"]["token"], json_out=True), out=out) == 0
    result = json.loads(out.getvalue())
    assert result["status"] == "undone" and len(result["removed"]) == 3
