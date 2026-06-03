from __future__ import annotations

import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from main import app  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_presets(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import importlib
    import services.preset_store as ps
    importlib.reload(ps)
    import main as m
    monkeypatch.setattr(m, "preset_store", ps.PresetStore())
    yield


def test_crud_flow():
    client = TestClient(app)
    created = client.post("/api/presets", json={
        "name": "Y2K Studio", "category": "Editorial", "prompt": "y2k studio flash",
        "params": {"aspect_ratio": "3:4"}, "modelId": "nano-banana", "refImages": [], "scope": "global",
    }).json()
    pid = created["id"]
    assert created["name"] == "Y2K Studio"

    listed = client.get("/api/presets?scope=global").json()
    assert any(p["id"] == pid for p in listed)

    got = client.get(f"/api/presets/{pid}").json()
    assert got["prompt"] == "y2k studio flash"

    updated = client.put(f"/api/presets/{pid}", json={"name": "Y2K Studio v2"}).json()
    assert updated["name"] == "Y2K Studio v2"

    assert client.delete(f"/api/presets/{pid}").json()["status"] == "deleted"
    assert client.get(f"/api/presets/{pid}").status_code == 404
