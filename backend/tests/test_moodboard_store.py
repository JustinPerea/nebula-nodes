from __future__ import annotations

from services.moodboard_store import MoodboardStore
from tests.conftest import stored_image_urls


def test_moodboard_store_create_update_list_delete(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()
    a, b = stored_image_urls(2, name="store")

    created = store.create(
        name="Warm editorial",
        images=[{"url": a, "weight": 1.4}],
        notes="soft light",
        mode="look",
        strength=0.8,
    )

    assert created["id"]
    assert created["images"][0]["weight"] == 1.0
    assert created["thumbnail"] == a

    listed = store.list(scope="global")
    assert [item["id"] for item in listed] == [created["id"]]

    updated = store.update(
        created["id"],
        mode="world",
        images=[{"url": b, "weight": 0.35}],
    )
    assert updated["version"] == 2
    assert updated["mode"] == "world"
    assert updated["thumbnail"] == b

    store.delete(created["id"])
    assert store.get(created["id"]) is None


def test_moodboard_store_rejects_path_traversal(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    store = MoodboardStore()

    try:
        store.create(name="Bad", projectId="../escape")
    except ValueError as exc:
        assert "invalid projectId" in str(exc)
    else:
        raise AssertionError("expected invalid project id")
