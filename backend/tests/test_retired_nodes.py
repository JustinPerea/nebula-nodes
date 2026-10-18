"""Saved-graph migrations for models their makers shut down (services/retired_nodes.py)."""
from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest

from services import retired_nodes
from services.retired_nodes import migrate_node


def _on(day: date):
    return patch("services.retired_nodes._today", return_value=day)


@pytest.mark.parametrize("saved,expected", [
    ("veo-3.1-generate-preview", "veo-3.1-generate-001"),
    ("veo-3.1-fast-generate-preview", "veo-3.1-fast-generate-001"),
    ("veo-3.1-lite-generate-preview", "veo-3.1-lite-generate-001"),
    ("veo-3.0-generate-001", "veo-3.1-generate-001"),
    ("veo-3.0-fast-generate-001", "veo-3.1-fast-generate-001"),
    ("veo-2.0-generate-001", "veo-3.1-generate-001"),
    ("veo-3.1-generate-001", "veo-3.1-generate-001"),
])
def test_veo_saved_models_land_on_vertex_ids(saved, expected):
    definition_id, params, label = migrate_node("veo-3", {"model": saved, "resolution": "1080p"}, "Shot 1")
    assert definition_id == "veo-3"
    assert params == {"model": expected, "resolution": "1080p"}
    assert label == "Shot 1"


def test_veo_migration_targets_are_node_options():
    from services.node_registry import NodeRegistry

    veo = NodeRegistry().get_all()["veo-3"]
    options = {o["value"] for p in veo["directParams"] if p["key"] == "model" for o in p["options"]}
    assert set(retired_nodes._VEO_MODELS.values()) <= options
    assert not (set(retired_nodes._VEO_MODELS) & options), "a retired ID is still offered"


@pytest.mark.parametrize("definition_id,replacement", [
    ("gpt-image-1-generate", "gpt-image-2.5-flare"),
    ("gpt-image-1-edit", "gpt-image-2.5-sunburst"),
])
def test_gpt_image_1_moves_to_2_5_only_from_its_shutdown(definition_id, replacement):
    saved = {"model": "gpt-image-1", "size": "1536x1024", "quality": "high", "_note": "hero"}
    with _on(date(2026, 10, 22)):
        assert migrate_node(definition_id, saved)[1] == saved, "it still works until 2026-10-23"
    with _on(date(2026, 10, 23)):
        definition_id_after, params, _ = migrate_node(definition_id, saved)
    assert definition_id_after == definition_id
    assert params == {**saved, "model": replacement}
    with _on(date(2026, 12, 1)):
        assert migrate_node(definition_id, {"model": "gpt-image-1.5"})[1] == {"model": "gpt-image-1.5"}


@pytest.mark.parametrize("definition_id,default", [
    ("gpt-image-1-generate", "gpt-image-2.5-flare"),
    ("gpt-image-1-edit", "gpt-image-2.5-sunburst"),
])
def test_gpt_image_replacements_are_offered_and_default(definition_id, default):
    from services.node_registry import NodeRegistry

    definition = NodeRegistry().get_all()[definition_id]
    model = next(p for p in definition["params"] if p["key"] == "model")
    values = [o["value"] for o in model["options"]]
    assert values[:3] == ["gpt-image-1", "gpt-image-1.5", "gpt-image-1-mini"], "existing options keep their order"
    assert {"gpt-image-2.5-flare", "gpt-image-2.5-sunburst"} <= set(values)
    assert model["default"] == default


def test_saved_sora_2_loads_as_veo_3_1_fast_with_a_title_that_says_so():
    definition_id, params, label = migrate_node(
        "sora-2", {"resolution": "1080p", "aspect_ratio": "9:16", "duration": 12, "_editorNote": "x"},
    )
    assert definition_id == "veo-3"
    assert params == {"model": "veo-3.1-fast-generate-001", "aspectRatio": "9:16", "resolution": "1080p",
                      "duration": "8", "_editorNote": "x"}
    assert label == retired_nodes.SORA_2_LABEL


def test_sora_2_pro_becomes_veo_3_1_and_a_renamed_node_keeps_its_title():
    _, params, label = migrate_node("sora-2", {"model": "pro", "duration": 4}, "Opening shot")
    assert params == {"model": "veo-3.1-generate-001", "duration": "4"}
    assert label == "Opening shot"


def test_saved_sora_2_i2v_keeps_only_what_veo_accepts():
    definition_id, params, label = migrate_node(
        "sora-2-i2v", {"resolution": "auto", "aspect_ratio": "auto", "duration": 8},
    )
    assert definition_id == "veo-3"
    assert params == {"model": "veo-3.1-fast-generate-001", "duration": "8"}
    assert label == retired_nodes.SORA_2_I2V_LABEL


def test_sora_ports_exist_on_veo_so_saved_edges_keep_working():
    from services.node_registry import NodeRegistry

    veo = NodeRegistry().get_all()["veo-3"]
    assert {"prompt", "image"} <= {p["id"] for p in veo["inputPorts"]}
    assert "video" in {p["id"] for p in veo["outputPorts"]}


@pytest.mark.parametrize("definition_id", ["sora-2", "sora-2-i2v"])
def test_sora_retirement_message_names_the_alternatives(definition_id):
    from services.node_registry import NodeRegistry

    message = retired_nodes.retired_message(definition_id)
    assert "2026-09-24" in message
    for alternative in ("veo-3", "grok-imagine-video", "runway-video"):
        assert f"'{alternative}'" in message
        assert alternative in NodeRegistry().get_all()
    assert definition_id not in NodeRegistry().get_all(), "hidden for new graphs"


@pytest.mark.parametrize("definition_id", [
    "meshy-text-to-3d", "meshy-image-to-3d", "meshy-multi-image-to-3d", "meshy-retexture",
])
def test_saved_meshy_5_moves_to_meshy_6_now(definition_id):
    with _on(date(2026, 10, 14)):
        assert migrate_node(definition_id, {"ai_model": "meshy-5", "enable_pbr": True})[1] == {
            "ai_model": "meshy-6", "enable_pbr": True,
        }


@pytest.mark.parametrize("definition_id", ["meshy-text-to-3d", "meshy-image-to-3d"])
def test_meshy_lowpoly_moves_to_smart_topology_from_its_retirement(definition_id):
    saved = {"model_type": "lowpoly", "topology": "quad", "target_polycount": 30000, "ai_model": "latest"}
    with _on(date(2026, 10, 29)):
        assert migrate_node(definition_id, saved)[1] == saved, "it still works until 2026-10-30"
    with _on(date(2026, 10, 30)):
        params = migrate_node(definition_id, saved)[1]
    assert params == {"model_type": "smart-topology", "topology": "triangle",
                      "target_polycount": 15000, "ai_model": "latest"}
    with _on(date(2026, 10, 30)):
        assert migrate_node(definition_id, {"model_type": "lowpoly", "target_polycount": 5000})[1] == {
            "model_type": "smart-topology", "target_polycount": 5000,
        }
        assert migrate_node(definition_id, {"model_type": "standard"})[1] == {"model_type": "standard"}


def test_meshy_migration_targets_are_node_options():
    from services.node_registry import NodeRegistry

    defs = NodeRegistry().get_all()
    for definition_id in ("meshy-text-to-3d", "meshy-image-to-3d", "meshy-multi-image-to-3d", "meshy-retexture"):
        params = [p for group in ("params", "sharedParams", "directParams") for p in defs[definition_id].get(group, [])]
        values = {p["key"]: {o["value"] for o in p.get("options", [])} for p in params}
        assert "meshy-6" in values["ai_model"] and "meshy-5" not in values["ai_model"]
        if "model_type" in values:
            assert "smart-topology" in values["model_type"]


@pytest.mark.parametrize("saved,replacement", [
    ("gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts"),
    ("gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts"),
    ("gemini-3.1-flash-tts-preview", "gemini-3.8-flash-lite-tts"),
])
def test_gemini_tts_previews_move_to_3_8_from_their_shutdown(saved, replacement):
    params = {"model": saved, "voiceName": "Charon"}
    with _on(date(2026, 11, 16)):
        assert migrate_node("gemini-tts", params)[1] == params, "it still works until 2026-11-17"
    with _on(date(2026, 11, 17)):
        assert migrate_node("gemini-tts", params) == ("gemini-tts", {"model": replacement, "voiceName": "Charon"}, None)


def test_gemini_tts_replacements_are_offered_and_default():
    from services.node_registry import NodeRegistry

    model = next(p for p in NodeRegistry().get_all()["gemini-tts"]["params"] if p["key"] == "model")
    values = [o["value"] for o in model["options"]]
    assert set(retired_nodes._GEMINI_TTS_MODELS.values()) <= set(values)
    assert model["default"] == "gemini-3.8-flash-tts"
    assert values[:3] == [
        "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts",
    ], "saved option order is kept"


# -- folded Krea FLUX nodes (MERGED) ----------------------------------------------

FLUX_VIDEO = "krea-video-black-forest-labs-flux-3-video"
FLUX_EDIT = "krea-video-black-forest-labs-flux-video-edit"
FLUX_UPSCALE = "krea-enhance-black-forest-labs-flux-video-upscale"
FOLDED_FIXTURE = __import__("pathlib").Path(__file__).parent / "fixtures" / "krea_flux_folded.nebula"


def _registry():
    from services.node_registry import NodeRegistry

    return NodeRegistry().get_all()


def test_folded_ids_are_gone_and_their_new_nodes_have_a_krea_route():
    defs = _registry()
    for old, merged in retired_nodes.MERGED.items():
        assert old not in defs, "the old Krea copy is no longer a node"
        routes = [route["id"] for route in defs[merged["into"]]["routes"]]
        assert retired_nodes.MERGED_ROUTE in routes
    from services import node_route
    assert retired_nodes.PROVIDER_PARAM == node_route.PROVIDER_PARAM


def test_folded_port_and_value_maps_point_at_what_the_new_nodes_have():
    from services import node_route

    defs = _registry()
    for old, merged in retired_nodes.MERGED.items():
        new = defs[merged["into"]]
        inputs = {port["id"] for port in new["inputPorts"]}
        outputs = {port["id"] for port in new["outputPorts"]}
        assert set(merged["inputs"].values()) <= inputs, old
        assert {port for port in merged["outputs"].values() if port} <= outputs, old
        assert set(merged["typed"]) <= set(merged["inputs"]), old
        for input_id, value_key, output_port in merged["typed"].values():
            assert value_key in {p["key"] for p in defs[input_id]["params"]}
            assert output_port in {p["id"] for p in defs[input_id]["outputPorts"]}
        # Every translated value is one of the new node's options.
        keys = node_route.route_param_keys(new, "krea")
        migrated = merged["params"]({})
        assert set(migrated) - {"_provider", "_kreaAuth"} <= keys


@pytest.mark.parametrize("old,saved,expected", [
    (FLUX_VIDEO, {"_kreaAuth": "mcp", "prompt": "comet", "start_image": "https://x/a.png", "duration": 8,
                  "resolution": "1080p", "aspect_ratio": "21:9", "generate_audio": False, "_previewUrl": "/p.png"},
     {"_provider": "krea", "_kreaAuth": "mcp", "duration": 8, "resolution": "fhd", "aspect_ratio": "21:9",
      "generate_audio": False, "_previewUrl": "/p.png"}),
    (FLUX_VIDEO, {"resolution": "720p"}, {"_provider": "krea", "_kreaAuth": "api-token", "resolution": "hd"}),
    (FLUX_EDIT, {"prompt": "night", "start_video": "https://x/a.mp4", "_kreaAuth": "mcp"},
     {"_provider": "krea", "_kreaAuth": "mcp"}),
    (FLUX_UPSCALE, {"creativity": "precise", "upscale_factor": 2.5, "video_url": "https://x/a.mp4"},
     {"_provider": "krea", "_kreaAuth": "api-token", "creativity": 0, "upscale_factor": 2.5}),
    (FLUX_UPSCALE, {"creativity": "creative"}, {"_provider": "krea", "_kreaAuth": "api-token", "creativity": 1}),
    # A hand-edited value outside the old options stays; the run then stops before billing.
    (FLUX_VIDEO, {"resolution": "4k"}, {"_provider": "krea", "_kreaAuth": "api-token", "resolution": "4k"}),
])
def test_a_folded_node_loads_on_the_krea_route_with_its_billing_mode(old, saved, expected):
    definition_id, params, label = migrate_node(old, saved)
    assert definition_id == retired_nodes.MERGED[old]["into"]
    assert params == expected
    assert label is None, "an unrenamed node takes the new node's own name"


def test_a_renamed_folded_node_keeps_its_title():
    assert migrate_node(FLUX_VIDEO, {}, "Comet shot")[2] == "Comet shot"
    assert migrate_node(FLUX_VIDEO, {}, "Flux 3 Video (Krea)")[2] is None


def test_folded_retirement_message_names_the_new_node():
    assert retired_nodes.retired_message(FLUX_UPSCALE) == (
        f"'{FLUX_UPSCALE}' is now part of 'flux-video-upscale' (provider: Krea). Use 'flux-video-upscale' instead.")


def test_migrate_graph_remaps_ports_moves_typed_values_and_warns_on_dropped_outputs():
    nodes = [
        {"id": "t", "definitionId": "text-input", "params": {"value": "comet"}},
        {"id": "v", "definitionId": FLUX_VIDEO, "position": {"x": 400, "y": 0},
         "params": {"prompt": "ignored, the port is wired", "start_image": "https://x/a.png", "end_image": " "},
         "outputs": {"video": {"type": "Video", "value": "a.mp4"}, "videos": {"type": "Array", "value": []},
                     "artifacts": {"type": "Array", "value": []}}},
        {"id": "u", "definitionId": FLUX_UPSCALE, "label": "Final", "params": {"video_url": "https://x/b.mp4"}},
        {"id": "p", "definitionId": "preview", "label": "Look", "params": {}},
    ]
    edges = [
        {"id": "e1", "source": "t", "sourceHandle": "text", "target": "v", "targetHandle": "prompt"},
        {"id": "e2", "source": "v", "sourceHandle": "artifacts", "target": "p", "targetHandle": "input"},
        {"id": "e3", "source": "u", "sourceHandle": "video", "target": "p", "targetHandle": "input"},
    ]
    out_nodes, out_edges, warnings = retired_nodes.migrate_graph(nodes, edges)
    by_id = {node["id"]: node for node in out_nodes}
    assert by_id["t"] is nodes[0], "other nodes are untouched"
    assert by_id["v"]["definitionId"] == "flux-3-video" and "label" not in by_id["v"]
    assert by_id["v"]["outputs"] == {"video": {"type": "Video", "value": "a.mp4"}}
    assert by_id["u"]["definitionId"] == "flux-video-upscale" and by_id["u"]["label"] == "Final"
    # Typed values the new node only reads from ports: an input node wired to it.
    assert by_id["v-start_image"] == {"id": "v-start_image", "definitionId": "image-input",
                                       "params": {"filePath": "https://x/a.png"}, "position": {"x": 40.0, "y": 0.0}}
    assert by_id["u-video"] == {"id": "u-video", "definitionId": "video-input", "params": {"filePath": "https://x/b.mp4"}}
    assert "v-prompt" not in by_id and "v-end_image" not in by_id, "wired or blank values aren't moved"
    assert {"source": "v-start_image", "sourceHandle": "image", "target": "v", "targetHandle": "start_image"} in out_edges
    assert {"source": "u-video", "sourceHandle": "video", "target": "u", "targetHandle": "video"} in out_edges
    assert [edge.get("id") for edge in out_edges if edge.get("id")] == ["e1", "e3"]
    assert warnings == [
        "'Flux 3 Video (Krea)' no longer has its Krea 'All artifacts' output, so its connection to 'Look' was removed."]


def test_migrate_graph_places_added_input_nodes_clear_of_saved_nodes():
    # Saved nodes 400 px apart (the fixture's layout): 360 px to the left of
    # the folded node is on top of its neighbour, so the input node moves down
    # past it, and a second one moves past the first.
    nodes = [
        {"id": "t", "definitionId": "text-input", "params": {"value": "comet"}, "position": {"x": 0, "y": 0}},
        {"id": "v", "definitionId": FLUX_VIDEO, "position": {"x": 400, "y": 0},
         "params": {"prompt": "a comet", "start_image": "https://x/a.png"}},
    ]
    out_nodes, _, _ = retired_nodes.migrate_graph(nodes, [])
    by_id = {node["id"]: node for node in out_nodes}
    assert by_id["v-prompt"]["position"] == {"x": 40.0, "y": 400.0}
    assert by_id["v-start_image"]["position"] == {"x": 40.0, "y": 800.0}


def test_migrate_graph_leaves_a_graph_without_folded_nodes_alone():
    nodes = [{"id": "a", "definitionId": "text-input", "params": {}}]
    assert retired_nodes.migrate_graph(nodes, [], key="id") == (nodes, [], [])


def test_migrate_graph_passes_a_malformed_graph_through_without_raising():
    # Imports, project files and the boot state arrive unvalidated; staging
    # refuses these as it did before the fold, so migration must not raise.
    unhashable = [{"id": "a", "definitionId": ["x"]}]
    assert retired_nodes.migrate_graph(unhashable, []) == (unhashable, [], [])
    nodes = [{"id": "v", "definitionId": FLUX_VIDEO, "params": {}}, "not a node",
             {"id": "p", "definitionId": "preview"}]
    edges = [{"source": "v", "sourceHandle": ["video"], "target": "p", "targetHandle": "in"},
             {"source": "p", "sourceHandle": "out", "target": "v", "targetHandle": {"x": 1}}, 7]
    out_nodes, out_edges, warnings = retired_nodes.migrate_graph(nodes, edges)
    assert out_nodes[0]["definitionId"] == "flux-3-video" and out_nodes[1] == "not a node"
    assert out_edges == edges and warnings == []


def test_migrate_graph_skips_a_position_it_cannot_place_by():
    nodes = [{"id": "v", "definitionId": FLUX_VIDEO, "params": {"prompt": "a comet"},
              "position": {"x": 10 ** 400, "y": float("nan")}}]
    out_nodes, _, _ = retired_nodes.migrate_graph(nodes, [])
    added = [node for node in out_nodes if node["definitionId"] == "text-input"]
    assert len(added) == 1 and "position" not in added[0]


def test_migrate_graph_places_by_a_huge_coordinate_without_looping():
    # At y = 1e18, y + 40 == y: a step-by-step search for a free spot never ends.
    import threading

    nodes = [
        {"id": "t", "definitionId": "text-input", "params": {}, "position": {"x": -360, "y": 1e18}},
        {"id": "v", "definitionId": FLUX_VIDEO, "params": {"prompt": "a comet"}, "position": {"x": 0, "y": 1e18}},
    ]
    result: list = []
    worker = threading.Thread(target=lambda: result.append(retired_nodes.migrate_graph(nodes, [])), daemon=True)
    worker.start()
    worker.join(5)
    assert not worker.is_alive(), "migrate_graph didn't return"
    added = next(node for node in result[0][0] if node["id"] == "v-prompt")
    assert added["position"]["y"] >= 1e18 + 400


def test_an_import_with_a_malformed_node_is_refused_not_a_server_error(app_client):
    _main, client = app_client
    response = client.post("/api/graph/import", json={"nodes": [
        {"id": "a", "definitionId": ["krea-video-black-forest-labs-flux-3-video"], "params": {}},
        {"id": "b", "definitionId": FLUX_VIDEO, "params": {}}], "edges": []})
    assert 400 <= response.status_code < 500, response.text


def test_a_saved_state_file_loads_the_folded_nodes_with_fresh_ids(tmp_path):
    import json

    from services.cli_graph import CLIGraph

    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [
        {"id": "n1", "definitionId": FLUX_EDIT, "params": {"prompt": "night", "_kreaAuth": "mcp"}},
        {"id": "n2", "definitionId": FLUX_UPSCALE, "params": {"creativity": "precise"}},
    ], "edges": [
        {"id": "e1", "source": "n1", "sourceHandle": "video", "target": "n2", "targetHandle": "video_url"},
    ], "counter": 2}))
    graph = CLIGraph()
    graph.load(path)
    assert graph.nodes["n1"]["definitionId"] == "flux-video-edit"
    assert graph.nodes["n1"]["params"] == {"_provider": "krea", "_kreaAuth": "mcp"}
    assert graph.nodes["n3"] == {"id": "n3", "definitionId": "text-input", "params": {"value": "night"}}
    assert graph.nodes["n2"]["params"] == {"_provider": "krea", "_kreaAuth": "api-token", "creativity": 0}
    assert graph.edges == [
        {"id": "e1", "source": "n1", "sourceHandle": "video", "target": "n2", "targetHandle": "video"},
        {"id": "e2", "source": "n3", "sourceHandle": "text", "target": "n1", "targetHandle": "prompt"},
    ]
    assert graph._counter == 3
    assert graph.add_node("preview", {}) == "n4"


def _fixture_import_body() -> dict:
    """The fixture as the canvas sends it (GraphFileActions.load)."""
    import json

    saved = json.loads(FOLDED_FIXTURE.read_text())
    return {
        "nodes": [{"id": n["id"], "definitionId": n["data"]["definitionId"], "label": n["data"]["label"],
                   "params": n["data"]["params"], "outputs": n["data"].get("outputs") or {}, "position": n["position"]}
                  for n in saved["nodes"]],
        "edges": [{"source": e["source"], "sourceHandle": e["sourceHandle"], "target": e["target"],
                   "targetHandle": e["targetHandle"]} for e in saved["edges"]],
    }


EXPECTED_FIXTURE_WARNINGS = [
    "'Comet shot' no longer has its Krea 'All videos' output, so its connection to 'Array Selector' was removed.",
    "'Flux Video Upscale (Krea)' no longer has its Krea 'Job' output, so its connection to 'Preview' was removed.",
]


@pytest.fixture
def app_client(monkeypatch):
    import main
    from fastapi.testclient import TestClient

    from services.cli_graph import CLIGraph

    monkeypatch.setattr(main, "cli_graph", CLIGraph())
    monkeypatch.setattr(main, "_is_person_request", lambda: True)
    return main, TestClient(main.app)


def test_a_saved_nebula_graph_with_all_three_loads_as_the_new_nodes(app_client):
    main, client = app_client
    response = client.post("/api/graph/import", json=_fixture_import_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["warnings"] == EXPECTED_FIXTURE_WARNINGS
    nodes = {n["definitionId"]: n for n in main.cli_graph.nodes.values()}
    video, edit, upscale = nodes["flux-3-video"], nodes["flux-video-edit"], nodes["flux-video-upscale"]
    assert video["label"] == "Comet shot"
    assert video["params"] == {"_provider": "krea", "_kreaAuth": "mcp", "duration": 8, "resolution": "fhd",
                               "aspect_ratio": "21:9", "generate_audio": False}
    assert video["outputs"] == {"video": {"type": "Video", "value": "https://example.com/comet.mp4"}}
    assert edit["params"] == {"_provider": "krea", "_kreaAuth": "api-token"} and "label" not in edit
    assert upscale["params"] == {"_provider": "krea", "_kreaAuth": "api-token", "creativity": 0, "upscale_factor": 2.5}
    image_input = nodes["image-input"]
    assert image_input["params"]["filePath"] == "https://example.com/start.png"
    texts = [n for n in main.cli_graph.nodes.values() if n["definitionId"] == "text-input"]
    assert sorted(n["params"]["value"] for n in texts) == ["A comet over a frozen lake", "Make it night"]
    by_id = {n["id"]: n["definitionId"] for n in main.cli_graph.nodes.values()}
    wires = sorted((by_id[e["source"]], e["sourceHandle"], by_id[e["target"]], e["targetHandle"])
                   for e in main.cli_graph.edges)
    assert wires == sorted([
        ("text-input", "text", "flux-3-video", "prompt"),
        ("image-input", "image", "flux-3-video", "start_image"),
        ("flux-3-video", "video", "flux-video-edit", "start_video"),
        ("text-input", "text", "flux-video-edit", "prompt"),
        ("flux-video-edit", "video", "flux-video-upscale", "video"),
    ])
    # The canvas gets the new nodes, titled by the new node's name when unrenamed.
    labels = {n["data"]["definitionId"]: n["data"]["label"] for n in body["nodes"]}
    assert labels["flux-3-video"] == "Comet shot"


def test_an_agent_import_keeps_the_billing_rule_the_old_node_had(app_client, monkeypatch):
    main, client = app_client
    monkeypatch.setattr(main, "_is_person_request", lambda: False)
    # Plan billing (mcp) on a new node is the person's call, as it was on the old one.
    refused = client.post("/api/graph/import", json=_fixture_import_body())
    assert refused.status_code == 403 and "_kreaAuth" in refused.json()["detail"]
    # The Krea route itself isn't the agent's change: loading on the API token passes.
    body = _fixture_import_body()
    for node in body["nodes"]:
        node["params"].pop("_kreaAuth", None)
    assert client.post("/api/graph/import", json=body).status_code == 200
    # A new node an agent sets to Krea itself is still refused.
    direct = client.post("/api/graph/import", json={"nodes": [
        {"id": "a", "definitionId": "flux-3-video", "params": {"_provider": "krea"}}], "edges": []})
    assert direct.status_code == 403 and "_provider" in direct.json()["detail"]


def test_creating_a_folded_node_by_its_old_id_names_the_new_one(app_client):
    _main, client = app_client
    response = client.post("/api/graph/node", json={"definitionId": FLUX_VIDEO, "params": {}})
    assert response.status_code == 400
    assert "is now part of 'flux-3-video' (provider: Krea)" in response.json()["detail"]


def test_a_saved_project_with_the_folded_nodes_opens_as_the_new_nodes():
    import json

    import main

    saved = json.loads(FOLDED_FIXTURE.read_text())
    snapshot = {"nodes": saved["nodes"], "edges": saved["edges"], "runHistory": [], "viewport": saved["viewport"],
                "createSessionId": None}
    warnings: list[str] = []
    result, candidate = main._stage_project_snapshot(snapshot, historical={}, warnings=warnings)
    assert warnings == EXPECTED_FIXTURE_WARNINGS
    by_id = {node["id"]: node for node in result["nodes"]}
    assert by_id["video-1"]["data"]["definitionId"] == "flux-3-video"
    assert by_id["video-1"]["data"]["label"] == "Comet shot"
    assert by_id["edit-1"]["data"]["label"] == "FLUX Video Edit [fast]"
    assert by_id["video-1"]["data"]["params"]["_kreaAuth"] == "mcp"
    assert set(by_id["video-1"]["data"]["outputs"]) == {"video"}
    assert by_id["video-1-start_image"]["data"]["definitionId"] == "image-input"
    assert by_id["edit-1-prompt"]["data"]["params"] == {"value": "Make it night"}
    edges = {edge["id"]: edge for edge in result["edges"]}
    assert set(edges) == {"e1", "e2", "e3", "migrated-1", "migrated-2"}
    assert edges["e3"]["targetHandle"] == "video"
    assert edges["migrated-1"]["data"] == {"dataType": "Image"}
    assert {(e["source"], e["target"]) for e in candidate.edges} == {(e["source"], e["target"]) for e in result["edges"]}
    # Saved before the fold, the project's nodes read as what they load as, so
    # an autosave of the migrated canvas isn't an agent's billing change.
    before = main._snapshot_nodes(snapshot)
    assert before["video-1"] == {"definitionId": "flux-3-video", "params": by_id["video-1"]["data"]["params"]}


def test_a_restore_bundle_with_the_folded_nodes_validates():
    import json

    import main

    saved = json.loads(FOLDED_FIXTURE.read_text())
    assert main._validate_restore_graph(saved) is saved


@pytest.mark.parametrize("mode,keys,expected", [
    ("mcp", {"BFL_API_KEY": "b", "FAL_KEY": "f"}, ("plan", "krea")),
    ("api-token", {"BFL_API_KEY": "b", "FAL_KEY": "f", "KREA_API_TOKEN": "k"}, ("fallback", "krea")),
])
def test_a_migrated_node_runs_on_krea_the_way_it_billed_before(mode, keys, expected):
    from services import node_route

    defs = _registry()
    for old, merged in retired_nodes.MERGED.items():
        definition_id, params, _label = migrate_node(old, {"_kreaAuth": mode})
        route = node_route.select_route(defs[definition_id], params, keys)
        assert (route.kind, route.route_id) == expected, old
        assert route.block is None


def test_a_migrated_node_without_a_krea_token_stops_instead_of_moving_to_bfl():
    from services import node_route

    definition_id, params, _label = migrate_node(FLUX_VIDEO, {})
    route = node_route.select_route(_registry()[definition_id], params, {"BFL_API_KEY": "b"})
    assert route.kind == "unset" and route.route_id == "krea" and route.missing == ("KREA_API_TOKEN",)


def test_spend_limits_on_a_folded_node_carry_over_lower_wins():
    from services import agent_spend

    settings = {"agentSpend": {"sessionUsd": 5, "models": {
        FLUX_VIDEO: {"perRunUsd": 2, "sessionUsd": None},
        "flux-3-video": {"perRunUsd": 3, "sessionUsd": 10},
        FLUX_UPSCALE: {"perRunUsd": 1.5},
    }}}
    caps = agent_spend.caps_from_settings(settings)
    assert caps["models"] == {"flux-3-video": {"perRunUsd": 2.0, "sessionUsd": 10.0},
                              "flux-video-upscale": {"perRunUsd": 1.5, "sessionUsd": None}}
    # Settings shows and saves them under the new node.
    view = agent_spend.saved_caps_view(settings["agentSpend"])
    assert view["models"] == caps["models"]
    saved = agent_spend.validate_caps(settings["agentSpend"], _registry())
    assert saved["models"] == caps["models"]
    with pytest.raises(ValueError):
        agent_spend.validate_caps({"models": {"not-a-node": {"perRunUsd": 1}}}, _registry())


def test_spend_recorded_under_a_folded_node_counts_toward_its_new_node(tmp_path):
    from services import agent_spend

    ledger = agent_spend.SpendLedger(tmp_path / "spend.json")
    ledger.record("chat:a", "Chat", {FLUX_VIDEO: 0.4})
    ledger.record("chat:a", "Chat", {"flux-3-video": 0.6})
    assert ledger.spent("chat:a").models == {"flux-3-video": 1.0}
    ledger.record("outside:shared", "Outside", {FLUX_EDIT: 0.3})
    assert ledger.spent("outside:shared").models == {"flux-video-edit": 0.3}


def test_a_cluster_with_a_folded_node_lands_as_the_new_node(app_client):
    main, client = app_client
    response = client.post("/api/graph/cluster", json={"nodes": [
        {"tempId": "up", "definitionId": FLUX_UPSCALE, "params": {"creativity": "creative", "video_url": "https://x/a.mp4"}},
    ], "edges": []})
    assert response.status_code == 200, response.text
    created = {main.cli_graph.nodes[n]["definitionId"]: main.cli_graph.nodes[n] for n in response.json()["idMap"].values()}
    assert created["flux-video-upscale"]["params"] == {"_provider": "krea", "_kreaAuth": "api-token", "creativity": 1}
    assert created["video-input"]["params"] == {"filePath": "https://x/a.mp4"}
    assert [(e["sourceHandle"], e["targetHandle"]) for e in main.cli_graph.edges] == [("video", "video")]
