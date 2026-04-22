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


def test_upload_valid_png_creates_node_and_file(client, monkeypatch):
    png_bytes = _make_png_bytes()
    resp = client.post(
        "/api/uploads",
        files={"file": ("example.png", png_bytes, "image/png")},
        data={"create_node": "true"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["nodeId"].startswith("n")
    assert body["url"].startswith("/api/outputs/chat-uploads/")
    assert body["url"].endswith(".png")
    assert body["thumbUrl"] == body["url"]
    assert body["filename"] == "example.png"

    # File exists on disk under our patched chat-uploads dir.
    hash_name = body["url"].split("/")[-1]
    saved = main_module.CHAT_UPLOADS_DIR / hash_name
    assert saved.exists()
    assert saved.read_bytes() == png_bytes

    # Node exists in cli_graph with expected params (canonical `filePath` key).
    node = main_module.cli_graph.nodes[body["nodeId"]]
    assert node["definitionId"] == "image-input"
    assert node["params"]["filePath"] == body["url"]
    assert node["params"]["_previewUrl"] == body["url"]


def test_upload_dedup_by_content_hash(client):
    png_bytes = _make_png_bytes()
    resp1 = client.post(
        "/api/uploads",
        files={"file": ("a.png", png_bytes, "image/png")},
        data={"create_node": "true"},
    )
    resp2 = client.post(
        "/api/uploads",
        files={"file": ("b.png", png_bytes, "image/png")},
        data={"create_node": "true"},
    )
    assert resp1.status_code == 200
    assert resp2.status_code == 200

    # Two distinct nodes in the graph...
    assert resp1.json()["nodeId"] != resp2.json()["nodeId"]

    # ...but the same file on disk.
    assert resp1.json()["url"] == resp2.json()["url"]
    saved_files = list(main_module.CHAT_UPLOADS_DIR.iterdir())
    assert len(saved_files) == 1


def test_upload_rejects_oversize(client):
    big = b"\x00" * (21 * 1024 * 1024)  # 21 MB
    resp = client.post(
        "/api/uploads",
        files={"file": ("big.png", big, "image/png")},
    )
    assert resp.status_code == 413
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_rejects_non_image(client):
    resp = client.post(
        "/api/uploads",
        files={"file": ("note.txt", b"hello world", "text/plain")},
    )
    assert resp.status_code == 415
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_rejects_fake_png(client):
    """A file claiming Content-Type: image/png but whose bytes aren't a PNG.
    Server-side MIME sniff must catch this."""
    resp = client.post(
        "/api/uploads",
        files={"file": ("fake.png", b"not really a png", "image/png")},
    )
    assert resp.status_code == 415
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0


def test_upload_rejects_tiny_signature_match(client):
    """A 3-byte payload that happens to match the JPEG signature prefix must
    be rejected. Otherwise we'd write a 3-byte file to disk and create a
    broken image-input node."""
    resp = client.post(
        "/api/uploads",
        files={"file": ("tiny.jpg", b"\xff\xd8\xff", "image/jpeg")},
    )
    assert resp.status_code == 415
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_no_create_node(client):
    """Default (no create_node flag) uploads and returns paths without
    creating a graph node."""
    png_bytes = _make_png_bytes()
    resp = client.post(
        "/api/uploads",
        files={"file": ("example.png", png_bytes, "image/png")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["url"].startswith("/api/outputs/chat-uploads/")
    assert body["url"].endswith(".png")
    assert "filePath" in body
    assert Path(body["filePath"]).is_absolute()
    assert body["filename"] == "example.png"
    # No nodeId / thumbUrl in the default response.
    assert "nodeId" not in body
    assert "thumbUrl" not in body
    # And no node in cli_graph.
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_create_node_false_explicit(client):
    """Explicit create_node=false matches the default no-create behavior."""
    png_bytes = _make_png_bytes()
    resp = client.post(
        "/api/uploads",
        files={"file": ("example.png", png_bytes, "image/png")},
        data={"create_node": "false"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "nodeId" not in body
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_create_node_truthy_variants(client):
    """create_node accepts 'true', '1', 'yes' case-insensitively."""
    for variant in ["true", "TRUE", "True", "1", "yes", "YES"]:
        main_module.cli_graph = CLIGraph()  # reset between iterations
        resp = client.post(
            "/api/uploads",
            files={"file": ("x.png", _make_png_bytes(), "image/png")},
            data={"create_node": variant},
        )
        assert resp.status_code == 200, f"failed for {variant!r}"
        assert "nodeId" in resp.json(), f"no nodeId for {variant!r}"
        assert len(main_module.cli_graph.nodes) == 1


def test_upload_no_create_still_validates(client):
    """Upload-only path still enforces MIME sniff, size cap, and min size."""
    # Wrong MIME.
    resp = client.post(
        "/api/uploads",
        files={"file": ("fake.png", b"not a real image", "image/png")},
    )
    assert resp.status_code == 415
    # Oversize.
    big = b"\x00" * (21 * 1024 * 1024)
    resp = client.post(
        "/api/uploads",
        files={"file": ("big.png", big, "image/png")},
    )
    assert resp.status_code == 413
    # Too small.
    resp = client.post(
        "/api/uploads",
        files={"file": ("tiny.jpg", b"\xff\xd8\xff", "image/jpeg")},
    )
    assert resp.status_code == 415


def test_sync_outputs_to_cli_graph_populates_image_output(client):
    """When /api/execute emits an ExecutedEvent, the node's outputs should
    land in cli_graph so GET /api/graph/node/{id}/path can resolve them."""
    main_module.cli_graph.add_node("nano-banana", {"model": "nano-banana"})
    # Simulate the handler's emit payload.
    main_module._sync_outputs_to_cli_graph(
        "n1",
        {"image": {"type": "Image", "value": "/api/outputs/generated/run-output.png"}},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    assert resp.json()["path"].endswith("generated/run-output.png")


def test_sync_outputs_to_cli_graph_wraps_bare_values(client):
    """Handlers that emit raw string values get wrapped in the {type, value}
    shape expected by the resolver, matching /api/graph/run's post-hoc loop."""
    main_module.cli_graph.add_node("some-model", {})
    main_module._sync_outputs_to_cli_graph("n1", {"image": "/api/outputs/bare.png"})
    node = main_module.cli_graph.nodes["n1"]
    assert node["outputs"] == {"image": {"type": "Any", "value": "/api/outputs/bare.png"}}


def test_sync_outputs_to_cli_graph_missing_node_noops(client):
    """Syncing outputs for a node that isn't in cli_graph (e.g. a temp
    _quick_input_ node) should silently no-op, not raise."""
    main_module._sync_outputs_to_cli_graph("n999", {"image": "/api/outputs/x.png"})
    # No exception, no nodes added.
    assert "n999" not in main_module.cli_graph.nodes
