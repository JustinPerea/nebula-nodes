import pytest
from handlers.remotion_node import handle_remotion_node
from models.graph import GraphNode


@pytest.fixture(autouse=True)
def _mock_renderer(monkeypatch, tmp_path):
    output = tmp_path / "render.mp4"
    output.write_bytes(b"rendered")

    async def fake_render(manifest, *, on_progress=None):
        if on_progress is not None:
            on_progress(1.0)
        return output

    monkeypatch.setattr("handlers.remotion_node.render_remotion_manifest", fake_render)


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="remotion-test", definitionId="remotion-node", params=params or {})


@pytest.mark.asyncio
async def test_handler_returns_manifest_on_valid_input():
    manifest = {"graph": {"nodes": [], "edges": []}, "timeline": []}
    node = _node({"manifest": manifest})
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert "video" in result
    assert "manifest" in result
    assert result["video"]["type"] == "Video"
    assert result["video"]["value"].endswith("render.mp4")
    assert result["manifest"]["value"] == manifest


@pytest.mark.asyncio
async def test_handler_rejects_malformed_manifest():
    node = _node({"manifest": {"not_a_real": "shape"}})
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_handler_uses_empty_default_when_no_manifest_param():
    node = _node({})
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert result["manifest"]["value"] == {"graph": {"nodes": [], "edges": []}, "timeline": []}


@pytest.mark.asyncio
async def test_handler_rejects_explicit_empty_dict_manifest():
    node = _node({"manifest": {}})
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_handler_returns_fresh_empty_manifest_each_call():
    node1 = _node({})
    node2 = _node({})
    r1 = await handle_remotion_node(node1, inputs={}, api_keys={})
    r1["manifest"]["value"]["timeline"].append({"poisoning": True})
    r2 = await handle_remotion_node(node2, inputs={}, api_keys={})
    assert r2["manifest"]["value"]["timeline"] == []
