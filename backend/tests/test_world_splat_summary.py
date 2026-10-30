"""A World v2 splat as numbers for agents: GET /api/graph/node/{id}/splat-summary
(main.world_splat_summaries) and view_output's `splat` beside the value.

The splats are synthetic PLYs written into Nebula's outputs; nothing runs.
"""
from __future__ import annotations

import json
from pathlib import Path

import mcp_server
from handlers.speridlabs_idol import world_value
from tests.speridlabs_fakes import splat_ply
from tests.test_mcp_projects_and_reads import nebula  # noqa: F401  (fixture)


def _idol_world(name: str, count: int = 300, *, seed: int = 9) -> dict:
    from services.output import OUTPUT_ROOT

    folder = Path(OUTPUT_ROOT) / "splat-summary"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_bytes(splat_ply(count, seed=seed))
    return world_value(path, seed=seed, gaussians=count, mode="Synthetic", steps=50)


def _node_with(outputs: dict) -> str:
    import main

    node_id = main.cli_graph.add_node("speridlabs-idol", {})
    main.cli_graph.nodes[node_id]["outputs"] = outputs
    return node_id


def test_the_summary_reads_the_splat_file(nebula):  # noqa: F811
    http = nebula["http"]
    world = _idol_world("a.ply", 300, seed=9)
    node_id = _node_with({"world": {"type": "World", "value": world}})
    response = http.get(f"/api/graph/node/{node_id}/splat-summary")
    assert response.status_code == 200, response.text
    summary = response.json()
    assert (summary["port"], summary["provider"], summary["model"], summary["seed"]) == ("world", "speridlabs", "idol", 9)
    assert summary["coordinateSystem"] == {"handedness": "right", "upAxis": "-y", "forwardAxis": "z", "unit": "custom"}
    [splat] = summary["splats"]
    assert splat["id"] == "splat" and splat["format"] == "ply" and splat["gaussians"] == 300
    assert splat["fileBytes"] == len(splat_ply(300, seed=9))
    box = splat["boundingBox"]
    assert all(-0.5 <= value <= 0.5 for value in box["min"] + box["max"])
    assert splat["nonFinitePositions"] == 0


def test_a_missing_or_damaged_file_is_named_not_raised(nebula):  # noqa: F811
    http = nebula["http"]
    missing = _idol_world("gone.ply")
    from services.output import resolve_output_ref

    Path(resolve_output_ref(missing["assets"]["splats"][0]["asset"]["uri"])).unlink()
    damaged = _idol_world("bad.ply")
    Path(resolve_output_ref(damaged["assets"]["splats"][0]["asset"]["uri"])).write_bytes(b"ply\nnope\n")
    for world, error in ((missing, "missing"), (damaged, "can't be read")):
        node_id = _node_with({"world": {"type": "World", "value": world}})
        summary = http.get(f"/api/graph/node/{node_id}/splat-summary").json()
        assert error in summary["splats"][0]["error"]


def test_a_value_without_a_ply_splat_has_no_summary(nebula):  # noqa: F811
    http = nebula["http"]
    v1 = {"type": "World", "value": {"id": "w", "spz_urls": {"full_res": "https://example.com/w.spz"}}}
    text = {"type": "Text", "value": "hello"}
    for outputs in ({"world": v1}, {"text": text}):
        node_id = _node_with(outputs)
        assert http.get(f"/api/graph/node/{node_id}/splat-summary").status_code == 404
    assert http.get("/api/graph/node/nope/splat-summary").status_code == 404


def test_a_summary_never_reads_outside_the_outputs(nebula, tmp_path):  # noqa: F811
    http = nebula["http"]
    outside = tmp_path / "outside.ply"
    outside.write_bytes(splat_ply(16))
    world = _idol_world("inside.ply")
    world["assets"]["splats"][0]["asset"]["uri"] = str(outside)
    node_id = _node_with({"world": {"type": "World", "value": world}})
    # A World value can't name a bare file path (models/spatial.py takes
    # output refs and http(s) only), so there is no PLY splat to read.
    response = http.get(f"/api/graph/node/{node_id}/splat-summary")
    assert response.status_code == 404


def test_view_output_gives_an_agent_the_splat_summary(nebula):  # noqa: F811
    world = _idol_world("view.ply", 128, seed=77)
    node_id = _node_with({"world": {"type": "World", "value": world}})
    answer = json.loads(mcp_server.view_output(node_id)[0])
    out = answer["outputs"]["world"]
    assert out["type"] == "World" and out["value"]["schemaVersion"] == 2
    splat = out["splat"]
    assert (splat["provider"], splat["model"], splat["seed"]) == ("speridlabs", "idol", 77)
    assert splat["splats"][0]["gaussians"] == 128
    assert splat["splats"][0]["fileBytes"] == len(splat_ply(128, seed=77))
