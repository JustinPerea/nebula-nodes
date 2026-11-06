"""PR #203 round 23b: every save's unique temp file lives inside one private
folder beside the file it saves (".settings-nebula-tmp", 0700), and every
agent's deny covers that folder, so a temp made after an agent's profile is
built (Codex's deny paths are exact) is inside a denied folder.
"""
from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path

import pytest

import services.settings as settings
from services import agent_profiles, file_access
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round15 import home_file  # noqa: F401 - fixture
from tests.test_idol_round17_settings import _parses, keyed  # noqa: F401 - fixture


def _folder(keyed_path: Path) -> Path:
    return settings.temp_folder_for(keyed_path.parent)


def _codex_denies(path: Path) -> bool:
    """Whether Codex's filesystem args, built from the deny paths a turn
    passes (codex_session), deny ``path`` or a folder holding it."""
    deny = [*agent_profiles.protected_agent_dirs(), *agent_profiles.secret_dirs(),
            *agent_profiles.default_secret_paths()]
    args = agent_profiles.codex_filesystem_args(workdir=path.parent.parent / "work", deny_paths=deny)
    entries = next(a for a in args if a.startswith("permissions.nebula-agent.filesystem="))
    resolved = str(path.resolve())
    for line in entries.split(", "):
        name = line.split(" = ")[0].strip("{ ").strip('"')
        if line.endswith('"deny"') or line.endswith('"deny"}'):
            if resolved == name or resolved.startswith(name.rstrip("/") + "/"):
                return True
    return False


def test_a_save_writes_its_temp_inside_the_private_folder(keyed, monkeypatch):
    seen = []
    real = settings._open_temp
    monkeypatch.setattr(settings, "_open_temp", lambda temp, **k: seen.append(temp) or real(temp, **k))
    settings.save_settings({"apiKeys": {"K": "new"}})
    folder = _folder(keyed)
    assert seen and all(Path(t).parent == folder for t in seen)
    assert _parses(keyed)["apiKeys"] == {"K": "new"}
    assert stat.S_IMODE(os.lstat(folder).st_mode) == 0o700
    assert list(folder.iterdir()) == []  # the temp went by rename


def test_codex_denies_the_temp_folder_and_a_temp_made_after_its_profile(keyed):
    folder = settings.temp_folder_for(keyed.parent)
    settings.save_settings({"apiKeys": {"K": "a"}})  # the folder exists now
    assert _codex_denies(folder)
    later = settings.new_temp_path_for(keyed)  # made after the profile was built
    later.write_bytes(b'{"apiKeys": {"K": "secret"}}')
    assert later.parent == folder and _codex_denies(later)


def test_codex_deny_list_holds_the_folder_itself(keyed):
    settings.save_settings({"apiKeys": {"K": "a"}})
    folder = settings.temp_folder_for(keyed.parent).resolve()
    assert folder in [p.resolve() for p in agent_profiles.secret_dirs()]  # mutation: drop it and this fails
    assert _codex_denies(folder / ".settings.json.nebula-tmp-1-0123456789abcdef")


def test_claude_denies_the_folder_and_anything_made_in_it(keyed):
    import fnmatch

    settings.save_settings({"apiKeys": {"K": "a"}})
    rules = [*agent_profiles.secret_deny_rules(agent_profiles.default_secret_paths()),
             *agent_profiles.dir_deny_rules(agent_profiles.secret_dirs())]
    later = settings.new_temp_path_for(keyed)
    deny = [r[len("Read(/"):-1] for r in rules]
    assert any(fnmatch.fnmatchcase(str(later.resolve()), pattern.replace("/**", "/*")) or
               str(later.resolve()).startswith(pattern.rstrip("*")) for pattern in deny
               if pattern.endswith("/**")), deny


def test_require_allowed_path_refuses_the_folder_and_a_temp_in_it(keyed):
    settings.save_settings({"apiKeys": {"K": "a"}})
    later = settings.new_temp_path_for(keyed)
    later.write_bytes(b"{}")
    with pytest.raises(file_access.ProtectedPathError):
        file_access.require_allowed_path(later)
    with pytest.raises(file_access.ProtectedPathError):
        file_access.require_allowed_path(_folder(keyed))
    # A file in the folder under any name is refused (the folder entry, not the name).
    odd = _folder(keyed) / "whatever"
    odd.write_bytes(b"{}")
    with pytest.raises(file_access.ProtectedPathError):
        file_access.require_allowed_path(odd)


def test_secret_temp_paths_lists_the_folder(keyed):
    assert settings.temp_folder_for(keyed.parent) in settings.secret_temp_paths()


def test_a_symlinked_temp_folder_is_refused_and_not_followed(keyed, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    _folder(keyed).symlink_to(elsewhere, target_is_directory=True)
    before = keyed.read_bytes()
    with pytest.raises(settings.SettingsUnwritable):
        settings.save_settings({"apiKeys": {"K": "a"}})
    assert keyed.read_bytes() == before and list(elsewhere.iterdir()) == []


def test_a_temp_folder_that_is_a_file_or_open_to_others_is_refused(keyed):
    _folder(keyed).write_bytes(b"in the way")
    with pytest.raises(settings.SettingsUnwritable):
        settings.save_settings({"apiKeys": {"K": "a"}})
    _folder(keyed).unlink()
    _folder(keyed).mkdir(mode=0o755)
    os.chmod(_folder(keyed), 0o755)
    with pytest.raises(settings.SettingsUnwritable):
        settings.save_settings({"apiKeys": {"K": "a"}})
    assert _parses(keyed)["apiKeys"]["FAL_KEY"].startswith("fal-kept-")


@pytest.mark.skipif(not hasattr(os, "geteuid"), reason="owner check")
def test_a_temp_folder_owned_by_someone_else_is_refused(keyed, monkeypatch):
    settings.save_settings({"apiKeys": {"K": "a"}})
    monkeypatch.setattr(settings, "_owned", lambda info: False)
    with pytest.raises(settings.SettingsUnwritable):
        settings.save_settings({"apiKeys": {"K": "b"}})


def test_the_copys_temp_lives_in_a_folder_of_its_own_in_the_copy_folder(keyed, monkeypatch):
    seen = []
    real = settings._open_temp
    monkeypatch.setattr(settings, "_open_temp", lambda temp, **k: seen.append(Path(temp)) or real(temp, **k))
    target = settings.backup_path(keyed)
    settings._make_copy_folder()
    settings._write_copy(target, b"{}")
    assert [p.parent for p in seen] == [settings.temp_folder_for(target.parent)]
    assert settings.temp_folder_for(settings.settings_copy_folder()) in settings.temp_folders()


def test_a_rename_across_devices_is_an_error_not_a_copy(keyed, monkeypatch):
    real = os.stat

    def other_device(p, *a, **k):
        info = real(p, *a, **k)
        if str(p).endswith(settings.TEMP_FOLDER):
            return os.stat_result((info.st_mode, info.st_ino, info.st_dev + 1, *tuple(info)[3:]))
        return info

    monkeypatch.setattr(settings.os, "stat", other_device)
    before = keyed.read_bytes()
    with pytest.raises(settings.SettingsUnwritable):
        settings.save_settings({"apiKeys": {"K": "a"}})
    assert keyed.read_bytes() == before
    assert list(_folder(keyed).iterdir()) == []  # the failed save removed its own temp


def test_the_sweep_clears_leftovers_in_the_folder_and_the_old_layout(keyed):
    folder = settings.temp_folder_for(keyed.parent)
    folder.mkdir(mode=0o700)
    inside = folder / ".settings.json.nebula-tmp-999999-0123456789abcdef"
    old_layout = keyed.with_name(".settings.json.nebula-tmp-999999-fedcba9876543210")
    old_shared = settings.temp_path_for(keyed)
    for f in (inside, old_layout, old_shared):
        f.write_bytes(b"{}")
    settings.sweep_stale_temp_files()  # holds the lock: all are leftovers
    assert not inside.exists() and not old_layout.exists() and not old_shared.exists()
    assert folder.is_dir()


def test_the_unlocked_sweep_judges_a_stale_temp_inside_the_folder(keyed):
    folder = settings.temp_folder_for(keyed.parent)
    folder.mkdir(mode=0o700)
    inside = folder / ".settings.json.nebula-tmp-999999-0123456789abcdef"
    fresh = folder / ".settings.json.nebula-tmp-999999-aaaaaaaaaaaaaaaa"
    inside.write_bytes(b"{}")
    fresh.write_bytes(b"{}")
    past = time.time() - 600
    os.utime(inside, (past, past))
    settings._sweep(keyed, None, locked=False)
    assert not inside.exists() and fresh.exists()


def test_the_sweep_never_follows_a_symlinked_temp_folder(keyed, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    victim = elsewhere / ".settings.json.nebula-tmp-999999-0123456789abcdef"
    victim.write_bytes(b"{}")
    _folder(keyed).symlink_to(elsewhere, target_is_directory=True)
    settings.sweep_stale_temp_files()
    assert victim.exists()
