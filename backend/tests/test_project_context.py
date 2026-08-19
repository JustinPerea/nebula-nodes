from __future__ import annotations

from fastapi.testclient import TestClient


def test_project_endpoint_returns_safe_backend_owned_identity(monkeypatch):
    from main import app

    monkeypatch.setenv("NEBULA_PROJECT_ID", "Nebula Project / local")
    monkeypatch.setenv("NEBULA_PROJECT_NAME", "Nebula Project")
    response = TestClient(app).get("/api/project")

    assert response.status_code == 200
    assert response.json() == {
        "id": "Nebula-Project-local",
        "name": "Nebula Project",
    }


def test_project_id_is_bounded_and_deterministic(monkeypatch):
    from services.project_context import get_current_project

    monkeypatch.setenv("NEBULA_PROJECT_ID", "long project name " * 20)
    first = get_current_project()["id"]
    second = get_current_project()["id"]

    assert first == second
    assert len(first) <= 64
