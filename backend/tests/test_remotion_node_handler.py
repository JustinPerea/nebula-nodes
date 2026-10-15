import pytest
from handlers.remotion_node import handle_remotion_node
from models.graph import GraphNode


@pytest.fixture(autouse=True)
def rendered(monkeypatch, tmp_path):
    """Manifests the handler handed to the (fake) renderer, in call order."""
    output = tmp_path / "render.mp4"
    output.write_bytes(b"rendered")
    manifests: list[dict] = []

    async def fake_render(manifest, *, on_progress=None):
        manifests.append(manifest)
        if on_progress is not None:
            on_progress(1.0)
        return output

    monkeypatch.setattr("handlers.remotion_node.render_remotion_manifest", fake_render)
    return manifests


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="remotion-test", definitionId="remotion-node", params=params or {})


@pytest.mark.asyncio
async def test_handler_renders_manifest_and_returns_only_declared_video(rendered):
    manifest = {"graph": {"nodes": [], "edges": []}, "timeline": []}
    node = _node({"manifest": manifest})
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    # Only the declared `video` port: an extra handle would make saving fail.
    assert set(result) == {"video"}
    assert result["video"]["type"] == "Video"
    assert result["video"]["value"].endswith("render.mp4")
    assert rendered == [manifest]


@pytest.mark.asyncio
async def test_handler_rejects_malformed_manifest():
    node = _node({"manifest": {"not_a_real": "shape"}})
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_handler_uses_empty_default_when_no_manifest_param(rendered):
    node = _node({})
    await handle_remotion_node(node, inputs={}, api_keys={})
    assert rendered == [{"graph": {"nodes": [], "edges": []}, "timeline": []}]


@pytest.mark.asyncio
async def test_handler_rejects_explicit_empty_dict_manifest():
    node = _node({"manifest": {}})
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})


@pytest.mark.asyncio
async def test_handler_returns_fresh_empty_manifest_each_call(rendered):
    node1 = _node({})
    node2 = _node({})
    await handle_remotion_node(node1, inputs={}, api_keys={})
    rendered[0]["timeline"].append({"poisoning": True})
    await handle_remotion_node(node2, inputs={}, api_keys={})
    assert rendered[1]["timeline"] == []
