"""Tests for POST /api/video-edit/preview-render."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from main import app


def _setup_preview_route(tmp_path, monkeypatch):
    """Shared fixture-ish helper for preview-render tests."""
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    run_dir = tmp_path / "output" / "run-1"
    run_dir.mkdir(parents=True)
    monkeypatch.setattr("routes.video_edit_preview.get_run_dir", lambda: run_dir)
    monkeypatch.setattr("routes.video_edit_preview.OUTPUT_ROOT", tmp_path / "output")
    return src


def test_preview_render_returns_preview_url(tmp_path, monkeypatch) -> None:
    client = TestClient(app)
    src = _setup_preview_route(tmp_path, monkeypatch)

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


def test_preview_render_chains_scale_into_filter_complex(tmp_path, monkeypatch) -> None:
    """ffmpeg rejects mixing simple -vf with -filter_complex on the same
    stream. The preview route must chain the scale stage into the filter
    graph and remap the output label, not pass -vf separately. Regression
    for the "Filtergraph 'scale=640:-2' was specified for a stream fed from
    a complex filtergraph" error caught in Phase F smoke.
    """
    client = TestClient(app)
    src = _setup_preview_route(tmp_path, monkeypatch)

    probe_result = type("PR", (), {"duration": 4.0, "fps": 30.0, "is_vfr": False})()
    captured: list[list[str]] = []

    async def fake_ffmpeg(args, on_progress=None):
        captured.append(args)
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
                    {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False},
                ],
            },
        )

    assert response.status_code == 200
    args = captured[0]
    assert "-vf" not in args  # no simple -vf flag
    filter_complex = args[args.index("-filter_complex") + 1]
    assert "scale=640:-2" in filter_complex  # scale chained into graph
    assert "[outvs]" in filter_complex  # scaled output relabeled
    # Mapping uses the scaled label, not the raw concat output
    map_indices = [i for i, a in enumerate(args) if a == "-map"]
    map_targets = [args[i + 1] for i in map_indices]
    assert "[outvs]" in map_targets
    assert "[outv]" not in map_targets
