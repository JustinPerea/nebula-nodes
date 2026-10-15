"""What agents and the CLI see for a route-table node: describe_node and
find_nodes in main.py, and `nebula info` (cli/formatter.py)."""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main  # noqa: E402
from cli.formatter import format_node_detail  # noqa: E402

TABLE = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())["definitions"]["routes-image"]
PRICING = json.loads((Path(__file__).parent / "fixtures" / "pricing_cases.json").read_text())


@pytest.fixture
def surfaces(monkeypatch):
    real_get, real_all = main.node_registry.get, main.node_registry.get_all
    monkeypatch.setattr(main.node_registry, "get",
                        lambda definition_id: TABLE if definition_id == TABLE["id"] else real_get(definition_id))
    monkeypatch.setattr(main.node_registry, "get_all", lambda: {**real_all(), TABLE["id"]: TABLE})
    # The pricing fixture's five-route entry, under this definition's id.
    table = {"currencies": PRICING["pricing"].get("currencies", {}),
             "nodes": {TABLE["id"]: PRICING["pricing"]["nodes"]["table"]}}
    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda: table)

    def with_keys(keys):
        monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": keys})
        return TestClient(main.app)
    return with_keys


def test_describe_node_lists_each_route(surfaces):
    body = surfaces({"FAL_KEY": "k"}).get(f"/api/agent/nodes/{TABLE['id']}").json()
    assert body["providerChoice"] == {"param": "_provider", "value": "auto", "resolved": "fal"}
    assert [route["id"] for route in body["routes"]] == ["bfl", "fal", "replicate", "openrouter", "krea"]
    by_id = {route["id"]: route for route in body["routes"]}
    assert by_id["bfl"]["maker"] is True and by_id["bfl"]["keySet"] is False
    assert by_id["fal"]["keySet"] is True and by_id["fal"]["name"] == "fal.ai"
    # Each route lists what it takes: the shared params and its own, as it
    # offers them (node_route.route_param_definitions).
    assert [param["key"] for param in by_id["bfl"]["params"]] == [
        "aspect_ratio", "resolution", "safety_tolerance", "grounding"]
    bfl_params = {param["key"]: param for param in by_id["bfl"]["params"]}
    fal_params = {param["key"]: param for param in by_id["fal"]["params"]}
    assert bfl_params["safety_tolerance"]["max"] == 4 and fal_params["safety_tolerance"]["max"] == 6
    assert "1.5k" in bfl_params["resolution"]["options"] and "1.5k" not in fal_params["resolution"]["options"]
    assert "grounding" not in fal_params
    assert by_id["krea"]["plan"] == "optional"
    assert by_id["bfl"]["price"] == {"usd": [0.03, 0.03]} and by_id["openrouter"]["price"] is None
    assert by_id["fal"]["priceUnconfirmed"] is True and "priceUnconfirmed" not in by_id["bfl"]
    assert all(route["block"] is None for route in body["routes"])
    assert "_provider" in body["providerNote"] and "propose_change" in body["providerNote"]
    # The legacy dual-route fields stay off a route-table node.
    for legacy in ("route", "fallback", "paramsDirect", "paramsFallback"):
        assert legacy not in body
    # Shared params only; the hidden _provider param isn't listed as a setting.
    assert [param["key"] for param in body["params"]] == ["aspect_ratio", "resolution", "safety_tolerance"]
    # The run is priced on the route Auto takes.
    assert body["price"]["atDefaultsUsd"] == [0.035, 0.035] and body["price"]["billedBy"] == "fal"


def test_describe_node_with_no_key_resolves_to_nothing(surfaces):
    body = surfaces({}).get(f"/api/agent/nodes/{TABLE['id']}").json()
    assert body["providerChoice"]["resolved"] is None
    assert body["price"]["atDefaultsUsd"] is None


def test_find_nodes_names_the_providers(surfaces):
    body = surfaces({"BFL_API_KEY": "k"}).get("/api/agent/nodes", params={"query": "fixture image"}).json()
    row = next(node for node in body["nodes"] if node["id"] == TABLE["id"])
    assert row["providers"] == ["bfl", "fal", "replicate", "openrouter", "krea"]
    assert row["price"] == {"usd": [0.03, 0.03]}
    veo = surfaces({}).get("/api/agent/nodes", params={"query": "veo-3", "ready_only": False}).json()
    assert all("providers" not in node for node in veo["nodes"])


def test_nebula_info_prints_one_line_per_route():
    text = format_node_detail(TABLE)
    assert "ROUTES (_provider" in text
    lines = [line for line in text.splitlines() if line.startswith("  ")]
    for route in ("bfl", "fal", "replicate", "openrouter", "krea"):
        assert any(line.strip().startswith(route) for line in lines), route
    assert "(maker)" in text and "Krea plan optional" in text
    assert "nebula propose" in text
    # Shared params and each route's own are all listed.
    for key in ("aspect_ratio", "resolution", "safety_tolerance", "grounding"):
        assert f"  {key}" in text, key
    # Under each route, what it takes that the PARAMS list doesn't say.
    assert "takes aspect_ratio auto|1:1|16:9; resolution 768sq|1k|2k|4k" in text
    assert "takes safety_tolerance 0-4; grounding" in text
