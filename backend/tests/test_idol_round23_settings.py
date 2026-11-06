"""PR #203 round 23: a save can never rename another save's temp file over
settings.json (the final review's three saves, no flock).

Each save writes a temp file of its own (".settings.json.nebula-tmp-<pid>-
<token>"), checks before the rename that the name still points at its own
open file, and the start sweep, the stale-temp judge and the agents' deny
lists all know every such name.
"""
from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import sys
import threading
import time

import pytest

import services.settings as settings
from services import agent_profiles, file_access
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round15 import home_file  # noqa: F401 - fixture
from tests.test_idol_round17_settings import _parses, keyed  # noqa: F401 - fixture


def _dead_pid() -> int:
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


def _unique(base, *, pid: int, token: str = "0123456789abcdef"):
    return base.with_name(f"{settings.temp_path_for(base).name}-{pid}-{token}")


def _old(path, seconds: float = 600) -> None:
    past = time.time() - seconds
    os.utime(path, (past, past))


# -- the final review's reproduction -----------------------------------------------------

def test_three_saves_without_flock_never_rename_another_saves_half_written_temp(tmp_path, monkeypatch):
    """W is a save in flight; J judged an older stale temp at the same name
    and moves the name into the judging folder, where W's temp is instead;
    X makes its temp at the freed name, so J's link back fails; W then
    renames "its" temp by name. Staged at the shared name (what a2ed98f4
    always wrote; raising=False so this test also runs on that code, where
    settings.json comes out torn). W must write again, never rename X's file."""
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"apiKeys": {"HF_TOKEN": "hf_old"}, "keep": 1}))
    before = os.lstat(path)
    shared = settings.temp_path_for(path)

    shared.write_bytes(b"stale")
    _old(shared)
    judged = os.lstat(shared)
    shared.unlink()

    names = iter([shared])  # W's first temp is at the shared name; its rewrite gets a name of its own
    monkeypatch.setattr(settings, "_new_temp", lambda p: next(names, None) or settings.new_temp_path_for(p),
                        raising=False)
    real_link, real_write_all = os.link, settings._write_all
    fired = []

    def x_makes_its_temp_first(src, dst, *a, **k):
        fd = os.open(dst, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, b'{"apiKe')
        os.close(fd)
        return real_link(src, dst, *a, **k)

    def w_writes_then_j_judges(fd, data):
        real_write_all(fd, data)
        if fired:
            return
        fired.append(True)
        monkeypatch.setattr(settings.os, "link", x_makes_its_temp_first)
        assert settings._remove_judged(shared, judged) is False  # J
        monkeypatch.setattr(settings.os, "link", real_link)

    monkeypatch.setattr(settings, "_write_all", w_writes_then_j_judges)
    new = json.dumps({"apiKeys": {"HF_TOKEN": "hf_new"}, "keep": 1}).encode()
    settings._write_atomically(path, new, before, locked=False)  # W

    assert json.loads(path.read_bytes()) == {"apiKeys": {"HF_TOKEN": "hf_new"}, "keep": 1}
    assert shared.read_bytes() == b'{"apiKe'  # X's file is X's: untouched


def test_the_save_checks_the_name_is_its_own_file_before_the_rename(tmp_path, monkeypatch):
    """Mutant: with the check gone and the shared name back, a stranger's
    file at the name is renamed over settings.json. Also with the first
    attempt's file lost, a save that finds strangers every time is busy."""
    path = tmp_path / "settings.json"
    path.write_text('{"keep": 1}')
    before = os.lstat(path)
    shared = settings.temp_path_for(path)
    real_write_all = settings._write_all

    def stranger_takes_the_name(fd, data):
        real_write_all(fd, data)
        os.rename(shared, tmp_path / "moved-away")
        shared.write_bytes(b'{"half')

    monkeypatch.setattr(settings, "_new_temp", lambda p: shared)
    monkeypatch.setattr(settings, "_write_all", stranger_takes_the_name)
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.05)
    with pytest.raises(settings.SettingsBusy):
        settings._write_atomically(path, b'{"keep": 2}', before, locked=False)
    assert json.loads(path.read_bytes()) == {"keep": 1}  # never torn
    assert shared.read_bytes() == b'{"half'


def test_a_failed_save_removes_only_its_own_temp_file(tmp_path, monkeypatch):
    path = tmp_path / "settings.json"
    path.write_text('{"keep": 1}')
    before = os.lstat(path)
    shared = settings.temp_path_for(path)
    real_write_all = settings._write_all

    def stranger_takes_the_name_then_fail(fd, data):
        real_write_all(fd, data)
        os.rename(shared, tmp_path / "moved-away")
        shared.write_bytes(b"stranger")
        raise OSError(5, "disk")

    monkeypatch.setattr(settings, "_new_temp", lambda p: shared)
    monkeypatch.setattr(settings, "_write_all", stranger_takes_the_name_then_fail)
    with pytest.raises(OSError):
        settings._write_atomically(path, b'{"keep": 2}', before, locked=False)
    assert shared.read_bytes() == b"stranger"


@pytest.mark.parametrize("round_", range(25))
def test_two_saves_at_once_without_flock_end_with_one_valid_write(tmp_path, round_):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"n": 0}))
    writes = [json.dumps({"n": i, "pad": "x" * 200_000}).encode() for i in (1, 2)]
    gate = threading.Barrier(2)
    errors: list[BaseException] = []

    def save(data: bytes) -> None:
        try:
            before = os.lstat(path)
            gate.wait()
            settings._write_atomically(path, data, before, locked=False)
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    threads = [threading.Thread(target=save, args=(data,)) for data in writes]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert not errors, errors
    assert path.read_bytes() in writes  # valid JSON, whole, one of the two
    json.loads(path.read_bytes())
    # Nothing left beside it but the private temp folder (round 23b), empty.
    assert sorted(p.name for p in tmp_path.iterdir()) == [settings.TEMP_FOLDER, "settings.json"]
    assert list((tmp_path / settings.TEMP_FOLDER).iterdir()) == []


def test_each_save_has_a_name_of_its_own(tmp_path):
    path = tmp_path / "settings.json"
    names = {settings.new_temp_path_for(path).name for _ in range(50)}
    assert len(names) == 50
    assert all(name.startswith(".settings.json.nebula-tmp-%d-" % os.getpid()) for name in names)
    assert all(settings.unique_temp_pid(name, "settings.json") == os.getpid() for name in names)
    assert settings.unique_temp_pid(".settings.json.nebula-tmp", "settings.json") is None
    assert settings.unique_temp_pid(".settings.json.nebula-tmp-12-xyz", "settings.json") is None


# -- the start sweep -------------------------------------------------------------------------

def test_the_start_sweep_removes_old_unique_temps_and_leaves_a_fresh_one(keyed, monkeypatch):
    """Without the lock: each judged by its own name and time, never by the
    others', and a temp whose writer is alive is kept."""
    dead = _dead_pid()
    gone = _unique(keyed, pid=dead, token="aaaaaaaaaaaaaaaa")
    fresh = _unique(keyed, pid=dead, token="bbbbbbbbbbbbbbbb")
    alive = _unique(keyed, pid=os.getpid(), token="cccccccccccccccc")
    copy_gone = settings.settings_copy_folder() / f".{settings.backup_path(keyed).name}.nebula-tmp-{dead}-dddddddddddddddd"  # this file's own copy
    settings.settings_copy_folder().mkdir(parents=True, exist_ok=True)
    mine = [gone, fresh, alive, copy_gone]
    for temp in mine:
        temp.write_bytes(b'{"apiKeys": {"K": "secret"}}')
        temp.chmod(0o600)
    for temp in (gone, alive, copy_gone):
        _old(temp)
    person = keyed.parent / ".settings.json.nebula-tmp-notours"
    person.write_bytes(b"mine")
    _old(person)
    monkeypatch.setattr(settings, "_locked", lambda path: None)
    removed = settings.sweep_stale_temp_files()
    assert sorted(removed) == sorted([gone, copy_gone])
    assert not gone.exists() and not copy_gone.exists()
    assert fresh.exists() and alive.exists() and person.exists()
    assert _parses(keyed)  # settings.json itself untouched


def test_a_temp_whose_writer_is_alive_goes_only_after_an_hour(keyed, monkeypatch):
    alive = _unique(keyed, pid=os.getpid())
    alive.write_bytes(b"{}")
    alive.chmod(0o600)
    _old(alive, settings.ALIVE_WRITER_SECONDS + 60)
    monkeypatch.setattr(settings, "_locked", lambda path: None)
    assert settings.sweep_stale_temp_files() == [alive]


def test_the_locked_start_sweep_removes_every_leftover_unique_temp(keyed):
    dead = _dead_pid()
    temps = [_unique(keyed, pid=dead, token=f"{i:016x}") for i in range(3)]
    for temp in temps:
        temp.write_bytes(b"{}")
        temp.chmod(0o600)
    assert sorted(settings.sweep_stale_temp_files()) == sorted(temps)
    assert not any(temp.exists() for temp in temps)


def test_a_judge_moves_only_the_orphan_it_judged_among_many(keyed):
    """Many names: each orphan is judged by its own identity; a successor
    at one name never takes the judgement of the other."""
    dead = _dead_pid()
    first, second = (_unique(keyed, pid=dead, token=f"{i:016x}") for i in (1, 2))
    for temp in (first, second):
        temp.write_bytes(b"{}")
        temp.chmod(0o600)
        _old(temp)
    judged = os.lstat(first)
    first.unlink()
    first.write_bytes(b"a successor, fresh")  # a different file under the judged name
    assert settings._remove_judged(first, judged) is False
    assert first.read_bytes() == b"a successor, fresh" and second.exists()


# -- the agents' deny lists --------------------------------------------------------------------

def test_the_agent_deny_list_blocks_reads_of_any_unique_temp_name(keyed):
    unique = _unique(keyed, pid=4242, token="feedfacecafebeef")
    unique.write_bytes(b'{"apiKeys": {"K": "secret"}}')
    rules = agent_profiles.secret_deny_rules(agent_profiles.default_secret_paths())
    deny = [rule[len("Read(/"):-1] for rule in rules]
    later = _unique(keyed, pid=777, token="0000111122223333")  # not made yet: caught by the pattern
    for name in (unique, later):
        assert any(fnmatch.fnmatchcase(str(name.resolve()), pattern) for pattern in deny), (name, deny)
    assert unique in agent_profiles.default_secret_paths()  # the one there now, for the path lists
    # The shared name's own rule is still there.
    assert f"Read(/{settings.temp_path_for(keyed).resolve()})" in rules


def test_a_path_named_like_a_unique_temp_is_refused_to_graph_and_media_reads(keyed, tmp_path):
    elsewhere = tmp_path / "elsewhere" / ".settings.json.nebula-tmp-4242-feedfacecafebeef"
    elsewhere.parent.mkdir()
    elsewhere.write_bytes(b"x")
    with pytest.raises(file_access.ProtectedPathError):
        file_access.require_allowed_path(elsewhere)
