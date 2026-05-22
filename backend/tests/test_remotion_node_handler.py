import pytest
from handlers.remotion_node import handle_remotion_node


@pytest.mark.asyncio
async def test_handler_returns_manifest_on_valid_input():
    manifest = {"graph": {"nodes": [], "edges": []}, "timeline": []}
    node = {"id": "remotion-test-1", "params": {"manifest": manifest}}
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert "video" in result
    assert "manifest" in result
    assert result["manifest"] == manifest


@pytest.mark.asyncio
async def test_handler_rejects_malformed_manifest():
    node = {"id": "remotion-test-2", "params": {"manifest": {"not_a_real": "shape"}}}
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_handler_uses_empty_default_when_no_manifest_param():
    node = {"id": "remotion-test-3", "params": {}}
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert result["manifest"] == {"graph": {"nodes": [], "edges": []}, "timeline": []}
