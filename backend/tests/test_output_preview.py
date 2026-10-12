"""GET /api/graph/node/{id}/preview: a small image of a node's output that an
MCP client can show inline (view_output, run_nodes)."""
from __future__ import annotations

import io
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services import output_preview
from services.cli_graph import CLIGraph


@pytest.fixture
def api(tmp_path, monkeypatch):
    import main as main_module

    root = tmp_path / "output"
    root.mkdir()
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", root)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.root = root
    return ctx


def _node_with(api, outputs: dict) -> str:
    node_id = api.graph.add_node("nano-banana", {})
    api.graph.nodes[node_id]["outputs"] = outputs
    return node_id


def _noise(width: int, height: int, mode: str = "RGB") -> Image.Image:
    import os

    raw = os.urandom(width * height * len(mode))
    return Image.frombytes(mode, (width, height), raw)


def test_an_image_comes_back_downscaled_under_the_cap(api):
    _noise(3000, 2000).save(api.root / "big.png")
    node_id = _node_with(api, {"image": {"type": "Image", "value": "/api/outputs/big.png"}})
    response = api.client.get(f"/api/graph/node/{node_id}/preview", params={"size": "large"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-nebula-preview-port"] == "image"
    assert len(response.content) <= output_preview.MAX_BYTES
    shown = Image.open(io.BytesIO(response.content))
    assert max(shown.size) <= output_preview.SIZES["large"]


def test_transparency_stays_png(api):
    image = Image.new("RGBA", (200, 100), (255, 0, 0, 0))
    image.paste((0, 255, 0, 255), (50, 25, 150, 75))
    image.save(api.root / "cutout.png")
    node_id = _node_with(api, {"image": {"type": "Image", "value": "/api/outputs/cutout.png"}})
    response = api.client.get(f"/api/graph/node/{node_id}/preview", params={"size": "small"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(response.content)).mode == "RGBA"


def test_an_image_list_becomes_one_sheet(api):
    for index in range(5):
        Image.new("RGB", (300, 300), (index * 40, 0, 0)).save(api.root / f"v{index}.png")
    values = [f"/api/outputs/v{index}.png" for index in range(5)]
    node_id = _node_with(api, {"images": {"type": "Image", "value": values}})
    response = api.client.get(f"/api/graph/node/{node_id}/preview", params={"size": "small"})
    assert response.status_code == 200, response.text
    sheet = Image.open(io.BytesIO(response.content))
    assert sheet.width > sheet.height  # four tiles side by side, not one


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_a_video_becomes_three_frames(api):
    clip = api.root / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
         "-pix_fmt", "yuv420p", str(clip)],
        check=True,
    )
    node_id = api.graph.add_node("text-input", {})
    api.graph.nodes[node_id]["outputs"] = {"video": {"type": "Video", "value": "/api/outputs/clip.mp4"}}
    response = api.client.get(f"/api/graph/node/{node_id}/preview", params={"size": "small"})
    assert response.status_code == 200, response.text
    sheet = Image.open(io.BytesIO(response.content))
    assert sheet.width > 2 * sheet.height


def test_refusals(api):
    text = _node_with(api, {"text": {"type": "Text", "value": "hello"}})
    assert api.client.get(f"/api/graph/node/{text}/preview").status_code == 415

    external = _node_with(api, {"image": {"type": "Image", "value": "https://example.com/a.png"}})
    refused = api.client.get(f"/api/graph/node/{external}/preview")
    assert refused.status_code == 415 and "external URL" in refused.json()["detail"]

    escape = _node_with(api, {"image": {"type": "Image", "value": "/api/outputs/../../etc/passwd"}})
    assert api.client.get(f"/api/graph/node/{escape}/preview").status_code in (404, 415)

    gone = _node_with(api, {"image": {"type": "Image", "value": "/api/outputs/missing.png"}})
    assert api.client.get(f"/api/graph/node/{gone}/preview").status_code == 404

    empty = _node_with(api, {})
    assert "Run it first" in api.client.get(f"/api/graph/node/{empty}/preview").json()["detail"]
    assert api.client.get(f"/api/graph/node/{empty}/preview", params={"port": "image"}).status_code == 404
    assert api.client.get(f"/api/graph/node/{empty}/preview", params={"size": "huge"}).status_code == 400
    assert api.client.get("/api/graph/node/n999/preview").status_code == 404


def test_garbage_file_is_a_clear_error(api):
    (api.root / "broken.png").write_bytes(b"not an image")
    node_id = _node_with(api, {"image": {"type": "Image", "value": "/api/outputs/broken.png"}})
    response = api.client.get(f"/api/graph/node/{node_id}/preview")
    assert response.status_code == 422
    assert "Couldn't preview" in response.json()["detail"]
