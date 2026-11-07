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


def _denied_by(args: list[str], path: Path) -> list[str]:
    """The deny entries of the Codex arguments ``args`` that are ``path`` or
    a folder holding it."""
    entries = next(a for a in args if a.startswith("permissions.nebula-agent.filesystem="))
    resolved = str(path.resolve())
    found = []
    for line in entries.split(", "):
        name = line.split(" = ")[0].strip("{ ").strip('"')
        if line.endswith('"deny"') or line.endswith('"deny"}'):
            if resolved == name or resolved.startswith(name.rstrip("/") + "/"):
                found.append(name)
    return found


def _codex_denies(path: Path) -> bool:
    """Whether Codex's filesystem args, built from the deny paths a turn
    passes (codex_session), deny ``path`` or a folder holding it."""
    deny = [*agent_profiles.protected_agent_dirs(), *agent_profiles.secret_dirs(),
            *agent_profiles.default_secret_paths()]
    args = agent_profiles.codex_filesystem_args(workdir=path.parent.parent / "work", deny_paths=deny)
    return bool(_denied_by(args, path))


def test_a_save_writes_its_temp_inside_the_private_folder(keyed, monkeypatch):
    seen = []
    real = settings._open_temp
    monkeypatch.setattr(settings, "_open_temp", lambda temp, **k: seen.append((temp, k.get("dir_fd"))) or real(temp, **k))
    settings.save_settings({"apiKeys": {"K": "new"}})
    folder = _folder(keyed)
    # Round 23c: a bare name made through the folder's descriptor, never a path.
    assert seen and all(os.sep not in name and dir_fd is not None for name, dir_fd in seen)
    assert _parses(keyed)["apiKeys"] == {"K": "new"}
    assert stat.S_IMODE(os.lstat(folder).st_mode) == 0o700
    assert list(folder.iterdir()) == []  # the temp went by rename


def test_codex_denies_the_temp_folder_and_a_temp_made_after_its_profile(keyed, tmp_path):
    from services import codex_session

    folder = settings.temp_folder_for(keyed.parent)
    assert not folder.exists()
    # Codex's profile is built FIRST, as a turn builds it: these are the
    # arguments its launcher receives (codex_session._codex_base_args).
    args = codex_session._codex_base_args(None, workdir=tmp_path / "work")
    settings.save_settings({"apiKeys": {"K": "a"}})  # the folder is made after the profile
    assert folder.is_dir()
    later = settings.new_temp_path_for(keyed)  # a temp made after the profile was built
    later.write_bytes(b'{"apiKeys": {"K": "secret"}}')
    covering = _denied_by(args, later)
    assert str(folder.resolve()) in covering, covering  # the folder entry is a prefix of the temp's path
    assert _denied_by(args, folder) and _denied_by(args, folder / "any-name")


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


@pytest.fixture(autouse=True)
def _fresh_log_flag(monkeypatch):
    monkeypatch.setattr(settings, "_private_refusal_logged", False)


def _saved_in_place(keyed: Path, value: str) -> None:
    """A save that finds no private folder writes in place: settings.json is
    valid and new, and nothing is ever written into the folder."""
    settings.save_settings({"apiKeys": {"K": value}})
    assert _parses(keyed)["apiKeys"] == {"K": value}


def test_a_symlinked_temp_folder_is_never_followed_and_the_save_goes_in_place(keyed, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    _folder(keyed).symlink_to(elsewhere, target_is_directory=True)
    _saved_in_place(keyed, "a")
    assert list(elsewhere.iterdir()) == []


def test_a_temp_folder_that_is_a_file_sends_the_save_in_place(keyed):
    _folder(keyed).write_bytes(b"in the way")
    _saved_in_place(keyed, "a")
    assert _folder(keyed).read_bytes() == b"in the way"


def test_a_folder_open_to_others_is_made_private_by_a_chmod(keyed):
    _folder(keyed).mkdir(mode=0o755)
    os.chmod(_folder(keyed), 0o755)
    settings.save_settings({"apiKeys": {"K": "a"}})
    assert stat.S_IMODE(os.lstat(_folder(keyed)).st_mode) == 0o700
    assert _parses(keyed)["apiKeys"] == {"K": "a"}


def _fixed_mode_directories(monkeypatch):
    """A filesystem that reports every directory 0755 whatever is set
    (vfat dmask=022, CIFS dir_mode=0755, NTFS-3g): mkdir and chmod are
    left without effect on the mode."""
    real_mkdir, real_fchmod = os.mkdir, os.fchmod

    def mkdir(path, mode=0o777, **kw):
        real_mkdir(path, 0o755, **kw)

    def fchmod(fd, mode):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            return
        real_fchmod(fd, mode)

    monkeypatch.setattr(settings.os, "mkdir", mkdir)
    monkeypatch.setattr(settings.os, "fchmod", fchmod)


def test_a_filesystem_with_fixed_modes_saves_in_place_and_never_writes_the_folder(keyed, monkeypatch, caplog):
    _fixed_mode_directories(monkeypatch)
    with caplog.at_level("WARNING"):
        _saved_in_place(keyed, "new")
        _saved_in_place(keyed, "newer")
    assert list(_folder(keyed).iterdir()) == []
    ours = [r for r in caplog.records if "private temp folder" in r.getMessage()]
    assert len(ours) == 1  # once per start
    assert str(keyed.parent) not in ours[0].getMessage() and "newer" not in ours[0].getMessage()


def test_a_filesystem_with_fixed_modes_makes_a_first_settings_file_in_place(tmp_path, monkeypatch):
    home = tmp_path / "home"
    path = home / "cfg" / "new.json"
    path.parent.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(path))
    monkeypatch.setenv("NEBULA_STATE_DIR", str(home / ".nebula"))
    _fixed_mode_directories(monkeypatch)
    settings.save_settings({"apiKeys": {"K": "first"}})
    assert json.loads(path.read_text())["apiKeys"] == {"K": "first"}
    assert stat.S_IMODE(os.lstat(path).st_mode) == 0o600
    assert list(settings.temp_folder_for(path.parent).iterdir()) == []


@pytest.mark.skipif(not hasattr(os, "geteuid"), reason="owner check")
def test_a_temp_folder_owned_by_someone_else_is_not_used_and_the_save_goes_in_place(keyed, monkeypatch):
    settings.save_settings({"apiKeys": {"K": "a"}})
    folder_ino = os.lstat(_folder(keyed)).st_ino
    real = settings._owned
    monkeypatch.setattr(settings, "_owned",
                        lambda info: False if stat.S_ISDIR(info.st_mode) and info.st_ino == folder_ino else real(info))
    _saved_in_place(keyed, "b")
    assert list(_folder(keyed).iterdir()) == []


def test_a_folder_swapped_for_a_symlink_after_the_check_never_receives_the_keys(keyed, tmp_path, monkeypatch):
    """The folder is opened once and used by descriptor: a swap after that
    lands nothing outside it (the old check-then-open-by-path let the temp
    be made in the folder the symlink pointed to)."""
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    folder = _folder(keyed)
    real = settings._open_private_folder

    def swap(parent, *, make):
        fd = real(parent, make=make)
        if make and fd is not None:
            os.rename(folder, str(folder) + ".old")
            os.symlink(elsewhere, folder)
        return fd

    monkeypatch.setattr(settings, "_open_private_folder", swap)
    touched = os.stat(elsewhere).st_mtime_ns
    settings.save_settings({"apiKeys": {"K": "new"}})
    # Nothing was made there, even a temp renamed away again (a directory's
    # modification time moves on any create or remove).
    assert list(elsewhere.iterdir()) == [] and os.stat(elsewhere).st_mtime_ns == touched
    assert _parses(keyed)["apiKeys"] == {"K": "new"}


def test_the_sweep_leaves_another_settings_files_temps_alone(keyed):
    folder = settings.temp_folder_for(keyed.parent)
    folder.mkdir(mode=0o700)
    mine = folder / (".%s.nebula-tmp-999999-0123456789abcdef" % keyed.name)
    theirs = folder / (".b.json.nebula-tmp-%d-0123456789abcdef" % os.getpid())
    copy_folder = settings.settings_copy_folder()
    copy_folder.mkdir(parents=True, exist_ok=True)
    os.chmod(copy_folder, 0o700)
    own_copy_folder = settings.temp_folder_for(copy_folder)
    own_copy_folder.mkdir(mode=0o700, exist_ok=True)
    own_copy = own_copy_folder / (settings.backup_path(keyed).name.join((".", ".nebula-tmp-999999-0123456789abcdef")))
    others_copy = own_copy_folder / (".settings-backup-%s.json.nebula-tmp-%d-0123456789abcdef" % ("f" * 16, os.getpid()))
    for f in (mine, theirs, own_copy, others_copy):
        f.write_bytes(b"{}")
    removed = settings.sweep_stale_temp_files()  # holds the lock
    assert mine in removed and own_copy in removed and not mine.exists() and not own_copy.exists()
    assert theirs.exists() and others_copy.exists()
    others_copy.unlink()  # the copy folder is shared by the module's tests


def test_the_copys_temp_lives_in_a_folder_of_its_own_in_the_copy_folder(keyed, monkeypatch):
    seen = []
    real = settings._open_temp
    monkeypatch.setattr(settings, "_open_temp", lambda temp, **k: seen.append((temp, k.get("dir_fd"))) or real(temp, **k))
    target = settings.backup_path(keyed)
    settings._make_copy_folder()
    settings._write_copy(target, b"{}")
    assert len(seen) == 1 and os.sep not in seen[0][0] and seen[0][1] is not None  # by descriptor
    assert target.read_bytes() == b"{}" and list(settings.temp_folder_for(target.parent).iterdir()) == []
    assert settings.temp_folder_for(settings.settings_copy_folder()) in settings.temp_folders()


def test_a_rename_across_devices_is_an_error_not_a_copy(keyed, monkeypatch):
    real = os.fstat

    def other_device(fd):
        info = real(fd)
        if stat.S_ISDIR(info.st_mode):
            return os.stat_result((info.st_mode, info.st_ino, info.st_dev + 1, *tuple(info)[3:]))
        return info

    monkeypatch.setattr(settings.os, "fstat", other_device)
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
