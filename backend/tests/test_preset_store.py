from __future__ import annotations

import importlib
import json

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import services.preset_store as ps
    importlib.reload(ps)
    return ps.PresetStore()


def test_create_and_get_roundtrip(store):
    p = store.create(name="Cinematic Noir", category="Cinematic",
                     prompt="high-contrast film noir lighting", params={"aspect_ratio": "16:9"},
                     modelId="nano-banana", refImages=[], scope="global", projectId=None)
    assert len(p["id"]) == 12
    assert p["name"] == "Cinematic Noir"
    assert p["version"] == 1
    got = store.get(p["id"])
    assert got["prompt"] == "high-contrast film noir lighting"
    assert got["params"] == {"aspect_ratio": "16:9"}


def test_list_is_scope_isolated(store):
    store.create(name="G", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    store.create(name="P", category="X", prompt="", params={}, modelId=None, refImages=[], scope="project", projectId="proj1")
    glob = store.list("global")
    proj = store.list("project", "proj1")
    assert [p["name"] for p in glob] == ["G"]
    assert [p["name"] for p in proj] == ["P"]


def test_project_scope_requires_project_id(store):
    with pytest.raises(ValueError, match="projectId is required"):
        store.list("project")

    with pytest.raises(ValueError, match="projectId is required"):
        store.create(
            name="P", category="X", prompt="", params={}, modelId=None,
            refImages=[], scope="project", projectId=None,
        )


def test_update_bumps_version_and_keeps_id(store):
    p = store.create(name="A", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    updated = store.update(p["id"], name="A2", prompt="new")
    assert updated["id"] == p["id"]
    assert updated["name"] == "A2"
    assert updated["prompt"] == "new"
    assert updated["version"] == 2


def test_delete_removes(store):
    p = store.create(name="A", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    store.delete(p["id"])
    assert store.get(p["id"]) is None


def test_rejects_traversal_project_id(store):
    import pytest as _pytest
    with _pytest.raises(ValueError):
        store.list("project", "../escape")


def test_a_preset_on_a_folded_krea_node_reads_as_the_node_it_became(store, tmp_path):
    """A preset Create saved on Flux 3 Video (Krea) before the fold applies to
    FLUX 3 Video on its Krea route, billing the way it was saved."""
    old = store.create(name="Comet", category="My Styles", prompt="", scope="global", projectId=None, refImages=[],
                       modelId="krea-video-black-forest-labs-flux-3-video",
                       params={"_kreaAuth": "api-token", "resolution": "1080p", "duration": 5})
    plan = store.create(name="Plan", category="My Styles", prompt="", scope="global", projectId=None, refImages=[],
                        modelId="krea-enhance-black-forest-labs-flux-video-upscale",
                        params={"_kreaAuth": "mcp", "creativity": "creative"})
    got = store.get(old["id"])
    assert got["modelId"] == "flux-3-video"
    assert got["params"] == {"_provider": "krea", "_kreaAuth": "api-token", "resolution": "fhd", "duration": 5}
    listed = {p["name"]: p for p in store.list("global")}
    assert listed["Comet"] == got
    assert listed["Plan"]["modelId"] == "flux-video-upscale"
    assert listed["Plan"]["params"] == {"_provider": "krea", "_kreaAuth": "mcp", "creativity": 1}
    # The file keeps what was saved; an edit returns the current reading.
    assert json.loads(next(tmp_path.rglob(f"{old['id']}.json")).read_text())["modelId"] == old["modelId"]
    assert store.update(old["id"], name="Comet 2")["modelId"] == "flux-3-video"


def test_a_preset_on_a_current_node_reads_as_saved(store):
    p = store.create(name="N", category="X", prompt="", params={"_provider": "fal", "aspect_ratio": "16:9"},
                     modelId="flux-3-image", refImages=[], scope="global", projectId=None)
    assert store.get(p["id"]) == p
