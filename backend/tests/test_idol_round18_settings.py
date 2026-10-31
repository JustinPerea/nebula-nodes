"""PR #203 round 18, section 2: review 17's settings findings and GM r36 B6.

- MEDIUM-1: the copy an in-place save keeps, the file a restore replaced
  and every temp file live in <state>/settings-copy (0700), on every agent
  deny list; the save's temp file beside settings.json has one fixed name,
  also denied; the start sweep, holding the lock, removes any left.
- LOW-1: the restore holds the save's lock throughout (mutant N22).
- LOW-2: the restore keeps the replaced file aside and only trusts a copy
  that is provably Nebula's (marker, hash, path, file checks).
- LOW-3: PUT and DELETE settings hold the lock from their read to their
  save, so two saves of different keys both survive.
- NIT-2: the copy folder's missing levels are 0700; a state path through a
  file is the not_a_folder 409, never a 500.
- NIT-3: a pwrite that takes no bytes (mutant N9).
- NIT-4: F_FULLFSYNC where the system has it, and the folder synced after
  each rename (mutants N2 and N12 too: every sync is seen).
- GM r36 B6a: the line for a copy folder Nebula can't change; B6b: the
  restored line, with its reason only when it is known.
"""
from __future__ import annotations

import errno
import json
import os
import stat
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from cli.formatter import format_event
from commons.actors import agent_registry
from services import agent_profiles, file_access
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import _person
from tests.test_idol_round15 import home_file  # noqa: F401 - fixture
from tests.test_idol_round15 import _refused as _refusal
from tests.test_idol_round17_settings import (OLD, _child, _hard_link, _parses, _wait_for, copy_body, keyed,  # noqa: F401
                                               write_copy)

BACKEND = Path(__file__).resolve().parents[1]
MCP = {"X-Nebula-Agent": "Claude Code"}
CLI = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Surface": "cli"}
NEW = {"apiKeys": {"FAL_KEY": "fal-new-" + "2" * 40}, "favorites": ["y" * 3000]}


@pytest.fixture
def home_state(keyed, monkeypatch):
    """Nebula's state folder at ~/.nebula, beside the settings, as a
    person's own install has it."""
    monkeypatch.setenv("NEBULA_STATE_DIR", str(keyed.parent))
    yield keyed.parent


def _popen(code: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", textwrap.dedent(code)], cwd=BACKEND, env=os.environ.copy(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _stop(*children: subprocess.Popen | None) -> None:
    for child in children:
        if child is not None and child.poll() is None:
            child.kill()
            child.communicate()


# -- MEDIUM-1: the copy folder and the fixed temp names are on every deny list --------------

def _protected_paths(keyed: Path) -> list[Path]:
    copy = settings.backup_path(keyed)
    return [settings.settings_copy_folder(), copy, settings.temp_path_for(copy),
            settings.settings_copy_folder() / "settings-replaced-20261031T120000Z.json",
            settings.temp_path_for(keyed)]


def test_the_copy_folder_and_the_temp_names_are_what_round_18_says(home_state, keyed):
    assert settings.settings_copy_folder() == home_state / "settings-copy"
    assert settings.backup_path(keyed).parent == home_state / "settings-copy"
    assert settings.temp_path_for(keyed) == keyed.parent / ".settings.json.nebula-tmp"
    assert settings.temp_path_for(keyed) in settings.secret_temp_paths()


def test_no_graph_or_media_path_reaches_the_copy_or_a_temp_file(home_state, keyed):
    for path in _protected_paths(keyed):
        with pytest.raises(file_access.ProtectedPathError):
            file_access.require_allowed_path(path)
        with pytest.raises(file_access.ProtectedPathError):
            file_access.require_allowed_path(f"file://{path}")


def test_codex_denies_the_copy_folder_and_the_temp_file(home_state, keyed, tmp_path):
    import tomllib

    work = tmp_path / "agent-work"
    work.mkdir()
    deny = [*agent_profiles.protected_agent_dirs(), *agent_profiles.default_secret_paths()]  # as codex_session passes
    args = agent_profiles.codex_filesystem_args(workdir=work, deny_paths=deny)
    overrides = tomllib.loads("\n".join(value for flag, value in zip(args, args[1:]) if flag == "-c"))
    filesystem = overrides["permissions"]["nebula-agent"]["filesystem"]
    for path in (settings.settings_copy_folder(), settings.temp_path_for(keyed)):
        assert filesystem[str(path.resolve())] == "deny", path


def test_claude_denies_reading_the_copy_folder_and_the_temp_file(home_state, keyed):
    args = agent_profiles.claude_profile_args(extra_dirs=[], secret_paths=agent_profiles.default_secret_paths(),
                                              deny_read_dirs=agent_profiles.protected_agent_dirs())
    deny = json.loads(args[args.index("--settings") + 1])["permissions"]["deny"]
    folder = settings.settings_copy_folder().resolve()
    assert f"Read(/{folder})" in deny and f"Read(/{folder}/**)" in deny
    assert f"Read(/{settings.temp_path_for(keyed).resolve()})" in deny


def test_no_agent_workspace_can_be_made_over_the_copy_folder(home_state, keyed):
    from services.agent_profiles import paths_overlap

    assert any(paths_overlap(settings.settings_copy_folder(), protected)
               for protected in agent_profiles.protected_agent_dirs())


def test_an_in_place_save_keeps_its_copy_and_temp_only_in_the_copy_folder(home_state, keyed, monkeypatch):
    """While the in-place write runs, the copy is in the copy folder (0700),
    and nothing holding the keys is anywhere else."""
    _hard_link(keyed)
    seen = []
    real = settings._overwrite

    def look(fd, data, old):
        folder = settings.settings_copy_folder()
        seen.append((stat.S_IMODE(folder.stat().st_mode), sorted(p.name for p in folder.iterdir()),
                     sorted(p.name for p in home_state.iterdir())))
        real(fd, data, old)

    monkeypatch.setattr(settings, "_overwrite", look)
    settings.save_settings(NEW)
    [(mode, in_copy, in_state)] = seen
    assert mode == 0o700 and in_copy == [settings.backup_path(keyed).name]
    assert in_state == ["settings-copy", "settings.json"]
    assert list(settings.settings_copy_folder().iterdir()) == []


# -- MEDIUM-1: the start sweep, under the lock --------------------------------------------

def test_the_start_sweep_removes_every_temp_file_left_and_moves_a_round_17_copy(home_state, keyed):
    left = [settings.temp_path_for(keyed), keyed.parent / ".settings-nebula-123-abcd_123.tmp"]
    copy_temp = settings.temp_path_for(settings.backup_path(keyed))
    copy_temp.parent.mkdir(mode=0o700)
    for path in [*left, copy_temp]:
        path.write_text(json.dumps(OLD), encoding="utf-8")  # fresh: no age needed under the lock
    legacy = home_state / "settings-backup-0123456789abcdef.json"
    legacy.write_text(json.dumps({"path": str(keyed), "text": json.dumps(OLD)}), encoding="utf-8")
    person = keyed.parent / ".settings.json.nebula-tmp.mine"
    person.write_text("the person's", encoding="utf-8")
    with TestClient(main.app):
        pass
    assert not any(path.exists() for path in [*left, copy_temp])
    assert sorted(p.name for p in home_state.iterdir()) == [person.name, "settings-copy", "settings.json"]
    moved = settings.settings_copy_folder() / "legacy-settings-backup-0123456789abcdef.json"
    assert moved.exists() and stat.S_IMODE(moved.stat().st_mode) == 0o600
    assert _parses(keyed) == OLD  # a legacy copy is never restored


def test_the_sweep_holds_the_saves_lock(home_state, keyed, monkeypatch):
    held = []
    real = settings._sweep

    def look(path, now, *, locked):
        held.append((getattr(settings._HELD, "path", None), locked))
        return real(path, now, locked=locked)

    monkeypatch.setattr(settings, "_sweep", look)
    settings.sweep_stale_temp_files()
    assert held == [(keyed, True)]


def test_without_the_lock_the_sweep_keeps_a_fresh_temp_file(home_state, keyed, monkeypatch):
    temp = settings.temp_path_for(keyed)
    temp.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(settings, "_locked", lambda path: None)  # a filesystem with no flock
    assert settings.sweep_stale_temp_files() == [] and temp.exists()
    past = time.time() - settings.STALE_TEMP_SECONDS - 5
    os.utime(temp, (past, past))
    assert settings.sweep_stale_temp_files() == [temp] and not temp.exists()


def test_a_temp_file_a_cut_save_left_is_replaced_by_the_next_save(keyed):
    temp = settings.temp_path_for(keyed)
    temp.write_text("a save cut short", encoding="utf-8")
    temp.chmod(0o644)
    settings.save_settings({"favorites": ["next"]})
    assert _parses(keyed) == {"favorites": ["next"]} and not temp.exists()


# -- LOW-1: the restore holds the save's lock throughout (N22) ----------------------------

HOLD_IN_PLACE = """
import os, time
import services.settings as s
real = s._pwrite
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

s._pwrite = hold
s.save_settings({new!r})
print("B SAVED")
"""

RESTORE = """
import services.settings as s
s._lock_waiting = lambda: open({waiting!r}, "w").close()
print("RESTORED", s.restore_settings_from_backup())
"""


def test_a_restore_waits_for_another_nebulas_save_and_never_drops_its_copy(keyed, tmp_path):
    """B is in the middle of an in-place save (its copy kept, the file
    still the old JSON). A Nebula starting then waits for B's lock before
    it reads anything: B's copy stays while B writes, and A then finds B's
    finished save and restores nothing."""
    _hard_link(keyed)
    inside, go, waiting = tmp_path / "B-inside", tmp_path / "go", tmp_path / "A-waiting"
    b = _popen(HOLD_IN_PLACE.format(inside=str(inside), go=str(go), new=NEW))
    a = None
    try:
        _wait_for(inside, b, "B inside its in-place write")
        assert settings.backup_path(keyed).exists()
        a = _popen(RESTORE.format(waiting=str(waiting)))
        _wait_for(waiting, a, "A waiting for B's lock")
        assert a.poll() is None and settings.backup_path(keyed).exists(), "A judged the file under B's save"
        go.touch()
        out_b, err_b = b.communicate(timeout=60)
        out_a, err_a = a.communicate(timeout=60)
    finally:
        go.touch()
        _stop(a, b)
    assert out_b.strip() == "B SAVED" and out_a.strip() == "RESTORED None", (err_a, err_b)
    assert _parses(keyed) == NEW
    assert not settings.backup_path(keyed).exists()


def test_the_restore_reads_judges_writes_and_drops_inside_the_lock(keyed, monkeypatch):
    held = []
    real = settings._restore

    def look(path):
        held.append(getattr(settings._HELD, "path", None))
        return real(path)

    monkeypatch.setattr(settings, "_restore", look)
    settings.restore_settings_from_backup()
    assert held == [keyed]


# -- LOW-2: the replaced file is kept; only Nebula's own copy is trusted --------------------

def _cut_copy(path: Path) -> tuple[bytes, bytes]:
    """A copy for an in-place save of NEW over OLD, and the file as that
    save leaves it part way: NEW's first bytes over OLD padded, cut where
    the mix doesn't parse (a cut inside two strings can)."""
    old = path.read_bytes()
    new = (json.dumps(NEW, indent=2) + "\n").encode()
    write_copy(settings.backup_path(path), copy_body(str(path), old.decode(), new.decode()))
    padded = old.ljust(max(len(old), len(new)), b" ")
    for cut in range(20, len(new)):
        mixed = new[:cut] + padded[cut:]
        try:
            json.loads(mixed)
        except ValueError:
            break
    path.write_bytes(mixed)
    return old, mixed


def test_a_restore_keeps_the_file_it_replaces_aside_this_users_only(home_state, keyed):
    old, mixed = _cut_copy(keyed)
    restored = settings.restore_settings_from_backup()
    assert restored.path == keyed and restored.unfinished is True
    assert keyed.read_bytes() == old
    assert restored.kept.parent == settings.settings_copy_folder()
    assert restored.kept.name.startswith("settings-replaced-") and restored.kept.read_bytes() == mixed
    assert stat.S_IMODE(restored.kept.stat().st_mode) == 0o600
    assert not settings.backup_path(keyed).exists()


def test_a_second_restore_in_the_same_second_keeps_both_files(home_state, keyed, monkeypatch):
    kept = []
    for _ in range(2):
        _cut_copy(keyed)
        kept.append(settings.restore_settings_from_backup().kept)
    assert len(set(kept)) == 2 and all(path.exists() for path in kept)


def test_a_restore_that_cant_keep_the_file_aside_changes_nothing(home_state, keyed, monkeypatch):
    _, mixed = _cut_copy(keyed)

    def refuse(current):
        raise OSError(errno.ENOSPC, "full")

    monkeypatch.setattr(settings, "_keep_aside", refuse)
    assert settings.restore_settings_from_backup() is None
    assert keyed.read_bytes() == mixed and settings.backup_path(keyed).exists()


@pytest.mark.parametrize("change", ["no-marker", "other-version", "wrong-hash", "text-changed", "next-missing",
                                    "text-doesnt-parse", "not-json"])
def test_a_copy_that_isnt_nebulas_marked_and_hashed_one_is_dropped_never_restored(keyed, change):
    _cut_copy(keyed)
    target = settings.backup_path(keyed)
    body = json.loads(target.read_text(encoding="utf-8"))
    if change == "no-marker":
        del body["nebula"]
    elif change == "other-version":
        body["version"] = 2
    elif change == "wrong-hash":
        body["sha256"] = "0" * 64
    elif change == "text-changed":
        body["text"] = json.dumps({"apiKeys": {"FAL_KEY": "planted"}})
    elif change == "next-missing":
        del body["next"]
    elif change == "text-doesnt-parse":
        body = copy_body(str(keyed), "{not json", body["next"])
    write_copy(target, body)
    if change == "not-json":
        target.write_text("{cut", encoding="utf-8")
    mixed = keyed.read_bytes()
    assert settings.restore_settings_from_backup() is None
    assert keyed.read_bytes() == mixed and not target.exists()


@pytest.mark.parametrize("kind", ["symlink", "hard-link", "group-readable", "other-owner"])
def test_a_copy_that_isnt_provably_nebulas_own_file_is_left_and_never_restored(keyed, tmp_path, monkeypatch, kind):
    _cut_copy(keyed)
    target = settings.backup_path(keyed)
    if kind == "symlink":
        real = tmp_path / "planted.json"
        os.replace(target, real)
        target.symlink_to(real)
    elif kind == "hard-link":
        os.link(target, tmp_path / "second-name.json")
    elif kind == "group-readable":
        target.chmod(0o640)
    else:
        monkeypatch.setattr(settings, "_owned", lambda info: False)
    mixed = keyed.read_bytes()
    assert settings.restore_settings_from_backup() is None
    assert keyed.read_bytes() == mixed and os.path.lexists(target)


# -- GM r36 B6b: the restored line, journaled and logged, through MCP, the CLI and chat ------

RESTORED_BECAUSE = ("Nebula restored your settings from its saved copy because the last save didn’t finish. "
                    "The file it replaced is kept at {kept}.")
RESTORED = "Nebula restored your settings from its saved copy. The file it replaced is kept at {kept}."


@pytest.fixture
def chat_turn():
    token = agent_registry.mint("claude", [], session="chat-r18-settings")
    yield {"Authorization": f"Agent {token}"}
    agent_registry.revoke(token)


def _start_and_read(caplog, chat_turn) -> tuple[list[dict], list[str], list[str]]:
    start = main.canvas_events.read(after=None)["cursor"]
    with caplog.at_level("WARNING", logger="nebula.settings"):
        with TestClient(main.app) as client:
            read = [client.get("/api/canvas/events", params={"after": start, "kinds": "settings"}, headers=h).json()
                    for h in (MCP, CLI, chat_turn)]
    logged = [record.getMessage() for record in caplog.records if record.name == "nebula.settings"]
    events = [[e for e in r["events"] if e["kind"] == "settings.restored"] for r in read]
    return events, logged, [format_event(e) for e in events[1]]


@pytest.mark.parametrize("case", ["unfinished", "changed-since"])
def test_the_restored_line_gives_the_reason_only_when_it_is_known(home_state, keyed, caplog, chat_turn, case):
    """A file that is the cut save's mix of old and new: "because the last
    save didn’t finish". A file changed since that save (cut to half here):
    the reason can't be known, so the line has no "because" clause."""
    if case == "unfinished":
        _cut_copy(keyed)
        template = RESTORED_BECAUSE
    else:
        good = keyed.read_bytes()
        write_copy(settings.backup_path(keyed), copy_body(str(keyed), good.decode()))
        keyed.write_bytes(good[: len(good) // 2])
        template = RESTORED
    events, logged, cli = _start_and_read(caplog, chat_turn)
    [kept] = [p for p in settings.settings_copy_folder().iterdir() if p.name.startswith("settings-replaced-")]
    shown = settings.shown_path(kept)
    assert shown.startswith("~/.nebula/settings-copy/settings-replaced-")
    line = template.format(kept=shown)
    assert logged == [line]
    for [event] in events:  # MCP, the CLI and chat read the same event
        assert event["summary"] == line and event["actor"]["kind"] == "system"
        assert event["data"] == {"file": "~/.nebula/settings.json", "keptAt": shown}
        assert "fal-kept" not in json.dumps(event)
    [shown_by_cli] = cli
    assert shown_by_cli.endswith(f"Nebula  {line}")


def test_the_restored_line_is_never_cut_on_the_desktops_state_path(keyed, monkeypatch):
    """The desktop app's state folder makes the line longer than other
    summaries may be: it is kept whole."""
    state = keyed.parent.parent / "Library" / "Application Support" / "Nebula Nodes" / "state"
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    _cut_copy(keyed)
    restored = settings.restore_settings_from_backup()
    line = main.settings_restored_line(restored)
    assert line == RESTORED_BECAUSE.format(kept=settings.shown_path(restored.kept))
    assert "~/Library/Application Support/Nebula Nodes/state/settings-copy/settings-replaced-" in line
    from services.canvas_events import MAX_SUMMARY_CHARS, CanvasEventJournal

    assert len(line) > MAX_SUMMARY_CHARS
    event = CanvasEventJournal().publish("settings.restored", actor={"kind": "system"}, summary=line, project_id=None)
    assert event["summary"] == line


def test_the_cut_short_check_knows_each_step_of_the_in_place_write():
    old, new = b'{"a": 1}  ', b'{"bb": 22, "c": 3}'
    size = len(new)
    grown = old + b" " * 3
    half = new[:6] + old.ljust(size, b" ")[6:]
    assert settings._cut_short(grown, old, new)
    assert settings._cut_short(half, old, new)
    assert settings._cut_short(old.ljust(size, b" "), old, new)
    assert not settings._cut_short(old[:5], old, new)          # shorter than the old file
    assert not settings._cut_short(b'{"x": 9}  ', old, new)    # bytes neither wrote
    assert not settings._cut_short(new + b" ", old, new)       # longer than both
    shorter = b'{"z": 0}'
    assert not settings._cut_short(old[:9], old, shorter)       # the cut leaves the new JSON whole


# -- LOW-3: PUT and DELETE hold the lock from the read to the save --------------------------

HOLD_TRANSACTION = """
import os, time
import services.settings as s
with s.settings_transaction():
    current = s.load_saved_settings()
    open({inside!r}, "w").close()
    deadline = time.monotonic() + 30
    while not os.path.exists({go!r}):
        if time.monotonic() > deadline:
            raise SystemExit("never released")
        time.sleep(0.01)
    current.setdefault("apiKeys", {{}})["OPENAI_API_KEY"] = "sk-from-A-1111"
    s.save_settings(current)
print("A SAVED")
"""


@pytest.mark.parametrize("write", ["put", "delete"])
def test_two_interleaved_settings_writes_of_different_keys_both_survive(keyed, tmp_path, monkeypatch, write):
    """A (another Nebula) has read the file inside its transaction and
    waits; this backend's PUT or DELETE starts then and must wait at its
    read, so A's key and this write both survive."""
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    waiting = threading.Event()
    monkeypatch.setattr(settings, "_lock_waiting", waiting.set)
    inside, go = tmp_path / "A-inside", tmp_path / "go"
    a = _popen(HOLD_TRANSACTION.format(inside=str(inside), go=str(go)))
    answers: list = []
    request = threading.Thread(target=lambda: answers.append(
        _person().put("/api/settings", json={"apiKeys": {"GEMINI_API_KEY": "gm-from-B-1111"}}) if write == "put"
        else _person().delete("/api/settings/api-keys/FAL_KEY")))
    try:
        _wait_for(inside, a, "A inside its transaction")
        request.start()
        assert waiting.wait(30), "the write never waited for A's lock"
        assert a.poll() is None
        go.touch()
        out_a, err_a = a.communicate(timeout=60)
        request.join(60)
    finally:
        go.touch()
        _stop(a)
    assert out_a.strip() == "A SAVED", err_a
    assert [answer.status_code for answer in answers] == [200]
    keys = _parses(keyed)["apiKeys"]
    assert keys["OPENAI_API_KEY"] == "sk-from-A-1111"
    if write == "put":
        assert keys["GEMINI_API_KEY"] == "gm-from-B-1111" and keys["FAL_KEY"] == OLD["apiKeys"]["FAL_KEY"]
    else:
        assert "FAL_KEY" not in keys


@pytest.mark.parametrize("write", ["put", "delete"])
def test_the_routes_read_and_save_inside_one_lock(keyed, monkeypatch, write):
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    seen = []
    real_read, real_save = main.load_saved_settings, main.save_settings
    monkeypatch.setattr(main, "load_saved_settings",
                        lambda: seen.append(("read", getattr(settings._HELD, "path", None))) or real_read())
    monkeypatch.setattr(main, "save_settings",
                        lambda current: seen.append(("save", getattr(settings._HELD, "path", None))) or real_save(current))
    client = _person()
    response = (client.put("/api/settings", json={"favorites": ["one"]}) if write == "put"
                else client.delete("/api/settings/api-keys/FAL_KEY"))
    assert response.status_code == 200
    assert seen == [("read", keyed), ("save", keyed)]
    assert getattr(settings._HELD, "path", None) is None


def test_a_save_inside_a_transaction_takes_no_second_lock(keyed, monkeypatch):
    calls = []
    real = settings._locked
    monkeypatch.setattr(settings, "_locked", lambda path: calls.append(path) or real(path))
    with settings.settings_transaction():
        settings.save_settings({"favorites": ["inside"]})
    assert calls == [keyed] and _parses(keyed) == {"favorites": ["inside"]}


def _within(seconds: float, work):
    """``work()``'s result, or its exception, failing (never hanging) when
    it takes longer than ``seconds``: the lock loop spun forever on 204ad52f."""
    done: list = []

    def run():
        try:
            done.append(("ok", work()))
        except BaseException as exc:  # noqa: BLE001 - handed back to the test
            done.append(("raised", exc))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    assert not worker.is_alive(), "the settings lock spun instead of returning"
    return done[0]


def test_a_folder_at_the_settings_path_is_locked_once_and_refused_promptly(keyed):
    """The transaction locks before the read that refuses a folder at the
    settings path: the lock takes the folder itself, never spinning."""
    keyed.unlink()
    keyed.mkdir()
    outcome, fd = _within(10, lambda: settings._locked(keyed))
    assert outcome == "ok" and fd is not None
    try:
        assert os.path.samestat(os.fstat(fd), os.lstat(keyed))
    finally:
        os.close(fd)
    outcome, response = _within(10, lambda: _person().put("/api/settings", json={"favorites": ["x"]}))
    assert outcome == "ok" and response.status_code == 409 and keyed.is_dir()


def test_a_lock_whose_target_keeps_changing_stops_at_the_deadline(keyed, monkeypatch):
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(settings, "_lock_holds", lambda fd, path: False)
    outcome, refused = _within(5, lambda: settings._locked(keyed))
    assert outcome == "raised" and isinstance(refused, OSError) and refused.errno == errno.EAGAIN


# -- NIT-2: the copy folder's levels, and a state path through a file ----------------------

def test_every_missing_level_of_the_copy_folder_is_this_users_only(keyed, tmp_path, monkeypatch):
    state = tmp_path / "home" / "s1" / "s2"
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    _hard_link(keyed)
    settings.save_settings({"favorites": []})
    for level in (state.parent, state, state / "settings-copy"):
        assert stat.S_IMODE(level.stat().st_mode) == 0o700, level


def test_a_loose_copy_folder_is_made_this_users_only_again(home_state, keyed):
    folder = settings.settings_copy_folder()
    folder.mkdir(mode=0o755)
    folder.chmod(0o755)
    _hard_link(keyed)
    settings.save_settings({"favorites": []})
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700


@pytest.mark.parametrize("where", ["state", "copy-folder"])
def test_a_state_path_through_a_file_is_the_not_a_folder_line(keyed, tmp_path, monkeypatch, where):
    in_the_way = tmp_path / "home" / "afile"
    in_the_way.write_text("a file", encoding="utf-8")
    if where == "state":
        monkeypatch.setenv("NEBULA_STATE_DIR", str(in_the_way / "state"))
    else:
        monkeypatch.setenv("NEBULA_STATE_DIR", str(tmp_path / "home"))
        in_the_way = tmp_path / "home" / "settings-copy"
        in_the_way.write_text("a file", encoding="utf-8")
    _hard_link(keyed)
    before = keyed.read_bytes()
    response = _person().put("/api/settings", json={"favorites": []})
    shown = f"~/{in_the_way.name}"
    line = (f"Nothing was saved because {shown} is a file, and Nebula needs a folder there. "
            "Move or rename that file, then try again.")
    assert _refusal(response) == (409, line, "settings_not_a_folder")
    assert keyed.read_bytes() == before


# -- GM r36 B6a: Nebula's folder takes no copy -------------------------------------------

COPY_LINE = ("Nothing was saved because Nebula isn’t allowed to change {folder}, where it keeps a copy while it "
             "saves. Check the folder’s permissions, then try again.")
COPY_AGENT_LINE = ("Nothing was saved because Nebula isn’t allowed to change {folder}, where it keeps a copy while "
                   "it saves. Ask the person to check the folder’s permissions.")


@pytest.mark.unprivileged
def test_a_copy_folder_nebula_cant_change_is_gms_line(keyed, tmp_path, monkeypatch):
    state = tmp_path / "home" / "st"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    _hard_link(keyed)
    before = keyed.read_bytes()
    state.chmod(0o555)
    try:
        response = _person().put("/api/settings", json={"favorites": []})
    finally:
        state.chmod(0o755)
    assert _refusal(response) == (409, COPY_LINE.format(folder="~/st"), "settings_unwritable")
    assert response.json()["fix"] == "Check the permissions of ~/st, then try again."
    assert keyed.read_bytes() == before


def test_the_copy_folder_line_by_reader_and_on_the_desktop_state_path(keyed, monkeypatch):
    desktop = keyed.parent.parent / "Library" / "Application Support" / "Nebula Nodes" / "state"
    block = settings.SettingsUnwritable(errno.EACCES, "no copy", desktop, "copy_folder")
    shown = "~/Library/Application Support/Nebula Nodes/state"
    for person, line in ((True, COPY_LINE), (False, COPY_AGENT_LINE)):
        monkeypatch.setattr(main.refusal_copy, "person_reads", lambda person=person: person)
        refusal = main._unwritable_refusal(block)
        assert (refusal.status_code, refusal.detail) == (409, line.format(folder=shown))
        assert refusal.fields["code"] == "settings_unwritable"


# -- NIT-3: a pwrite that takes no bytes (N9) ----------------------------------------------

def test_a_pwrite_that_takes_no_bytes_fails_and_leaves_the_file_and_its_copy(keyed, monkeypatch):
    _hard_link(keyed)
    before = keyed.read_bytes()
    calls = {"n": 0}

    def nothing(fd, data, offset):
        calls["n"] += 1
        if calls["n"] > 1000:
            raise AssertionError("the write loops on a pwrite that takes no bytes")
        return 0

    monkeypatch.setattr(settings, "_pwrite", nothing)
    with pytest.raises(OSError) as raised:
        settings.save_settings(NEW)
    assert raised.value.errno == errno.EIO and calls["n"] == 2  # the write, then the put-back
    assert keyed.read_bytes() == before
    assert settings.backup_path(keyed).exists()  # the put-back failed too: kept for the next start


# -- NIT-4: F_FULLFSYNC, and the folder synced after each rename (N2, N12) --------------------

@pytest.fixture
def syncs(monkeypatch):
    """Every sync the save makes, as (what, command): "file" or "folder",
    through the module's own fcntl seam."""
    seen: list[tuple[str, int]] = []

    def fcntl(fd, command):
        seen.append(("folder" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file", command))
        os.fsync(fd)

    monkeypatch.setattr(settings, "_FULLFSYNC", 51)
    monkeypatch.setattr(settings, "_fcntl", fcntl)
    monkeypatch.setattr(settings, "_fsync", lambda fd: seen.append(("fsync", fd)))  # never os.fsync itself
    yield seen


def test_an_atomic_save_full_syncs_the_temp_file_then_the_folder(keyed, syncs):
    settings.save_settings({"favorites": []})
    assert [what for what, _ in syncs if what != "fsync"] == ["file", "folder"]
    assert {command for what, command in syncs if what != "fsync"} == {51}


def test_an_in_place_save_full_syncs_the_copy_its_folder_and_each_step(keyed, syncs):
    """The copy, then its folder after the rename, then the grow (N2), the
    new JSON; the copy's own sync is the first (N12)."""
    _hard_link(keyed)
    settings.save_settings(NEW)  # longer: grow, then write
    assert [what for what, _ in syncs if what != "fsync"] == ["file", "folder", "file", "file"]


def test_a_filesystem_with_no_full_sync_falls_back_to_fsync(keyed, monkeypatch):
    seen = []

    def refuse(fd, command):
        raise OSError(errno.ENOTSUP, "no F_FULLFSYNC")

    monkeypatch.setattr(settings, "_FULLFSYNC", 51)
    monkeypatch.setattr(settings, "_fcntl", refuse)
    monkeypatch.setattr(settings, "_fsync", lambda fd: seen.append(fd) or os.fsync(fd))
    settings.save_settings({"favorites": []})
    assert len(seen) == 2 and _parses(keyed) == {"favorites": []}  # the temp file, then the folder


def test_macos_has_the_full_sync_the_save_uses():
    if sys.platform != "darwin":
        assert settings._FULLFSYNC is None or isinstance(settings._FULLFSYNC, int)
        return
    import fcntl

    assert settings._FULLFSYNC == fcntl.F_FULLFSYNC and settings._fcntl is fcntl.fcntl
