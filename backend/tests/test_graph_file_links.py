"""Q123 a (Justin, 2026-10-24): "Yes: `nebula load` and an MCP tool open a
bundle, restoring its files, as Load graph does. A big one opens as a new
project."

The canvas rewrites a restored bundle's links (frontend/src/lib/graphFile.ts
rewriteAssetUrls); agents get the same rewrite from the backend
(services/graph_file_links.py), through the restore route's `rewriteLinks`
flag. One shared fixture (tests/fixtures/graph_file_links_cases.json) is read
here and by frontend/tests/graphFileLinksParity.test.ts, which runs the
canvas's own functions, so the two can't drift. The World and spatial check
is a stricter subset of the canvas's (no port of its full parsers): see
docs/notes/2026-10-24-feat-agent-open-bundle.md.
"""
from __future__ import annotations

import copy
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services import graph_file_links as links
from services.project_size import project_name_for_file

SHARED = json.loads((Path(__file__).resolve().parent / "fixtures" / "graph_file_links_cases.json")
                    .read_text(encoding="utf-8"))


def _short(value) -> str:
    return json.dumps(value)[:80]


# -- the shared cases ---------------------------------------------------------------

@pytest.mark.parametrize("case", SHARED["links"], ids=lambda case: _short(case["value"]))
def test_a_link_reads_as_the_canvas_reads_it(case):
    assert links.parse_local_output_reference(case["value"]) == case["expected"]


@pytest.mark.parametrize("case", SHARED["paths"], ids=lambda case: _short(case["raw"]))
def test_an_output_path_canonicalizes_as_the_canvas_does(case):
    assert links.canonical_portable_output_relative_path(case["raw"]) == case["expected"]


@pytest.mark.parametrize("case", SHARED["mappings"], ids=lambda case: _short(case["mapping"]))
def test_the_restore_mapping_is_checked_as_the_canvas_checks_it(case):
    if case["error"]:
        with pytest.raises(links.GraphFileLinkError) as exc:
            links.validated_restore_mapping(case["mapping"])
        assert str(exc.value) == case["error"]
        return
    assert links.validated_restore_mapping(case["mapping"]) == case["expected"]


def test_a_graph_is_rewritten_to_its_restored_files_with_the_canvas_warnings():
    rewrite = SHARED["rewrite"]
    nodes = copy.deepcopy(rewrite["nodes"])
    warnings = links.rewrite_asset_urls(nodes, links.validated_restore_mapping(rewrite["mapping"]))
    assert warnings == rewrite["expectedWarnings"]
    assert nodes == rewrite["expectedNodes"]


@pytest.mark.parametrize("case", SHARED["projectNames"], ids=lambda case: _short(case["fileName"]))
def test_a_file_over_the_limit_opens_as_the_project_the_canvas_would_name(case):
    assert project_name_for_file(case["fileName"]) == case["expected"]


def test_the_restore_preflight_and_the_link_reader_share_one_component_rule():
    # Not a third copy: main's restore checks a zip member's parts with the
    # same function the link reader uses.
    import main

    assert main._decoded_portable_component("caf%C3%A9.png") == links.decoded_portable_component("caf%C3%A9.png")
    with pytest.raises(main.HTTPException) as exc:
        main._decoded_portable_component("con.png")
    assert exc.value.status_code == 400 and exc.value.detail == "Zip bundle contains a non-portable path"


# -- World and spatial outputs: the strict subset --------------------------------------

def _world(value) -> dict:
    return {"id": "w1", "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"label": "World", "definitionId": "worldlabs-world", "params": {},
                     "outputs": {"world": {"type": "World", "value": value}}}}


def test_a_world_holding_an_outside_asset_is_dropped_with_the_canvas_line():
    nodes = [_world({"assets": {"splats": {"100k": "https://evil.example/s.spz"},
                                "thumbnail": "/api/outputs/w/t.png", "panorama": {"uri": "http://example.com/p.png"}}})]
    warnings = links.sanitize_imported_spatial_outputs(nodes)
    assert warnings == ["2 external World asset references were omitted; only Nebula output assets can be loaded.",
                        "1 invalid World output was made unavailable."]
    assert nodes[0]["data"]["outputs"] == {}


def test_a_world_with_only_nebula_assets_stays():
    value = {"assets": {"splats": {"100k": "/api/outputs/w/s.spz"}, "thumbnail": "http://127.0.0.1:8000/api/outputs/w/t.png"},
             "worldId": "abc", "marbleUrl": "https://marble.worldlabs.ai/world/abc"}
    nodes = [_world(copy.deepcopy(value))]
    assert links.sanitize_imported_spatial_outputs(nodes) == []
    assert nodes[0]["data"]["outputs"]["world"]["value"] == value


def test_a_world_or_spatial_output_that_isnt_an_object_is_made_unavailable():
    nodes = [_world("not a world"),
             {"id": "d1", "type": "model-node", "position": {"x": 0, "y": 0},
              "data": {"label": "Depth", "definitionId": "x", "params": {},
                       "outputs": {"depth": {"type": "DepthMap", "value": ["no"]},
                                   "image": {"type": "Image", "value": "/api/outputs/a.png"}}}}]
    warnings = links.sanitize_imported_spatial_outputs(nodes)
    assert warnings == ["1 invalid World output was made unavailable.", "1 invalid spatial output was made unavailable."]
    assert nodes[0]["data"]["outputs"] == {}
    assert list(nodes[1]["data"]["outputs"]) == ["image"]


def test_a_spatial_asset_outside_nebulas_outputs_is_made_unavailable():
    bad = {"type": "PointCloud", "value": {"asset": {"id": "p", "uri": "https://example.com/p.ply", "mediaType": "x/y"}}}
    traversal = {"type": "DepthMap", "value": {"asset": {"id": "d", "uri": "/api/outputs/../d.png", "mediaType": "image/png"}}}
    good = {"type": "PointCloud", "value": {"asset": {"id": "p", "uri": "/api/outputs/r/p.ply", "mediaType": "x/y"}}}
    nodes = [{"id": "s1", "type": "model-node", "position": {"x": 0, "y": 0},
              "data": {"label": "S", "definitionId": "x", "params": {},
                       "outputs": {"bad": bad, "traversal": traversal, "good": copy.deepcopy(good)}}}]
    warnings = links.sanitize_imported_spatial_outputs(nodes)
    assert warnings == ["2 invalid spatial outputs were made unavailable."]
    assert nodes[0]["data"]["outputs"] == {"good": good}


@pytest.mark.parametrize("case", SHARED["spatial"], ids=lambda case: case["name"])
def test_a_world_or_spatial_output_is_never_kept_where_the_canvas_drops_it(case):
    """The shared cases name what the canvas keeps (the vitest twin runs its
    sanitizeImportedSpatialOutputs) and what this subset keeps: never more."""
    nodes = copy.deepcopy(case["nodes"])
    warnings = links.sanitize_imported_spatial_outputs(nodes)
    kept = {node["id"]: list(node["data"]["outputs"]) for node in nodes}
    assert warnings == case["backend"]["warnings"]
    assert kept == case["backend"]["kept"]
    for node_id, ports in kept.items():
        assert set(ports) <= set(case["canvas"]["kept"][node_id])


@pytest.mark.parametrize("case", SHARED["worldUrls"], ids=lambda case: _short(case["value"]))
def test_world_urls_are_judged_as_the_canvas_judges_them(case):
    assert links.is_safe_world_url(case["value"]) is case["expected"]


# -- the restore route's rewriteLinks flag ---------------------------------------------

def _bundle(graph: dict, assets: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("graph.json", json.dumps(graph))
        for name, data in assets.items():
            archive.writestr(f"assets/{name}", data)
    return buffer.getvalue()


def _graph_with_picture() -> dict:
    return {"version": 3, "paramsVersion": 1, "name": "Glass", "createdAt": "2026-10-24T00:00:00.000Z",
            "nodes": [{"id": "a", "type": "model-node", "position": {"x": 0, "y": 0},
                       "data": {"label": "Picture", "definitionId": "image-input",
                                "params": {"filePath": "/api/outputs/old/pic.png"},
                                "outputs": {"image": {"type": "Image", "value": "http://localhost:8000/api/outputs/old/pic.png"}}}},
                      {"id": "b", "type": "model-node", "position": {"x": 0, "y": 200},
                       "data": {"label": "Note", "definitionId": "text-input",
                                "params": {"value": "/api/outputs/old/gone.png"}, "outputs": {}}}],
            "edges": []}


@pytest.fixture
def restore_client(tmp_path, monkeypatch):
    import main

    monkeypatch.setattr(main, "OUTPUT_ROOT", tmp_path)
    return TestClient(main.app)


def test_restore_with_rewrite_links_answers_a_graph_ready_to_import(restore_client, tmp_path):
    zipped = _bundle(_graph_with_picture(), {"old/pic.png": b"\x89PNG\r\n\x1a\nPIC"})
    resp = restore_client.post("/api/outputs/restore", params={"rewriteLinks": "true"}, content=zipped,
                               headers={"content-type": "application/zip", "X-Nebula-Agent": "Claude Code"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    served = body["urlMapping"]["old/pic.png"]
    node = body["graph"]["nodes"][0]["data"]
    assert node["params"]["filePath"] == served and node["outputs"]["image"]["value"] == served
    assert body["graph"]["nodes"][1]["data"]["params"]["value"] is None
    assert body["warnings"] == ["Bundled asset unavailable: old/gone.png"]
    rel = served.removeprefix("/api/outputs/")
    assert (tmp_path / rel).read_bytes() == b"\x89PNG\r\n\x1a\nPIC"


def test_restore_without_the_flag_answers_as_it_always_has(restore_client):
    # The person's Load graph rewrites in the tab: its answer is unchanged.
    graph = _graph_with_picture()
    resp = restore_client.post("/api/outputs/restore", content=_bundle(graph, {"old/pic.png": b"PIC"}),
                               headers={"content-type": "application/zip"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"graph", "urlMapping"}
    assert body["graph"] == graph


def test_restore_with_the_flag_keeps_its_checks(restore_client):
    # Content type, origin and the graph's own validation still come first.
    zipped = _bundle(_graph_with_picture(), {})
    assert restore_client.post("/api/outputs/restore", params={"rewriteLinks": "true"}, content=zipped,
                               headers={"content-type": "text/plain"}).status_code == 415
    assert restore_client.post("/api/outputs/restore", params={"rewriteLinks": "true"}, content=zipped,
                               headers={"content-type": "application/zip",
                                        "origin": "https://evil.example"}).status_code == 403
    not_graph = io.BytesIO()
    with zipfile.ZipFile(not_graph, "w") as archive:
        archive.writestr("photo.png", b"PIC")
    refused = restore_client.post("/api/outputs/restore", params={"rewriteLinks": "true"},
                                  content=not_graph.getvalue(), headers={"content-type": "application/zip"})
    assert refused.status_code == 400 and "graph.json" in refused.json()["detail"]
