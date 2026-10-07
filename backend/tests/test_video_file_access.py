"""Protected video files cannot enter editor routes or FFmpeg consumers."""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from handlers import video_edit
from routes import render_exports, video_edit_preview


@pytest.fixture
def protected_video(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "commons"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    video = root / "private.mp4"
    video.write_bytes(b"private fixture")
    return video


@pytest.mark.parametrize("alias", ["direct", "symlink", "hardlink", "protected-output-root"])
def test_video_resolver_denies_protected_aliases(protected_video, tmp_path, monkeypatch, alias):
    source = protected_video
    if alias == "symlink":
        source = tmp_path / "alias.mp4"
        source.symlink_to(protected_video)
    elif alias == "hardlink":
        source = tmp_path / "alias.mp4"
        os.link(protected_video, source)
    value = str(source)
    if alias == "protected-output-root":
        monkeypatch.setattr(video_edit, "OUTPUT_ROOT", protected_video.parent)
        value = "/api/outputs/private.mp4"
    with pytest.raises(ValueError, match="[Pp]rotected|multiple|hard.link"):
        video_edit._resolve_local_path(value)


@pytest.mark.parametrize("route", ["preview", "export"])
def test_editor_route_rejects_before_probe_or_job(protected_video, monkeypatch, route):
    app = FastAPI()
    app.include_router(video_edit_preview.router)
    app.include_router(render_exports.router)
    probe = AsyncMock()
    spawn = Mock()
    monkeypatch.setattr(video_edit_preview, "ffprobe_video", probe)
    monkeypatch.setattr(render_exports.render_job_manager, "start", spawn)
    endpoint = "/api/video-edit/preview-render" if route == "preview" else "/api/video-edit/export"
    with TestClient(app) as client:
        response = client.post(endpoint, json={
            "sourceUrl": str(protected_video),
            "clips": [{"sourceIn": 0, "sourceOut": 1, "speed": 1}],
        })
    assert response.status_code == 400
    assert "protected" in response.json()["detail"].lower()
    probe.assert_not_awaited()
    spawn.assert_not_called()


@pytest.mark.asyncio
async def test_direct_video_render_checks_source_before_subprocess(protected_video, monkeypatch):
    probe = AsyncMock()
    render = AsyncMock()
    monkeypatch.setattr(video_edit, "ffprobe_video", probe)
    monkeypatch.setattr(video_edit, "run_ffmpeg", render)
    with pytest.raises(ValueError, match="[Pp]rotected"):
        await video_edit.render_video_edit_file(
            protected_video, [{"sourceIn": 0, "sourceOut": 1, "speed": 1}]
        )
    probe.assert_not_awaited()
    render.assert_not_awaited()


def test_video_resolver_preserves_ordinary_and_output_imports(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"ordinary fixture")
    monkeypatch.setattr(video_edit, "OUTPUT_ROOT", tmp_path)
    assert video_edit._resolve_local_path(str(source)) == source.resolve()
    assert video_edit._resolve_local_path("/api/outputs/source.mp4") == source.resolve()
