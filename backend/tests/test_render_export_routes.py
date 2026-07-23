from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from main import app
from services.render_jobs import RenderJobManager


def _poll(client: TestClient, job_id: str) -> dict:
    body: dict = {}
    for _ in range(50):
        response = client.get(f"/api/render-jobs/{job_id}")
        assert response.status_code == 200
        body = response.json()
        if body["status"] != "running":
            return body
        time.sleep(0.01)
    return body


def test_video_export_job_completes_and_returns_download_url(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "run" / "final.webm"
    manager = RenderJobManager()
    monkeypatch.setattr("routes.render_exports.render_job_manager", manager)
    monkeypatch.setattr("services.render_jobs.OUTPUT_ROOT", tmp_path)

    async def fake_render(source_path, clips, **kwargs):
        assert source_path == source
        assert kwargs["output_format"] == "webm"
        kwargs["on_progress"](0.5)
        output.parent.mkdir()
        output.write_bytes(b"rendered")
        return output

    monkeypatch.setattr("routes.render_exports.render_video_edit_file", fake_render)

    with TestClient(app) as client:
        response = client.post("/api/video-edit/export", json={
            "sourceUrl": str(source),
            "clips": [{"sourceIn": 0, "sourceOut": 1, "speed": 1, "volume": 1, "mute": False}],
            "format": "webm",
            "resolution": "720p",
            "quality": "high",
        })
        assert response.status_code == 202
        body = _poll(client, response.json()["id"])

    assert body["status"] == "complete"
    assert body["progress"] == 1.0
    assert body["outputUrl"] == "/api/outputs/run/final.webm"


def test_remotion_route_rejects_malformed_manifest(monkeypatch) -> None:
    monkeypatch.setattr("routes.render_exports.render_job_manager", RenderJobManager())
    with TestClient(app) as client:
        response = client.post("/api/remotion-render", json={"manifest": {}})
    assert response.status_code == 400
    assert "manifest" in response.json()["detail"]


def test_render_job_can_be_cancelled(tmp_path, monkeypatch) -> None:
    manager = RenderJobManager()
    monkeypatch.setattr("routes.render_exports.render_job_manager", manager)

    async def never_finishes(manifest, *, on_progress=None):
        import asyncio
        await asyncio.Future()
        return tmp_path / "unreachable.mp4"

    monkeypatch.setattr("routes.render_exports.render_remotion_manifest", never_finishes)
    manifest = {"graph": {"nodes": [], "edges": []}, "timeline": []}

    with TestClient(app) as client:
        started = client.post("/api/remotion-render", json={"manifest": manifest})
        assert started.status_code == 202
        cancelled = client.delete(f"/api/render-jobs/{started.json()['id']}")

    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"


def test_video_export_rejects_missing_source() -> None:
    with TestClient(app) as client:
        response = client.post("/api/video-edit/export", json={
            "sourceUrl": "/does/not/exist.mp4",
            "clips": [{"sourceIn": 0, "sourceOut": 1, "speed": 1}],
        })
    assert response.status_code == 404
