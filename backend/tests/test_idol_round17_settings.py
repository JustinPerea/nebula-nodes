"""PR #203 round 17, section 2: review 16's settings findings.

- MEDIUM-1: no save loses settings.json. A file whose ACL and extended
  attributes can be carried stays atomic; an in-place write grows the file
  first, writes the new JSON over the old, then cuts it, so it parses at
  every step, keeps a verified copy of the old file in Nebula's own folder
  (put back at the next start when the file doesn't parse), and every save
  holds an exclusive lock.
- LOW-1: the startup sweep removes only Nebula's own temp names.
- LOW-2: the temp file's group (S15) and a file that turns read-only before
  the in-place write (S16).
- NIT-2: every missing folder level is 0700, and the line names the folder
  that refuses (GM r33 item 5).
- NIT-3: the in-place write never follows a symlink or writes a file other
  than the one it decided on.
"""
from __future__ import annotations

import errno
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import _person
from tests.test_idol_round15 import PERSON_LINE, SAVED, home_file  # noqa: F401 - fixture
from tests.test_idol_round15 import _refused as _refusal

BACKEND = Path(__file__).resolve().parents[1]
OLD = {"apiKeys": {"FAL_KEY": "fal-kept-" + "1" * 40}, "favorites": ["x" * 2000]}
DARWIN = sys.platform == "darwin"


@pytest.fixture
def keyed(home_file):
    """settings.json holding a key, about 2 KB."""
    home_file.write_text(json.dumps(OLD, indent=2) + "\n", encoding="utf-8")
    yield home_file


def _parses(path: Path) -> dict:
    return json.loads(path.read_bytes())


def _left(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir())


def _child(code: str, timeout: float = 60) -> subprocess.CompletedProcess:
    """Python in a child process with this test's environment (its settings
    path and Nebula folder)."""
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=BACKEND, env=os.environ.copy(),
                          capture_output=True, text=True, timeout=timeout)


def _hard_link(path: Path) -> Path:
    other = path.parent.parent / "other-name.json"
    os.link(path, other)
    return other


def _acl(path: Path, entry: str) -> None:
    subprocess.run(["chmod", "+a", entry, str(path)], check=True)


def _no_acl(path: Path) -> None:
    subprocess.run(["chmod", "-N", str(path)], check=False)


def _xattr(path: Path, name: str = "com.apple.quarantine", value: str = "0081;5f000000;Safari;") -> None:
    if hasattr(os, "setxattr"):
        os.setxattr(path, f"user.{name}", value.encode())
    else:
        subprocess.run(["xattr", "-w", name, value, str(path)], check=True)


def _xattrs(path: Path) -> list[str]:
    if hasattr(os, "listxattr"):
        return [n.removeprefix("user.") for n in os.listxattr(path)]
    return subprocess.run(["xattr", str(path)], capture_output=True, text=True, check=True).stdout.split()


XATTRS = hasattr(os, "setxattr") or bool(shutil.which("xattr"))


# -- the reviewer's p1: a full disk (RLIMIT_FSIZE) never cuts the file ----------------------

FULL_DISK = """
import json, resource, signal
signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
resource.setrlimit(resource.RLIMIT_FSIZE, (4000, 4000))
import services.settings as s
try:
    s.save_settings({"apiKeys": {"FAL_KEY": "fal-new-" + "2" * 40}, "favorites": ["y" * 8000]})
    print("SAVED")
except OSError as e:
    print("RAISED", type(e).__name__, e.errno)
"""


def _full_disk_case(keyed, kind):
    folder = keyed.parent
    if kind == "hardlink":
        _hard_link(keyed)
    elif kind == "xattr":
        _xattr(keyed)
    elif kind == "acl-deny-delete":
        _acl(keyed, "everyone deny delete")
    before = keyed.read_bytes()
    if kind == "ro-folder":
        folder.chmod(0o555)
    try:
        result = _child(FULL_DISK)
    finally:
        folder.chmod(0o755)
        if kind == "acl-deny-delete":
            _no_acl(keyed)
    assert result.stdout.split()[:3] == ["RAISED", "OSError", str(errno.EFBIG)], result
    assert keyed.read_bytes() == before
    assert _parses(keyed)["apiKeys"]["FAL_KEY"] == OLD["apiKeys"]["FAL_KEY"]
    assert _left(folder) == ["settings.json"]
    assert not settings.backup_path(keyed).exists()


@pytest.mark.parametrize("kind", ["plain", "hardlink", pytest.param("xattr", marks=pytest.mark.skipif(
    not XATTRS, reason="no xattr support")), pytest.param("acl-deny-delete", marks=[pytest.mark.skipif(
        not DARWIN, reason="macOS ACLs (chmod +a)"), pytest.mark.unprivileged])])  # root ignores ACLs
def test_a_full_disk_leaves_the_old_file_whole(keyed, kind):
    _full_disk_case(keyed, kind)


@pytest.mark.unprivileged
def test_a_full_disk_in_a_read_only_folder_leaves_the_old_file_whole(keyed):
    _full_disk_case(keyed, "ro-folder")


# -- ENOSPC during the grow and during the new JSON (simulated) ------------------------------

def _no_space_on(calls: set[int], partial: bool = False):
    """settings._pwrite that fails with ENOSPC on the given calls (1 = the
    first), after writing half of what it was given when ``partial``."""
    real = settings._pwrite
    seen = {"n": 0}

    def pwrite(fd, data, offset):
        seen["n"] += 1
        if seen["n"] in calls:
            if partial:
                real(fd, bytes(data[:len(data) // 2]), offset)
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(fd, data, offset)

    return pwrite


@pytest.mark.parametrize("new_favorites,failing,partial", [
    (["y" * 8000], {1}, False),        # the grow fails: the old JSON never changed
    (["y" * 8000], {2}, True),         # half the new JSON written, then a full disk
    (["short"], {1}, True),            # shorter: the new JSON (padded) is the first write
], ids=["during-the-grow", "during-the-new-json", "shorter-during-the-new-json"])
def test_no_space_in_the_in_place_write_puts_the_old_file_back(keyed, monkeypatch, new_favorites, failing, partial):
    _hard_link(keyed)  # written in place
    before = keyed.read_bytes()
    monkeypatch.setattr(settings, "_pwrite", _no_space_on(failing, partial))
    with pytest.raises(OSError) as raised:
        settings.save_settings({"apiKeys": {"FAL_KEY": "fal-new"}, "favorites": new_favorites})
    assert raised.value.errno == errno.ENOSPC and not isinstance(raised.value, settings.SettingsUnwritable)
    assert keyed.read_bytes() == before
    assert not settings.backup_path(keyed).exists()


def test_a_full_disk_during_the_grow_leaves_json_that_parses_even_with_no_way_back(keyed, monkeypatch):
    """The grow is first so a full disk fails before the old JSON changes:
    half the spaces written and nothing written back still parses."""
    _hard_link(keyed)
    monkeypatch.setattr(settings, "_pwrite", _no_space_on(set(range(1, 100)), partial=True))
    with pytest.raises(OSError):
        settings.save_settings({"apiKeys": {"FAL_KEY": "fal-new"}, "favorites": ["y" * 8000]})
    assert _parses(keyed) == OLD


def test_a_file_left_broken_is_put_back_from_its_copy_at_the_next_start(keyed, monkeypatch):
    """The new JSON half written and the put-back failing too: the file
    doesn't parse, and the next start puts the copy back."""
    _hard_link(keyed)
    before = keyed.read_bytes()
    real = settings._pwrite
    monkeypatch.setattr(settings, "_pwrite", _no_space_on(set(range(2, 100)), partial=True))
    with pytest.raises(OSError):
        settings.save_settings({"apiKeys": {"FAL_KEY": "fal-new"}, "favorites": ["y" * 8000]})
    monkeypatch.setattr(settings, "_pwrite", real)
    with pytest.raises(ValueError):
        _parses(keyed)
    assert settings.backup_path(keyed).exists()
    broken = keyed.read_bytes()
    restored = settings.restore_settings_from_backup()
    assert restored.path == keyed and restored.unfinished
    assert keyed.read_bytes() == before and restored.kept.read_bytes() == broken
    assert not settings.backup_path(keyed).exists()


# -- the reviewer's p2: a kill at any step leaves JSON that parses ------------------------

KILL_AT = """
import os, signal
import services.settings as s
point = {point!r}
calls = {{"pwrite": 0}}
real_pwrite, real_truncate, real_replace = s._pwrite, s._truncate, s._replace

def die():
    os.kill(os.getpid(), signal.SIGKILL)

if point == "after-open":
    s._read_all = lambda fd, size: die()
elif point == "after-the-grow":
    def pwrite(fd, data, offset):
        calls["pwrite"] += 1
        if calls["pwrite"] == 2:
            die()
        return real_pwrite(fd, data, offset)
    s._pwrite = pwrite
elif point == "after-the-new-json":
    s._truncate = lambda fd, length: die()
elif point == "before-the-rename":
    s._replace = lambda src, dst: die()
s.save_settings({{"apiKeys": {{"FAL_KEY": "fal-new"}}, "favorites": {favorites!r}}})
print("SAVED")
"""


@pytest.mark.parametrize("point,favorites,in_place,kept", [
    ("after-open", ["y"], True, "old"),
    ("after-the-grow", ["y" * 8000], True, "old"),
    ("after-the-new-json", ["y"], True, "new"),
    ("before-the-rename", ["y"], False, "old"),
])
def test_a_kill_at_any_step_leaves_settings_that_parse(keyed, point, favorites, in_place, kept):
    if in_place:
        _hard_link(keyed)
    result = _child(KILL_AT.format(point=point, favorites=favorites))
    assert result.returncode == -signal.SIGKILL, result
    saved = _parses(keyed)
    assert saved["apiKeys"]["FAL_KEY"] == (OLD["apiKeys"]["FAL_KEY"] if kept == "old" else "fal-new")
    # The next start: the file parses, so its copy is dropped and nothing is put back.
    assert settings.restore_settings_from_backup() is None
    assert not settings.backup_path(keyed).exists()
    assert _parses(keyed) == saved


# -- the reviewer's p3: two Nebulas saving at once never interleave -------------------------

HOLD = """
import os, time
import services.settings as s
seam = {seam!r}
real = getattr(s, seam)
held = {{"done": False}}

def hold(*args):
    if not held["done"]:
        held["done"] = True
        open({inside!r}, "w").close()
        deadline = time.monotonic() + 30
        while not os.path.exists({go!r}):
            if time.monotonic() > deadline:
                raise SystemExit("never released")
            time.sleep(0.01)
    return real(*args)

setattr(s, seam, hold)
s.save_settings({{"apiKeys": {{"FAL_KEY": "fal-A"}}, "favorites": ["a" * 3000]}})
print("A SAVED")
"""

WAIT = """
import services.settings as s
s._lock_waiting = lambda: open({waiting!r}, "w").close()
s.save_settings({{"apiKeys": {{"FAL_KEY": "fal-B"}}, "favorites": ["b"]}})
print("B SAVED")
"""


def _wait_for(path: Path, process: subprocess.Popen, what: str) -> None:
    deadline = time.monotonic() + 30
    while not path.exists():
        assert process.poll() is None, f"{what}: the child exited first: {process.communicate()}"
        assert time.monotonic() < deadline, f"{what} never happened"
        time.sleep(0.01)


@pytest.mark.parametrize("kind", ["atomic", "in-place"])
def test_two_processes_saving_at_once_take_turns(keyed, tmp_path, kind):
    """A holds the save's lock in the middle of its write; B, started then,
    waits for it (its wait is seen, never timed) and saves after A. The file
    is B's whole JSON."""
    if kind == "in-place":
        _hard_link(keyed)
    inside, go, waiting = tmp_path / "A-inside", tmp_path / "go", tmp_path / "B-waiting"
    seam = "_replace" if kind == "atomic" else "_pwrite"
    run = lambda code: subprocess.Popen([sys.executable, "-c", textwrap.dedent(code)], cwd=BACKEND,  # noqa: E731
                                        env=os.environ.copy(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True)
    a = run(HOLD.format(seam=seam, inside=str(inside), go=str(go)))
    b = None
    try:
        _wait_for(inside, a, "A inside its write")
        b = run(WAIT.format(waiting=str(waiting)))
        _wait_for(waiting, b, "B waiting for A's lock")
        assert a.poll() is None and b.poll() is None
        go.touch()
        out_a, err_a = a.communicate(timeout=60)
        out_b, err_b = b.communicate(timeout=60)
    finally:
        go.touch()
        for child in (a, b):
            if child is not None and child.poll() is None:
                child.kill()
    assert out_a.strip() == "A SAVED" and out_b.strip() == "B SAVED", (err_a, err_b)
    assert _parses(keyed) == {"apiKeys": {"FAL_KEY": "fal-B"}, "favorites": ["b"]}
    assert _left(keyed.parent) == ["settings.json"]


# -- the copy and the restore at start ---------------------------------------------------

def copy_body(path: str, text: str, next_text: str = '{"favorites": []}\n') -> dict:
    """A copy as _keep_backup writes it (round 18: marked, hashed, with the
    text being written)."""
    return {"nebula": "settings-copy", "version": 1, "path": path,
            "sha256": settings._copy_digest(Path(path), text, next_text), "text": text, "next": next_text}


def write_copy(target: Path, body: dict) -> None:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.write_text(json.dumps(body), encoding="utf-8")
    target.chmod(0o600)


def _broken_with_copy(path: Path) -> bytes:
    """A copy for ``path`` and the file cut to half of it: not what the save
    leaves part way, so why it doesn't parse isn't known."""
    good = path.read_bytes()
    write_copy(settings.backup_path(path.resolve()), copy_body(str(path.resolve()), good.decode()))
    path.write_bytes(good[: len(good) // 2])
    return good


def test_a_file_that_doesnt_parse_is_put_back_at_start_journaled_and_logged(keyed, caplog, monkeypatch):
    monkeypatch.setenv("NEBULA_STATE_DIR", str(keyed.parent))  # ~/.nebula, as the person's own
    good = _broken_with_copy(keyed)
    start = main.canvas_events.read(after=None)["cursor"]
    with caplog.at_level("WARNING", logger="nebula.settings"):
        with TestClient(main.app):
            pass
    assert keyed.read_bytes() == good
    assert not settings.backup_path(keyed).exists()
    [event] = [e for e in main.canvas_events.read(after=start, limit=200)["events"] if e["kind"] == "settings.restored"]
    assert event["actor"]["kind"] == "system"
    [kept] = [p for p in settings.settings_copy_folder().iterdir() if p.name.startswith("settings-replaced-")
              and p.read_bytes() == good[: len(good) // 2]]
    shown_kept = settings.shown_path(kept)
    line = f"Nebula restored your settings from its saved copy. The file it replaced is kept at {shown_kept}."
    assert event["data"] == {"file": "~/.nebula/settings.json", "keptAt": shown_kept}
    assert event["summary"] == line
    assert "fal-kept" not in json.dumps(event)
    assert [record.getMessage() for record in caplog.records if record.name == "nebula.settings"] == [line]


def test_until_the_restore_agents_read_the_unreadable_answer(keyed):
    """The copy changes nothing before the start that restores it."""
    _broken_with_copy(keyed)
    with pytest.raises(settings.SettingsUnreadable):
        settings.load_settings()


def test_a_file_that_parses_drops_its_copy_and_is_left_as_it_is(keyed):
    good = _broken_with_copy(keyed)
    keyed.write_text('{"favorites": ["newer"]}\n', encoding="utf-8")
    assert settings.restore_settings_from_backup() is None
    assert _parses(keyed) == {"favorites": ["newer"]} and keyed.read_bytes() != good
    assert not settings.backup_path(keyed).exists()


def test_another_files_copy_and_a_gone_file_are_never_restored(keyed, tmp_path):
    _broken_with_copy(keyed)
    target = settings.backup_path(keyed.resolve())
    kept = json.loads(target.read_text(encoding="utf-8"))
    write_copy(target, copy_body(str(tmp_path / "elsewhere.json"), kept["text"], kept["next"]))
    assert settings.restore_settings_from_backup() is None and target.exists()
    keyed.unlink()
    write_copy(target, kept)
    assert settings.restore_settings_from_backup() is None
    assert not keyed.exists() and not target.exists()


@pytest.mark.unprivileged
def test_a_file_nebula_cant_read_keeps_its_copy_and_is_left(keyed):
    _broken_with_copy(keyed)
    keyed.chmod(0o200)
    try:
        assert settings.restore_settings_from_backup() is None
    finally:
        keyed.chmod(0o644)
    assert settings.backup_path(keyed).exists()


def test_the_copy_is_this_users_only_verified_and_gone_after_the_write(keyed, monkeypatch):
    """Kept before the in-place write changes a byte: 0600, the old bytes
    exactly, then removed."""
    _hard_link(keyed)
    before = keyed.read_bytes()
    seen = []
    real = settings._overwrite

    def look(fd, data, old):
        target = settings.backup_path(keyed)
        seen.append((stat.S_IMODE(target.stat().st_mode), json.loads(target.read_text(encoding="utf-8"))))
        assert keyed.read_bytes() == before
        real(fd, data, old)

    monkeypatch.setattr(settings, "_overwrite", look)
    settings.save_settings({"favorites": []})
    [(mode, kept)] = seen
    assert mode == 0o600 and kept == copy_body(str(keyed), before.decode(), '{\n  "favorites": []\n}\n')
    assert not settings.backup_path(keyed).exists()
    assert _parses(keyed) == {"favorites": []}


def test_an_atomic_save_keeps_no_copy(keyed, monkeypatch):
    monkeypatch.setattr(settings, "_keep_backup", lambda *a: pytest.fail("an atomic save kept a copy"))
    settings.save_settings({"favorites": []})


@pytest.mark.unprivileged
def test_a_copy_nebula_isnt_allowed_to_make_refuses_the_save_before_it_writes(keyed, tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    _hard_link(keyed)
    before = keyed.read_bytes()
    state.chmod(0o555)
    try:
        with pytest.raises(settings.SettingsUnwritable) as refused:
            settings.save_settings({"favorites": []})
    finally:
        state.chmod(0o755)
    assert refused.value.cause == "copy_folder" and refused.value.where == state
    assert keyed.read_bytes() == before


def test_a_copy_that_doesnt_read_back_refuses_the_save_before_it_writes(keyed, monkeypatch):
    _hard_link(keyed)
    before = keyed.read_bytes()
    real = settings._write_all

    def short_copy(fd, data):
        real(fd, data[:-1] if bytes(data[:11]) == b'{"nebula": ' else data)

    monkeypatch.setattr(settings, "_write_all", short_copy)
    with pytest.raises(OSError) as raised:
        settings.save_settings({"favorites": []})
    assert raised.value.errno == errno.EIO
    assert keyed.read_bytes() == before


# -- (c): the lock is on the file that is there now ---------------------------------------

def test_a_lock_taken_on_a_file_since_replaced_is_taken_again(keyed, monkeypatch):
    stale = os.open(keyed, os.O_RDONLY)
    fresh = keyed.with_name("fresh.json")
    fresh.write_text("{}", encoding="utf-8")
    os.replace(fresh, keyed)
    real = settings._lock_target
    targets = [lambda path: stale, real]
    monkeypatch.setattr(settings, "_lock_target", lambda path: targets.pop(0)(path))
    fd = settings._locked(keyed)
    try:
        assert fd is not None and os.fstat(fd).st_ino == keyed.stat().st_ino
    finally:
        os.close(fd)
    assert not targets


def test_with_no_file_the_folder_is_locked_until_a_file_is_there(home_file):
    home_file.unlink()
    folder_fd = os.open(home_file.parent, os.O_RDONLY)
    try:
        assert settings._lock_holds(folder_fd, home_file)
        home_file.write_text("{}", encoding="utf-8")
        assert not settings._lock_holds(folder_fd, home_file)
    finally:
        os.close(folder_fd)


# -- (a): a file with an ACL and extended attributes stays atomic and keeps them ------------

@pytest.mark.unprivileged  # a chmod +a the scan can't read (root ignores ACLs)
@pytest.mark.skipif(not DARWIN, reason="macOS: copyfile(3), chmod +a and xattr")
def test_an_acl_and_xattr_file_stays_atomic_and_keeps_both_on_macos(keyed):
    _xattr(keyed)
    _acl(keyed, "everyone allow read")
    try:
        inode = keyed.stat().st_ino
        assert _person().put("/api/settings", json={"favorites": ["saved"]}).status_code == 200
        assert keyed.stat().st_ino != inode
        assert _parses(keyed)["favorites"] == ["saved"]
        assert "com.apple.quarantine" in _xattrs(keyed)
        listed = subprocess.run(["ls", "-le", str(keyed)], capture_output=True, text=True, check=True).stdout
        assert "everyone allow read" in listed
    finally:
        _no_acl(keyed)
    assert _left(keyed.parent) == ["settings.json"]


@pytest.mark.skipif(not hasattr(os, "setxattr"), reason="Linux xattrs (os.setxattr)")
def test_an_xattr_and_posix_acl_file_stays_atomic_and_keeps_both_on_linux(keyed):
    try:
        os.setxattr(keyed, "user.nebula-tag", b"kept")
    except OSError as exc:
        pytest.skip(f"this filesystem takes no user xattr ({exc})")
    acl = shutil.which("setfacl") and subprocess.run(["setfacl", "-m", "u:nobody:r", str(keyed)]).returncode == 0
    inode = keyed.stat().st_ino
    assert _person().put("/api/settings", json={"favorites": ["saved"]}).status_code == 200
    assert keyed.stat().st_ino != inode and os.getxattr(keyed, "user.nebula-tag") == b"kept"
    if acl:
        assert "system.posix_acl_access" in os.listxattr(keyed)


def test_metadata_that_cant_be_carried_writes_in_place_and_leaves_no_temp(keyed, monkeypatch):
    """Through the one seam every system's copy goes through
    (settings._copy_metadata), so the same branch runs on macOS and Linux
    (round 18: patching the platform's own calls passed only on macOS)."""
    monkeypatch.setattr(settings, "_has_own_metadata", lambda path: True)
    tried: list[str] = []

    def refuse(*args, **kwargs):
        tried.append(args)
        raise OSError(errno.ENOTSUP, "no")

    monkeypatch.setattr(settings, "_copy_metadata", refuse)
    inode = keyed.stat().st_ino
    settings.save_settings({"favorites": ["in place"]})
    assert tried, "the save never tried to carry the metadata"
    assert keyed.stat().st_ino == inode and _parses(keyed) == {"favorites": ["in place"]}
    assert _left(keyed.parent) == ["settings.json"]


def _user_xattr_or_skip(path: Path) -> None:
    if not hasattr(os, "setxattr"):
        pytest.skip("Linux xattrs (os.setxattr)")
    try:
        os.setxattr(path, "user.nebula-tag", b"kept")
    except OSError as exc:
        pytest.skip(f"this filesystem takes no user xattr ({exc})")


def test_linux_an_xattr_that_cant_be_set_on_the_new_file_writes_in_place(keyed, monkeypatch):
    """Linux's copy fails closed: a user xattr the temp file refuses keeps
    the file (and the xattr) where it is, written in place."""
    _user_xattr_or_skip(keyed)

    def refuse(*args, **kwargs):
        raise OSError(errno.EPERM, "refused")

    monkeypatch.setattr(settings, "_setxattr", refuse)  # the module's seam, never os.setxattr itself
    inode = keyed.stat().st_ino
    settings.save_settings({"favorites": ["in place"]})
    assert keyed.stat().st_ino == inode and _parses(keyed) == {"favorites": ["in place"]}
    assert os.getxattr(keyed, "user.nebula-tag") == b"kept"
    assert _left(keyed.parent) == ["settings.json"]


class _FakeLinuxXattrs:
    """Linux's xattr calls over a dict, so the Linux copy runs on any system."""

    def __init__(self, refuse: bool) -> None:
        self.attrs: dict[str, dict[str, bytes]] = {}
        self.refuse = refuse

    def listxattr(self, path, *args, **kwargs):
        return list(self.attrs.get(os.fspath(path), {}))

    def getxattr(self, path, name, *args, **kwargs):
        return self.attrs[os.fspath(path)][name]

    def setxattr(self, path, name, value, *args, **kwargs):
        if self.refuse:
            raise OSError(errno.EPERM, "refused")
        self.attrs.setdefault(os.fspath(path), {})[name] = value


@pytest.mark.parametrize("refuse", [True, False], ids=["refused-in-place", "carried-atomic"])
def test_the_linux_copy_as_linux_runs_it(keyed, monkeypatch, refuse):
    """The platform "linux" with Linux's xattr calls (faked), through the
    module's own seams (settings._PLATFORM, _listxattr, _getxattr,
    _setxattr; review 17, tests MEDIUM-1: never sys.platform or os's own,
    which every test shares): an xattr the temp file refuses writes in
    place; one it takes is copied, then the rename. This runs the Linux
    branch on macOS too."""
    fake = _FakeLinuxXattrs(refuse)
    fake.attrs[os.fspath(keyed)] = {"user.nebula-tag": b"kept", "security.selinux": b"own"}
    monkeypatch.setattr(settings, "_PLATFORM", "linux")
    for name in ("listxattr", "getxattr", "setxattr"):
        monkeypatch.setattr(settings, f"_{name}", getattr(fake, name))
    inode = keyed.stat().st_ino
    settings.save_settings({"favorites": ["saved"]})
    assert _parses(keyed) == {"favorites": ["saved"]}
    assert _left(keyed.parent) == ["settings.json"]
    if refuse:
        assert keyed.stat().st_ino == inode
    else:
        assert keyed.stat().st_ino != inode
        copied = [attrs for path, attrs in fake.attrs.items() if path != os.fspath(keyed)]
        # The person's xattr went onto the temp file; the system's own label didn't.
        assert copied == [{"user.nebula-tag": b"kept"}]


# -- LOW-1: the sweep removes only Nebula's own names ------------------------------------

def test_the_sweep_keeps_every_file_nebula_didnt_name(keyed, tmp_path, monkeypatch):
    folder = keyed.parent
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    persons = [".settings-backup.tmp", ".settings-my-old-version-2024.tmp", ".settings-ab12cd_3.tmp",
               ".settings-nebula-12-short.tmp", ".settings-nebula-x-abcdefgh.tmp"]
    for name in persons:
        (folder / name).write_text("the person's", encoding="utf-8")
    ours = folder / ".settings-nebula-123-abcd_123.tmp"
    ours_in_state = state / ".settings-nebula-123-zz000000.tmp"
    for path in (ours, ours_in_state):
        path.write_text(json.dumps(OLD), encoding="utf-8")
    target = tmp_path / "target.tmp"
    target.write_text("a link's target", encoding="utf-8")
    link = folder / ".settings-nebula-1-link0000.tmp"
    link.symlink_to(target)
    hard = folder / ".settings-nebula-1-hard0000.tmp"
    os.link(target, hard)
    past = time.time() - settings.STALE_TEMP_SECONDS - 5
    for path in [*(folder / name for name in persons), ours, ours_in_state, target]:
        os.utime(path, (past, past))
    os.utime(link, (past, past), follow_symlinks=False)
    removed = settings.sweep_stale_temp_files()
    assert sorted(removed) == sorted([ours, ours_in_state])
    assert _left(folder) == sorted([*persons, link.name, hard.name, "settings.json"])
    assert target.exists()


def test_the_sweep_keeps_a_nebula_name_another_user_owns(keyed, monkeypatch):
    ours = keyed.parent / ".settings-nebula-123-abcd_123.tmp"
    ours.write_text("{}", encoding="utf-8")
    past = time.time() - settings.STALE_TEMP_SECONDS - 5
    os.utime(ours, (past, past))
    monkeypatch.setattr(settings.os, "geteuid", lambda: os.getuid() + 1)
    assert settings.sweep_stale_temp_files() == [] and ours.exists()


def test_a_save_names_its_temp_file_as_the_sweep_knows_it(keyed, monkeypatch):
    names = []
    real = settings._replace

    def look(src, dst):
        names.append(Path(src).name)
        real(src, dst)

    monkeypatch.setattr(settings, "_replace", look)
    settings.save_settings({"favorites": []})
    [name] = names
    # Round 18: one fixed name, the one the deny lists and the sweep name (review 17, settings MEDIUM-1).
    assert name == ".settings.json.nebula-tmp" == settings.temp_path_for(keyed).name


# -- LOW-2: mutants S15 and S16 ---------------------------------------------------------

def _with_gid(real: os.stat_result, gid: int) -> os.stat_result:
    fields = list(real[:10])
    fields[5] = gid
    return os.stat_result(fields)


def test_the_temp_file_takes_the_old_files_group(keyed, monkeypatch):
    real = keyed.stat()
    calls = []
    monkeypatch.setattr(settings, "_chown", lambda fd, uid, gid: calls.append((uid, gid)))
    settings._write(keyed, b'{"favorites": []}\n', _with_gid(real, real.st_gid + 1), backup=True)
    assert calls == [(-1, real.st_gid + 1)]
    assert _parses(keyed) == {"favorites": []}


def test_a_group_nebula_cant_give_the_temp_file_writes_in_place(keyed, monkeypatch):
    real = keyed.stat()

    def refuse(fd, uid, gid):
        raise PermissionError(errno.EPERM, "Operation not permitted")

    monkeypatch.setattr(settings, "_chown", refuse)
    settings._write(keyed, b'{"favorites": []}\n', _with_gid(real, real.st_gid + 1), backup=True)
    assert keyed.stat().st_ino == real.st_ino and _parses(keyed) == {"favorites": []}
    assert _left(keyed.parent) == ["settings.json"]


def test_the_same_group_needs_no_chown(keyed, monkeypatch):
    monkeypatch.setattr(settings, "_chown", lambda *a: pytest.fail("chown with nothing to change"))
    settings.save_settings({"favorites": []})


@pytest.mark.unprivileged
def test_a_file_that_turns_read_only_before_the_in_place_write_gets_the_file_line(keyed, monkeypatch):
    """S16: in a read-only folder (in place), the file turns read-only after
    the save's own check: the in-place open's EACCES is the 409's file line,
    never a 500."""
    before = keyed.read_bytes()
    real = settings.settings_write_block

    def then_read_only():
        answer = real()
        keyed.chmod(0o444)
        return answer

    monkeypatch.setattr(settings, "settings_write_block", then_read_only)
    keyed.parent.chmod(0o555)
    try:
        response = TestClient(main.app, raise_server_exceptions=False).put(
            "/api/settings", json={"favorites": []}, headers=_person().headers)
    finally:
        keyed.parent.chmod(0o755)
        keyed.chmod(0o644)
    assert _refusal(response) == (409, PERSON_LINE, "settings_unwritable")
    assert keyed.read_bytes() == before


@pytest.mark.parametrize("err", [errno.EACCES, errno.EPERM])
def test_a_refused_in_place_write_is_the_file_line(keyed, monkeypatch, err):
    _hard_link(keyed)

    def refuse(fd, data, offset):
        raise OSError(err, "refused")

    monkeypatch.setattr(settings, "_pwrite", refuse)
    with pytest.raises(settings.SettingsUnwritable) as refused:
        settings.save_settings({"favorites": []})
    assert refused.value.cause == "file" and refused.value.where == keyed


# -- NIT-2: every missing level 0700; the folder that refuses is named ---------------------

def test_every_missing_folder_level_is_made_this_users_only(home_file, tmp_path, monkeypatch):
    path = tmp_path / "home" / "a" / "b" / "settings.json"
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(path))
    assert _person().put("/api/settings", json={"favorites": []}).status_code == 200
    for level in (path.parent.parent, path.parent):
        assert stat.S_IMODE(level.stat().st_mode) == 0o700, level
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.unprivileged
def test_two_missing_levels_under_a_read_only_folder_name_that_folder(home_file, tmp_path, monkeypatch):
    ro = tmp_path / "home" / "ro"
    ro.mkdir()
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(ro / "nebula" / "deeper" / "settings.json"))
    ro.chmod(0o555)
    try:
        response = _person().put("/api/settings", json={"favorites": []})
    finally:
        ro.chmod(0o755)
    line = (f"Nothing was saved because Nebula isn’t allowed to change ~{os.sep}ro. "
            "Check the folder’s permissions, then try again.")
    assert _refusal(response) == (409, line, "settings_unwritable")
    assert response.json()["fix"] == f"Check the permissions of ~{os.sep}ro, then try again."
    assert _left(ro) == []


def test_a_level_made_by_the_save_that_refuses_the_next_names_it(home_file, tmp_path, monkeypatch):
    """The check passed, then the folder the save made refuses the next
    level: the line names the folder that refused (the one just made)."""
    top = tmp_path / "home" / "top"
    top.mkdir()
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(top / "a" / "b" / "settings.json"))
    real = os.mkdir

    def mkdir(path, mode=0o777, *a, **k):
        if Path(path).name == "b":
            raise PermissionError(errno.EACCES, "Permission denied", str(path))
        return real(path, mode, *a, **k)

    monkeypatch.setattr(settings.os, "mkdir", mkdir)
    with pytest.raises(settings.SettingsUnwritable) as refused:
        settings.save_settings({"favorites": []})
    assert refused.value.cause == "folder" and refused.value.where == top / "a"
    assert stat.S_IMODE((top / "a").stat().st_mode) == 0o700


# -- NIT-3: the in-place write writes the file it decided on, never through a link ----------

def test_a_symlink_swapped_in_after_the_decision_is_never_written_through_in_place(keyed, tmp_path, monkeypatch):
    other = _hard_link(keyed)  # in place
    outside = tmp_path / "outside.txt"
    outside.write_text("the person's other file", encoding="utf-8")
    real = settings._write_in_place
    attempts = []

    def swap(path, data, before, *, backup):
        if not attempts:
            os.unlink(path)
            os.symlink(outside, path)
        attempts.append(path)
        try:
            return real(path, data, before, backup=backup)
        except settings._Changed:
            assert outside.read_text(encoding="utf-8") == "the person's other file"
            raise

    monkeypatch.setattr(settings, "_write_in_place", swap)
    settings.save_settings({"favorites": ["decided again"]})
    # The first decision never wrote through the link; the save decided
    # again from the path, as a save on a symlinked path does (it writes
    # through to the target: test_a_symlinked_settings_path_writes_through_to_its_target).
    assert attempts[0] == keyed and len(attempts) == 1
    assert keyed.is_symlink() and _parses(outside) == {"favorites": ["decided again"]}
    assert json.loads(other.read_text(encoding="utf-8")) == OLD


def test_another_file_swapped_in_after_the_decision_is_decided_again(keyed, monkeypatch):
    other = _hard_link(keyed)  # in place
    real = settings._write_in_place
    attempts = []
    attempts_inode: list[int] = []

    def swap(path, data, before, *, backup):
        if not attempts:
            fresh = path.with_name("fresh.json")
            fresh.write_text('{"favorites": ["swapped"]}', encoding="utf-8")
            os.replace(fresh, path)
            attempts_inode.append(path.stat().st_ino)
        attempts.append(path)
        return real(path, data, before, backup=backup)

    monkeypatch.setattr(settings, "_write_in_place", swap)
    settings.save_settings({"favorites": ["decided again"]})
    # The swapped-in file has one name: the second decision replaced it
    # whole (a new inode), never wrote into it in place.
    assert len(attempts) == 1 and _parses(keyed) == {"favorites": ["decided again"]}
    assert keyed.stat().st_ino != attempts_inode[0]
    assert json.loads(other.read_text(encoding="utf-8")) == OLD


def test_the_in_place_write_never_opens_through_a_symlink_even_to_the_same_file(keyed):
    other = _hard_link(keyed)
    before = keyed.stat()
    link = keyed.with_name("link.json")
    link.symlink_to(other)
    with pytest.raises(settings._Changed):
        settings._write_in_place(link, b'{"favorites": []}\n', before, backup=False)
    assert _parses(keyed) == OLD
