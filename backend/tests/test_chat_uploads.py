from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import main as main_module
from main import app
from services.cli_graph import CLIGraph
from services.ffmpeg import ProbeResult
from services.output import OUTPUT_ROOT


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


def _make_mp4_bytes() -> bytes:
    """Minimal MP4 header bytes that pass _sniff_video_type. Not a real
    playable video — tests that need ffprobe results must mock the probe."""
    # ftyp box with 'isom' brand.
    return b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00" + b"\x00" * 100


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


def test_node_path_for_image_input_with_absolute_filepath(client):
    """Nodes created by /api/uploads?create_node=true store filePath as an
    absolute local path. The node-path endpoint must resolve that directly
    (it's already under OUTPUT_ROOT) rather than returning 'not local'."""
    # Construct a path under OUTPUT_ROOT.
    test_abs_path = str((OUTPUT_ROOT / "chat-uploads" / "absolute.png").resolve())
    main_module.cli_graph.add_node(
        "image-input",
        {"filePath": test_abs_path, "_previewUrl": "/api/outputs/chat-uploads/absolute.png"},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    assert resp.json()["path"] == test_abs_path


def test_node_path_for_moved_output_path(client):
    """Persisted state can carry absolute paths from an old repo location.
    If the same relative asset exists under the current OUTPUT_ROOT, resolve
    to the current path instead of treating the node as broken."""
    rel = Path("chat-uploads") / "moved-path.png"
    current = OUTPUT_ROOT / rel
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_bytes(_make_png_bytes())
    old_abs = f"/tmp/old-nebula/output/{rel.as_posix()}"

    main_module.cli_graph.add_node(
        "image-input",
        {"filePath": old_abs},
    )

    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    assert resp.json()["path"] == str(current.resolve())


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


def test_export_rewrites_moved_output_path(client):
    rel = Path("chat-uploads") / "moved-output.png"
    current = OUTPUT_ROOT / rel
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_bytes(_make_png_bytes())
    old_abs = f"/tmp/old-nebula/output/{rel.as_posix()}"

    main_module.cli_graph.add_node(
        "gpt-image-1-generate",
        {},
        outputs={"image": {"type": "Image", "value": old_abs}},
    )

    resp = client.get("/api/graph/export")
    assert resp.status_code == 200
    node = resp.json()["nodes"][0]
    assert node["data"]["outputs"]["image"]["value"] == f"/api/outputs/{rel.as_posix()}"


def test_export_normalizes_moved_image_input_params(client):
    rel = Path("chat-uploads") / "moved-input.png"
    current = OUTPUT_ROOT / rel
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_bytes(_make_png_bytes())
    old_abs = f"/tmp/old-nebula/output/{rel.as_posix()}"

    main_module.cli_graph.add_node(
        "image-input",
        {"filePath": old_abs},
    )

    resp = client.get("/api/graph/export")
    assert resp.status_code == 200
    params = resp.json()["nodes"][0]["data"]["params"]
    assert params["filePath"] == str(current.resolve())
    assert params["_previewUrl"] == f"/api/outputs/{rel.as_posix()}"


def test_execute_request_nodes_normalize_moved_image_input_params(client):
    rel = Path("chat-uploads") / "moved-execute.png"
    current = OUTPUT_ROOT / rel
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_bytes(_make_png_bytes())
    old_abs = f"/tmp/old-nebula/output/{rel.as_posix()}"

    node = main_module.GraphNode(
        id="n1",
        definitionId="image-input",
        params={"filePath": old_abs},
        outputs={},
    )

    normalized = main_module._normalize_execute_nodes([node])[0]
    assert normalized.params["filePath"] == str(current.resolve())
    assert normalized.params["_previewUrl"] == f"/api/outputs/{rel.as_posix()}"


def test_image_input_outside_output_root_auto_imports(client, tmp_path, monkeypatch):
    """image-input filePath pointing to a valid image OUTSIDE OUTPUT_ROOT
    (cross-project ref, CLI-set absolute path) gets copied into chat-uploads
    so the browser can preview it via /api/outputs. Stale outputs across the
    graph that referenced the old absolute path get rewritten in lock-step."""
    # Override OUTPUT_ROOT so the mocked chat-uploads lives under it — that
    # mirrors prod where CHAT_UPLOADS_DIR is OUTPUT_ROOT / "chat-uploads" and
    # lets _output_url_from_ref convert the migrated path to /api/outputs/...
    fake_root = tmp_path / "output"
    fake_root.mkdir()
    chat_uploads = fake_root / "chat-uploads"
    chat_uploads.mkdir()
    monkeypatch.setattr("main.OUTPUT_ROOT", fake_root)
    monkeypatch.setattr("main.CHAT_UPLOADS_DIR", chat_uploads)

    external_dir = tmp_path / "external"
    external_dir.mkdir()
    external = external_dir / "external-image.png"
    external.write_bytes(_make_png_bytes())
    external_abs = str(external.resolve())

    main_module.cli_graph.add_node("image-input", {"filePath": external_abs})
    main_module.cli_graph.add_node(
        "router",
        {},
        outputs={"out1": {"type": "Image", "value": external_abs}},
    )
    # Mirror prod state: prior execution left the image-input's own output
    # pointing at the external path; migration must rewrite that too.
    main_module.cli_graph.nodes["n1"]["outputs"] = {
        "image": {"type": "Image", "value": external_abs}
    }

    resp = client.get("/api/graph/export")
    assert resp.status_code == 200
    nodes = {n["id"]: n["data"] for n in resp.json()["nodes"]}

    img_input = nodes["n1"]
    new_preview_url = img_input["params"]["_previewUrl"]
    assert new_preview_url.startswith("/api/outputs/chat-uploads/")
    assert img_input["params"]["filePath"].endswith(new_preview_url.split("/")[-1])
    # Image-input's own output got rewritten to the URL form.
    assert img_input["outputs"]["image"]["value"] == new_preview_url
    # Router's stale cached output also got rewritten — preview chain stays intact.
    assert nodes["n2"]["outputs"]["out1"]["value"] == new_preview_url


def test_image_input_non_image_path_leaves_params_untouched(client, tmp_path):
    """Files that aren't recognized images don't get auto-imported — we
    don't want to silently copy arbitrary bytes into chat-uploads."""
    text_file = tmp_path / "not-an-image.txt"
    text_file.write_text("hello world")
    main_module.cli_graph.add_node("image-input", {"filePath": str(text_file.resolve())})

    resp = client.get("/api/graph/export")
    assert resp.status_code == 200
    params = resp.json()["nodes"][0]["data"]["params"]
    # filePath unchanged; no _previewUrl synthesized for a non-image.
    assert params["filePath"] == str(text_file.resolve())
    assert "_previewUrl" not in params or not params.get("_previewUrl")


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
    # filePath is the absolute local path handlers open(); _previewUrl is the URL
    # the frontend displays. The URL also appears in the response body for the
    # frontend to use.
    assert node["params"]["filePath"] == str(saved.resolve())
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


def test_sync_outputs_to_cli_graph_keeps_long_text_values(client):
    """Long prompt text is a Text output, not a candidate media path."""
    value = (
        "Create a square app-character concept image of a cute Shiba Inu inside "
        "an isometric cutaway dog house. " * 20
    ).strip()

    main_module.cli_graph.add_node("text-input", {"value": value})
    main_module._sync_outputs_to_cli_graph(
        "n1",
        {"text": {"type": "Text", "value": value}},
    )

    node = main_module.cli_graph.nodes["n1"]
    assert node["outputs"] == {"text": {"type": "Text", "value": value}}


def test_sync_outputs_to_cli_graph_stores_current_output_urls(client):
    rel = Path("generated") / "synced-output.png"
    current = OUTPUT_ROOT / rel
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_bytes(_make_png_bytes())

    main_module.cli_graph.add_node("some-model", {})
    main_module._sync_outputs_to_cli_graph(
        "n1",
        {"image": {"type": "Image", "value": str(current.resolve())}},
    )

    node = main_module.cli_graph.nodes["n1"]
    assert node["outputs"] == {
        "image": {"type": "Image", "value": f"/api/outputs/{rel.as_posix()}"}
    }


def test_sync_outputs_to_cli_graph_missing_node_noops(client):
    """Syncing outputs for a node that isn't in cli_graph (e.g. a temp
    _quick_input_ node) should silently no-op, not raise."""
    main_module._sync_outputs_to_cli_graph("n999", {"image": "/api/outputs/x.png"})
    # No exception, no nodes added.
    assert "n999" not in main_module.cli_graph.nodes


def test_upload_create_node_filepath_is_openable(client):
    """Regression: filePath on a chat-upload-created image-input node must be
    a real local path that handlers can open(), not the served URL."""
    png_bytes = _make_png_bytes()
    resp = client.post(
        "/api/uploads",
        files={"file": ("readable.png", png_bytes, "image/png")},
        data={"create_node": "true"},
    )
    assert resp.status_code == 200
    body = resp.json()
    node = main_module.cli_graph.nodes[body["nodeId"]]
    node_file_path = node["params"]["filePath"]
    # Must be absolute and openable.
    assert Path(node_file_path).is_absolute()
    assert Path(node_file_path).is_file()
    # And the bytes must round-trip.
    assert Path(node_file_path).read_bytes() == png_bytes


def test_video_upload_probes_and_stores_source_metadata(client):
    """Uploading a video should run ffprobe and store duration/fps/isVfr
    on the created node's params AND return them in the response."""
    fake_probe = ProbeResult(duration=12.5, fps=29.97, is_vfr=False)
    with patch("main.ffprobe_video", return_value=fake_probe):
        resp = client.post(
            "/api/uploads",
            files={"file": ("test.mp4", _make_mp4_bytes(), "video/mp4")},
            data={"create_node": "true"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sourceDuration"] == 12.5
    assert body["sourceFps"] == 29.97
    assert body["sourceIsVfr"] is False
    assert "nodeId" in body

    # Node params should have the same metadata so the frontend can read it
    # from sourceNode.data.params when spawning the edit node downstream.
    node = main_module.cli_graph.nodes[body["nodeId"]]
    assert node["params"]["sourceDuration"] == 12.5
    assert node["params"]["sourceFps"] == 29.97
    assert node["params"]["sourceIsVfr"] is False
    assert node["params"]["filePath"].endswith(".mp4")


def test_video_upload_ffprobe_failure_returns_415(client):
    """If ffprobe can't read the uploaded video (corrupt/unsupported),
    the upload should reject with 415 instead of creating a broken node."""
    with patch("main.ffprobe_video", side_effect=RuntimeError("bad codec")):
        resp = client.post(
            "/api/uploads",
            files={"file": ("test.mp4", _make_mp4_bytes(), "video/mp4")},
            data={"create_node": "true"},
        )
    assert resp.status_code == 415
    assert "Could not probe video metadata" in resp.json()["detail"]
