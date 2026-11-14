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
    return world_value(path, seed=seed, gaussians=count, mode="synthetic", steps=50)


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
    assert summary["coordinateSystem"] == {"handedness": "right", "upAxis": "-y", "forwardAxis": "x", "unit": "custom"}
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


def test_an_spz_only_world_v2_has_no_summary(nebula):  # noqa: F811
    """The summary reads 3DGS PLYs only; an SPZ splat is gzip, not a PLY."""
    http = nebula["http"]
    world = _idol_world("as-spz.ply")
    splat = world["assets"]["splats"][0]
    splat["format"] = "spz"
    node_id = _node_with({"world": {"type": "World", "value": world}})
    assert http.get(f"/api/graph/node/{node_id}/splat-summary").status_code == 404


def test_an_unreadable_file_names_no_path(nebula, monkeypatch):  # noqa: F811
    import services.splat_ply as splat_ply_module

    http = nebula["http"]
    world = _idol_world("locked.ply")
    from services.output import resolve_output_ref

    where = resolve_output_ref(world["assets"]["splats"][0]["asset"]["uri"])

    def refuse(path):
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr(splat_ply_module, "summarize_splat_ply", refuse)
    node_id = _node_with({"world": {"type": "World", "value": world}})
    summary = http.get(f"/api/graph/node/{node_id}/splat-summary").json()
    error = summary["splats"][0]["error"]
    assert error == "The splat file can't be read from Nebula's outputs."
    assert str(where) not in error and "/" not in error.replace("Nebula's", "")


def test_cli_agents_read_the_summary_with_nebula_splat(nebula, capsys):  # noqa: F811
    """skills/nebula/SKILL.md sends CLI agents to `nebula splat <node>`, the
    same summary view_output gives MCP agents."""
    from cli.client import NebulaClient
    from cli.commands import splat

    world = _idol_world("cli.ply", 200, seed=5)
    node_id = _node_with({"world": {"type": "World", "value": world}})
    client = NebulaClient()
    client._client = nebula["http"]
    assert splat.run(client, node_id) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["seed"] == 5 and printed["splats"][0]["gaussians"] == 200
    text_node = _node_with({"text": {"type": "Text", "value": "hi"}})
    assert splat.run(client, text_node) == 1
    assert "no World output with a PLY splat" in capsys.readouterr().err
