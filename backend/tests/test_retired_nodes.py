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
