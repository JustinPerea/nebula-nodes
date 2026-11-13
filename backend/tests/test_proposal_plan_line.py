"""The proposal card's plan line (GM - Design, 2026-11-01: the canvas proposal
card redesign). One line under the agent's note says what Accept changes and
costs, by node name and never by id; the view carries it as `plan`, so the
card, `nebula proposal` and MCP read the same words."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cli.formatter import format_proposal
from services import money
from services.canvas_proposals import billed_to, change_count, plan_groups, plan_line
from tests.test_canvas_proposals import _propose, api  # noqa: F401 - the shared fixture

ROOT = Path(__file__).resolve().parents[2]
CHIPS = json.loads((ROOT / "contracts" / "fixtures" / "money" / "chips.json").read_text())["chip"]


@pytest.mark.parametrize("row", CHIPS, ids=lambda row: f"{row['low']}-{row['high']}-{row['open']}")
def test_chip_label_matches_the_cards_chip(row):
    high = row["high"] if row["high"] is not None else float("nan")
    assert money.chip_label(row["low"], high, row["open"]) == row["text"]


def _view(**over):
    view = {"nodes": [], "edges": [], "params": [], "run": [],
            "cost": {"paidRuns": 0, "freeRuns": 0, "estimate": None, "upTo": False, "nodes": []}}
    cost = over.pop("cost", {})
    view.update(over)
    view["cost"] = {**view["cost"], **cost}
    return view


def _entry(ref, name, *, paid=True, model="Krea 2", billed="your Krea plan", node_id=None):
    return {"ref": ref, "nodeId": node_id, "kind": "paid" if paid else "free", "name": name,
            "model": model, "billedTo": billed if paid else None}


HERO = {"nodeId": "n4", "name": "Hero shot (n4)", "title": "Hero shot", "model": "Krea 2",
        "changes": {"aspect_ratio": {"from": "16:9", "to": "1:1"}}}


def test_change_and_run_the_same_node_reads_as_one_clause():
    view = _view(params=[HERO], run=["n4"],
                 cost={"paidRuns": 1, "nodes": [_entry("n4", "Hero shot", node_id="n4")]})
    assert plan_line(view) == "Changes and runs “Hero shot” · Krea 2 on your Krea plan · no list price"


def test_run_only_names_the_canvas_node_never_its_id():
    view = _view(run=["n4"], cost={"paidRuns": 1, "estimate": {"low": 0.03, "high": 0.03, "open": False},
                                   "nodes": [_entry("n4", "Hero shot", model="GPT Image 2",
                                                    billed="your OpenAI key", node_id="n4")]})
    line = plan_line(view)
    assert line == "Runs “Hero shot” · GPT Image 2 on your OpenAI key · ~$0.03"
    assert "n4" not in line


def test_change_one_run_another():
    prompt = {"nodeId": "n2", "name": "Prompt (n2)", "title": "Prompt", "changes": {"value": {"from": "a", "to": "b"}}}
    view = _view(params=[prompt], run=["n4"], cost={
        "paidRuns": 1, "freeRuns": 1, "upTo": True, "estimate": {"low": 0, "high": 0.43, "open": False},
        "nodes": [_entry("n2", "Prompt", paid=False, node_id="n2"), _entry("n4", "Hero shot", node_id="n4")]})
    assert plan_line(view) == "Changes “Prompt”, runs “Hero shot” · Krea 2 on your Krea plan · Up to $0.43"


def test_runs_say_their_class_paid_plan_may_cost_never_free():
    """GM, PR #203 r11 item 2, r19 item 1 (the frontend's old line 1, now the backend's)."""
    entries = [_entry("a", "A", model="GPT Image 2", billed="your OpenAI key"),
               _entry("b", "B", model="GPT Image 2", billed="your OpenAI key"),
               _entry("+k", "Krea 2")]
    mixed = _view(run=["a", "b", "+k"], nodes=[{"ref": "+k", "name": "Krea 2"}],
                  cost={"paidRuns": 2, "planRuns": 1, "nodes": entries})
    assert plan_line(mixed) == "Adds and runs “Krea 2”, runs “A” and “B” · 2 paid runs · 1 on your Krea plan · no list price"
    plan_only = _view(run=["+k"], cost={"paidRuns": 0, "planRuns": 1, "nodes": [entries[2]]})
    assert plan_line(plan_only) == "Runs “Krea 2” · Krea 2 on your Krea plan · no list price"
    may = _view(run=["n1"], cost={"mayCostRuns": 1, "mayCost": [{"name": "Idol", "account": "Hugging Face"}]})
    assert "free" not in plan_line(may) and "Hugging Face" in plan_line(may)


def test_adds_with_connections_and_counts_from_four():
    one = _view(nodes=[{"ref": "+k", "name": "Krea 2"}], edges=[{}])
    assert plan_line(one) == "Adds “Krea 2” and 1 connection · nothing runs until you choose"
    three = _view(nodes=[{"ref": f"+{i}", "name": f"N{i}"} for i in range(3)], edges=[{}, {}])
    # GM - Design, PR #216 r4: the connections close the list of the nodes added.
    assert plan_line(three) == "Adds “N0”, “N1”, “N2” and 2 connections · nothing runs until you choose"
    four = _view(params=[{**HERO, "nodeId": f"n{i}", "title": f"T{i}"} for i in range(4)])
    assert plan_line(four) == "Changes 4 nodes · nothing runs until you choose"


def test_adds_and_runs_the_new_node():
    view = _view(nodes=[{"ref": "+k", "name": "Krea 2"}], edges=[{}], run=["+k"], cost={
        "paidRuns": 1, "estimate": {"low": 0.07, "high": 0.07, "open": True},
        "nodes": [_entry("+k", "Krea 2", billed="your Krea API key")]})
    # GM - Design, PR #216 r3: the verbs merge onto the node, and "plus" carries the connections.
    assert plan_line(view) == "Adds and runs “Krea 2” plus 1 connection · Krea 2 on your Krea API key · $0.07 + unpriced"


def test_an_add_a_change_and_a_run_never_take_a_serial_comma():
    """GM - Design, PR #216 r1 and r3: the same node changed and run is one
    group, whatever else is added; groups join with ", ", and a name list
    never has a serial comma."""
    alt = {"nodeId": "n3", "name": "Alt still (n3)", "title": "Alt still", "model": "GPT Image 2",
           "changes": {"quality": {"from": None, "to": "high"}}}
    cost = {"paidRuns": 1, "estimate": {"low": 0.16, "high": 0.16, "open": False},
            "nodes": [_entry("n3", "Alt still", model="GPT Image 2", billed="your OpenAI key", node_id="n3")]}
    merged = _view(nodes=[{"ref": "+t", "name": "Second take"}], edges=[{}, {}], params=[alt], run=["n3"], cost=cost)
    assert plan_line(merged) == ("Adds “Second take” and 2 connections, changes and runs “Alt still”"
                                 " · GPT Image 2 on your OpenAI key · ~$0.16")
    three = _view(nodes=[{"ref": "+t", "name": "Second take"}], params=[{**alt, "nodeId": "n2", "title": "Prompt"}],
                  run=["n3"], cost=cost)
    assert plan_line(three) == ("Adds “Second take”, changes “Prompt”, runs “Alt still”"
                                " · GPT Image 2 on your OpenAI key · ~$0.16")
    assert ", and " not in plan_line(merged) + plan_line(three)


def test_several_paid_runs_are_a_count_and_free_runs_say_free():
    view = _view(run=["n4", "n5"], cost={"paidRuns": 3, "upTo": True, "nodes": [
        _entry("n4", "A", node_id="n4"), _entry("n5", "B", node_id="n5"), _entry("n3", "C", node_id="n3")]})
    # The chip's "Up to" carries a run that may be skipped (GM - Design, PR #216 r3).
    assert plan_line(view) == "Runs “A” and “B” · 3 paid runs · no list price"
    free = _view(run=["n4"], cost={"freeRuns": 1, "nodes": [_entry("n4", "Upscale", paid=False, node_id="n4")]})
    assert plan_line(free) == "Runs “Upscale” · free"


def _waiting(**cost):
    return _view(nodes=[{"ref": "+c", "name": "Combine Text"}], run=["+c"], cost={"nodes": [], **cost})


def test_a_run_waiting_on_placeholders_keeps_its_words():
    """GM - Design, round 4: "runs nothing until Codex finishes 2 nodes", or
    "agents finish" for several; review 4, M2: it counts the placeholders
    themselves (`placeholders`), and a backend without that count keeps `count`.
    Moved here from the canvas's own tests with the line (2026-11-01)."""
    assert plan_line(_waiting(pendingSkipped={"count": 2, "placeholders": 1, "agents": ["Codex"]})) == (
        "Adds “Combine Text” · runs nothing until Codex finishes 1 node")
    assert plan_line(_waiting(pendingSkipped={"count": 2, "agents": ["Codex"]})) == (
        "Adds “Combine Text” · runs nothing until Codex finishes 2 nodes")
    assert plan_line(_waiting(pendingSkipped={"count": 3, "agents": ["Codex", "Cursor"]})) == (
        "Adds “Combine Text” · runs nothing until agents finish 3 nodes")
    # Something still runs: the run's own words.
    assert plan_line(_waiting(freeRuns=1, pendingSkipped={"count": 2, "agents": ["Codex"]})) == (
        "Adds and runs “Combine Text” · free")


def test_a_paid_run_no_provider_can_take_names_only_the_model():
    view = _view(run=["n4"], cost={"paidRuns": 1, "nodes": [_entry("n4", "Hero shot", billed=None, node_id="n4")]})
    assert plan_line(view) == "Runs “Hero shot” · Krea 2 · no list price"


def test_billed_to_names_who_pays():
    import main

    definitions = main.node_registry.get_all()
    krea = definitions["krea-2-generate"]
    paid = {"kind": "paid", "provider": "krea"}
    assert billed_to(krea, {"_kreaAuth": "mcp"}, paid) == "your Krea plan"
    assert billed_to(krea, {"_kreaAuth": "api-token"}, paid) == "your Krea API key"
    assert billed_to(definitions["gpt-image-2-generate"], {}, {"kind": "paid", "provider": "openai"}) == "your OpenAI key"
    assert billed_to(krea, {}, {"kind": "free", "provider": None}) is None
    assert billed_to(krea, {"_kreaAuth": "api-token"}, {"kind": "paid", "provider": None}) is None


def test_the_view_card_cli_and_mcp_read_the_same_names(api):  # noqa: F811 - pytest fixture
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token", "prompt": "chrome"})
    api.graph.set_label(node_id, "Hero shot")
    response = _propose(api, {"note": "One image at 1:1 first",
                              "params": [{"nodeId": node_id, "params": {"_kreaAuth": "mcp", "aspect_ratio": "1:1"}}],
                              "run": [node_id]})
    assert response.status_code == 201, response.text
    view = response.json()["proposal"]
    assert view["plan"].startswith("Changes and runs “Hero shot” · Krea 2 on your Krea plan · ")
    assert node_id not in view["plan"]
    change = view["params"][0]
    assert (change["title"], change["model"]) == ("Hero shot", "Krea 2")
    entry = view["cost"]["nodes"][0]
    assert (entry["name"], entry["model"], entry["billedTo"]) == ("Hero shot", "Krea 2", "your Krea plan")
    # The CLI prints the card's line word for word, beside its own id lines.
    assert f"  card     {view['plan']}" in format_proposal(view).splitlines()
    # The not-ready line names the node in curly quotes (GM - Design, PR #216 r1).
    assert view["cost"]["notReady"][0]["person"] == "“Hero shot” needs your Krea plan. Sign in to Krea in Settings."
    # get_proposal (MCP) and the HTTP read return the same view.
    again = api.client.get(f"/api/canvas/proposals/{view['id']}", headers={"X-Nebula-Agent": "Claude Code"})
    assert again.json()["proposal"]["plan"] == view["plan"]


def test_the_api_token_not_ready_line_quotes_the_name_too(api):  # noqa: F811 - pytest fixture
    node_id = api.graph.add_node("gpt-image-2-generate", {})
    api.graph.set_label(node_id, "Alt still")
    response = _propose(api, {"note": "Try it", "params": [{"nodeId": node_id, "params": {"quality": "high"}}],
                              "run": [node_id]})
    assert response.status_code == 201, response.text
    row = response.json()["proposal"]["cost"]["notReady"][0]
    assert row["person"] == "“Alt still” needs your OpenAI API key. Add it in Settings."
    # Agents keep find_nodes' words.
    assert row["missing"].startswith("needs ")


def test_mcp_reads_the_plan_and_every_field_it_is_made_from(api, monkeypatch):  # noqa: F811 - pytest fixture
    """Every feature ships for agents (Justin's standing rule): propose_change
    and get_proposal return `plan`, and it is derivable from the fields beside
    it (names, models, payers, the estimate)."""
    import httpx

    import mcp_server

    def through_the_app(method, url, *, headers, timeout, **kwargs):
        path = url.split("://", 1)[1].split("/", 1)[1]
        response = api.client.request(method, f"/{path}", headers=headers, **{
            key: value for key, value in kwargs.items() if key in ("json", "params")})
        return httpx.Response(response.status_code, json=response.json(), request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", through_the_app)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token"})
    api.graph.set_label(node_id, "Hero shot")
    created = mcp_server.propose_change("One image at 1:1 first",
                                        params=[{"nodeId": node_id, "params": {"_kreaAuth": "mcp"}}], run=[node_id])
    view = created["proposal"]
    assert view["plan"] == "Changes and runs “Hero shot” · Krea 2 on your Krea plan · no list price"
    entry = view["cost"]["nodes"][0]
    assert {"name", "model", "billedTo"} <= set(entry)
    assert {"title", "model"} <= set(view["params"][0])
    read = mcp_server.get_proposal(view["id"])["proposal"]
    assert read["plan"] == view["plan"]
    assert plan_line({key: value for key, value in read.items() if key != "plan"}) == read["plan"]


def test_a_route_line_names_the_node_in_curly_quotes():
    """node_route.route_unavailable_line starts with the model's name; the
    card names the node, quoted (GM - Design, PR #216 r1)."""
    import main

    flux = {"displayName": "FLUX 3"}
    assert main._quoted_name_line("FLUX 3 can't run on BFL: no key. Add it in Settings.", "Hero shot", flux) == (
        "“Hero shot” can't run on BFL: no key. Add it in Settings.")
    assert main._quoted_name_line("“Hero shot” needs your Krea account.", "Hero shot", flux) == (
        "“Hero shot” needs your Krea account.")
    assert main._quoted_name_line("needs a key", "Hero shot", flux) == "needs a key"


# -- round 3 (GM - Design, PR #216 r3; review 1 M1, L1-L3, N1) ---------------

KREA = {"nodeId": "n4", "name": "Krea 2 (n4)", "title": "Krea 2", "model": "Krea 2",
        "changes": {"model": {"from": "a", "to": "b"}}}


def _removed(count):
    return [{"source": f"n{i}", "sourceHandle": "image", "target": "n4", "targetHandle": "images",
             "sourceName": f"Photo {i}", "targetName": "Krea 2", "targetLabel": "Images"} for i in range(count)]


def test_gm_r3_examples_word_for_word():
    one_paid = {"paidRuns": 1, "nodes": [_entry("n4", "Krea 2", node_id="n4")]}
    # 4: the verbs merge onto the node; "plus" carries connections, "and" when it doesn't run.
    adds = _view(nodes=[{"ref": "+a", "name": "A"}], edges=[{}], run=["+a"], cost={"freeRuns": 1})
    assert plan_line(adds) == "Adds and runs “A” plus 1 connection · free"
    assert plan_line({**adds, "run": []}) == "Adds “A” and 1 connection · nothing runs until you choose"
    # 5
    both = _view(params=[KREA], run=["n4", "n5"], names={"n4": "Krea 2", "n5": "GPT Image 2"},
                 cost={"paidRuns": 2, "nodes": [_entry("n4", "Krea 2", node_id="n4"),
                                                _entry("n5", "GPT Image 2", node_id="n5")]})
    assert plan_line(both) == "Changes and runs “Krea 2”, runs “GPT Image 2” · 2 paid runs · no list price"
    # 9: removals close the line.
    swap = _view(params=[KREA], run=["n4"], removedEdges=_removed(2), cost=one_paid)
    assert plan_line(swap) == ("Changes and runs “Krea 2”, removes 2 connections"
                               " · Krea 2 on your Krea plan · no list price")


def test_nodes_merge_by_id_never_by_name():
    """GM - Design, PR #216 r3 (6): another node with a name already said
    reads "another “Image”"; two in one group, "2 “Image” nodes"; no model."""
    image = {**KREA, "nodeId": "n2", "title": "Image", "model": "GPT Image 2"}
    another = _view(params=[image], run=["n7"], names={"n2": "Image", "n7": "Image"},
                    cost={"freeRuns": 1, "nodes": [_entry("n7", "Image", paid=False, node_id="n7")]})
    assert plan_line(another) == "Changes “Image”, runs another “Image” · free"
    two = _view(run=["n7", "n8"], names={"n7": "Image", "n8": "Image"}, cost={"freeRuns": 2})
    assert plan_line(two) == "Runs 2 “Image” nodes · free"
    assert "GPT Image 2" not in plan_line(another)


def test_adds_two_runs_one():
    """Review 1 L1 (mutant B2): the run names the node it runs, not both
    (GM - Design, PR #216 r4: "runs “A”" after the nodes added)."""
    view = _view(nodes=[{"ref": "+a", "name": "A"}, {"ref": "+b", "name": "B"}], run=["+a"], cost={"freeRuns": 1})
    assert plan_line(view) == "Adds “A” and “B”, runs “A” · free"


def test_an_unnamed_run_target_never_reads_none_or_turns_the_rest_into_a_count():
    """Review 1 L1 (mutant B4) and L3."""
    view = _view(params=[KREA], run=["n4", "n9"], cost={"freeRuns": 2})
    line = plan_line(view)
    assert line == "Changes and runs “Krea 2”, runs 1 node · free"
    assert "None" not in line
    named = _view(run=["n3", "n9"], names={"n3": "Prompt"}, cost={"freeRuns": 2})
    assert plan_line(named) == "Runs “Prompt” and 1 more node · free"


def test_a_change_whose_run_waits_on_placeholders_never_says_changes_and_runs():
    """Review 1 L1 (mutant B11)."""
    view = _view(params=[KREA], run=["n4"], cost={"pendingSkipped": {"count": 1, "agents": ["Codex"]}})
    assert plan_line(view) == "Changes “Krea 2” · runs nothing until Codex finishes 1 node"


def test_a_name_in_quotes_is_quoted_once():
    """Review 1 N1."""
    view = _view(params=[{**KREA, "title": "“Hero”"}])
    assert plan_line(view) == "Changes “Hero” · nothing runs until you choose"
    # Review 3 NIT-3: only quotes that wrap a name come off; its own
    # apostrophe stays, as on the card (cardQuoted).
    assert plan_line(_view(params=[{**KREA, "title": "Artists'"}])) == "Changes “Artists'” · nothing runs until you choose"
    assert plan_line(_view(params=[{**KREA, "title": "'90s look"}])) == "Changes “'90s look” · nothing runs until you choose"


def test_a_name_with_and_in_it_keeps_the_groups_comma():
    view = _view(params=[{**KREA, "title": "Salt and pepper"}], run=["n5"], names={"n5": "C"}, cost={"freeRuns": 1})
    assert plan_line(view) == "Changes “Salt and pepper”, runs “C” · free"


def _unquoted(group: str) -> str:
    """The group with each quoted name as one word. No other rewrite: the
    merged verb's "and" counts too (review 2 L1)."""
    import re

    return re.sub(r"“[^”]*”", "Q", group)


def test_no_group_holds_two_ands_outside_quoted_names():
    """Review 1 M1: every combination of adds, changes, runs, connections and
    removals, up to four nodes each."""
    import itertools

    checked = 0
    for added, changed, run_added, run_changed, run_other, edges, removed in itertools.product(
            range(4), range(4), range(3), range(3), range(3), range(3), range(3)):
        nodes = [{"ref": f"+{i}", "name": f"New {i} and more"} for i in range(added)]
        params = [{**KREA, "nodeId": f"n{i}", "title": f"Old {i}"} for i in range(changed)]
        run = [f"+{i}" for i in range(min(run_added, added))] + [f"n{i}" for i in range(min(run_changed, changed))]
        run += [f"n{50 + i}" for i in range(run_other)]
        view = _view(nodes=nodes, params=params, run=run, edges=[{}] * edges, removedEdges=_removed(removed),
                     names={f"n{50 + i}": f"Other {i}" for i in range(run_other)},
                     cost={"freeRuns": len(run)})
        for group in plan_groups(view):
            # The merged verb's own "and" ("Adds and runs") counts (review 2 L1).
            assert _unquoted(group).count(" and ") <= 1, (group, view)
            checked += 1
    assert checked > 1000


def test_change_count_counts_every_operation():
    """GM - Design, PR #216 r2-r3: node added, node changed, connection added,
    connection removed are one each; field lines don't count."""
    from services.canvas_proposals import ParamChange, ProposalSpec, ProposedEdge, ProposedNode

    spec = ProposalSpec(note="x", nodes=(ProposedNode(ref="+a", definition_id="text-input", params={"a": 1, "b": 2}, position=None),),
                        edges=(ProposedEdge("+a", "text", "n1", "prompt"),),
                        params=(ParamChange("n1", {"a": 1, "b": 2, "c": 3}),))
    assert change_count(spec) == 3
    assert change_count(spec, removed=2) == 5


def test_a_name_is_quoted_only_where_the_line_starts_with_the_model():
    """Review 1 L2: the node's own name is no lead, so a line that starts
    with a word that happens to be the node's name is left alone."""
    import main

    gpt = {"displayName": "GPT Image 2"}
    line = "Add your OpenAI API key in Settings, then run the node again."
    assert main._quoted_name_line(line, "Add", gpt) == line
    assert main._quoted_name_line("This node is set to OpenAI.", "This", {"displayName": ""}) == (
        "This node is set to OpenAI.")


def test_a_route_line_takes_the_nodes_name_in_place_of_the_model():
    """Review 1 L2's structural fix: route_unavailable_line names the node
    itself when given its name, so nothing has to match a prefix."""
    from services import node_route
    from tests.test_node_route import CASES, _definition

    checked = 0
    for case in CASES["cases"]:
        definition = _definition(case["nodeId"])
        if not node_route.has_routes(definition) or not case.get("unavailableLine"):
            continue
        params = node_route.with_wired_blockers(definition, case["params"], case.get("wiredCounts") or case.get("wired", ()))
        # The card names the node by its type, in quotes (GM, PR #203 r32);
        # given the node's own name (quoted by the function) it names that.
        model = str(definition.get("displayName") or "")
        plain = node_route.route_unavailable_line(definition, params, case["apiKeys"]) or ""
        if not plain.startswith(f"“{model}” "):
            continue
        named = node_route.route_unavailable_line(definition, params, case["apiKeys"], name="Hero shot")
        assert named == "“Hero shot”" + plain[len(model) + 2:]
        checked += 1
    assert checked > 0


# -- round 3b (GM - Design, PR #216 r4; review 2 L1, L2) ---------------------

def _new(*names):
    return [{"ref": f"+{name.lower()}", "name": name} for name in names]


def test_gm_r4_added_nodes_that_all_run():
    """GM r4 1: every added node also runs → "runs both", "runs all 3", and
    from 4 a count; one added node keeps "Adds and runs"."""
    two = _view(nodes=_new("A", "B"), edges=[{}], run=["+a", "+b"], cost={"freeRuns": 2})
    assert plan_line(two) == "Adds “A”, “B” and 1 connection, runs both · free"
    three = _view(nodes=_new("A", "B", "C"), edges=[{}], run=["+a", "+b", "+c"], cost={"freeRuns": 3})
    assert plan_line(three) == "Adds “A”, “B”, “C” and 1 connection, runs all 3 · free"
    four = _view(nodes=_new("A", "B", "C", "D"), edges=[{}], run=["+a", "+b", "+c", "+d"], cost={"freeRuns": 4})
    assert plan_line(four) == "Adds 4 nodes and 1 connection, runs all 4 · free"
    one = _view(nodes=_new("A"), edges=[{}], run=["+a"], cost={"freeRuns": 1})
    assert plan_line(one) == "Adds and runs “A” plus 1 connection · free"
    # No connection: the names alone.
    assert plan_line({**two, "edges": []}) == "Adds “A” and “B”, runs both · free"


def test_gm_r4_only_some_added_nodes_run():
    """GM r4 1: "If only some added nodes run, name them"."""
    view = _view(nodes=_new("A", "B"), edges=[{}], run=["+a"], cost={"freeRuns": 1})
    assert plan_line(view) == "Adds “A”, “B” and 1 connection, runs “A” · free"
    # A name that doesn't tell them apart is a count of them.
    same = _view(nodes=[{"ref": "+x", "name": "Image"}, {"ref": "+y", "name": "Image"}], run=["+x"],
                 cost={"freeRuns": 1})
    assert plan_line(same) == "Adds 2 “Image” nodes, runs 1 of them · free"
    many = _view(nodes=_new("A", "B", "C", "D", "E"), run=["+a", "+b"], cost={"freeRuns": 2})
    assert plan_line(many) == "Adds 5 nodes, runs “A” and “B” · free"


def test_gm_r4_changed_nodes_that_run_follow_the_same_rule():
    """Review 2 L1: no merged verb before two names ("Changes and runs “A”
    and “B”"), so no group says "and" twice."""
    params = [{**KREA, "nodeId": "n1", "title": "A"}, {**KREA, "nodeId": "n2", "title": "B"}]
    both = _view(params=params, run=["n1", "n2"], cost={"freeRuns": 2})
    assert plan_line(both) == "Changes “A” and “B”, runs both · free"
    one = _view(params=params, run=["n1"], cost={"freeRuns": 1})
    assert plan_line(one) == "Changes “A” and “B”, runs “A” · free"


def test_other_runs_join_the_run_named_last():
    """One "runs" per line end: the other nodes it runs join the last run
    clause ("both plus", or one list of names)."""
    params = [{**KREA, "nodeId": "n1", "title": "A"}, {**KREA, "nodeId": "n2", "title": "B"}]
    both = _view(params=params, run=["n1", "n2", "n9"], names={"n9": "C"}, cost={"freeRuns": 3})
    assert plan_line(both) == "Changes “A” and “B”, runs both plus “C” · free"
    some = _view(params=params, run=["n1", "n9"], names={"n9": "C"}, cost={"freeRuns": 2})
    assert plan_line(some) == "Changes “A” and “B”, runs “A” and “C” · free"
    # After a single merged group the other runs keep their own group (GM r3 5).
    single = _view(params=params[:1], run=["n1", "n9"], names={"n9": "C"}, cost={"freeRuns": 2})
    assert plan_line(single) == "Changes and runs “A”, runs “C” · free"
    # Added nodes that run, then changed ones that don't: the other runs get their own group.
    mixed = _view(nodes=_new("X", "Y"), params=params[:1], run=["+x", "+y", "n9"], names={"n9": "C"},
                  cost={"freeRuns": 3})
    assert plan_line(mixed) == "Adds “X” and “Y”, runs both, changes “A”, runs “C” · free"


def test_gm_r4_another_after_a_count_and_every_group_keeps_its_verb():
    """GM r4 2: "Keep "another" after a count; every group keeps its verb".
    The groups keep r3's order (changes before other runs), so GM's example
    "Runs 2 “Image” nodes, changes another “Image”" reads with the change first."""
    params = [{**KREA, "nodeId": "n1", "title": "Image"}, {**KREA, "nodeId": "n2", "title": "Image"}]
    view = _view(params=params, run=["n7"], names={"n7": "Image"}, cost={"freeRuns": 1})
    assert plan_line(view) == "Changes 2 “Image” nodes, runs another “Image” · free"
    two_others = _view(params=params[:1], run=["n7", "n8"], names={"n7": "Image", "n8": "Image"},
                       cost={"freeRuns": 2})
    assert plan_line(two_others) == "Changes “Image”, runs 2 other “Image” nodes · free"


def test_l2_a_group_that_counted_its_nodes_said_no_name():
    """Review 2 L2: "Adds 4 nodes, runs another “Image”" pointed back at a
    name the reader never saw."""
    nodes = [{"ref": "+a", "name": "Image"}, *_new("B", "C", "D")]
    view = _view(nodes=nodes, run=["n7"], names={"n7": "Image"}, cost={"freeRuns": 1})
    assert plan_line(view) == "Adds 4 nodes, runs “Image” · free"


def test_a_quoted_name_is_quoted_once_in_the_not_ready_line(api):  # noqa: F811 - pytest fixture
    """Review 2 L4: the plan line's rule for the card's other lines."""
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token"})
    api.graph.set_label(node_id, "“Hero shot”")
    response = _propose(api, {"note": "Try it", "params": [{"nodeId": node_id, "params": {"_kreaAuth": "mcp"}}],
                              "run": [node_id]})
    assert response.status_code == 201, response.text
    view = response.json()["proposal"]
    assert view["cost"]["notReady"][0]["person"] == "“Hero shot” needs your Krea plan. Sign in to Krea in Settings."
    assert view["plan"].startswith("Changes and runs “Hero shot” · ")
    import main

    assert main._quoted_name_line("FLUX 3 can't run here.", "'Hero'", {"displayName": "FLUX 3"}) == "“Hero” can't run here."
