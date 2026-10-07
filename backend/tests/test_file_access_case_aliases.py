"""Conservative name matching closes case/Unicode aliases on macOS volumes."""
from __future__ import annotations

import unicodedata
from pathlib import Path

import pytest

from services.file_access import ProtectedPathError, require_allowed_path


@pytest.fixture
def protected_root(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    root.mkdir()
    (root / "reference.png").write_bytes(b"synthetic private fixture")
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    return root


@pytest.mark.parametrize("suffix", ["reference.png", "future/graph.json"])
def test_case_alias_of_protected_directory_is_denied(protected_root, suffix):
    # This is the same directory on the developer's case-insensitive macOS
    # volume. Denial is intentionally conservative on case-sensitive CI too.
    alias = protected_root.with_name("COMMONS") / suffix
    with pytest.raises(ProtectedPathError):
        require_allowed_path(alias)


def test_case_alias_when_configured_protected_name_is_uppercase(
    protected_root, monkeypatch
):
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(protected_root.with_name("COMMONS")))
    with pytest.raises(ProtectedPathError):
        require_allowed_path(protected_root / "new.json")


@pytest.mark.parametrize("form", ["uppercase", "nfd", "uppercase-nfd"])
def test_secret_file_case_and_unicode_aliases_denied(tmp_path, monkeypatch, form):
    import services.settings as settings

    secret = tmp_path / "crédentials.json"
    secret.write_text("synthetic secret fixture")
    monkeypatch.setattr(settings, "SETTINGS_PATH", secret)
    name = secret.name.upper() if "uppercase" in form else secret.name
    if "nfd" in form:
        name = unicodedata.normalize("NFD", name)
    with pytest.raises(ProtectedPathError):
        require_allowed_path(secret.with_name(name))


def test_protected_directory_unicode_alias_denied(tmp_path, monkeypatch):
    root = tmp_path / "références"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    alias = root.with_name(unicodedata.normalize("NFD", root.name)) / "future.png"
    with pytest.raises(ProtectedPathError):
        require_allowed_path(alias)


def test_adjacent_name_is_still_allowed(protected_root):
    adjacent = protected_root.with_name("commons-public") / "reference.png"
    assert require_allowed_path(adjacent) == adjacent.resolve()
