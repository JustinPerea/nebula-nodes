import pytest
from handlers.remotion_node import handle_remotion_node
from models.graph import GraphNode


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="remotion-test", definitionId="remotion-node", params=params or {})


@pytest.mark.asyncio
async def test_handler_returns_manifest_on_valid_input():
    manifest = {"graph": {"nodes": [], "edges": []}, "timeline": []}
    node = _node({"manifest": manifest})
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert "video" in result
    assert "manifest" in result
    assert result["manifest"] == manifest


@pytest.mark.asyncio
async def test_handler_rejects_malformed_manifest():
    node = _node({"manifest": {"not_a_real": "shape"}})
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_handler_uses_empty_default_when_no_manifest_param():
    node = _node({})
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert result["manifest"] == {"graph": {"nodes": [], "edges": []}, "timeline": []}


@pytest.mark.asyncio
async def test_handler_rejects_explicit_empty_dict_manifest():
    node = _node({"manifest": {}})
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})
