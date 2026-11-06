"""PR #203 round 20, section 2b C: review 19's settings-durability findings.

1. With no flock, a temp judged stale is removed only while it is still the
   file judged (moved to a name of its own, checked by inode), and judged on
   the folder's own clock; one dated ahead of that clock is stale too.
2. A verified copy the copy folder won't take the replaced file for is said
   (settings.not_restored), naming that folder.
3. settings.not_restored's line by cause (GM r40 item 3 for any cause but
   not being allowed).
5. The replaced file is named by the time and a random suffix, kept once.
6. The guards review 19's mutants R1, R8 and R9 reached.
7. The Settings notice lasts until the person dismisses it, across a
   restart, and stays the person's only.
"""
from __future__ import annotations

import asyncio
import errno
import json
import os
import re
import stat
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import PERSON, _person
from tests.test_idol_round15 import home_file  # noqa: F401 - fixture
from tests.test_idol_round17_settings import _parses, _wait_for, keyed  # noqa: F401 - fixture
from tests.test_idol_round18_settings import _cut_copy, _popen, _stop, home_state  # noqa: F401 - fixture

A_SAVES = {"apiKeys": {"FAL_KEY": "fal-from-A-" + "a" * 40}, "favorites": ["A" * 4000]}
B_SAVES = {"apiKeys": {"OPENAI_API_KEY": "sk-from-B-" + "b" * 40}, "favorites": ["B" * 4000]}

# A: no flock; writes its temp whole, then waits before its rename.
A_CODE = """
import os, time
import services.settings as s
s._locked = lambda path: None
s.LOCK_TIMEOUT_SECONDS = 120
real = s._replace
def wait_then_replace(temp, path):
    open({ready!r}, "w").close()
    d = time.monotonic() + 60
    while not os.path.exists({go!r}):
        if time.monotonic() > d: raise SystemExit("never released")
        time.sleep(0.01)
    return real(temp, path)
s._replace = wait_then_replace
try:
    s.save_settings({saves!r}); print("A SAVED")
except Exception as e:
    print("A RAISED", type(e).__name__, e)
"""

# B: no flock. Pauses once it has judged the temp stale, just before taking
# it away (its rename), and says when it starts waiting for another's temp.
# ``ahead``: this process's wall clock runs that many seconds fast.
B_CODE = """
import os, time
import services.settings as s
s._locked = lambda path: None
s.LOCK_TIMEOUT_SECONDS = 120
real_time = time.time
s.time.time = lambda: real_time() + {ahead!r}
TEMP = {temp!r}
real_rename = os.rename
paused = []
def held_rename(src, dst, *a, **k):
    if str(src) == TEMP and {pause!r} and not paused:
        paused.append(1)
        open({at_rename!r}, "w").close()
        d = time.monotonic() + 60
        while not os.path.exists({go_rename!r}):
            if time.monotonic() > d: raise SystemExit("never released")
            time.sleep(0.01)
    return real_rename(src, dst, *a, **k)
s.os.rename = held_rename
def waiting():
    open({waiting!r}, "w").close()
s._temp_waiting = waiting
try:
    s.save_settings({saves!r}); print("B SAVED")
except Exception as e:
    print("B RAISED", type(e).__name__, e)
"""


def _keys(path: Path):
    try:
        return sorted(_parses(path).get("apiKeys", {}))
    except ValueError:
        return "UNPARSEABLE"


def _marks(tmp_path: Path) -> dict[str, Path]:
    return {name: tmp_path / name for name in ("ready", "go", "at_rename", "go_rename", "waiting")}


# -- 1. no flock: the stale temp, the folder's clock, a future one -----------------------------

def test_two_saves_meeting_one_stale_temp_never_remove_each_others(keyed, tmp_path):
    """Review 19's q1: B judges the stale temp and pauses before taking it;
    A takes it, makes its own and writes it whole. B then finds A's temp,
    not the one it judged: it puts it back and waits. Never a torn file."""
    marks = _marks(tmp_path)
    temp = settings.temp_path_for(keyed)
    temp.write_bytes(b"cut short long ago")
    past = time.time() - 600
    os.utime(temp, (past, past))
    b = _popen(B_CODE.format(ahead=0, temp=str(temp), pause=True, at_rename=str(marks["at_rename"]),
                             go_rename=str(marks["go_rename"]), waiting=str(marks["waiting"]), saves=B_SAVES))
    a = None
    try:
        _wait_for(marks["at_rename"], b, "B at its rename of the stale temp")
        a = _popen(A_CODE.format(ready=str(marks["ready"]), go=str(marks["go"]), saves=A_SAVES))
        _wait_for(marks["ready"], a, "A's own temp whole, before its rename")
        mine = os.lstat(temp).st_ino
        marks["go_rename"].touch()
        _wait_for(marks["waiting"], b, "B waiting for A's temp")
        assert os.lstat(temp).st_ino == mine  # A's temp is back under the name
        marks["go"].touch()
        out_a, err_a = a.communicate(timeout=60)
        assert out_a.strip() == "A SAVED", err_a[-400:]
        out_b, err_b = b.communicate(timeout=60)
        assert out_b.strip() == "B SAVED", err_b[-400:]
        assert _keys(keyed) == ["OPENAI_API_KEY"] and not temp.exists()
    finally:
        for mark in marks.values():
            mark.touch()
        _stop(a, b)


def test_a_wall_clock_running_fast_never_takes_a_live_temp(keyed, tmp_path):
    """Review 19's q2: B's clock is two minutes fast (or the folder's server
    two minutes behind). On the folder's own clock A's temp is fresh: B
    waits for it, and both save whole."""
    marks = _marks(tmp_path)
    temp = settings.temp_path_for(keyed)
    a = _popen(A_CODE.format(ready=str(marks["ready"]), go=str(marks["go"]), saves=A_SAVES))
    b = None
    try:
        _wait_for(marks["ready"], a, "A's temp whole")
        b = _popen(B_CODE.format(ahead=120, temp=str(temp), pause=False, at_rename=str(marks["at_rename"]),
                                 go_rename=str(marks["go_rename"]), waiting=str(marks["waiting"]), saves=B_SAVES))
        _wait_for(marks["waiting"], b, "B waiting for A's temp")
        marks["go"].touch()
        out_a, err_a = a.communicate(timeout=60)
        assert out_a.strip() == "A SAVED", err_a[-400:]
        out_b, err_b = b.communicate(timeout=60)
        assert out_b.strip() == "B SAVED", err_b[-400:]
        assert _keys(keyed) == ["OPENAI_API_KEY"]
    finally:
        for mark in marks.values():
            mark.touch()
        _stop(a, b)


def test_a_temp_dated_ahead_of_the_folder_is_stale(keyed, monkeypatch):
    """Review 19's q3: a temp a year ahead blocked every save with no flock
    and the sweep never removed it."""
    temp = settings.temp_path_for(keyed)
    future = time.time() + 86400 * 365
    for _ in range(2):
        temp.write_bytes(b"planted")
        temp.chmod(0o600)
        os.utime(temp, (future, future))
        monkeypatch.setattr(settings, "_locked", lambda path: None)
        monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.3)
        monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
        response = _person().put("/api/settings", json={"favorites": ["x"]})
        assert response.status_code == 200, response.text
        assert not temp.exists()
    temp.write_bytes(b"planted")
    temp.chmod(0o600)
    os.utime(temp, (future, future))
    assert temp in settings.sweep_stale_temp_files() and not temp.exists()


def test_a_temp_a_moment_ahead_is_not_stale():
    now = time.time()
    fresh = os.stat_result((0o100600, 0, 0, 1, 0, 0, 0, now, now + settings.CLOCK_SLACK_SECONDS - 1, now))
    ahead = os.stat_result((0o100600, 0, 0, 1, 0, 0, 0, now, now + settings.CLOCK_SLACK_SECONDS + 1, now))
    old = os.stat_result((0o100600, 0, 0, 1, 0, 0, 0, now, now - settings.STALE_TEMP_SECONDS - 1, now))
    assert not settings._stale(fresh, now) and settings._stale(ahead, now) and settings._stale(old, now)


def test_the_folders_clock_is_the_files_time_there(tmp_path, monkeypatch):
    monkeypatch.setattr(settings.time, "time", lambda: 0.0)
    assert abs(settings._folder_now(tmp_path) - os.stat(tmp_path).st_mtime) < 5
    assert list(tmp_path.iterdir()) == []  # the probe is gone


def test_only_the_judged_temp_is_removed(tmp_path):
    temp = tmp_path / ".settings.json.nebula-tmp"
    temp.write_bytes(b"judged")
    judged = os.lstat(temp)
    assert settings._remove_judged(temp, judged) and not temp.exists()
    temp.write_bytes(b"another save's")
    other = os.lstat(temp)
    assert settings._remove_judged(temp, judged) is False
    assert temp.read_bytes() == b"another save's" and os.lstat(temp).st_ino == other.st_ino
    judging = settings.judging_folder_for(tmp_path)
    assert sorted(tmp_path.iterdir()) == sorted([temp, judging]) and list(judging.iterdir()) == []


def test_the_judged_temp_is_checked_where_no_agent_reads(keyed, monkeypatch):
    """Round 20: while it is checked, a temp file (another save's, keys
    included, when it isn't the one judged) sits in the judging folder,
    which every agent deny list names: never under a name of its own beside
    settings.json, where none does."""
    from services import agent_profiles, file_access

    temp = settings.temp_path_for(keyed)
    temp.write_bytes(b'{"apiKeys": {"FAL_KEY": "fal-another-saves"}}')
    judged = os.lstat(temp)
    temp.unlink()
    temp.write_bytes(b'{"apiKeys": {"FAL_KEY": "fal-another-saves"}}')  # another save's, since
    seen = []
    real_link = os.link

    def no_room(src, dst, *a, **k):  # another took the name meanwhile: it can't go back
        seen.append(sorted(p.name for p in settings.judging_folder_for(keyed.parent).iterdir()))
        raise FileExistsError(errno.EEXIST, "taken", dst)

    monkeypatch.setattr(settings.os, "link", no_room)
    assert settings._remove_judged(temp, judged) is False
    monkeypatch.setattr(settings.os, "link", real_link)
    judging = settings.judging_folder_for(keyed.parent)
    [left] = list(judging.iterdir())
    assert seen == [[left.name]] and not temp.exists()
    assert [p for p in keyed.parent.iterdir() if settings._TEMP_NAME.fullmatch(p.name)] == []
    assert judging in agent_profiles.secret_dirs()
    with pytest.raises(file_access.ProtectedPathError):
        file_access.require_allowed_path(left)
    # Not a grant's concern: the folder holding settings.json is granted as before.
    assert judging not in agent_profiles.protected_agent_dirs()
    # Once stale, the start sweep takes it, and the folder with it.
    past = time.time() - 600
    os.utime(left, (past, past))
    monkeypatch.setattr(settings, "_locked", lambda path: None)
    assert left in settings.sweep_stale_temp_files()
    assert not judging.exists()


def test_a_judging_folder_that_isnt_nebulas_takes_nothing(tmp_path):
    temp = tmp_path / ".settings.json.nebula-tmp"
    temp.write_bytes(b"judged")
    judged = os.lstat(temp)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    settings.judging_folder_for(tmp_path).symlink_to(elsewhere)
    assert settings._remove_judged(temp, judged) is False
    assert temp.read_bytes() == b"judged" and list(elsewhere.iterdir()) == []


# -- 2 and 3. a copy not put back, said by its cause --------------------------------------------

@pytest.mark.unprivileged
def test_a_copy_folder_that_takes_no_file_is_said(home_state, keyed, caplog, monkeypatch):
    monkeypatch.setattr(main, "_settings_notice", None)
    _cut_copy(keyed)
    folder = settings.settings_copy_folder()
    folder.chmod(0o500)
    start = main.canvas_events.read(after=None)["cursor"]
    try:
        result = settings.restore_settings_from_backup()
        with caplog.at_level("WARNING", logger="nebula.settings"):
            with TestClient(main.app) as client:
                read = client.get("/api/canvas/events", params={"after": start, "kinds": "settings"},
                                  headers={"X-Nebula-Agent": "Claude Code"}).json()
    finally:
        folder.chmod(0o700)
    assert isinstance(result, settings.NotRestored) and result.why.where == folder
    line = main.settings_not_restored_line(result)
    assert line == main.SETTINGS_NOT_RESTORED.format(path=settings.shown_path(folder))
    logged = [record.getMessage() for record in caplog.records if record.name == "nebula.settings"]
    [event] = [e for e in read["events"] if e["kind"].startswith("settings.")]
    assert line in logged and event["kind"] == "settings.not_restored" and event["summary"] == line
    assert settings.backup_path(keyed).exists()




@pytest.mark.parametrize("why,allowed", [
    (OSError(errno.ENOSPC, "No space left on device"), False),
    (OSError(errno.EIO, "I/O error"), False),
    (settings.SettingsBusy("another save", "x"), False),
    (OSError(errno.EACCES, "Permission denied"), True),
    (OSError(errno.EROFS, "Read-only file system"), True),
], ids=["full", "io", "busy", "eacces", "erofs"])
def test_the_not_restored_line_says_its_cause(tmp_path, why, allowed):
    line = main.settings_not_restored_line(settings.NotRestored(tmp_path / "settings.json", why))
    if allowed:
        assert "isn’t allowed to change" in line
    else:
        # GM, PR #203 r40 item 3, verbatim.
        assert line == ("Nebula has a saved copy of your settings but couldn’t put it back. It’ll try again the "
                        "next time Nebula starts.")


@pytest.mark.unprivileged
def test_a_read_only_folder_is_the_place_the_line_names(home_state, keyed):
    """Review 19's R10: the folder, not the file, when the folder refuses."""
    _cut_copy(keyed)
    keyed.chmod(0o400)
    keyed.parent.chmod(0o500)
    try:
        result = settings.restore_settings_from_backup()
    finally:
        keyed.parent.chmod(0o700)
        keyed.chmod(0o600)
    assert isinstance(result, settings.NotRestored)
    where = result.why.where
    assert where in (keyed, keyed.parent)
    assert main.settings_not_restored_line(result) == main.SETTINGS_NOT_RESTORED.format(path=settings.shown_path(where))
    if where == keyed.parent:
        assert settings.shown_path(keyed.parent) in main.settings_not_restored_line(result)


# -- 5. the replaced file's name ---------------------------------------------------------------

def test_the_replaced_file_is_named_by_time_and_kept_once(home_state):
    first = settings._keep_aside(b"{broken")
    assert re.fullmatch(r"settings-replaced-\d{8}T\d{6}Z-[0-9a-f]{8}\.json", first.name), first.name
    assert settings._keep_aside(b"{broken") == first
    other = settings._keep_aside(b"{also broken")
    assert other != first and other.read_bytes() == b"{also broken"
    assert stat.S_IMODE(first.stat().st_mode) == 0o600


# -- 6. the guards review 19's mutants reached ----------------------------------------------------

def test_the_copys_temp_without_the_lock_is_never_taken_while_fresh(keyed, monkeypatch):
    """R1: an in-place save with no flock writes its copy through the copy's
    temp, as a save without the lock: a fresh foreign temp there is waited
    for, then the save is busy, never removed."""
    target = settings.backup_path(keyed)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = settings.temp_path_for(target)
    temp.write_bytes(b"another save's copy")
    temp.chmod(0o600)
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.3)
    with pytest.raises(settings.SettingsBusy):
        settings._write_copy(target, b"{}")
    assert temp.read_bytes() == b"another save's copy"


def test_a_temp_gone_between_the_open_and_the_look_is_made_again(tmp_path, monkeypatch):
    """R8: the other save's temp went between this save's open and its
    lstat: made now, never an error."""
    temp = tmp_path / ".settings.json.nebula-tmp"
    temp.write_bytes(b"theirs")
    real = os.lstat
    calls = []

    def gone_once(path, *args, **kwargs):
        if str(path) == str(temp) and not calls:
            calls.append(1)
            temp.unlink()
            raise FileNotFoundError(errno.ENOENT, "gone", str(path))
        return real(path, *args, **kwargs)

    monkeypatch.setattr(settings.os, "lstat", gone_once)
    fd = settings._open_temp(str(temp), locked=False)
    os.close(fd)
    assert calls and temp.exists() and temp.read_bytes() == b""


def test_a_lock_that_never_holds_still_is_busy_a_409(keyed, monkeypatch):
    """R9: the lock's "kept changing" deadline is SettingsBusy: a 409."""
    monkeypatch.setattr(settings, "_lock_holds", lambda fd, path: False)
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    response = _person().put("/api/settings", json={"favorites": ["x"]})
    assert response.status_code == 409 and response.json().get("code") == "settings_busy", response.text


def test_a_file_that_keeps_changing_under_the_save_is_busy(keyed, monkeypatch):
    def changed(*args, **kwargs):
        raise settings._Changed()

    monkeypatch.setattr(settings, "_write", changed)
    with pytest.raises(settings.SettingsBusy):
        settings.save_settings({"favorites": ["x"]})


# -- 7. the notice lasts until dismissed -----------------------------------------------------------

def _restart() -> None:
    main._settings_notice = None
    asyncio.run(main._sweep_settings_temp_files())


def test_the_notice_survives_a_restart_until_the_person_dismisses_it(home_state, keyed, monkeypatch, sockets):  # noqa: F811
    monkeypatch.setattr(main, "_settings_notice", None)
    _cut_copy(keyed)
    _restart()
    first = dict(main._settings_notice or {})
    assert first.get("kind") == "restored"
    kept = settings.settings_copy_folder() / settings.NOTICE_FILE
    assert kept.exists() and stat.S_IMODE(kept.stat().st_mode) == 0o600
    _restart()  # nothing to restore now: the kept notice comes back
    assert main._settings_notice == first
    client = TestClient(main.app)
    assert client.get("/api/settings/notice", headers=PERSON).json()["notice"] == first
    for agent in ({"X-Nebula-Agent": "Claude Code"}, {**PERSON, "X-Nebula-Agent": "Claude Code"}, {}):
        assert client.get("/api/settings/notice", headers=agent).status_code == 403
    assert client.post("/api/settings/notice/dismiss", headers=PERSON).status_code == 200
    assert not kept.exists()
    _restart()
    assert main._settings_notice is None


def test_the_notice_is_never_in_what_agents_read(home_state, keyed, monkeypatch):
    monkeypatch.setattr(main, "_settings_notice", None)
    _cut_copy(keyed)
    _restart()
    kept = settings.settings_copy_folder() / settings.NOTICE_FILE
    from services import agent_profiles

    assert settings.settings_copy_folder() in agent_profiles.protected_agent_dirs()
    events = main.canvas_events.read(after=None)["events"]
    assert not any(json.dumps(main._settings_notice) in json.dumps(event) for event in events)
    assert kept.exists()


def test_a_judging_folder_others_can_read_takes_nothing(tmp_path):
    temp = tmp_path / ".settings.json.nebula-tmp"
    temp.write_bytes(b"judged")
    judged = os.lstat(temp)
    judging = settings.judging_folder_for(tmp_path)
    judging.mkdir()
    judging.chmod(0o755)
    assert settings._remove_judged(temp, judged) is False
    assert temp.read_bytes() == b"judged" and list(judging.iterdir()) == []


def test_a_judging_folder_swept_away_under_the_move_leaves_the_temp_judged_again(tmp_path, monkeypatch):
    temp = tmp_path / ".settings.json.nebula-tmp"
    temp.write_bytes(b"judged")
    judged = os.lstat(temp)

    def swept(src, dst, *a, **k):  # the start sweep removed the empty folder first
        raise FileNotFoundError(errno.ENOENT, "no such folder", dst)

    monkeypatch.setattr(settings.os, "rename", swept)
    assert settings._remove_judged(temp, judged) is False and temp.exists()


def test_a_successor_that_took_the_freed_inode_is_not_the_judged_temp(tmp_path, monkeypatch):
    """CI on 54f9483c (Linux): a filesystem hands a freed inode to the next
    file made, so another save's new temp had the judged one's device and
    inode. Simulated here on any platform: every stat in the settings module
    reports the judged file's inode."""
    temp = tmp_path / ".settings.json.nebula-tmp"
    temp.write_bytes(b"judged")
    past = time.time() - 600
    os.utime(temp, (past, past))
    judged = os.lstat(temp)
    temp.unlink()
    temp.write_bytes(b"another save's, made since")
    real_stat = os.stat

    def reusing(path, *a, **k):
        info = real_stat(path, *a, **k)
        fields = list(info)[:7] + [0, 0, 0]
        fields[1], fields[2] = judged.st_ino, judged.st_dev
        return os.stat_result(tuple(fields) + (info.st_atime, info.st_mtime, info.st_ctime,
                                               info.st_atime_ns, info.st_mtime_ns, info.st_ctime_ns))

    monkeypatch.setattr(settings.os, "stat", reusing)
    assert settings._remove_judged(temp, judged) is False
    monkeypatch.undo()
    assert temp.read_bytes() == b"another save's, made since"
