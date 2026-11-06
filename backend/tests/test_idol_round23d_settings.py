"""PR #203 round 23d: the settings save copies the old file's metadata onto
its temp file, and clears a copied ACL off it, by open descriptor only, so a
temp folder swapped for a symlink after the save opened it is never reached;
and the sweep puts a private folder that was chmodded open back to 0700.
"""
from __future__ import annotations

import os
import stat
import subprocess
import sys

import pytest

import services.settings as settings
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round15 import home_file  # noqa: F401 - fixture
from tests.test_idol_round17_settings import _parses, keyed  # noqa: F401 - fixture


def _swap_folder_after_open(monkeypatch, parent, elsewhere):
    real = settings._private_folder_or_in_place

    def swap(folder_parent):
        fd = real(folder_parent)
        folder = settings.temp_folder_for(folder_parent)
        os.rename(folder, str(folder) + ".old")
        os.symlink(elsewhere, folder)
        return fd

    monkeypatch.setattr(settings, "_private_folder_or_in_place", swap)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS: fcopyfile and the xattr tool")
def test_a_folder_swapped_after_open_gets_no_copy_of_the_metadata(keyed, tmp_path, monkeypatch):
    """copyfile(3) by path followed the swapped-in symlink: an empty file with
    settings.json's xattrs landed in the other folder, and settings.json
    lost its xattr. By descriptor, nothing lands and the xattr is carried."""
    subprocess.run(["xattr", "-w", "user.test", "v", str(keyed)], check=True)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    _swap_folder_after_open(monkeypatch, keyed.parent, elsewhere)
    settings.save_settings({"favorites": ["saved"]})
    assert _parses(keyed) == {"favorites": ["saved"]}
    assert list(elsewhere.iterdir()) == []
    kept = subprocess.run(["xattr", str(keyed)], capture_output=True, text=True).stdout
    assert "user.test" in kept


def test_no_metadata_call_ever_takes_a_path_to_the_temp(keyed, monkeypatch):
    """Linux's copy, with os.*xattr patched: every call is by descriptor."""
    calls: list[tuple[str, object]] = []
    attrs = {"user.nebula-tag": b"kept", "security.selinux": b"own"}

    def listxattr(target, *a, **k):
        calls.append(("list", target))
        return list(attrs)

    def getxattr(target, name, *a, **k):
        calls.append(("get", target))
        return attrs[name]

    def setxattr(target, name, value, *a, **k):
        calls.append(("set", target))
        assert name == "user.nebula-tag" and value == b"kept"

    monkeypatch.setattr(settings, "_PLATFORM", "linux")
    monkeypatch.setattr(settings, "_listxattr", listxattr)
    monkeypatch.setattr(settings, "_getxattr", getxattr)
    monkeypatch.setattr(settings, "_setxattr", setxattr)
    settings.save_settings({"favorites": ["saved"]})
    kinds = {kind for kind, _ in calls}
    assert {"list", "get", "set"} <= kinds
    # the temp is only ever written through its descriptor
    assert all(isinstance(target, int) for kind, target in calls if kind == "set")
    assert [target for kind, target in calls if kind == "get"] and all(
        isinstance(target, int) for kind, target in calls if kind == "get")
    assert _parses(keyed) == {"favorites": ["saved"]}


def test_darwin_clear_acl_and_copy_take_descriptors(monkeypatch, tmp_path):
    """The ACL clear and the copy are called with integers, never paths."""
    seen: list[tuple[str, tuple]] = []

    class Fn:
        def __init__(self, name, result=1):
            self.name, self.result = name, result

        def __call__(self, *args):
            seen.append((self.name, args))
            return self.result

    class Lib:
        def __init__(self):
            for name in ("fcopyfile", "acl_set_fd_np"):
                setattr(self, name, Fn(name, 0))
            self.acl_init = Fn("acl_init", 99)
            self.acl_free = Fn("acl_free", 0)

    monkeypatch.setattr(settings, "_libc", lambda: Lib())
    settings._darwin_copy_metadata(7, 8)
    settings._darwin_clear_acl(8)
    by_name = {name: args for name, args in seen}
    assert by_name["fcopyfile"][:2] == (7, 8) and by_name["acl_set_fd_np"][0] == 8


def test_a_private_folder_chmodded_open_is_restored_and_swept(keyed):
    folder = settings.temp_folder_for(keyed.parent)
    folder.mkdir(mode=0o700)
    leftover = folder / f".{keyed.name}.nebula-tmp-999999-0123456789abcdef"
    leftover.write_text("keys")
    os.chmod(folder, 0o755)
    removed = settings.sweep_stale_temp_files()
    assert not leftover.exists() and leftover in removed
    assert stat.S_IMODE(os.lstat(folder).st_mode) == 0o700


def test_the_sweep_never_chmods_a_symlink_or_a_stranger_s_folder(keyed, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    os.chmod(other, 0o755)
    os.symlink(other, settings.temp_folder_for(keyed.parent))
    settings.sweep_stale_temp_files()
    assert stat.S_IMODE(os.lstat(other).st_mode) == 0o755
