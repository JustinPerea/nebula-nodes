"""Prices measured from a run's input file (SeedVR2, FLUX Video Upscale/Edit).

A price entry with ``sizing`` multiplies by quantities read from the input
its port receives: megapixels in and out, a clip's seconds and frames.
Nebula reads them from the file it will send, at check time, and never
downloads anything to do it. When the input isn't known yet, the node is
unpriced, so an agent's run is refused and goes through a proposal.
"""
from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend, input_sizes, model_pricing  # noqa: E402
from services.node_registry import NodeRegistry  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_canvas_proposals import CLAUDE, _propose, api  # noqa: E402,F401  (api is a fixture)

CASES = json.loads((Path(__file__).parent / "fixtures" / "pricing_cases.json").read_text())
REGISTRY = NodeRegistry().get_all()
PRICING = model_pricing.load_pricing()


def _png(path: Path, width: int, height: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (width, height), (40, 80, 120)).save(path, "PNG")
    return path


def _stored_png(name: str, width: int, height: int) -> Path:
    from services.output import OUTPUT_ROOT

    return _png(OUTPUT_ROOT / "price-from-input" / name, width, height)


# -- the shipped table, run by run -----------------------------------------------

@pytest.mark.parametrize("case", CASES["sizedRunCases"], ids=[c["name"] for c in CASES["sizedRunCases"]])
def test_a_sized_run_is_priced_from_its_measured_input(case):
    """runScope.test.ts runs the same cases (pricing_cases.json sizedRunCases)."""
    item = {"id": "n1", "definitionId": case["nodeId"], "params": case["params"], "name": "Node"}
    sizes = {"n1": case["size"]} if case.get("size") else None
    result = model_pricing.estimate_run([item], PRICING, REGISTRY, case["apiKeys"], None,
                                        {"n1": {case["port"]: 1}}, sizes)
    expected = case["expected"]
    if expected["low"] is None:
        assert "n1" not in result["priced"] and "n1" in result["unpriced"]
    else:
        assert result["priced"]["n1"]["low"] == pytest.approx(expected["low"])
        assert result["priced"]["n1"]["high"] == pytest.approx(expected["high"])
    assert ("n1" in result["awaitingInput"]) is expected["awaitingInput"]
    assert result["reasons"].get("n1") == expected["reason"]


def test_seedvr2_entry_is_sourced_unconfirmed_and_says_how_it_counts():
    entry = PRICING["nodes"]["seedvr2-upscale"]
    assert entry["unconfirmed"] is True and entry["checked"] == "2026-10-21"
    assert entry["sizing"]["port"] == "image" and entry["sizing"]["roundUp"] == ["(larger megapixels)"]
    quotes = " ".join(source["quote"] for source in entry["sources"])
    assert "$0.001 per megapixel" in quotes
    assert "rounded up" in entry["notes"] and "Nebula" in entry["notes"]
    assert model_pricing.size_note(entry, REGISTRY["seedvr2-upscale"]) == (
        "$0.001 per megapixel of the larger of input and output, rounded up to a whole megapixel; "
        "priced from your image's size when you run it")


def test_an_entry_reading_a_measured_quantity_needs_sizing():
    definition = CASES["definitions"]["sized"]
    entry = {**CASES["pricing"]["nodes"]["sized"]}
    entry.pop("sizing")
    problems = model_pricing.validate_pricing({"nodes": {"sized": entry}}, {"sized": definition})
    assert any("needs sizing" in problem for problem in problems)
    bad = {**CASES["pricing"]["nodes"]["sized"], "sizing": {"port": "nope", "roundUp": ["(input dpi)"], "say": ""}}
    problems = "\n".join(model_pricing.validate_pricing({"nodes": {"sized": bad}}, {"sized": definition}))
    assert "sizing.port" in problems and "sizing.roundUp" in problems and "sizing.say" in problems


# -- measuring the input ---------------------------------------------------------

def test_an_image_is_measured_from_its_header():
    path = _stored_png("in.png", 1000, 1000)
    assert input_sizes.measure(str(path), "Image") == {"width": 1000, "height": 1000}


def test_a_stored_output_is_measured_by_its_served_ref_and_a_loopback_url():
    path = _stored_png("served.png", 640, 480)
    ref = "/api/outputs/price-from-input/served.png"
    assert input_sizes.measure(ref, "Image") == {"width": 640, "height": 480}
    assert input_sizes.measure(f"http://127.0.0.1:8000{ref}", "Image") == {"width": 640, "height": 480}
    assert path.exists()


def test_a_data_uri_is_measured_without_a_request():
    buffer = io.BytesIO()
    Image.new("RGB", (300, 200)).save(buffer, "PNG")
    uri = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    assert input_sizes.measure(uri, "Image") == {"width": 300, "height": 200}


def test_an_outside_url_is_never_fetched(monkeypatch):
    import httpx
    import urllib.request

    def refuse(*args, **kwargs):
        raise AssertionError("pricing must not download")

    monkeypatch.setattr(httpx, "get", refuse)
    monkeypatch.setattr(httpx.Client, "send", refuse)
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    assert input_sizes.measure("https://example.com/cat.png", "Image") is None


def test_missing_or_unreadable_files_measure_as_unknown(tmp_path):
    assert input_sizes.measure(str(tmp_path / "gone.png"), "Image") is None
    text = tmp_path / "notes.png"
    text.write_text("not an image")
    assert input_sizes.measure(str(text), "Image") is None
    assert input_sizes.measure("", "Image") is None


def test_a_video_is_measured_by_the_probe(monkeypatch):
    from services.output import OUTPUT_ROOT

    clip = OUTPUT_ROOT / "price-from-input" / "clip.mp4"
    clip.parent.mkdir(parents=True, exist_ok=True)
    clip.write_bytes(b"\x00")
    seen = []

    def fake_probe(path):
        seen.append(Path(path))
        return {"width": 1280, "height": 720, "seconds": 4.2, "frames": 126}

    monkeypatch.setattr(input_sizes, "_probe_video", fake_probe)
    assert input_sizes.measure(str(clip), "Video") == {"width": 1280, "height": 720, "seconds": 4.2, "frames": 126}
    assert seen == [clip.resolve()]


def test_run_input_sizes_reads_an_upload_in_the_run():
    path = _stored_png("up.png", 1000, 1000)
    items = [{"id": "in", "definitionId": "image-input", "params": {"filePath": str(path)}},
             {"id": "up", "definitionId": "seedvr2-upscale", "params": {}}]
    edges = [("in", "image", "up", "image")]
    assert input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY) == {"up": {"width": 1000, "height": 1000}}


def test_an_input_made_in_the_same_run_is_not_known():
    """The upstream node runs as part of this request, so its image doesn't exist yet."""
    items = [{"id": "gen", "definitionId": "gpt-image-2-generate", "params": {}},
             {"id": "up", "definitionId": "seedvr2-upscale", "params": {}}]
    edges = [("gen", "image", "up", "image")]
    nodes = {"gen": {"definitionId": "gpt-image-2-generate", "params": {},
                     "outputs": {"image": {"type": "Image", "value": "/api/outputs/price-from-input/served.png"}}}}
    assert input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY, nodes) == {}


def test_a_wired_output_that_already_exists_is_measured():
    """An upstream node outside the run (a cached ancestor in a proposal) gives its existing output."""
    _stored_png("existing.png", 800, 600)
    items = [{"id": "up", "definitionId": "seedvr2-upscale", "params": {}}]
    edges = [("gen", "image", "up", "image")]
    nodes = {"gen": {"definitionId": "gpt-image-2-generate", "params": {},
                     "outputs": {"image": {"type": "Image", "value": "/api/outputs/price-from-input/existing.png"}}}}
    assert input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY, nodes) == {"up": {"width": 800, "height": 600}}


def test_two_wires_into_the_sized_port_are_not_guessed(tmp_path):
    a = _png(tmp_path / "a.png", 100, 100)
    b = _png(tmp_path / "b.png", 2000, 2000)
    items = [{"id": "a", "definitionId": "image-input", "params": {"filePath": str(a)}},
             {"id": "b", "definitionId": "image-input", "params": {"filePath": str(b)}},
             {"id": "up", "definitionId": "seedvr2-upscale", "params": {}}]
    edges = [("a", "image", "up", "image"), ("b", "image", "up", "image")]
    assert input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY) == {}


# -- the spending check ----------------------------------------------------------

SEEDVR = "seedvr2-upscale"


def _decide(items, edges, sizes, settings):
    return agent_spend.decide(items, edges, settings={"apiKeys": {"FAL_KEY": "set"}, **settings}, pricing=PRICING,
                              definitions=REGISTRY, spent=agent_spend.Spent(), how_to_ask="ASK.", sizes=sizes)


UP = [{"id": "up", "definitionId": SEEDVR, "params": {}}]


def test_an_unknown_input_size_is_refused_with_what_to_do():
    refusal = _decide(UP, [("gen", "up", "image")], None, {}).refusal
    assert refusal is not None and "no list price" not in refusal
    assert "up (SeedVR2 Upscale)" in refusal and "size of its input" in refusal
    assert "Image Input" in refusal and refusal.endswith("ASK.")
    assert "`nebula quick seedvr2-upscale --input image=<file>`" in refusal


@pytest.mark.parametrize(("cap", "allowed"), [(0.005, True), (0.0041, True), (0.004, False), (0.003, False)])
def test_the_limit_checks_the_computed_price(cap, allowed):
    settings = {"agentSpend": {"models": {SEEDVR: {"perRunUsd": cap}}}}
    decision = _decide(UP, [("in", "up", "image")], {"up": {"width": 1000, "height": 1000}}, settings)
    assert (decision.refusal is None) is allowed
    assert decision.charge == {SEEDVR: pytest.approx(0.004)}
    if not allowed:
        assert "$0.004" in decision.refusal


@pytest.fixture
def client(monkeypatch, person):
    import main

    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    # The pre-call check (keys, unwired prompts) is tested elsewhere; the
    # fake engine never calls a provider.
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    test_client = TestClient(main.app)
    test_client.delete("/api/graph?force=true")
    yield test_client
    test_client.delete("/api/graph?force=true")
    test_client.put("/api/settings", json={"runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": None, "models": {}}},
                    headers=PERSON)


def _limit(client, cap):
    response = client.put("/api/settings", headers=PERSON, json={
        "apiKeys": {"FAL_KEY": "placeholder-not-a-key"}, "runCostConfirmUsd": 1,
        "agentSpend": {"sessionUsd": None, "models": {SEEDVR: {"perRunUsd": cap}}}})
    assert response.status_code == 200, response.text


def test_nebula_quick_prices_seedvr2_from_the_file(client, tmp_path):
    """`nebula quick seedvr2-upscale <file>` posts /api/quick: priced from the file, refused by the limit."""
    import main

    path = _png(tmp_path / "quick.png", 1000, 1000)
    _limit(client, 0.004)
    response = client.post("/api/quick", json={"definitionId": SEEDVR, "inputs": {"image": str(path)}, "params": {}})
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert "$0.004" in detail and "no list price" not in detail
    main.execute_graph.assert_not_awaited()


def test_nebula_quick_under_the_limit_goes_ahead(client, tmp_path):
    import main

    path = _png(tmp_path / "quick-ok.png", 1000, 1000)
    _limit(client, 0.005)
    client.post("/api/quick", json={"definitionId": SEEDVR, "inputs": {"image": str(path)}, "params": {}})
    main.execute_graph.assert_awaited_once()


def test_a_canvas_run_from_an_upload_is_priced_and_an_unrun_upstream_is_refused(client, tmp_path):
    import main

    _limit(client, 0.004)
    path = _stored_png("canvas.png", 1000, 1000)
    upload = client.post("/api/graph/node", json={"definitionId": "image-input", "params": {"filePath": str(path)}})
    seed = client.post("/api/graph/node", json={"definitionId": SEEDVR, "params": {}})
    up_id, in_id = seed.json()["id"], upload.json()["id"]
    client.post("/api/graph/connect", json={"source": in_id, "sourceHandle": "image", "target": up_id,
                                         "targetHandle": "image"})
    response = client.post("/api/graph/run", json={"targetNodeId": up_id})
    assert response.status_code == 403, response.text
    assert "$0.004" in response.json()["detail"]

    gen = client.post("/api/graph/node", json={"definitionId": "gpt-image-2-generate", "params": {}}).json()["id"]
    other = client.post("/api/graph/node", json={"definitionId": SEEDVR, "params": {}}).json()["id"]
    client.post("/api/graph/connect", json={"source": gen, "sourceHandle": "image", "target": other,
                                         "targetHandle": "image"})
    refused = client.post("/api/graph/run", json={"targetNodeId": other})
    assert refused.status_code == 403
    assert "size of its input" in refused.json()["detail"] and "no list price for" not in refused.json()["detail"]
    main.execute_graph.assert_not_awaited()


# -- the canvas's measure route ---------------------------------------------------

def test_the_measure_route_reads_only_the_output_store(client, tmp_path):
    _stored_png("route.png", 1200, 900)
    outside = _png(tmp_path / "outside.png", 10, 10)
    response = client.post("/api/pricing/input-sizes", json={"refs": [
        {"ref": "/api/outputs/price-from-input/route.png", "kind": "Image"},
        {"ref": str(outside), "kind": "Image"},
        {"ref": "https://example.com/x.png", "kind": "Image"},
    ]})
    assert response.status_code == 200
    assert response.json()["sizes"] == {
        "/api/outputs/price-from-input/route.png": {"width": 1200, "height": 900},
        str(outside): None,
        "https://example.com/x.png": None,
    }
    too_many = client.post("/api/pricing/input-sizes", json={"refs": [{"ref": "x", "kind": "Image"}] * 65})
    assert too_many.status_code == 400


# -- agent surfaces --------------------------------------------------------------

def test_describe_and_find_nodes_say_it_is_priced_from_the_input(client):
    detail = client.get(f"/api/agent/nodes/{SEEDVR}").json()
    assert detail["price"]["atDefaultsUsd"] is None
    assert detail["price"]["byInputSize"] == (
        "$0.001 per megapixel of the larger of input and output, rounded up to a whole megapixel; "
        "priced from your image's size when you run it")
    rows = client.get("/api/agent/nodes", params={"query": "seedvr2", "ready_only": "false"}).json()["nodes"]
    row = next(row for row in rows if row["id"] == SEEDVR)
    assert row["price"] == "by input size" and "megapixel" in row["priceNote"]


def test_a_proposal_prices_seedvr2_from_an_upstream_output_that_exists(api):
    from services.output import OUTPUT_ROOT

    _png(OUTPUT_ROOT / "price-from-input" / "proposal.png", 1000, 1000)
    gen = api.graph.add_node("gpt-image-2-generate", {})
    api.graph.nodes[gen]["outputs"] = {"image": {"type": "Image",
                                                 "value": "/api/outputs/price-from-input/proposal.png"}}
    body = {"note": "Upscale it", "nodes": [{"ref": "+up", "definitionId": SEEDVR}],
            "edges": [{"source": gen, "sourceHandle": "image", "target": "+up", "targetHandle": "image"}],
            "run": ["+up"]}
    cost = _propose(api, body).json()["proposal"]["cost"]
    assert {node["ref"]: node["price"] for node in cost["nodes"]}["+up"] == {
        "low": pytest.approx(0.004), "high": pytest.approx(0.004)}


def test_nebula_info_and_context_show_the_size_price(client, capsys):
    """The CLI twin: `nebula info` prints the price line, `nebula context` lists it by input size."""
    from cli.client import NebulaClient
    from cli.commands import nodes
    from cli.formatter import _price

    cli = NebulaClient("http://testserver")
    cli._client = client
    nodes.run_info(cli, SEEDVR)
    out = capsys.readouterr().out
    assert ("PRICE: $0.001 per megapixel of the larger of input and output, rounded up to a whole megapixel; "
            "priced from your image's size when you run it (unconfirmed)") in out
    nodes.run_info(cli, "text-input")
    assert "PRICE: free" in capsys.readouterr().out
    assert _price("by input size") == "by input size"


@pytest.mark.skipif(not (__import__("shutil").which("ffmpeg") and __import__("shutil").which("ffprobe")),
                    reason="needs ffmpeg and ffprobe")
def test_the_real_probe_reads_a_clip_header():
    import subprocess

    from services.output import OUTPUT_ROOT

    clip = OUTPUT_ROOT / "price-from-input" / "tiny.mp4"
    clip.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=2",
                    "-pix_fmt", "yuv420p", str(clip)], check=True, timeout=60)
    size = input_sizes.measure(str(clip), "Video")
    assert size is not None and (size["width"], size["height"]) == (64, 48)
    assert size["frames"] == 20 and size["seconds"] == pytest.approx(2.0, abs=0.05)


# -- why a size isn't known (review: the refusal named the wrong reason) ---------

@pytest.mark.parametrize(("source", "handle", "in_run", "expected"), [
    ({"definitionId": "image-input", "params": {"filePath": "https://images.example.com/x.png"}}, "image", True, "remote"),
    ({"definitionId": "image-input", "params": {"filePath": "/nowhere/gone.png"}}, "image", True, "unreadable"),
    ({"definitionId": "gpt-image-2-generate", "params": {}}, "image", True, "pending"),
    ({"definitionId": "gpt-image-2-generate", "params": {}, "outputs": {}}, "image", False, "pending"),
])
def test_run_input_sizes_says_why_a_size_is_not_known(source, handle, in_run, expected):
    items = [{"id": "up", "definitionId": SEEDVR, "params": {}}]
    if in_run:
        items.insert(0, {"id": "src", **source})
    reasons: dict[str, str] = {}
    sizes = input_sizes.run_input_sizes(items, [("src", handle, "up", "image")], PRICING, REGISTRY,
                                        {"src": source}, reasons=reasons)
    assert sizes == {} and reasons == {"up": expected}


def test_run_input_sizes_says_when_the_port_has_no_single_wire(tmp_path):
    a = _png(tmp_path / "a.png", 100, 100)
    items = [{"id": "a", "definitionId": "image-input", "params": {"filePath": str(a)}},
             {"id": "b", "definitionId": "image-input", "params": {"filePath": str(a)}},
             {"id": "up", "definitionId": SEEDVR, "params": {}},
             {"id": "lone", "definitionId": SEEDVR, "params": {}}]
    edges = [("a", "image", "up", "image"), ("b", "image", "up", "image")]
    reasons: dict[str, str] = {}
    assert input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY, reasons=reasons) == {}
    assert reasons == {"up": "wires", "lone": "unwired"}


def test_a_measured_node_has_no_reason():
    path = _stored_png("ok.png", 10, 10)
    items = [{"id": "in", "definitionId": "image-input", "params": {"filePath": str(path)}},
             {"id": "up", "definitionId": SEEDVR, "params": {}}]
    reasons: dict[str, str] = {}
    assert input_sizes.run_input_sizes(items, [("in", "image", "up", "image")], PRICING, REGISTRY, reasons=reasons)
    assert reasons == {}


def _decide_why(reason):
    return agent_spend.decide(UP, [("in", "up", "image")], settings={"apiKeys": {"FAL_KEY": "set"}}, pricing=PRICING,
                              definitions=REGISTRY, spent=agent_spend.Spent(), how_to_ask="ASK.", sizes=None,
                              size_reasons={"up": reason}).refusal


def test_an_outside_url_is_refused_for_what_it_is():
    refusal = _decide_why("remote")
    assert "up (SeedVR2 Upscale)" in refusal and "another host" in refusal and "never downloads" in refusal
    assert "doesn't exist yet" not in refusal
    # The next step is a local copy, not the command that just failed.
    assert "`nebula quick seedvr2-upscale --input image=<local file path>`" in refusal
    assert "download" in refusal.lower() and refusal.endswith("ASK.")


def test_an_unreadable_file_is_refused_for_what_it_is():
    refusal = _decide_why("unreadable")
    assert "couldn't read" in refusal and "doesn't exist yet" not in refusal
    assert "`nebula quick seedvr2-upscale --input image=<file>`" not in refusal


def test_a_port_without_one_wire_is_refused_for_what_it_is():
    assert "more than one" in _decide_why("wires")
    assert "nothing connected" in _decide_why("unwired")


def test_an_input_still_to_be_made_keeps_its_wording():
    refusal = _decide_why("pending")
    assert "doesn't exist yet" in refusal and "Image Input" in refusal


def test_nebula_quick_on_an_outside_url_says_it_is_never_downloaded(client):
    import main

    _limit(client, 0.004)
    response = client.post("/api/quick", json={"definitionId": SEEDVR,
                                               "inputs": {"image": "https://images.example.com/a.png"}, "params": {}})
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert "another host" in detail and "doesn't exist yet" not in detail and "no list price" not in detail
    main.execute_graph.assert_not_awaited()
