"""Media readers outside graph execution enforce the protected-path boundary."""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import render_exports
from services import moodboard_analysis, remotion_render


@pytest.fixture
def protected_image(tmp_path, monkeypatch):
    protected = tmp_path / "commons"
    protected.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(protected))
    image = protected / "image.png"
    image.write_bytes(b"private image fixture")
    return image


@pytest.mark.parametrize("mode", ["protected-output-root", "hardlink-in-output"])
def test_moodboard_analyzer_skips_protected_image_before_open(
    tmp_path, monkeypatch, protected_image, mode
):
    if mode == "protected-output-root":
        output = protected_image.parent
    else:
        output = tmp_path / "output"
        output.mkdir()
        os.link(protected_image, output / "image.png")
    monkeypatch.setattr(moodboard_analysis, "OUTPUT_ROOT", output)
    monkeypatch.setattr(moodboard_analysis, "DEFAULT_OUTPUT_ROOT", output)
    image_open = Mock(side_effect=AssertionError("must not decode protected pixels"))
    monkeypatch.setattr(moodboard_analysis.Image, "open", image_open)

    result = moodboard_analysis.analyze_moodboard({"images": [{"url": "/api/outputs/image.png"}]})

    assert result["images"][0]["status"] == "unresolved"
    image_open.assert_not_called()


@pytest.mark.asyncio
async def test_remotion_blocks_nested_protected_reference_before_worker(
    tmp_path, monkeypatch, protected_image
):
    spawn = AsyncMock()
    monkeypatch.setattr(remotion_render, "_spawn_subprocess", spawn)
    manifest = {
        "graph": {"nodes": [{"data": {"params": {"filePath": str(protected_image)}}}], "edges": []},
        "timeline": [],
    }
    output = tmp_path / "render-output"
    with pytest.raises(ValueError, match="[Pp]rotected"):
        await remotion_render.render_remotion_manifest(manifest, output_dir=output)
    spawn.assert_not_awaited()
    assert not output.exists()


def test_remotion_route_rejects_nested_protected_reference_before_job(
    monkeypatch, protected_image
):
    app = FastAPI()
    app.include_router(render_exports.router)
    start = Mock()
    monkeypatch.setattr(render_exports.render_job_manager, "start", start)
    with TestClient(app) as client:
        response = client.post("/api/remotion-render", json={"manifest": {
            "graph": {"nodes": [], "edges": []},
            "timeline": [{"src": str(protected_image)}],
        }})
    assert response.status_code == 400
    assert "protected" in response.json()["detail"].lower()
    start.assert_not_called()
