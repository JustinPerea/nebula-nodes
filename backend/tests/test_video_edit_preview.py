"""Tests for POST /api/video-edit/preview-render."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from main import app


def test_preview_render_returns_preview_url(tmp_path, monkeypatch) -> None:
    client = TestClient(app)
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    run_dir = tmp_path / "output" / "run-1"
    run_dir.mkdir(parents=True)
    monkeypatch.setattr("routes.video_edit_preview.get_run_dir", lambda: run_dir)
    monkeypatch.setattr("routes.video_edit_preview.OUTPUT_ROOT", tmp_path / "output")

    probe_result = type("PR", (), {"duration": 4.0, "fps": 30.0, "is_vfr": False})()

    async def fake_ffmpeg(args, on_progress=None):
        Path(args[-1]).touch()

    with (
        patch("routes.video_edit_preview.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("routes.video_edit_preview.run_ffmpeg", side_effect=fake_ffmpeg),
    ):
        response = client.post(
            "/api/video-edit/preview-render",
            json={
                "sourceUrl": str(src),
                "clips": [
                    {"id": "c1", "sourceIn": 0.5, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False},
                ],
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["previewUrl"].startswith("/api/outputs/")
    assert "_preview/" in body["previewUrl"]
