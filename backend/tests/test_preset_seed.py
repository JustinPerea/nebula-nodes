from __future__ import annotations

import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as m  # noqa: E402
import services.preset_store as ps  # noqa: E402


@pytest.fixture()
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path))
    import importlib
    importlib.reload(ps)
    store = ps.PresetStore()
    monkeypatch.setattr(m, "preset_store", store)
    return store


def test_seed_populates_empty_global_then_is_idempotent(fresh):
    assert fresh.list("global") == []
    m.seed_presets_if_empty()
    seeded = fresh.list("global")
    assert len(seeded) >= 12
    names = {p["name"] for p in seeded}
    assert "Cinematic Noir" in names
    # idempotent: running again does not duplicate
    m.seed_presets_if_empty()
    assert len(fresh.list("global")) == len(seeded)


def test_seed_skips_when_not_empty(fresh):
    fresh.create(name="Mine", category="X", prompt="", params={}, modelId=None, refImages=[], scope="global", projectId=None)
    m.seed_presets_if_empty()
    names = {p["name"] for p in fresh.list("global")}
    assert names == {"Mine"}  # untouched
