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
