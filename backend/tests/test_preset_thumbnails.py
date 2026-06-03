"""Tests for preset thumbnail serving, backfill, and PresetUpdate thumbnail field."""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as m  # noqa: E402
import services.preset_store as ps  # noqa: E402

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    importlib.reload(ps)
    store = ps.PresetStore()
    monkeypatch.setattr(m, "preset_store", store)
    return store


@pytest.fixture()
def client():
    return TestClient(m.app)


# ---------------------------------------------------------------------------
# (a) GET /api/presets/thumbnails/<slug>
# ---------------------------------------------------------------------------

def test_thumbnail_route_serves_existing_webp(client, tmp_path, monkeypatch):
    """A valid slug whose .webp exists on disk → 200 image/webp."""
    # Create a fake thumbnails dir alongside a fake seed.json
    thumbnails_dir = tmp_path / "thumbnails"
    thumbnails_dir.mkdir()
    fake_webp = thumbnails_dir / "cinematic-noir.webp"
    fake_webp.write_bytes(b"RIFF\x00\x00\x00\x00WEBP")  # minimal WebP-ish bytes

    fake_seed = tmp_path / "seed.json"
    fake_seed.write_text("[]", encoding="utf-8")

    monkeypatch.setattr(m, "_PRESET_SEED_PATH", fake_seed)

    resp = client.get("/api/presets/thumbnails/cinematic-noir")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/webp"


def test_thumbnail_route_404_for_missing_webp(client, tmp_path, monkeypatch):
    """A well-formed slug with no matching file → 404."""
    thumbnails_dir = tmp_path / "thumbnails"
    thumbnails_dir.mkdir()
    fake_seed = tmp_path / "seed.json"
    fake_seed.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(m, "_PRESET_SEED_PATH", fake_seed)

    resp = client.get("/api/presets/thumbnails/does-not-exist")
    assert resp.status_code == 404


def test_thumbnail_route_rejects_traversal_slug(client, tmp_path, monkeypatch):
    """A slug containing ../  is rejected with 404 (slug regex fails)."""
    fake_seed = tmp_path / "seed.json"
    fake_seed.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(m, "_PRESET_SEED_PATH", fake_seed)

    resp = client.get("/api/presets/thumbnails/../foo")
    # FastAPI may 307-redirect or 404; either way not 200
    assert resp.status_code != 200


def test_thumbnail_route_rejects_bad_slug_uppercase(client, tmp_path, monkeypatch):
    """Slug with uppercase letters fails the regex → 404."""
    fake_seed = tmp_path / "seed.json"
    fake_seed.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(m, "_PRESET_SEED_PATH", fake_seed)

    resp = client.get("/api/presets/thumbnails/Bad_Slug")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# (b) backfill_preset_thumbnails
# ---------------------------------------------------------------------------

def _make_seed_and_thumbnails(base: Path) -> tuple[Path, Path]:
    """Write a minimal seed.json + cinematic-noir.webp; return (seed_path, thumbnails_dir)."""
    seed_data = [{"name": "Cinematic Noir", "category": "Cinematic", "prompt": "noir",
                  "params": {}, "modelId": "nano-banana"}]
    seed_path = base / "seed.json"
    seed_path.write_text(json.dumps(seed_data), encoding="utf-8")
    thumbnails_dir = base / "thumbnails"
    thumbnails_dir.mkdir(exist_ok=True)
    (thumbnails_dir / "cinematic-noir.webp").write_bytes(b"WEBP")
    return seed_path, thumbnails_dir


def test_backfill_sets_thumbnail_url(fresh, tmp_path, monkeypatch):
    """After seed + backfill, the seeded preset has thumbnail = /api/presets/thumbnails/cinematic-noir."""
    seed_path, _ = _make_seed_and_thumbnails(tmp_path)
    monkeypatch.setattr(m, "_PRESET_SEED_PATH", seed_path)

    m.seed_presets_if_empty()
    m.backfill_preset_thumbnails()

    presets = fresh.list("global")
    noir = next(p for p in presets if p["name"] == "Cinematic Noir")
    assert noir["thumbnail"] == "/api/presets/thumbnails/cinematic-noir"


def test_backfill_is_idempotent(fresh, tmp_path, monkeypatch):
    """Running backfill twice does not bump the version a second time."""
    seed_path, _ = _make_seed_and_thumbnails(tmp_path)
    monkeypatch.setattr(m, "_PRESET_SEED_PATH", seed_path)

    m.seed_presets_if_empty()
    m.backfill_preset_thumbnails()

    presets_after_first = fresh.list("global")
    noir_v1 = next(p for p in presets_after_first if p["name"] == "Cinematic Noir")
    version_after_first = noir_v1["version"]

    m.backfill_preset_thumbnails()

    presets_after_second = fresh.list("global")
    noir_v2 = next(p for p in presets_after_second if p["name"] == "Cinematic Noir")
    assert noir_v2["version"] == version_after_first  # no extra bump


def test_backfill_does_not_touch_user_presets(fresh, tmp_path, monkeypatch):
    """User presets (names not in seed.json) are untouched by backfill."""
    seed_path, _ = _make_seed_and_thumbnails(tmp_path)
    monkeypatch.setattr(m, "_PRESET_SEED_PATH", seed_path)

    # Create a user preset with a custom name before seeding
    user_preset = fresh.create(
        name="My Style", category="My Styles", prompt="custom", params={},
        modelId=None, refImages=[], scope="global", projectId=None,
    )
    original_version = user_preset["version"]
    original_thumbnail = user_preset["thumbnail"]

    m.seed_presets_if_empty()
    m.backfill_preset_thumbnails()

    refreshed = fresh.get(user_preset["id"])
    assert refreshed["thumbnail"] == original_thumbnail
    assert refreshed["version"] == original_version


# ---------------------------------------------------------------------------
# (c) PresetUpdate thumbnail round-trips through PUT
# ---------------------------------------------------------------------------

def test_put_preset_sets_thumbnail(fresh, client):
    """PUT /api/presets/{id} with thumbnail field persists the value."""
    created = client.post("/api/presets", json={
        "name": "My Style", "category": "Style", "prompt": "x",
        "params": {}, "modelId": None, "refImages": [], "scope": "global",
    }).json()
    pid = created["id"]

    updated = client.put(f"/api/presets/{pid}", json={"thumbnail": "/api/outputs/foo.webp"}).json()
    assert updated["thumbnail"] == "/api/outputs/foo.webp"

    got = client.get(f"/api/presets/{pid}").json()
    assert got["thumbnail"] == "/api/outputs/foo.webp"


def test_post_preset_with_thumbnail(fresh, client):
    """POST /api/presets with thumbnail field stores it on creation."""
    created = client.post("/api/presets", json={
        "name": "Styled", "category": "Style", "prompt": "y",
        "params": {}, "modelId": None, "refImages": [], "scope": "global",
        "thumbnail": "/api/outputs/thumb.webp",
    }).json()
    assert created["thumbnail"] == "/api/outputs/thumb.webp"
