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
