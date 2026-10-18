"""Who bills a run is the person's call: a route-table node's ``_provider``
and a Krea node's ``_kreaAuth`` (main._billing_choice and the guard behind
every agent edit, main._refuse_agent_billing_change)."""
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main  # noqa: E402
from services import canvas_edits, node_route  # noqa: E402

TABLE = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())["definitions"]["routes-image"]


@pytest.fixture
def agent(monkeypatch):
    real_get = main.node_registry.get
    monkeypatch.setattr(main.node_registry, "get",
                        lambda definition_id: TABLE if definition_id == TABLE["id"] else real_get(definition_id))
    monkeypatch.setattr(main, "_is_person_request", lambda: False)


def _refusal(changes) -> str | None:
    try:
        main._refuse_agent_billing_change(changes)
    except HTTPException as exc:
        assert exc.status_code == 403
        return str(exc.detail)
    return None


def test_billing_choice_reads_both_params(agent):
    assert main._billing_choice(TABLE["id"], {}) == ("auto", "api-token")
    assert main._billing_choice(TABLE["id"], {"_provider": "fal", "_kreaAuth": "mcp"}) == ("fal", "mcp")
    # A Krea node with both modes: no provider choice.
    assert main._billing_choice("krea-2-generate", {"_kreaAuth": "mcp"}) == ("", "mcp")
    # A node with neither choice.
    assert main._billing_choice("text-input", {}) is None


def test_an_agent_cant_switch_the_provider(agent):
    detail = _refusal([("n1", TABLE["id"], {}, {"_provider": "replicate"})])
    assert detail and "_provider" in detail and "propose_change" in detail
    # Back to Auto is a switch too.
    assert _refusal([("n1", TABLE["id"], {"_provider": "fal"}, {"_provider": "auto"})])
    # The same choice, spelled out, or another param, isn't.
    assert _refusal([("n1", TABLE["id"], {}, {"_provider": "auto", "seed": 3})]) is None
    assert _refusal([("n1", TABLE["id"], {"_provider": "fal"}, {"_provider": "fal", "seed": 3})]) is None


def test_a_new_node_must_start_on_auto_and_the_api_token(agent):
    assert _refusal([("+n", TABLE["id"], None, {})]) is None
    assert _refusal([("+n", TABLE["id"], None, {"_provider": "auto", "_kreaAuth": "api-token"})]) is None
    assert "_provider" in _refusal([("+n", TABLE["id"], None, {"_provider": "bfl"})])
    assert "_kreaAuth" in _refusal([("+n", TABLE["id"], None, {"_kreaAuth": "mcp"})])


def test_the_krea_mode_on_a_route_table_node_is_guarded_too(agent):
    detail = _refusal([("n1", TABLE["id"], {"_provider": "krea"}, {"_provider": "krea", "_kreaAuth": "mcp"})])
    assert detail and "_kreaAuth" in detail


def test_the_person_may_switch(agent, monkeypatch):
    monkeypatch.setattr(main, "_is_person_request", lambda: True)
    assert _refusal([("n1", TABLE["id"], {}, {"_provider": "replicate"})]) is None


def test_check_provider_takes_auto_or_a_route_id(agent):
    main._check_provider(TABLE["id"], {"_provider": "auto"}, "n1")
    main._check_provider(TABLE["id"], {"_provider": "openrouter"}, "n1")
    main._check_provider(TABLE["id"], {"seed": 1}, "n1")
    with pytest.raises(HTTPException) as bad:
        main._check_provider(TABLE["id"], {"_provider": "google"}, "n1")
    assert bad.value.status_code == 400 and "auto, bfl, fal, replicate, openrouter, krea" in bad.value.detail
    with pytest.raises(HTTPException) as legacy:
        main._check_provider("veo-3", {"_provider": "fal"}, "n2")
    assert legacy.value.status_code == 400 and "left out" in legacy.value.detail


def test_proposals_and_edits_may_carry_both_billing_params():
    assert canvas_edits.INTERNAL_OK == frozenset(node_route.BILLING_PARAMS) == {"_provider", "_kreaAuth"}


def test_a_run_never_writes_billing_params_back(monkeypatch, tmp_path):
    from models.graph import GraphNode
    from services.cli_graph import CLIGraph

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    monkeypatch.setattr(main, "cli_graph", graph)
    node_id = graph.add_node("nano-banana", {"prompt": "a", "_provider": "auto"})
    ran = GraphNode(id=node_id, definitionId="nano-banana",
                    params={"prompt": "a", "_provider": "fal", "_kreaAuth": "mcp"}, outputs={})
    main._sync_params_to_cli_graph([ran], submitted={node_id: dict(ran.params)})
    assert graph.nodes[node_id]["params"].get("_provider") == "auto"
    assert "_kreaAuth" not in graph.nodes[node_id]["params"]


def test_cost_for_names_the_route_the_run_takes(agent):
    from services.canvas_proposals import cost_for

    assert cost_for(TABLE, {}, None, {"FAL_KEY": "set"})["provider"] == "fal"
    assert cost_for(TABLE, {"_provider": "replicate"}, None, {"REPLICATE_API_TOKEN": "s"})["provider"] == "replicate"
    blocked = cost_for(TABLE, {"_provider": "replicate"}, None, {"FAL_KEY": "set"})
    assert blocked["provider"] is None and "REPLICATE_API_TOKEN" in blocked["unavailable"]
    # Without keys: the explicit route, or the maker under Auto.
    assert cost_for(TABLE, {"_provider": "krea"})["provider"] == "krea"
    assert cost_for(TABLE, {})["provider"] == "bfl"
