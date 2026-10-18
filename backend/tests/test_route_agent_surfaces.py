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


def test_saving_accepts_every_route_s_params(surfaces):
    """Values stay flat in node.params, so a save takes any route's params,
    even ones the shown route doesn't offer (route_block decides at run time)."""
    surfaces({})
    valid = main._valid_param_keys(TABLE["id"])
    assert {"aspect_ratio", "resolution", "safety_tolerance", "grounding", "_provider", "_kreaAuth"} <= valid
    main._validate_params(TABLE["id"], {"_provider": "fal", "resolution": "1.5k", "grounding": True})


# -- what each provider offers: describe_node, MODEL_REFERENCE.md and the card agree --

ROOT = Path(__file__).resolve().parents[2]
ROUTE_TABLES = json.loads((Path(__file__).parent / "fixtures" / "route_tables.json").read_text())["nodes"]
REGISTRY = json.loads((ROOT / "backend" / "data" / "node_definitions.json").read_text())
ROUTE_TABLE_NODES = sorted(node_id for node_id, definition in REGISTRY.items() if definition.get("routes"))


@pytest.fixture
def real_nodes(monkeypatch):
    """describe_node over the real registry and pricing, with no key set."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    return TestClient(main.app)


def _shown_on_card(definition, params):
    """route_tables.json's routeParams for one route (directRoute.ts
    routeParamDefinitions, frontend/tests/lib/routeTables.test.ts) less what
    no card lists: the switcher's `_` params and editor-managed hidden ones."""
    hidden = {str(p.get("key")) for p in main.node_route.all_param_definitions(definition) if p.get("hidden")}
    return [p for p in params if not p["key"].startswith("_") and p["key"] not in hidden]


def _comparable(param):
    """A param as all three surfaces must agree on it: key, option values,
    range, and the values it is shown under."""
    out = {"key": param["key"]}
    if param.get("options") is not None:
        values = [option.get("value") if isinstance(option, dict) else option for option in param["options"]]
        out["options"] = [json.dumps(value) if not isinstance(value, str) else value for value in values]
    for bound in ("min", "max"):
        if param.get(bound) is not None:
            out[bound] = param[bound]
    when = param.get("visibleWhen", param.get("onlyWhen"))
    if when:
        out["when"] = {key: [json.dumps(v) if not isinstance(v, str) else v for v in values]
                       for key, values in when.items()}
    return out


def _reference_tables():
    """docs/MODEL_REFERENCE.md's per-provider settings tables, parsed back:
    {node id: {route id: [comparable param]}}."""
    import re

    text = (ROOT / "docs" / "MODEL_REFERENCE.md").read_text()
    tables: dict[str, dict[str, list[dict]]] = {}
    node_id = route_id = None
    for line in text.splitlines():
        found = re.match(r"^\| \*\*ID\*\* \| `([^`]+)` \|$", line)
        if found:
            node_id, route_id = found.group(1), None
            continue
        found = re.match(r"^\*\*.+ \(`([^`]+)`\) settings\*\*", line)
        if found and node_id:
            route_id = found.group(1)
            tables.setdefault(node_id, {})[route_id] = []
            continue
        if line == "---":
            route_id = None
        if not (route_id and line.startswith("| ") and not line.startswith("| Parameter") and "---" not in line):
            continue
        cells = [cell.strip() for cell in line.strip("|").split(" | ")]
        _label, key, _type, _default, offered, when = cells
        param: dict = {"key": key.strip("`")}
        if re.fullmatch(r"(-?[\d.]+|…)–(-?[\d.]+|…)", offered):
            low, high = offered.split("–")
            number = lambda text: None if text == "…" else (float(text) if "." in text else int(text))  # noqa: E731
            param["min"], param["max"] = number(low), number(high)
        elif offered != "—":
            param["options"] = re.findall(r"`([^`]*)`", offered)
        if when != "always":
            param["when"] = {}
            for part in when.split("; "):
                ctrl, values = part.split(" = ")
                param["when"][ctrl.strip("`")] = re.findall(r"`([^`]*)`", values)
        tables[node_id][route_id].append({k: v for k, v in param.items() if v is not None})
    return tables


def test_route_tables_snapshot_is_the_live_per_route_function():
    """route_tables.json is what the card shows (routeTables.test.ts holds
    directRoute.ts to it); it must also be today's route_param_definitions."""
    for node_id in ROUTE_TABLE_NODES:
        definition = REGISTRY[node_id]
        for route in definition["routes"]:
            live = [_comparable(dict(p)) for p in main.node_route.route_param_definitions(definition, route["id"])]
            assert live == [_comparable(p) for p in ROUTE_TABLES[node_id]["routeParams"][route["id"]]], (node_id, route["id"])


def test_describe_node_reference_and_card_list_the_same_settings_per_provider(real_nodes):
    reference = _reference_tables()
    for node_id in ROUTE_TABLE_NODES:
        definition = REGISTRY[node_id]
        body = real_nodes.get(f"/api/agent/nodes/{node_id}").json()
        described = {route["id"]: route for route in body["routes"]}
        assert list(described) == [route["id"] for route in definition["routes"]], node_id
        assert set(reference.get(node_id) or {}) == set(described), node_id
        for route_id, row in described.items():
            card = [_comparable(p) for p in _shown_on_card(definition, ROUTE_TABLES[node_id]["routeParams"][route_id])]
            assert [_comparable(p) for p in row["params"]] == card, (node_id, route_id, "describe_node")
            assert reference[node_id][route_id] == card, (node_id, route_id, "MODEL_REFERENCE.md")


def test_a_setting_a_provider_does_not_offer_is_absent_or_conditional(real_nodes):
    klein = {r["id"]: r for r in real_nodes.get("/api/agent/nodes/flux-3-image-klein").json()["routes"]}
    assert "seed" in {p["key"] for p in klein["bfl"]["params"]}
    assert "seed" not in {p["key"] for p in klein["openrouter"]["params"]}
    assert klein["openrouter"]["hides"] == ["no Seed"] and "hides" not in klein["bfl"]
    # A 0 minimum is a range, not "no minimum".
    assert next(p for p in klein["openrouter"]["params"] if p["key"] == "safety_tolerance")["min"] == 0
    flux2 = {r["id"]: r for r in real_nodes.get("/api/agent/nodes/flux-2-pro").json()["routes"]}
    safety = {route: next(p for p in flux2[route]["params"] if p["key"] == "safety_tolerance") for route in flux2}
    assert "onlyWhen" not in safety["bfl"]
    assert safety["fal"]["onlyWhen"] == {"model": ["pro", "max", "flex"]}
    assert flux2["fal"]["hides"] == ["Safety only with Model FLUX.2 [pro], FLUX.2 [max] or FLUX.2 [flex]"]
    video = {r["id"]: r for r in real_nodes.get("/api/agent/nodes/flux-3-video").json()["routes"]}
    for route in ("bfl", "fal", "replicate"):
        resolution = next(p for p in video[route]["params"] if p["key"] == "resolution")
        assert resolution["onlyWhen"] == {"draft": [False]}, route
    assert "onlyWhen" not in next(p for p in video["openrouter"]["params"] if p["key"] == "resolution")


def test_the_mcp_tool_description_names_the_route_fields_describe_node_returns(real_nodes):
    import re

    import mcp_server

    doc = mcp_server.describe_node.__doc__ or ""
    named = set(re.findall(r"`([A-Za-z_]+)`", doc))
    body = real_nodes.get("/api/agent/nodes/flux-3-image-klein").json()
    route_fields = {field for route in body["routes"] for field in route}
    # Every field the description promises on a route-table node is real.
    for field in ("providerChoice", "routes", "params", "onlyWhen", "hides", "price", "priceUnconfirmed",
                  "note", "block", "fixes", "_provider"):
        assert field in named, field
    assert {"params", "hides", "price", "note", "block"} <= route_fields
    assert "providerChoice" in body and "fixes" in main.node_route.route_unavailable(
        REGISTRY["flux-3-image-klein"], {"_provider": "openrouter", "seed": 42}, {"OPENROUTER_API_KEY": "k"})
    assert "routes" in mcp_server.INSTRUCTIONS and "propose_change" in mcp_server.INSTRUCTIONS


def test_a_proposal_cost_entry_carries_the_fixes_of_a_hidden_setting_stop():
    from services.canvas_proposals import cost_for

    definition = REGISTRY["flux-3-image-klein"]
    entry = cost_for(definition, {"_provider": "openrouter", "seed": 42}, None, {"OPENROUTER_API_KEY": "k"})
    assert entry["provider"] is None and "Clear Seed" in entry["unavailable"]
    assert entry["fixes"] == [{"param": "seed", "value": None}]
    # A stop on a missing key has nothing to edit in place.
    missing = cost_for(definition, {"_provider": "openrouter"}, None, {})
    assert missing["provider"] is None and "fixes" not in missing


def test_nebula_info_names_what_each_route_hides():
    klein = format_node_detail(REGISTRY["flux-3-image-klein"]).splitlines()
    at = next(i for i, line in enumerate(klein) if line.strip().startswith("openrouter"))
    assert klein[at + 1].strip() == "no Seed"
    flux2 = format_node_detail(REGISTRY["flux-2-pro"])
    assert "Safety only with Model FLUX.2 [pro], FLUX.2 [max] or FLUX.2 [flex]" in flux2
    video = format_node_detail(REGISTRY["flux-3-video"])
    assert video.count("Resolution only with Draft (fast preview) off") == 3


REPO = Path(__file__).resolve().parents[2]
# Skills whose .agents and .claude copies were identical when PR 5 started;
# an edit to one must reach the other (Claude Code reads .claude/skills).
MIRRORED_SKILLS = ("anthropic", "bfl", "elevenlabs", "higgsfield", "minimax", "nebula-nodes-visuals", "nous",
                   "openrouter", "quiver", "replicate", "xai")


def test_mirrored_skill_copies_stay_identical():
    for name in MIRRORED_SKILLS:
        agents = (REPO / ".agents" / "skills" / name / "SKILL.md").read_text()
        claude = (REPO / ".claude" / "skills" / name / "SKILL.md").read_text()
        assert agents == claude, f"{name}: .agents and .claude SKILL.md differ"


def test_where_agents_get_fixes_is_what_the_code_returns(real_nodes):
    """A route stop's structured `fixes` reach an agent only on a proposal's
    cost entry (canvas_proposals.cost_for); describe_node's block and run
    errors carry no `fixes` field. The tool description, the provider note
    and the docs say so, and the documented shape is the code's."""
    import mcp_server

    definition = REGISTRY["flux-3-image-klein"]
    assert set(main.node_route.hidden_fix(definition, "seed")) == {"param", "value"}
    routes = real_nodes.get("/api/agent/nodes/flux-3-image-klein").json()["routes"]
    assert all("fixes" not in (route.get("block") or {}) for route in routes)
    for text in (mcp_server.describe_node.__doc__ or "", main.PROVIDER_CHOICE_NOTE,
                 (REPO / "docs" / "MCP-SETUP.md").read_text()):
        flat = " ".join(text.split())
        assert "propose_change` cost entry" in flat or "propose_change cost entry" in flat, flat[:300]
    routes_doc = (REPO / "docs" / "PROVIDER-ROUTES.md").read_text()
    assert "[{param, value}]" in routes_doc and "{param, value, label}" not in routes_doc


def test_route_docs_describe_pr5_behaviour():
    """Docs that state a PR 5 behaviour match what the router does."""
    keys = {"BFL_API_KEY": "k", "FAL_KEY": "k", "REPLICATE_API_TOKEN": "k", "KREA_API_TOKEN": "k"}
    route = main.node_route.select_route
    # A FLUX 3 Video draft at Full HD runs on Replicate (Resolution is hidden).
    assert route(REGISTRY["flux-3-video"], {"_provider": "replicate", "draft": True, "resolution": "fhd"},
                 keys).route_id == "replicate"
    for copy in (".agents", ".claude"):
        skill = (REPO / copy / "skills" / "replicate" / "SKILL.md").read_text()
        assert "a draft at `fhd`) stops" not in skill and "720p draft" in skill, copy
    # FLUX.2 Flash on fal no longer sends safety_tolerance: the one approved legacy delta.
    flux2_row = next(line for line in (REPO / "docs" / "PROVIDER-ROUTES.md").read_text().splitlines()
                     if line.startswith("| `flux-2-pro`"))
    assert "APPROVED_LEGACY_DELTA" in flux2_row
    # Krea 3: high thinking on fal stops; Jam under Auto stops on Krea.
    krea3 = REGISTRY["krea-3"]
    assert route(krea3, {"_provider": "fal", "thinking_mode": "high"}, keys).kind == main.node_route.UNSET
    assert route(krea3, {"model": "jam"}, keys).kind == main.node_route.UNSET
    for doc in (REPO / "docs" / "model-providers" / "krea" / "krea-3.md", REPO / ".agents" / "skills" / "krea" / "SKILL.md"):
        text = doc.read_text()
        assert "Hidden settings" in text and "Model Jam (speed)" in text, doc
