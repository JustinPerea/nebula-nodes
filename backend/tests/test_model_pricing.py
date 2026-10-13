"""The curated price table: its shape, its provenance, and the estimate."""
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import app  # noqa: E402
from services import model_pricing  # noqa: E402
from services.node_registry import NodeRegistry  # noqa: E402

CASES = json.loads((Path(__file__).parent / "fixtures" / "pricing_cases.json").read_text())


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
def test_estimate_matches_shared_cases(case):
    entry = CASES["pricing"]["nodes"].get(case["nodeId"])
    definition = CASES["definitions"].get(case["nodeId"], {})
    result = model_pricing.estimate_node(entry, definition, case["params"], case.get("routeProvider"),
                                         case.get("wired", []))
    expected = case["expected"]
    if expected is None:
        assert result is None
    else:
        assert result["currency"] == expected["currency"]
        assert result["low"] == pytest.approx(expected["low"])
        assert result["high"] == pytest.approx(expected["high"])
        assert result.get("plus") == expected.get("plus")


def test_fixture_table_is_valid():
    assert model_pricing.validate_pricing(CASES["pricing"], CASES["definitions"]) == []


def test_shipped_table_is_valid_against_the_registry():
    pricing = model_pricing.load_pricing()
    assert model_pricing.validate_pricing(pricing, NodeRegistry().get_all()) == []


def test_validation_catches_unsourced_and_unknown_entries():
    definitions = CASES["definitions"]
    bad = {
        "nodes": {
            "img": {"currency": "usd", "per": "image", "rows": [{"match": {"quality": "ultra"}, "price": -1}],
                    "sources": [{"url": "http://example.com", "quote": ""}], "checked": "10/10/2026"},
            "ghost": {"currency": "usd", "per": "image", "rows": [], "sources": [], "checked": "2026-10-10"},
            "cu": {"currency": "krea_cu", "per": "image", "rows": [{"match": {}, "price": 1}],
                   "sources": [{"url": "https://example.com", "quote": "x"}], "checked": "2026-10-10"},
        }
    }
    problems = "\n".join(model_pricing.validate_pricing(bad, definitions))
    for expected in ("checked must be an ISO date", "https url", "quoted price line",
                     "price must be", "quality='ultra' is not an option", "ghost: no such node",
                     "krea_cu is not described"):
        assert expected in problems


def test_pricing_route_serves_the_table():
    response = TestClient(app).get("/api/pricing")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"currencies", "nodes"}


def test_route_provider_prefers_the_direct_key_then_falls_back():
    veo = NodeRegistry().get_all()["veo-3"]
    assert model_pricing.route_provider(veo, {"GOOGLE_API_KEY": "set", "FAL_KEY": "set"}) == "google"
    assert model_pricing.route_provider(veo, {"FAL_KEY": "set"}) == "fal"
    assert model_pricing.route_provider(veo, {}) == veo["apiProvider"]
    # Vertex is a direct route too and bills Google's listed amounts.
    assert model_pricing.route_provider(veo, {"GOOGLE_VERTEX_CREDENTIALS": "{}", "FAL_KEY": "set"}) == "google"


def test_real_table_prices_veo_by_model_and_resolution():
    veo = NodeRegistry().get_all()["veo-3"]
    entry = model_pricing.load_pricing()["nodes"]["veo-3"]
    default = model_pricing.estimate_node(entry, veo, {}, "google")
    assert default == {"currency": "usd", "low": 3.2, "high": 3.2}, "8 s at 720p on Veo 3.1"
    fast_4k = model_pricing.estimate_node(
        entry, veo, {"model": "veo-3.1-fast-generate-preview", "resolution": "4k", "duration": "4"}, "google",
    )
    assert fast_4k["low"] == pytest.approx(1.2)
    assert model_pricing.estimate_node(entry, veo, {}, "fal") is None


def test_run_multipliers_follow_the_nearest_batch_or_iterator():
    nodes = [
        {"id": "b", "definitionId": "batch", "params": {"items_text": "one\n\ntwo\nthree"}},
        {"id": "img", "definitionId": "nano-banana", "params": {}},
        {"id": "it", "definitionId": "iterator-image", "params": {"batch_size_cap": 4}},
        {"id": "img2", "definitionId": "nano-banana", "params": {}},
        {"id": "solo", "definitionId": "nano-banana", "params": {}},
    ]
    edges = [("b", "img"), ("img", "it"), ("it", "img2")]
    runs = model_pricing.run_multipliers(nodes, edges)
    assert runs["img"] == (3, 3)
    assert runs["img2"] == (1, 4)
    assert runs["solo"] == (1, 1)


def test_estimate_run_sums_priced_nodes_and_names_the_rest():
    definitions = NodeRegistry().get_all()
    pricing = {"nodes": {
        "nano-banana": {"currency": "usd", "per": "image", "rows": [{"match": {}, "price": 0.05}]},
        "gpt-image-2-edit": {"currency": "usd", "per": "image", "plus": "input images",
                             "rows": [{"match": {}, "price": [0.01, 0.2]}]},
    }}
    krea_id = next(k for k, d in definitions.items()
                   if d.get("apiProvider") == "krea"
                   and any(p.get("key") == "_kreaAuth" for p in d.get("params") or []))
    items = [
        {"id": "a", "definitionId": "nano-banana", "params": {}},
        {"id": "e", "definitionId": "gpt-image-2-edit", "params": {}},
        {"id": "c", "definitionId": "claude-chat", "params": {}},
        {"id": "k", "definitionId": krea_id, "params": {"_kreaAuth": "mcp"}},
        {"id": "t", "definitionId": "text-input", "params": {}},
    ]
    result = model_pricing.estimate_run(items, pricing, definitions, {}, {"a": (2, 2)})
    assert result["low"] == pytest.approx(0.11) and result["high"] == pytest.approx(0.3)
    assert result["priced"]["a"] == {"low": pytest.approx(0.1), "high": pytest.approx(0.1), "model": "nano-banana"}
    assert result["unpriced"] == ["c"] and result["plan"] == ["k"] and result["plus"] == ["input images"]
    nothing = model_pricing.estimate_run([items[2]], pricing, definitions, {})
    assert nothing["low"] is None and nothing["high"] is None and nothing["unpriced"] == ["c"]


# -- settings the rows can't see -----------------------------------------------

KLING_SHOTS = '[{"prompt": "a", "duration": "10"}]'


def test_kling_v3_multi_shot_runs_are_unpriced():
    """Kling bills shots that must sum to the duration, but neither fal nor
    Kling says what a mismatched sum costs, so only single-prompt runs are priced."""
    kling = NodeRegistry().get_all()["kling-v3"]
    entry = model_pricing.load_pricing()["nodes"]["kling-v3"]
    base = {"model": "standard", "generate_audio": True, "duration": "5"}
    assert model_pricing.estimate_node(entry, kling, {**base, "multi_prompt": KLING_SHOTS}) is None
    assert model_pricing.estimate_node(entry, kling, {**base, "multi_prompt": "   "}) is None
    single = model_pricing.estimate_node(entry, kling, {**base, "multi_prompt": ""})
    assert single["low"] == pytest.approx(0.63) and single["high"] == pytest.approx(0.63)
    assert model_pricing.estimate_node(entry, kling, base)["high"] == pytest.approx(0.63)
    assert model_pricing.estimate_node(entry, kling, {**base, "model": "pro"})["high"] == pytest.approx(0.84)


def test_krea_kling_multi_shot_runs_are_unpriced_by_param_or_by_wire():
    definitions = NodeRegistry().get_all()
    pricing = model_pricing.load_pricing()
    node_id = "krea-video-kling-kling-3-0"
    entry = pricing["nodes"][node_id]
    params = {"mode": "std", "generate_audio": False, "duration": 5}
    assert model_pricing.estimate_node(entry, definitions[node_id], params)["high"] == pytest.approx(0.42)
    shots = {**params, "multi_prompt": '[{"prompt": "a", "duration": 10}]'}
    assert model_pricing.estimate_node(entry, definitions[node_id], shots) is None
    # The handler copies a wired value over the param, so an empty param proves nothing.
    item = {"id": "k", "definitionId": node_id, "params": params}
    wired = model_pricing.wired_ports([item], [("text", "k", "multi_prompt"), ("img", "k", "start_image")])
    assert wired == {"k": {"multi_prompt", "start_image"}}
    result = model_pricing.estimate_run([item], pricing, definitions, {}, None, wired)
    assert result["unpriced"] == ["k"] and result["priced"] == {}
    plain = model_pricing.estimate_run([item], pricing, definitions, {}, None, {"k": {"start_image"}})
    assert plain["priced"]["k"]["high"] == pytest.approx(0.42)
    # Every generated Kling 3.0 row carries the guard, so a catalog refresh keeps it.
    assert all(row["match"].get("multi_prompt") == "" for row in entry["rows"])


@pytest.mark.parametrize("node_id", [
    "krea-video-alibaba-wan-2-5", "krea-video-alibaba-wan-3-0", "krea-video-lightricks-ltx-video-2-5-fast",
    "krea-video-lightricks-ltx-video-2-5-pro", "krea-video-vidu-q3",
])
def test_krea_charges_nothing_extra_for_audio_on_these_models(node_id):
    """Krea's price list for these keys on resolution and duration only; it does
    list audio where it charges for it (Veo 3, Kling 3.0)."""
    definition = NodeRegistry().get_all()[node_id]
    entry = model_pricing.load_pricing()["nodes"][node_id]
    assert "generate_audio" not in model_pricing.priced_keys(entry)
    assert "doesn't vary with generate_audio" in entry["notes"]
    for row in entry["rows"]:
        settings = {key: value for key, value in row["match"].items()}
        with_audio = model_pricing.estimate_node(entry, definition, {**settings, "generate_audio": True})
        without = model_pricing.estimate_node(entry, definition, {**settings, "generate_audio": False})
        assert with_audio == without and with_audio is not None


# -- local nodes that call a provider ------------------------------------------

@pytest.mark.parametrize(("params", "priced_as"), [
    ({}, None), ({"mode": "heuristic"}, None), ({"mode": "opencv"}, None),
    ({"mode": "vision-llm"}, "unpriced"), ({"mode": ""}, "unpriced"), ({"mode": None}, "unpriced"),
    ({"mode": "bogus"}, "unpriced"),
])
def test_vision_llm_qc_runs_are_unpriced_and_local_modes_free(params, priced_as):
    definitions = NodeRegistry().get_all()
    for node_id in ("qc-loop-safety", "qc-frame-review", "qc-composited-look", "qc-camera-geometry"):
        item = {"id": "q", "definitionId": node_id, "params": params}
        result = model_pricing.estimate_run([item], model_pricing.load_pricing(), definitions,
                                            {"ANTHROPIC_API_KEY": "set"})
        assert result["priced"] == {} and result["plan"] == []
        assert result["unpriced"] == (["q"] if priced_as else [])


def test_is_local_means_no_provider_call():
    definitions = NodeRegistry().get_all()
    assert model_pricing.is_local(definitions["text-input"])
    assert not model_pricing.is_local(definitions["cinema-scene"])
    assert model_pricing.is_local(definitions["qc-loop-safety"])
    assert not model_pricing.is_local(definitions["qc-loop-safety"], {"mode": "vision-llm"})
    assert not model_pricing.is_local(definitions["nano-banana"])
