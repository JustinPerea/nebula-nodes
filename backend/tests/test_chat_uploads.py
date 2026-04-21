from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main as main_module
from main import app
from services.cli_graph import CLIGraph


@pytest.fixture(autouse=True)
def reset_graph_and_uploads(tmp_path, monkeypatch):
    """Reset cli_graph between tests and point chat-uploads at tmp_path so
    the real filesystem isn't touched. Each test starts with a clean graph
    and a clean chat-uploads dir."""
    main_module.cli_graph = CLIGraph()
    chat_uploads = tmp_path / "chat-uploads"
    chat_uploads.mkdir()
    monkeypatch.setattr("main.CHAT_UPLOADS_DIR", chat_uploads)
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _make_png_bytes() -> bytes:
    """A minimal valid 1x1 PNG."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )


def test_node_path_for_image_input(client):
    # Seed a minimal image-input node pointing at a file under OUTPUT_ROOT.
    main_module.cli_graph.add_node(
        "image-input",
        {"file": "/api/outputs/chat-uploads/ff.png",
         "_previewUrl": "/api/outputs/chat-uploads/ff.png"},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"].endswith("chat-uploads/ff.png")
    assert Path(body["path"]).is_absolute()


def test_node_path_for_image_input_via_filepath(client):
    """image-input nodes created via the canonical `filePath` schema param
    must resolve. This is the shape CLI creation and the Inspector UI use."""
    main_module.cli_graph.add_node(
        "image-input",
        {"filePath": "/api/outputs/chat-uploads/via-filepath.png"},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"].endswith("chat-uploads/via-filepath.png")
    assert Path(body["path"]).is_absolute()


def test_node_path_for_model_output(client):
    """A model node with an image output should resolve via outputs['image'],
    which is the shape real handlers produce."""
    main_module.cli_graph.add_node(
        "nano-banana",
        {"model": "nano-banana"},
    )
    # Mutate the seeded node to carry an output in the shape handlers produce.
    main_module.cli_graph.nodes["n1"]["outputs"] = {
        "image": {"type": "Image", "value": "/api/outputs/generated/xyz.png"}
    }
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"].endswith("generated/xyz.png")
    assert Path(body["path"]).is_absolute()


def test_node_path_for_unknown_node(client):
    resp = client.get("/api/graph/node/n99/path")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_node_path_for_text_input_rejects(client):
    main_module.cli_graph.add_node("text-input", {"value": "hello"})
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 400
    assert "no image file" in resp.json()["detail"].lower()


def test_node_path_for_external_url_rejects(client):
    main_module.cli_graph.add_node(
        "image-input",
        {"file": "https://example.com/foo.png",
         "_previewUrl": "https://example.com/foo.png"},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 400
    assert "not local" in resp.json()["detail"].lower()
