"""TDD tests for CharacterStore — project-scoped & global character persistence.

Round-trip correctness contract:
  - referenceViews order is preserved verbatim (identity-correctness)
  - frozenTraitString is returned byte-identical (identity-correctness)
  - version bumps deterministically on update
  - scope semantics: project-scoped vs. global are isolated
"""
from __future__ import annotations

import os
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_char(**kwargs):
    """Return minimal valid Character input dict, overridable via kwargs."""
    base = {
        "name": "Lena",
        "subjectType": "human",
        "referenceViews": ["url_front", "url_side", "url_back"],
        "frozenTraitString": "mid-30s, warm olive skin, sharp cheekbones",
        "seed": 42,
        "consistencyStrength": 0.85,
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# Store unit tests (isolated via monkeypatch on NEBULA_CHARACTER_ROOT)
# ---------------------------------------------------------------------------

class TestCharacterStoreCreate:
    def test_create_returns_assigned_fields(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        char = store.create(**_make_char(projectId="proj-1"))

        assert isinstance(char["id"], str) and len(char["id"]) == 12
        assert char["version"] == 1
        assert char["name"] == "Lena"
        assert char["subjectType"] == "human"
        assert char["seed"] == 42
        assert char["consistencyStrength"] == 0.85
        assert char["thumbnail"] == "url_front"  # referenceViews[0]
        assert char["projectId"] == "proj-1"
        assert "createdAt" in char
        assert "updatedAt" in char

    def test_create_preserves_reference_views_order_verbatim(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        views = ["z_third", "a_first", "m_second"]
        char = store.create(**_make_char(referenceViews=views))

        assert char["referenceViews"] == views

    def test_create_preserves_frozen_trait_string_byte_identical(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        trait = "  Exact BYTES — do NOT normalize  \n"
        char = store.create(**_make_char(frozenTraitString=trait))

        assert char["frozenTraitString"] == trait

    def test_create_with_fewer_than_3_views_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="referenceViews"):
            store.create(**_make_char(referenceViews=["only_one", "only_two"]))

    def test_create_with_0_views_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="referenceViews"):
            store.create(**_make_char(referenceViews=[]))

    def test_create_global_character_when_no_project_id(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        char = store.create(**_make_char())  # no projectId
        assert char.get("projectId") is None


class TestCharacterStoreGet:
    def test_get_round_trips_verbatim(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        views = ["front_url", "back_url", "side_url"]
        trait = "  byte-identical trait\nwith newlines  "
        created = store.create(**_make_char(
            referenceViews=views,
            frozenTraitString=trait,
            projectId="proj-abc",
        ))

        fetched = store.get(created["id"])

        assert fetched is not None
        assert fetched["id"] == created["id"]
        assert fetched["referenceViews"] == views   # order preserved
        assert fetched["frozenTraitString"] == trait  # byte-identical
        assert fetched["version"] == 1
        assert fetched["projectId"] == "proj-abc"

    def test_get_missing_id_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        assert store.get("nonexistentid12") is None


class TestCharacterStoreList:
    def test_list_project_scope_returns_only_that_project(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        c1 = store.create(**_make_char(name="Char1", projectId="proj-x"))
        c2 = store.create(**_make_char(name="Char2", projectId="proj-x"))
        _c3 = store.create(**_make_char(name="Char3", projectId="proj-y"))
        _c_global = store.create(**_make_char(name="GlobalChar"))

        result = store.list(scope="project", projectId="proj-x")
        ids = {c["id"] for c in result}

        assert c1["id"] in ids
        assert c2["id"] in ids
        assert len(result) == 2

    def test_list_global_scope_excludes_project_scoped(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        _c_proj = store.create(**_make_char(name="ProjChar", projectId="proj-z"))
        c_global = store.create(**_make_char(name="GlobalChar"))

        result = store.list(scope="global")
        ids = {c["id"] for c in result}

        assert c_global["id"] in ids
        assert _c_proj["id"] not in ids

    def test_list_empty_project_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        result = store.list(scope="project", projectId="no-such-project")
        assert result == []

    def test_list_empty_global_returns_empty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        result = store.list(scope="global")
        assert result == []


class TestCharacterStoreUpdate:
    def test_update_bumps_version(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        created = store.create(**_make_char(projectId="proj-1"))
        assert created["version"] == 1

        updated = store.update(created["id"], name="Lena Renamed")
        assert updated["version"] == 2

    def test_update_refreshes_updated_at(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        created = store.create(**_make_char(projectId="proj-1"))
        updated = store.update(created["id"], name="New Name")

        # updatedAt must be >= createdAt (can land in same microsecond on fast machines)
        assert updated["updatedAt"] >= created["createdAt"]

    def test_update_persists_name_change(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        created = store.create(**_make_char(projectId="proj-1"))
        store.update(created["id"], name="Updated Name")

        fetched = store.get(created["id"])
        assert fetched["name"] == "Updated Name"

    def test_update_preserves_trait_string_byte_identical(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        trait = "  do NOT normalize  \n"
        created = store.create(**_make_char(frozenTraitString=trait, projectId="p1"))
        updated = store.update(created["id"], consistencyStrength=0.5)

        assert updated["frozenTraitString"] == trait

    def test_update_missing_id_raises(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(KeyError):
            store.update("nonexistentid12", name="ghost")


class TestCharacterStorePathTraversal:
    """Verify that invalid projectId values are rejected before any path is built."""

    def test_create_traversal_project_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid projectId"):
            store.create(**_make_char(projectId="../evil"))

    def test_create_absolute_project_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid projectId"):
            store.create(**_make_char(projectId="/etc/passwd"))

    def test_list_traversal_project_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid projectId"):
            store.list(scope="project", projectId="../evil")

    def test_list_absolute_project_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid projectId"):
            store.list(scope="project", projectId="/etc/passwd")

    def test_valid_project_id_with_dash_and_digit_works(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        char = store.create(**_make_char(projectId="proj_123"))
        assert char["projectId"] == "proj_123"
        listed = store.list(scope="project", projectId="proj_123")
        assert any(c["id"] == char["id"] for c in listed)


class TestCharacterStoreCharIdValidation:
    """Verify that invalid char_id values are rejected before any path is built."""

    def test_get_traversal_char_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid character id"):
            store.get("../evil")

    def test_get_slash_char_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid character id"):
            store.get("a/b")

    def test_update_traversal_char_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid character id"):
            store.update("../evil", name="bad")

    def test_update_slash_char_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid character id"):
            store.update("a/b", name="bad")

    def test_delete_traversal_char_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid character id"):
            store.delete("../evil")

    def test_delete_slash_char_id_raises_value_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(ValueError, match="invalid character id"):
            store.delete("a/b")

    def test_valid_12hex_char_id_does_not_raise(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        # get with a safe-format id on an empty store returns None (not an error)
        result = store.get("abc123def456")
        assert result is None


class TestCharacterStoreDelete:
    def test_delete_removes_character(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        char = store.create(**_make_char(projectId="proj-del"))
        store.delete(char["id"])

        assert store.get(char["id"]) is None

    def test_delete_removes_from_list(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        char = store.create(**_make_char(projectId="proj-del"))
        store.delete(char["id"])

        ids = [c["id"] for c in store.list(scope="project", projectId="proj-del")]
        assert char["id"] not in ids

    def test_delete_missing_id_raises(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEBULA_CHARACTER_ROOT", str(tmp_path))
        from services.character_store import CharacterStore
        store = CharacterStore()

        with pytest.raises(KeyError):
            store.delete("nonexistentid12")
