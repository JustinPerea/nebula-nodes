"""API-level tests for /api/characters CRUD routes.

Uses a fresh TestClient fixture (no clear_graph autouse — that's graph-specific).
The conftest.py sandbox sets NEBULA_CHARACTER_ROOT to a temp dir at collection
time, so these tests never touch the real ~/.nebula/characters directory.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from main import app
    return TestClient(app)


_VALID_BODY = {
    "name": "Rina",
    "subjectType": "human",
    "referenceViews": ["url_a", "url_b", "url_c"],
    "frozenTraitString": "late 20s, warm skin tone, high cheekbones",
    "seed": 7,
    "consistencyStrength": 0.9,
    "projectId": "proj-test",
}


class TestCharacterCreateAndGet:
    def test_post_returns_200_shape(self, client):
        resp = client.post("/api/characters", json=_VALID_BODY)
        assert resp.status_code == 200
        data = resp.json()
        assert "id" in data
        assert data["name"] == "Rina"
        assert data["version"] == 1
        assert data["subjectType"] == "human"
        assert data["thumbnail"] == "url_a"
        assert data["projectId"] == "proj-test"
        assert "createdAt" in data
        assert "updatedAt" in data

    def test_post_then_get_round_trips(self, client):
        post_resp = client.post("/api/characters", json=_VALID_BODY)
        assert post_resp.status_code == 200
        char_id = post_resp.json()["id"]

        get_resp = client.get(f"/api/characters/{char_id}")
        assert get_resp.status_code == 200
        fetched = get_resp.json()
        assert fetched["id"] == char_id
        assert fetched["name"] == "Rina"
        assert fetched["referenceViews"] == ["url_a", "url_b", "url_c"]
        assert fetched["frozenTraitString"] == "late 20s, warm skin tone, high cheekbones"

    def test_get_missing_id_returns_404(self, client):
        resp = client.get("/api/characters/doesnotexist1")
        assert resp.status_code == 404

    def test_post_fewer_than_3_views_returns_422(self, client):
        body = {**_VALID_BODY, "referenceViews": ["only_one", "only_two"]}
        resp = client.post("/api/characters", json=body)
        # store raises ValueError → mapped to 422 by the route
        assert resp.status_code == 422


class TestCharacterList:
    def test_list_project_scope_returns_posted_char(self, client):
        client.post("/api/characters", json=_VALID_BODY)
        resp = client.get("/api/characters?scope=project&projectId=proj-test")
        assert resp.status_code == 200
        names = [c["name"] for c in resp.json()]
        assert "Rina" in names

    def test_list_global_scope_excludes_project_char(self, client):
        client.post("/api/characters", json=_VALID_BODY)
        resp = client.get("/api/characters?scope=global")
        assert resp.status_code == 200
        project_ids = [c.get("projectId") for c in resp.json()]
        # Every returned character must be global (no projectId)
        assert all(pid is None for pid in project_ids)

    def test_list_defaults_to_global_scope(self, client):
        resp = client.get("/api/characters")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)


class TestCharacterUpdate:
    def test_put_bumps_version(self, client):
        post_resp = client.post("/api/characters", json=_VALID_BODY)
        char_id = post_resp.json()["id"]

        put_resp = client.put(f"/api/characters/{char_id}", json={"name": "Rina Updated"})
        assert put_resp.status_code == 200
        assert put_resp.json()["version"] == 2
        assert put_resp.json()["name"] == "Rina Updated"

    def test_put_missing_id_returns_404(self, client):
        resp = client.put("/api/characters/doesnotexist1", json={"name": "ghost"})
        assert resp.status_code == 404

    def test_put_updated_at_gte_created_at(self, client):
        post_resp = client.post("/api/characters", json=_VALID_BODY)
        data = post_resp.json()
        char_id = data["id"]
        created_at = data["createdAt"]

        put_resp = client.put(f"/api/characters/{char_id}", json={"name": "X"})
        updated_at = put_resp.json()["updatedAt"]
        assert updated_at >= created_at


class TestCharacterPathTraversal:
    """Verify that traversal projectId values are rejected at the route layer."""

    def test_post_traversal_project_id_returns_400(self, client):
        body = {**_VALID_BODY, "projectId": "../evil"}
        resp = client.post("/api/characters", json=body)
        assert resp.status_code == 400

    def test_post_absolute_project_id_returns_400(self, client):
        body = {**_VALID_BODY, "projectId": "/etc/passwd"}
        resp = client.post("/api/characters", json=body)
        assert resp.status_code == 400

    def test_get_list_traversal_project_id_returns_400(self, client):
        resp = client.get("/api/characters?scope=project&projectId=../evil")
        assert resp.status_code == 400

    def test_get_list_absolute_project_id_returns_400(self, client):
        resp = client.get("/api/characters?scope=project&projectId=/etc/passwd")
        assert resp.status_code == 400


class TestCharacterCharIdValidation:
    """Verify that syntactically-invalid char_id values return 404 (not 500)."""

    def test_get_dotdot_char_id_returns_404(self, client):
        # "not_a..real" is a single path segment FastAPI delivers to the handler;
        # the store's _validate_char_id rejects the dots → route maps to 404.
        resp = client.get("/api/characters/not_a..real")
        assert resp.status_code == 404

    def test_put_dotdot_char_id_returns_404(self, client):
        resp = client.put("/api/characters/not_a..real", json={"name": "x"})
        assert resp.status_code == 404

    def test_delete_dotdot_char_id_returns_404(self, client):
        resp = client.delete("/api/characters/not_a..real")
        assert resp.status_code == 404

    def test_get_valid_hex_id_not_found_returns_404(self, client):
        # A syntactically valid id that simply doesn't exist still gives 404.
        resp = client.get("/api/characters/abc123def456")
        assert resp.status_code == 404


class TestCharacterDelete:
    def test_delete_then_get_returns_404(self, client):
        post_resp = client.post("/api/characters", json=_VALID_BODY)
        char_id = post_resp.json()["id"]

        del_resp = client.delete(f"/api/characters/{char_id}")
        assert del_resp.status_code == 200
        assert del_resp.json()["status"] == "deleted"

        get_resp = client.get(f"/api/characters/{char_id}")
        assert get_resp.status_code == 404

    def test_delete_missing_id_returns_404(self, client):
        resp = client.delete("/api/characters/doesnotexist1")
        assert resp.status_code == 404
