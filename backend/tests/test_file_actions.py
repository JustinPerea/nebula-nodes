"""Tests for /api/reveal and /api/export endpoints."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import app  # noqa: E402
from services import output as output_mod
from services.settings import DEFAULT_SETTINGS


@pytest.fixture()
def client():
    return TestClient(app)


# ─── /api/export ──────────────────────────────────────────────────────────────

def test_export_copies_file_to_export_folder(tmp_path, monkeypatch):
    """Export copies the output file into the configured exportFolder."""
    # Create a fake output file under the test OUTPUT_ROOT
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    # Also patch main.OUTPUT_ROOT so _output_path_from_ref resolves correctly
    import main as main_module
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)

    src_dir = tmp_path / "run1"
    src_dir.mkdir(parents=True)
    src_file = src_dir / "result.png"
    src_file.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)

    export_dir = tmp_path / "exports"

    # Monkeypatch load_settings to return our exportFolder
    fake_settings = {**DEFAULT_SETTINGS, "exportFolder": str(export_dir)}
    monkeypatch.setattr(main_module, "load_settings", lambda: fake_settings)

    client = TestClient(app)
    resp = client.post("/api/export", json={"url": "/api/outputs/run1/result.png"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "ok"
    saved = Path(data["savedPath"])
    assert saved.exists()
    assert saved.read_bytes() == src_file.read_bytes()


def test_export_collision_avoidance(tmp_path, monkeypatch):
    """Export appends -1, -2, ... when destination file already exists."""
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    import main as main_module
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)

    src_dir = tmp_path / "run2"
    src_dir.mkdir(parents=True)
    src_file = src_dir / "img.png"
    src_file.write_bytes(b"data")

    export_dir = tmp_path / "exports2"
    export_dir.mkdir(parents=True)
    # Pre-create the target to force collision
    (export_dir / "img.png").write_bytes(b"existing")

    fake_settings = {**DEFAULT_SETTINGS, "exportFolder": str(export_dir)}
    monkeypatch.setattr(main_module, "load_settings", lambda: fake_settings)

    client = TestClient(app)
    resp = client.post("/api/export", json={"url": "/api/outputs/run2/img.png"})
    assert resp.status_code == 200, resp.text
    saved = Path(resp.json()["savedPath"])
    assert saved.name == "img -1.png"
    assert saved.read_bytes() == b"data"


def test_export_rejects_non_output_url(client):
    """Export returns 400 for a URL that is not under /api/outputs."""
    resp = client.post("/api/export", json={"url": "https://example.com/evil.png"})
    assert resp.status_code == 400


def test_export_rejects_path_traversal(client):
    """Export returns 400 for a path-traversal attempt."""
    resp = client.post("/api/export", json={"url": "/api/outputs/../../etc/passwd"})
    assert resp.status_code == 400


# ─── /api/reveal ──────────────────────────────────────────────────────────────

def test_reveal_returns_ok_for_valid_output(tmp_path, monkeypatch):
    """Reveal returns 200 for a valid output URL (subprocess launch mocked)."""
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    import main as main_module
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", tmp_path)

    src_dir = tmp_path / "run3"
    src_dir.mkdir(parents=True)
    (src_dir / "clip.mp4").write_bytes(b"fake-mp4")

    # Mock asyncio.create_subprocess_exec to avoid actually launching open/xdg-open
    mock_proc = AsyncMock()
    with patch("asyncio.create_subprocess_exec", return_value=mock_proc) as mock_exec:
        client = TestClient(app)
        resp = client.post("/api/reveal", json={"url": "/api/outputs/run3/clip.mp4"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ok"
    mock_exec.assert_called_once()


def test_reveal_rejects_non_output_url(client):
    """Reveal returns 400 for a URL that is not under /api/outputs."""
    resp = client.post("/api/reveal", json={"url": "https://example.com/secret.png"})
    assert resp.status_code == 400


def test_reveal_rejects_path_traversal(client):
    """Reveal returns 400 for a path-traversal attempt."""
    resp = client.post("/api/reveal", json={"url": "/api/outputs/../../etc/passwd"})
    assert resp.status_code == 400
