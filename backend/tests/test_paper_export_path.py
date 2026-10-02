"""Paper-only export guard stays independent of unpublished workspace services."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from services.paper_export_path import MAX_PAPER_EXPORT_BYTES, PNG_SIGNATURE, require_allowed_path


def exported(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PNG_SIGNATURE + b"fixture")
    return path


def test_accepts_standalone_png_export(tmp_path):
    path = exported(tmp_path / "logo.png")
    assert require_allowed_path(path) == path.resolve()


@pytest.mark.parametrize("path", ["logo.png", "/dev/logo.png", "/proc/logo.png", "/sys/logo.png", "/.vol/logo.png", "bad\x00.png", "bad\n.png"])
def test_rejects_relative_control_and_device_paths(path):
    with pytest.raises((OSError, ValueError)):
        require_allowed_path(path)


@pytest.mark.parametrize("name", [".codex", ".claude", ".ssh", ".aws", ".config", ".nebula"])
def test_rejects_export_inside_secret_namespace(tmp_path, monkeypatch, name):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    with pytest.raises(ValueError, match="Protected storage"):
        require_allowed_path(exported(tmp_path / name / "reference.png"))


def test_rejects_custom_state_and_settings_paths(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path / "state"))
    with pytest.raises(ValueError, match="Protected storage"):
        require_allowed_path(exported(tmp_path / "state" / "reference.png"))
    settings = exported(tmp_path / "settings.png")
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(settings))
    with pytest.raises(ValueError, match="Settings"):
        require_allowed_path(settings)


def test_rejects_symlink_to_protected_namespace(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    exported(tmp_path / ".codex" / "reference.png")
    (tmp_path / "alias").symlink_to(tmp_path / ".codex", target_is_directory=True)
    with pytest.raises(ValueError, match="Protected storage"):
        require_allowed_path(tmp_path / "alias" / "reference.png")


def test_rejects_final_symlink_and_hardlink(tmp_path):
    path = exported(tmp_path / "logo.png")
    alias = tmp_path / "alias.png"
    alias.symlink_to(path)
    with pytest.raises(ValueError, match="absolute PNG"):
        require_allowed_path(alias)
    alias.unlink()
    os.link(path, alias)
    with pytest.raises(ValueError, match="standalone"):
        require_allowed_path(alias)


def test_rejects_fake_png_and_oversized_export(tmp_path):
    fake = tmp_path / "logo.png"
    fake.write_bytes(b"private document")
    with pytest.raises(ValueError, match="not a PNG"):
        require_allowed_path(fake)
    large = exported(tmp_path / "large.png")
    with large.open("r+b") as stream:
        stream.truncate(MAX_PAPER_EXPORT_BYTES + 1)
    with pytest.raises(ValueError, match="32 MiB"):
        require_allowed_path(large)
