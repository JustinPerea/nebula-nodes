"""Tests for the configurable output-root feature.

Covers:
- _resolve_output_root() precedence (env > setting > default)
- GET /api/outputs/<rel> serve route (200, traversal → 404, missing → 404, fallback root)
- HTTP Range request returns 206 (video seeking parity)
- Traversal guard tested directly via the route handler (not httpx-normalised URLs)
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import app, serve_output  # noqa: E402
from services import output as output_mod
from services.output import _resolve_output_root, DEFAULT_OUTPUT_ROOT


# ─── _resolve_output_root() precedence ────────────────────────────────────────

def test_env_wins_over_setting_and_default(tmp_path, monkeypatch):
    """NEBULA_OUTPUT_ROOT env var takes highest precedence."""
    monkeypatch.setenv("NEBULA_OUTPUT_ROOT", str(tmp_path))
    fake_settings = {"outputPath": "/some/other/path"}
    with patch("services.output.load_settings", return_value=fake_settings):
        result = _resolve_output_root()
    assert result == tmp_path


def test_setting_used_when_no_env(tmp_path, monkeypatch):
    """outputPath from settings is used when NEBULA_OUTPUT_ROOT is unset."""
    monkeypatch.delenv("NEBULA_OUTPUT_ROOT", raising=False)
    fake_settings = {"outputPath": str(tmp_path)}
    with patch("services.output.load_settings", return_value=fake_settings):
        result = _resolve_output_root()
    assert result == tmp_path


def test_default_used_when_neither_env_nor_setting(monkeypatch):
    """Falls back to DEFAULT_OUTPUT_ROOT when env and setting are both absent."""
    monkeypatch.delenv("NEBULA_OUTPUT_ROOT", raising=False)
    fake_settings = {"outputPath": None}
    with patch("services.output.load_settings", return_value=fake_settings):
        result = _resolve_output_root()
    assert result == DEFAULT_OUTPUT_ROOT


def test_default_used_when_setting_load_raises(monkeypatch):
    """Falls back to DEFAULT_OUTPUT_ROOT when load_settings raises."""
    monkeypatch.delenv("NEBULA_OUTPUT_ROOT", raising=False)
    with patch("services.output.load_settings", side_effect=Exception("disk error")):
        result = _resolve_output_root()
    assert result == DEFAULT_OUTPUT_ROOT


# ─── GET /api/outputs/<rel> serve route ───────────────────────────────────────

@pytest.fixture()
def client():
    return TestClient(app)


def test_serve_existing_file_returns_200(monkeypatch):
    """A file present under OUTPUT_ROOT is served with 200."""
    import main as main_module

    # OUTPUT_ROOT is a tmp dir set by conftest; write a file into it.
    root = output_mod.OUTPUT_ROOT
    run_dir = root / "2024-01-01_00-00-00"
    run_dir.mkdir(parents=True, exist_ok=True)
    asset = run_dir / "test.png"
    asset.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

    client = TestClient(app)
    resp = client.get("/api/outputs/2024-01-01_00-00-00/test.png")
    assert resp.status_code == 200
    assert resp.content[:8] == b"\x89PNG\r\n\x1a\n"

    # cleanup
    asset.unlink(missing_ok=True)
    run_dir.rmdir()


def test_serve_path_traversal_returns_404(client):
    """A ../ traversal attempt must be rejected with 404."""
    resp = client.get("/api/outputs/../../../etc/passwd")
    assert resp.status_code == 404


def test_serve_missing_file_returns_404(client):
    """A well-formed path to a non-existent file returns 404."""
    resp = client.get("/api/outputs/nonexistent-run/ghost.png")
    assert resp.status_code == 404


def test_serve_fallback_to_default_root(tmp_path, monkeypatch):
    """A file only present under DEFAULT_OUTPUT_ROOT is served when OUTPUT_ROOT differs."""
    import main as main_module

    # Write the file under DEFAULT_OUTPUT_ROOT (the real default, not the test temp dir).
    fallback_run = DEFAULT_OUTPUT_ROOT / "_test_fallback_run"
    fallback_run.mkdir(parents=True, exist_ok=True)
    asset = fallback_run / "fallback.png"
    asset.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)

    try:
        # Point OUTPUT_ROOT at a different tmp dir so the file is NOT there.
        alt_root = tmp_path / "alt_output"
        alt_root.mkdir()
        monkeypatch.setattr(output_mod, "OUTPUT_ROOT", alt_root)
        monkeypatch.setattr(main_module, "OUTPUT_ROOT", alt_root)
        # DEFAULT_OUTPUT_ROOT stays as-is (not monkeypatched).
        monkeypatch.setattr(main_module, "DEFAULT_OUTPUT_ROOT", DEFAULT_OUTPUT_ROOT)

        client = TestClient(app)
        resp = client.get("/api/outputs/_test_fallback_run/fallback.png")
        assert resp.status_code == 200
        assert resp.content[:8] == b"\x89PNG\r\n\x1a\n"
    finally:
        asset.unlink(missing_ok=True)
        try:
            fallback_run.rmdir()
        except OSError:
            pass


def test_serve_range_request_returns_206():
    """A Range: bytes=0-3 request must return 206 Partial Content (video seeking parity).

    starlette FileResponse supports Range natively, so this verifies the mount
    replacement did not regress that behaviour.
    """
    root = output_mod.OUTPUT_ROOT
    run_dir = root / "2024-01-01_00-00-01"
    run_dir.mkdir(parents=True, exist_ok=True)
    asset = run_dir / "clip.mp4"
    # Write 16 bytes of fake MP4-ish content (enough to satisfy a range request).
    asset.write_bytes(b"\x00\x00\x00\x18ftyp" + b"\x00" * 8)

    try:
        client = TestClient(app)
        resp = client.get(
            "/api/outputs/2024-01-01_00-00-01/clip.mp4",
            headers={"Range": "bytes=0-3"},
        )
        assert resp.status_code == 206, f"Expected 206, got {resp.status_code}"
        assert resp.content == b"\x00\x00\x00\x18"[:4]
    finally:
        asset.unlink(missing_ok=True)
        try:
            run_dir.rmdir()
        except OSError:
            pass


# ─── Traversal guard — tested directly via the route handler ──────────────────
#
# The existing test_serve_path_traversal_returns_404 sends the request through
# httpx/TestClient which normalises "../" segments before they reach the app,
# so the containment check in serve_output is never exercised (false green).
#
# These tests call serve_output() directly with a raw traversal string so the
# guard is actually triggered.  They would FAIL if the relative_to containment
# check inside serve_output were removed.

def test_serve_output_blocks_raw_traversal():
    """Calling serve_output() directly with a ../ traversal must raise HTTPException(404).

    This test exercises the containment guard inside the route handler, which
    httpx/TestClient normalises away before the handler is reached.
    """
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(serve_output("../../../../etc/passwd"))
    assert exc_info.value.status_code == 404


def test_serve_output_blocks_url_encoded_traversal():
    """URL-encoded traversal (%2F..) must also be blocked.

    Python's Path will decode percent-encoded segments when constructing the
    candidate path; the containment check must still catch the escape.
    """
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(serve_output("%2F..%2F..%2Fetc%2Fpasswd"))
    assert exc_info.value.status_code == 404
