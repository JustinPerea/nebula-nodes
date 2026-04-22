from __future__ import annotations

import pytest

from services.node_registry import NodeRegistry


@pytest.fixture
def registry():
    return NodeRegistry()


def test_loads_all_definitions(registry):
    nodes = registry.get_all()
    assert len(nodes) > 0
    first = next(iter(nodes.values()))
    assert "id" in first
    assert "displayName" in first
    assert "category" in first
    assert "envKeyName" in first


def test_get_by_id(registry):
    node = registry.get("gpt-image-1-generate")
    assert node is not None
    assert node["displayName"] == "GPT Image 1"
    assert node["category"] == "image-gen"


def test_get_unknown_returns_none(registry):
    assert registry.get("nonexistent-node") is None


def test_get_by_category(registry):
    image_nodes = registry.get_by_category("image-gen")
    assert len(image_nodes) > 0
    assert all(n["category"] == "image-gen" for n in image_nodes)


def test_get_categories(registry):
    cats = registry.get_categories()
    assert "image-gen" in cats
    assert "video-gen" in cats
    assert "text-gen" in cats


def test_get_nodes_for_key(registry):
    nodes = registry.get_nodes_for_key("OPENAI_API_KEY")
    assert len(nodes) > 0
    for n in nodes:
        key = n["envKeyName"]
        if isinstance(key, list):
            assert "OPENAI_API_KEY" in key
        else:
            assert key == "OPENAI_API_KEY"


def test_get_all_key_names(registry):
    keys = registry.get_all_key_names()
    assert "OPENAI_API_KEY" in keys
    assert "GOOGLE_API_KEY" in keys
    assert isinstance(keys, set)


def test_search_by_name(registry):
    results = registry.search("imagen")
    assert any("imagen" in n["id"] for n in results)


def test_search_case_insensitive(registry):
    results = registry.search("GPT")
    assert len(results) > 0


@pytest.mark.asyncio
async def test_gpt_image_2_nodes_registered() -> None:
    async def fake_emit(_e):
        return None
    from execution.sync_runner import get_handler_registry
    registry = get_handler_registry(emit=fake_emit)
    assert "gpt-image-2-generate" in registry
    assert "gpt-image-2-edit" in registry


@pytest.mark.asyncio
async def test_gpt_image_2_fal_nodes_registered() -> None:
    async def fake_emit(_e):
        return None
    from execution.sync_runner import get_handler_registry
    registry = get_handler_registry(emit=fake_emit)
    assert "gpt-image-2-fal-generate" in registry
    assert "gpt-image-2-fal-edit" in registry
