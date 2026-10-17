"""Presets get the one-time saved-params upgrades (services/saved_graph_upgrades.py).

A preset file records the version its params were saved at (``paramsVersion``,
missing = 0). Reads upgrade a copy without writing; every write stores the
upgraded params with the current version. Justin, 2026-10-17: "2. Yes".
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as m  # noqa: E402
from services.saved_graph_upgrades import PARAMS_VERSION  # noqa: E402

# A claude-chat style saved from Create on main: the whole composer params.
MAIN_PARAMS = {"model": "claude-opus-4-6", "extended_thinking": True, "max_tokens": 4096, "effort": "high"}


@pytest.fixture()
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import services.preset_store as ps
    importlib.reload(ps)
    monkeypatch.setattr(m, "preset_store", ps.PresetStore())
    return tmp_path


def _write(root: Path, preset_id: str, **overrides) -> Path:
    preset = {
        "id": preset_id, "name": "Old style", "category": "My Styles", "prompt": "",
        "params": dict(MAIN_PARAMS), "modelId": "claude-chat", "refImages": [], "thumbnail": "",
        "version": 1, "scope": "global", "projectId": None,
        "createdAt": "2026-10-01T00:00:00+00:00", "updatedAt": "2026-10-01T00:00:00+00:00",
    }
    preset.update(overrides)
    path = root / "_global" / f"{preset_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(preset), encoding="utf-8")
    return path


# ---------- store ----------

def test_an_unmarked_preset_reads_upgraded_without_writing(root):
    path = _write(root, "old1")
    before = path.read_bytes()
    got = m.preset_store.get("old1")
    assert got["params"]["max_tokens"] == 64_000
    assert got["params"]["effort"] == "high"
    assert got["paramsVersion"] == PARAMS_VERSION
    listed = m.preset_store.list("global")
    assert listed[0]["params"]["max_tokens"] == 64_000
    assert path.read_bytes() == before
    assert got["version"] == 1


@pytest.mark.parametrize("model", ["claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-8"])
def test_every_upgraded_model(root, model):
    _write(root, "old1", params={**MAIN_PARAMS, "model": model})
    assert m.preset_store.get("old1")["params"]["max_tokens"] == 64_000


@pytest.mark.parametrize("overrides", [
    {"params": {**MAIN_PARAMS, "extended_thinking": False}},
    {"params": {**MAIN_PARAMS, "max_tokens": 8192}},
    {"params": {**MAIN_PARAMS, "model": "claude-opus-5-5"}},
    {"params": {**MAIN_PARAMS, "model": "claude-haiku-4-5"}},
    {"params": {**MAIN_PARAMS, "model": ["claude-opus-4-6"]}},  # malformed: must not raise
    {"modelId": None},
    {"modelId": "nano-banana"},
    {"params": {"max_tokens": 4096}},  # partial: no model
    {"params": {"model": "claude-opus-4-6", "max_tokens": 4096}},  # partial: no thinking
    {"params": {**MAIN_PARAMS}, "paramsVersion": 1},  # a 4,096 saved after the upgrade
])
def test_left_as_stored(root, overrides):
    _write(root, "keep", **overrides)
    expected = overrides.get("params", MAIN_PARAMS)
    assert m.preset_store.get("keep")["params"] == expected


def test_a_malformed_marker_reads_as_version_0(root):
    _write(root, "bad", paramsVersion="1")
    assert m.preset_store.get("bad")["params"]["max_tokens"] == 64_000


def test_a_newer_marker_is_kept(root):
    _write(root, "newer", paramsVersion=PARAMS_VERSION + 1)
    got = m.preset_store.get("newer")
    assert got["params"]["max_tokens"] == 4096
    assert got["paramsVersion"] == PARAMS_VERSION + 1


def test_create_upgrades_by_the_caller_s_version(root):
    def make(version):
        return m.preset_store.create(name="S", category="X", prompt="", params=MAIN_PARAMS,
                                     modelId="claude-chat", refImages=[], scope="global",
                                     projectId=None, params_version=version)
    old = make(0)
    current = make(PARAMS_VERSION)
    assert old["params"]["max_tokens"] == 64_000
    assert current["params"]["max_tokens"] == 4096
    for preset in (old, current):
        stored = json.loads((root / "_global" / f"{preset['id']}.json").read_text())
        assert stored["paramsVersion"] == PARAMS_VERSION
        assert stored["params"] == preset["params"]
    # The deliberate 4,096 stays 4,096 on every later read.
    assert m.preset_store.get(current["id"])["params"]["max_tokens"] == 4096


def test_a_thumbnail_only_update_stores_the_upgrade_once(root):
    path = _write(root, "old1")
    updated = m.preset_store.update("old1", thumbnail="/api/presets/thumbnails/x")
    stored = json.loads(path.read_text())
    assert stored["params"]["max_tokens"] == 64_000
    assert stored["paramsVersion"] == PARAMS_VERSION
    assert stored["version"] == 2  # one edit, not one per read or upgrade
    assert updated == stored


def test_update_upgrades_new_params_by_the_caller_s_version(root):
    _write(root, "a", paramsVersion=PARAMS_VERSION)
    assert m.preset_store.update("a", params=MAIN_PARAMS, params_version=0)["params"]["max_tokens"] == 64_000
    _write(root, "b", paramsVersion=PARAMS_VERSION)
    assert m.preset_store.update("b", params=MAIN_PARAMS)["params"]["max_tokens"] == 4096
    assert m.preset_store.get("b")["params"]["max_tokens"] == 4096


def test_update_cannot_overwrite_the_marker_through_fields(root):
    path = _write(root, "old1")
    m.preset_store.update("old1", name="Renamed", paramsVersion=PARAMS_VERSION)
    assert json.loads(path.read_text())["params"]["max_tokens"] == 64_000


# ---------- HTTP ----------

def _post(client, **extra):
    # Main's CreateView "Save current" body, verbatim shape (no paramsVersion).
    body = {"name": "Mine", "category": "My Styles", "prompt": "", "params": MAIN_PARAMS,
            "modelId": "claude-chat", "refImages": [], "scope": "global", "thumbnail": "", **extra}
    return client.post("/api/presets", json=body)


def test_post_without_a_version_is_main_s_bundle(root):
    created = _post(TestClient(m.app)).json()
    assert created["params"]["max_tokens"] == 64_000
    assert created["paramsVersion"] == PARAMS_VERSION


def test_post_at_the_current_version_keeps_4096(root):
    client = TestClient(m.app)
    created = _post(client, paramsVersion=PARAMS_VERSION).json()
    assert created["params"]["max_tokens"] == 4096
    assert client.get(f"/api/presets/{created['id']}").json()["params"]["max_tokens"] == 4096


@pytest.mark.parametrize("bad", [-1, "1", True, 1.5, None])
def test_a_malformed_version_is_refused(root, bad):
    client = TestClient(m.app)
    assert _post(client, paramsVersion=bad).status_code == 422
    _write(root, "a", paramsVersion=PARAMS_VERSION)
    assert client.put("/api/presets/a", json={"params": MAIN_PARAMS, "paramsVersion": bad}).status_code == 422
    assert list((root / "_global").glob("*.json")) == [root / "_global" / "a.json"]


def test_put_without_a_version_is_current(root):
    client = TestClient(m.app)
    _write(root, "a", paramsVersion=PARAMS_VERSION)
    assert client.put("/api/presets/a", json={"params": MAIN_PARAMS}).json()["params"]["max_tokens"] == 4096
    assert client.put("/api/presets/a", json={"params": MAIN_PARAMS, "paramsVersion": 0}).json()["params"]["max_tokens"] == 64_000


def test_get_and_list_serve_the_upgrade(root):
    client = TestClient(m.app)
    _write(root, "old1")
    assert client.get("/api/presets/old1").json()["params"]["max_tokens"] == 64_000
    assert client.get("/api/presets?scope=global").json()[0]["params"]["max_tokens"] == 64_000


# ---------- boot ----------

def test_seeded_presets_are_current_and_backfill_keeps_their_params(root):
    m.seed_presets_if_empty()
    seeded = m.preset_store.list("global")
    assert seeded and all(p["paramsVersion"] == PARAMS_VERSION for p in seeded)
    on_disk = [json.loads(p.read_text()) for p in (root / "_global").glob("*.json")]
    assert all(p["paramsVersion"] == PARAMS_VERSION for p in on_disk)
    before = {p["id"]: p["params"] for p in on_disk}
    m.backfill_preset_thumbnails()
    after = {p["id"]: p["params"] for p in m.preset_store.list("global")}
    assert after == before
