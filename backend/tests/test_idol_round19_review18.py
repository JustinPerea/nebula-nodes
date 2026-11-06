"""PR #203 round 19, sections 2 and 3: review 18's findings and GM r38.

Settings durability (review 18):
- LOW-1: with no flock, a save never removes another save's fresh temp
  file: it waits for it, then refuses (409 settings_busy); a stale one is
  removed. Two real processes with no lock never tear the file.
- LOW-2: a restore that can't write keeps nothing aside and says so (the
  server log and settings.not_restored); a restore whose write fails keeps
  the file aside once, by its hash.
- NIT-1 and copy-ui LOW-3: a folder at a fixed file name, and a lock wait
  past the deadline, are 409s, never 500s.
- NIT-2 and GM r38 item 4: the copy-folder line names the folder that
  refuses and, when that is above the state folder, the state folder it
  can't make.
- NIT-7: mutants O1 (the resolved temp of a symlinked settings.json), O19
  (the copy's temp inside the copy folder), O24 (a waiter stops at the
  deadline while another process holds the lock), O26 (an existing
  read-only copy folder).

Copy (review 18 copy-ui NIT-2; GM r38 items 1, 2 and 5):
- B14: a pass-through ("Through") is named by its label on the card and in
  the log, by the one rule.
- A node's several needs are one line on the card and in the bubble, ending
  once; the bubble names the node once, by the person's label when renamed.
- settings.restored's line at the top of Settings until the person
  dismisses it; its routes are the person's only.
"""
from __future__ import annotations

import asyncio
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
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from commons.actors import agent_registry
from execution import person_line
from execution.engine import validate_graph
from models.graph import GraphNode
from services import agent_profiles
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import PERSON, _person
from tests.test_idol_round15 import home_file  # noqa: F401 - fixture
from tests.test_idol_round15 import _refused as _refusal
from tests.test_idol_round17_settings import OLD, _hard_link, _parses, _wait_for, keyed, shared_temp_name  # noqa: F401
from tests.test_idol_round18_settings import COPY_LINE, NEW, _cut_copy, _stop, home_state  # noqa: F401

BACKEND = Path(__file__).resolve().parents[1]
MCP = {"X-Nebula-Agent": "Claude Code"}
CLI = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Surface": "cli"}
BUSY = "Nothing was saved because another Nebula is saving your settings. Try again in a moment."


def _popen(code: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", textwrap.dedent(code)], cwd=BACKEND, env=os.environ.copy(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


# -- LOW-1: no flock, one fixed temp name ---------------------------------------------

def test_without_the_lock_a_fresh_temp_file_is_waited_for_never_removed(keyed, monkeypatch, shared_temp_name):
    temp = settings.temp_path_for(keyed)
    temp.write_bytes(b"another save's half")
    temp.chmod(0o600)
    before = keyed.read_bytes()
    waited = []
    monkeypatch.setattr(settings, "_temp_waiting", lambda: waited.append(True))
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.2)
    outcome, refused = _within(20, lambda: settings._open_temp(str(temp), locked=False))
    assert outcome == "raised" and isinstance(refused, settings.SettingsBusy), refused
    assert refused.errno == errno.EAGAIN and waited == [True]
    assert temp.read_bytes() == b"another save's half"
    # A save without the lock refuses the same way, the file as it was.
    monkeypatch.setattr(settings, "_locked", lambda path: None)
    outcome, refused = _within(20, lambda: settings.save_settings({"favorites": ["no"]}))
    assert outcome == "raised" and isinstance(refused, settings.SettingsBusy), refused
    assert keyed.read_bytes() == before and temp.read_bytes() == b"another save's half"


def test_without_the_lock_a_stale_temp_file_is_a_save_cut_short_and_replaced(keyed, monkeypatch, shared_temp_name):
    temp = settings.temp_path_for(keyed)
    temp.write_bytes(b"a save cut short long ago")
    past = time.time() - settings.STALE_TEMP_SECONDS - 5
    os.utime(temp, (past, past))
    monkeypatch.setattr(settings, "_locked", lambda path: None)
    settings.save_settings({"favorites": ["next"]})
    assert _parses(keyed) == {"favorites": ["next"]} and not temp.exists()


def test_with_the_lock_a_fresh_temp_file_is_a_save_cut_short_and_replaced(keyed):
    temp = settings.temp_path_for(keyed)
    temp.write_bytes(b"cut short a moment ago")
    fd = settings._open_temp(str(temp), locked=True)
    try:
        assert os.fstat(fd).st_size == 0 and stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
    finally:
        os.close(fd)


def test_a_folder_at_the_temp_name_raises_never_waits(keyed, monkeypatch):
    temp = settings.temp_path_for(keyed)
    temp.mkdir()
    monkeypatch.setattr(settings, "_temp_waiting", lambda: pytest.fail("waited on a folder"))
    for locked in (True, False):
        with pytest.raises(FileExistsError):
            settings._open_temp(str(temp), locked=locked)
    assert temp.is_dir()


NO_FLOCK_A = """
import os, time
import services.settings as s
s._locked = lambda path: None
s._new_temp = s.temp_path_for  # the shared name (round 23: saves name their own)  # a filesystem that takes no flock
s.LOCK_TIMEOUT_SECONDS = 120
real = s._replace
def wait_then_replace(temp, path):
    open({a_ready!r}, "w").close()
    deadline = time.monotonic() + 60
    while not os.path.exists({go_a!r}):
        if time.monotonic() > deadline:
            raise SystemExit("never released")
        time.sleep(0.01)
    return real(temp, path)
s._replace = wait_then_replace
s.save_settings({a!r})
print("A SAVED")
"""

NO_FLOCK_B = """
import os, time
import services.settings as s
s._locked = lambda path: None
s._new_temp = s.temp_path_for  # the shared name (round 23: saves name their own)
s.LOCK_TIMEOUT_SECONDS = 120  # events decide the wait, never the clock
s._temp_waiting = lambda: open({b_waiting!r}, "w").close()
real = s._write_all
def half_then_wait(fd, data):
    data = bytes(data)
    real(fd, data[: len(data) // 2])
    open({b_half!r}, "w").close()
    deadline = time.monotonic() + 60
    while not os.path.exists({go_b!r}):
        if time.monotonic() > deadline:
            raise SystemExit("never released")
        time.sleep(0.01)
    real(fd, data[len(data) // 2:])
s._write_all = half_then_wait
s.save_settings({b!r})
print("B SAVED")
"""

A_SAVES = {"apiKeys": {"FAL_KEY": "fal-from-A-" + "a" * 40}, "favorites": ["A" * 4000]}
B_SAVES = {"apiKeys": {"OPENAI_API_KEY": "sk-from-B-" + "b" * 40}, "favorites": ["B" * 4000]}


@pytest.mark.parametrize("b_ends", ["killed", "finishes"])
def test_two_saves_with_no_flock_never_tear_the_file_or_lose_a_saved_answer(keyed, tmp_path, b_ends):
    """Review 18's p8, two real processes whose _locked returns None: A has
    written its temp file whole and waits before its rename; B, started
    then, finds A's temp and waits (never removes it). A's rename puts its
    own whole file in place; B then saves, or is killed half way through its
    temp file, and the file is still A's whole JSON."""
    a_ready, go_a, b_waiting, b_half, go_b = (tmp_path / n for n in ("a-ready", "go-a", "b-waiting", "b-half", "go-b"))
    temp = settings.temp_path_for(keyed)
    a = _popen(NO_FLOCK_A.format(a_ready=str(a_ready), go_a=str(go_a), a=A_SAVES))
    b = None
    try:
        _wait_for(a_ready, a, "A's temp file written whole")
        a_temp = temp.read_bytes()
        b = _popen(NO_FLOCK_B.format(b_waiting=str(b_waiting), b_half=str(b_half), go_b=str(go_b), b=B_SAVES))
        _wait_for(b_waiting, b, "B waiting for A's temp file")
        assert temp.read_bytes() == a_temp and not b_half.exists(), "B touched A's temp file"
        go_a.touch()
        out_a, err_a = a.communicate(timeout=60)
        assert out_a.strip() == "A SAVED", err_a
        assert _parses(keyed) == A_SAVES  # A's "saved" is what the file holds, whole
        _wait_for(b_half, b, "B writing its own temp file")
        assert _parses(keyed) == A_SAVES
        if b_ends == "killed":
            b.kill()
            b.communicate(timeout=60)
            assert _parses(keyed) == A_SAVES
        else:
            go_b.touch()
            out_b, err_b = b.communicate(timeout=60)
            assert out_b.strip() == "B SAVED", err_b
            assert _parses(keyed) == B_SAVES
    finally:
        go_a.touch()
        go_b.touch()
        _stop(a, b)


HOLD_LOCK = """
import fcntl, os, time
fd = os.open({path!r}, os.O_RDONLY)
fcntl.flock(fd, fcntl.LOCK_EX)
open({held!r}, "w").close()
deadline = time.monotonic() + 60
while not os.path.exists({go!r}) and time.monotonic() < deadline:
    time.sleep(0.01)
"""


@pytest.fixture
def lock_held(keyed, tmp_path):
    """Another process holds the save's flock on settings.json until the
    test ends."""
    held, go = tmp_path / "held", tmp_path / "go"
    child = _popen(HOLD_LOCK.format(path=str(keyed), held=str(held), go=str(go)))
    try:
        _wait_for(held, child, "the other process holding the lock")
        yield child
    finally:
        go.touch()
        _stop(child)


def _within(seconds: float, work):
    done: list = []

    def run():
        try:
            done.append(("ok", work()))
        except BaseException as exc:  # noqa: BLE001 - handed back to the test
            done.append(("raised", exc))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    assert not worker.is_alive(), "the wait never stopped"
    return done[0]


def test_a_waiter_stops_at_the_lock_deadline_while_another_process_holds_it(keyed, lock_held, monkeypatch):
    """Mutant O24 (review 18 NIT-7): the wait's deadline while the lock is
    held, not only while its target keeps changing."""
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.3)
    outcome, refused = _within(20, lambda: settings._locked(keyed))
    assert outcome == "raised" and isinstance(refused, settings.SettingsBusy), refused
    assert lock_held.poll() is None


@pytest.mark.parametrize("write", ["put", "delete"])
def test_a_settings_write_another_nebula_holds_past_the_wait_is_a_409(keyed, lock_held, monkeypatch, write):
    """Review 18 copy-ui LOW-3: a bare 500 before. GM r38 item 3's line,
    neutral, with its own code."""
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    before = keyed.read_bytes()
    client = _person()
    response = (client.put("/api/settings", json={"favorites": ["held"]}) if write == "put"
                else client.delete("/api/settings/api-keys/FAL_KEY"))
    assert _refusal(response) == (409, BUSY, "settings_busy")
    assert response.json()["fix"] == "Try again in a moment."
    assert keyed.read_bytes() == before


def test_a_save_that_meets_another_saves_temp_past_the_wait_is_a_409(keyed, monkeypatch, shared_temp_name):
    monkeypatch.setattr(settings, "LOCK_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    monkeypatch.setattr(settings, "_locked", lambda path: None)
    temp = settings.temp_path_for(keyed)
    temp.write_bytes(b"in flight")
    response = _person().put("/api/settings", json={"favorites": ["x"]})
    assert _refusal(response) == (409, BUSY, "settings_busy")
    assert temp.read_bytes() == b"in flight"


# -- LOW-2: a restore that can't write ------------------------------------------------

def _aside(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.glob("settings-replaced-*")) if folder.exists() else []


@pytest.mark.unprivileged
def test_two_restores_against_a_read_only_file_keep_nothing_aside_and_say_why(home_state, keyed):
    _, mixed = _cut_copy(keyed)
    keyed.chmod(0o400)
    try:
        results = [settings.restore_settings_from_backup() for _ in range(2)]
    finally:
        keyed.chmod(0o600)
    assert all(isinstance(r, settings.NotRestored) for r in results), results
    assert all(r.why.cause == "file" and r.why.where == keyed for r in results)
    assert _aside(settings.settings_copy_folder()) == []
    assert keyed.read_bytes() == mixed and settings.backup_path(keyed).exists()


def test_two_restores_whose_write_fails_keep_the_file_aside_once(home_state, keyed, monkeypatch):
    _, mixed = _cut_copy(keyed)

    def refuse(*args, **kwargs):
        raise PermissionError(errno.EACCES, "refused", str(keyed))

    monkeypatch.setattr(settings, "_write", refuse)
    results = [settings.restore_settings_from_backup() for _ in range(2)]
    assert all(isinstance(r, settings.NotRestored) and r.why.errno == errno.EACCES for r in results)
    assert len(_aside(settings.settings_copy_folder())) == 1
    assert keyed.read_bytes() == mixed and settings.backup_path(keyed).exists()


NOT_RESTORED = ("Nebula has a saved copy of your settings but couldn’t put it back, because it isn’t allowed to "
                "change {path}. It’ll try again the next time Nebula starts.")


@pytest.fixture
def chat_turn():
    token = agent_registry.mint("claude", [], session="chat-r19-review18")
    yield {"Authorization": f"Agent {token}"}
    agent_registry.revoke(token)


@pytest.mark.unprivileged
def test_a_copy_the_start_cant_put_back_is_logged_and_journaled(home_state, keyed, caplog, chat_turn, monkeypatch):
    monkeypatch.setattr(main, "_settings_notice", None)  # an earlier test's start may have set it
    _cut_copy(keyed)
    keyed.chmod(0o400)
    start = main.canvas_events.read(after=None)["cursor"]
    try:
        with caplog.at_level("WARNING", logger="nebula.settings"):
            with TestClient(main.app) as client:
                read = [client.get("/api/canvas/events", params={"after": start, "kinds": "settings"},
                                   headers=h).json() for h in (MCP, CLI, chat_turn)]
                notice = client.get("/api/settings/notice", headers=PERSON).json()
    finally:
        keyed.chmod(0o600)
    line = NOT_RESTORED.format(path="~/.nebula/settings.json")
    assert [r.getMessage() for r in caplog.records if r.name == "nebula.settings"] == [line]
    for r in read:
        [event] = [e for e in r["events"] if e["kind"].startswith("settings.")]
        assert event["kind"] == "settings.not_restored" and event["summary"] == line
        assert event["data"] == {"file": "~/.nebula/settings.json"} and event["actor"]["kind"] == "system"
        assert "fal-kept" not in json.dumps(event)
    assert notice == {"notice": None}  # only a restore that happened is shown to the person


# -- NIT-1: a folder at one of the save's fixed names ---------------------------------

IN_THE_WAY = ("Nothing was saved because {folder} is a folder, and Nebula needs to put a file there. "
              "Move or rename that folder, then try again.")


@pytest.mark.parametrize("name", ["temp", "copy", "copy-temp"])
def test_a_folder_at_a_fixed_file_name_is_a_409(home_state, keyed, monkeypatch, name, shared_temp_name):
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    copy = settings.backup_path(keyed)
    if name == "temp":  # no settings.json yet, so there is nothing to write in place
        keyed.unlink()
        in_the_way = settings.temp_path_for(keyed)
    else:
        _hard_link(keyed)  # an in-place save keeps its copy
        in_the_way = copy if name == "copy" else settings.temp_path_for(copy)
    in_the_way.mkdir(parents=True)
    before = keyed.read_bytes() if keyed.exists() else None
    response = _person().put("/api/settings", json={"favorites": ["x"]})
    shown = settings.shown_path(in_the_way)
    assert _refusal(response) == (409, IN_THE_WAY.format(folder=shown), "settings_not_a_folder")
    assert in_the_way.is_dir()
    assert (keyed.read_bytes() if keyed.exists() else None) == before


def test_a_folder_at_the_temp_name_beside_a_file_is_written_in_place(keyed, monkeypatch):
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    settings.temp_path_for(keyed).mkdir()
    response = _person().put("/api/settings", json={"favorites": ["in place"]})
    assert response.status_code == 200 and _parses(keyed)["favorites"] == ["in place"]


# -- NIT-2 and GM r38 item 4: the copy-folder line names both folders ------------------

TWO_FOLDERS = ("Nothing was saved because Nebula isn’t allowed to change ~/ro, so it can’t make ~/ro/deeper/state, "
               "where it keeps a copy while it saves. Check the permissions of ~/ro, then try again.")


@pytest.mark.unprivileged
def test_a_folder_above_the_state_folder_that_refuses_names_both(keyed, tmp_path, monkeypatch):
    ro = tmp_path / "home" / "ro"
    ro.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(ro / "deeper" / "state"))
    _hard_link(keyed)
    before = keyed.read_bytes()
    ro.chmod(0o555)
    try:
        response = _person().put("/api/settings", json={"favorites": []})
    finally:
        ro.chmod(0o755)
    assert _refusal(response) == (409, TWO_FOLDERS, "settings_unwritable")
    assert response.json()["fix"] == "Check the permissions of ~/ro, then try again."
    assert keyed.read_bytes() == before


def test_the_copy_folder_error_carries_the_state_folder_only_when_above_it(keyed, tmp_path, monkeypatch):
    state = tmp_path / "home" / "ro" / "deeper" / "state"
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    cases = {tmp_path / "home" / "ro": state, state: None, state / "settings-copy": None}
    for refuses, creates in cases.items():
        def refuse(folder, cause="folder", refuses=refuses):
            raise settings.SettingsUnwritable(errno.EACCES, "no", refuses, cause)

        monkeypatch.setattr(settings, "_make_folders", refuse)
        with pytest.raises(settings.SettingsUnwritable) as raised:
            settings._make_copy_folder()
        assert raised.value.where == refuses and raised.value.creates == creates, refuses


def test_the_two_folder_line_by_reader(keyed, monkeypatch):
    home = keyed.parent.parent
    block = settings.SettingsUnwritable(errno.EACCES, "no", home / "ro", "copy_folder",
                                        creates=home / "ro" / "deeper" / "state")
    agent = ("Nothing was saved because Nebula isn’t allowed to change ~/ro, so it can’t make ~/ro/deeper/state, "
             "where it keeps a copy while it saves. Ask the person to check the permissions of ~/ro.")
    for person, line in ((True, TWO_FOLDERS), (False, agent)):
        monkeypatch.setattr(main.refusal_copy, "person_reads", lambda person=person: person)
        refusal = main._unwritable_refusal(block)
        assert (refusal.status_code, refusal.detail, refusal.fields["code"]) == (409, line, "settings_unwritable")


# -- NIT-7: mutants O1, O19, O26 ------------------------------------------------------

def test_a_symlinked_settings_files_real_temp_is_on_the_deny_list(keyed, tmp_path):
    """Mutant O1: the temp a save of a symlinked settings.json writes is
    beside the real file, and agents may read neither spelling."""
    real = tmp_path / "home" / "dotfiles" / "settings.json"
    real.parent.mkdir()
    real.write_bytes(keyed.read_bytes())
    keyed.unlink()
    keyed.symlink_to(real)
    assert [p for p in settings.secret_temp_paths() if p.name != settings.TEMP_FOLDER] == [
        settings.temp_path_for(keyed), settings.temp_path_for(real)]
    assert settings.temp_folder_for(real.parent) in settings.secret_temp_paths()  # round 23b
    denied = agent_profiles.default_secret_paths()
    assert settings.temp_path_for(real) in denied and settings.temp_path_for(keyed) in denied


def test_the_copys_temp_file_is_inside_the_copy_folder_while_it_holds_the_keys(home_state, keyed, monkeypatch):
    """Mutant O19: where the copy's temp file is while it is written, not
    only where the copy ends up."""
    _hard_link(keyed)
    opened = []
    real = settings._open_temp
    monkeypatch.setattr(settings, "_open_temp", lambda temp, *, locked: opened.append(Path(temp)) or
                        real(temp, locked=locked))
    settings.save_settings({"favorites": ["in place"]})
    copy = settings.backup_path(keyed)
    shared = settings.temp_path_for(copy)
    [temp] = opened  # round 23: the shared name, then the save's process id and a token
    # round 23b: in the private folder inside the copy folder
    assert temp.parent == settings.temp_folder_for(shared.parent) and temp.name.startswith(shared.name + "-")
    assert settings.is_secret_temp_name(temp.name)
    assert opened[0].parent.parent == settings.settings_copy_folder() == copy.parent


@pytest.mark.unprivileged
def test_an_existing_copy_folder_nebula_cant_write_is_the_copy_folder_line(home_state, keyed, monkeypatch):
    """Mutant O26: EACCES in an existing 0500 copy folder names that folder
    (round 18 tested only a state folder with no copy folder yet)."""
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    folder = settings.settings_copy_folder()
    folder.mkdir(mode=0o700)
    _hard_link(keyed)
    before = keyed.read_bytes()
    folder.chmod(0o500)
    try:
        response = _person().put("/api/settings", json={"favorites": []})
    finally:
        folder.chmod(0o700)
    assert _refusal(response) == (409, COPY_LINE.format(folder="~/.nebula/settings-copy"), "settings_unwritable")
    assert keyed.read_bytes() == before


# -- B14: a pass-through is named by its label ----------------------------------------

def test_a_pass_through_is_named_by_its_label_on_the_card_and_in_the_log():
    assert person_line.connect_line("Through") == "Connect an output to “Through”, then run the node again."
    assert person_line.input_need("Through").again[0] == (
        "needs an output connected to “Through”. Connect one, then run the node again.")
    assert person_line.connect_line("Prompt") == "Connect a prompt to this node, then run it again."


# -- GM r38 item 1: several needs, one line -------------------------------------------

def _card(definition: str, keys: dict[str, str]) -> set[str]:
    errors = validate_graph([GraphNode(id="n1", definitionId=definition, params={})], [], keys)
    return {error.person for error in errors}


@pytest.mark.parametrize("definition,keys,line", [
    # One need: its own line stands.
    ("gpt-image-2-generate", {"OPENAI_API_KEY": "sk-test-fake"}, "Connect a prompt to this node, then run it again."),
    ("flux-kontext", {"FAL_KEY": "fal-test-fake"}, "Connect a prompt and an image to this node, then run it again."),
    ("flux-fill-inpaint", {"FAL_KEY": "fal-test-fake"},
     "Connect a prompt, a base image and a mask to this node, then run it again."),
    ("claude-chat", {}, "Connect the messages and add your Anthropic API key in Settings, then run it again."),
    ("flux-kontext", {}, "Connect the prompt and the image, and add your fal.ai API key in Settings, then run it again."),
    ("flux-fill-inpaint", {}, "Connect the prompt, the base image and the mask, and add your fal.ai API key in "
                              "Settings, then run it again."),
    ("image-compare", {}, "Connect an output to “Image A” and an output to “Image B”, then run it again."),
])
def test_a_nodes_needs_are_one_card_line_ending_once(definition, keys, line):
    assert _card(definition, keys) == {line}


def test_gms_card_and_bubble_forms_word_for_word():
    assert person_line.needs_card_line(["Prompt", "Image"]) == (
        "Connect a prompt and an image to this node, then run it again.")
    assert person_line.needs_card_line(["Prompt"], "your Anthropic API key") == (
        "Connect the prompt and add your Anthropic API key in Settings, then run it again.")
    assert person_line.needs_bubble(["Prompt", "Image"]) == "needs a prompt and an image. Connect both."
    assert person_line.needs_bubble(["Prompt"], "your Anthropic API key") == (
        "needs a prompt and your Anthropic API key. Connect the prompt and add the key in Settings.")
    assert person_line.needs_bubble(["Prompt", "Base Image", "Mask (white = edit)"], "your fal.ai API key") == (
        "needs a prompt, a base image, a mask and your fal.ai API key. Connect the prompt, the base image and the "
        "mask, and add the key in Settings.")
    assert person_line.needs_card_line(["Prompt"]) is None and person_line.needs_card_line([]) is None


@pytest.fixture
def bubbles(monkeypatch):
    said: list[str] = []
    original = main.manager.broadcast_raw

    async def heard(data, **kwargs):
        if isinstance(data, dict) and data.get("type") == "agentPresence" and data.get("say"):
            said.append(str(data["say"]))
        await original(data, **kwargs)

    monkeypatch.setattr(main.manager, "broadcast_raw", heard)
    yield said


def _run(monkeypatch, nodes: list[tuple[str, dict, str | None]], headers: dict[str, str], keys: dict[str, str],
         wires: tuple[tuple[int, str, int, str], ...] = ()) -> dict:
    """A canvas of ``nodes`` (definition, params, the person's label or
    None) run as ``headers``' caller with ``keys``."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": dict(keys)})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            ids = []
            for definition, params, label in nodes:
                added = client.post("/api/graph/node", json={"definitionId": definition, "params": params},
                                    headers=PERSON)
                assert added.status_code == 200, added.text
                ids.append(added.json()["id"])
                if label:
                    renamed = client.put(f"/api/graph/node/{ids[-1]}/label", json={"label": label}, headers=PERSON)
                    assert renamed.status_code == 200, renamed.text
            for source, out, target, into in wires:
                wire = {"source": ids[source], "sourceHandle": out, "target": ids[target], "targetHandle": into}
                assert client.post("/api/graph/connect", headers=PERSON, json=wire).status_code == 200
            response = client.post("/api/graph/run", json={}, headers=headers)
        finally:
            client.delete("/api/graph?force=true")
    return response.json()


WHO = pytest.mark.parametrize("who", ["mcp", "cli", "chat"])


def _headers(who: str, chat_turn: dict[str, str]) -> dict[str, str]:
    return {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]


@WHO
@pytest.mark.parametrize("definition,label,keys,bubble", [
    # Its first sentence: what's needed. The action is on the card and in the
    # log (GM, PR #203 r39 item 5).
    ("flux-kontext", "Hero shot", {"FAL_KEY": "fal-test-fake"}, "“Hero shot” needs a prompt and an image."),
    ("claude-chat", "Hero shot", {}, "“Hero shot” needs messages and your Anthropic API key."),
    # Longer than the bubble holds (MAX_SAY_CHARS): its whole first sentence,
    # never cut inside the second; the Agent log has the line whole.
    ("flux-fill-inpaint", None, {},
     "“FLUX Fill (Inpaint)” needs a prompt, a base image, a mask and your fal.ai API key."),
    ("gpt-image-2-generate", None, {"OPENAI_API_KEY": "sk-test-fake"},
     "“GPT Image 2” needs a prompt."),
])
def test_the_bubble_says_a_nodes_needs_once_by_its_name(monkeypatch, bubbles, chat_turn, person, who, definition,
                                                        label, keys, bubble):
    body = _run(monkeypatch, [(definition, {}, label)], _headers(who, chat_turn), keys)
    assert body["status"] == "failed"
    assert bubbles == [bubble]


FLUX3_AT_1_5K = ("flux-3-image", {"_provider": "fal", "resolution": "1.5K"})


@WHO
def test_a_renamed_nodes_route_line_names_it_once_by_its_label(monkeypatch, bubbles, chat_turn, person, who):
    """GM r38 item 2: "“Hero shot” can’t run on fal.ai with “Resolution” set
    to 1.5K. …": the label when renamed, never the type's name as well."""
    keys = {"FAL_KEY": "fal-test-fake", "REPLICATE_API_TOKEN": "r8-test-fake"}
    body = _run(monkeypatch, [("text-input", {"value": "a fox"}, None), (*FLUX3_AT_1_5K, "Hero shot")],
                _headers(who, chat_turn), keys, wires=((0, "text", 1, "prompt"),))
    assert body["status"] == "failed"
    [said] = bubbles
    assert said == "“Hero shot” can’t run on fal.ai with “Resolution” set to 1.5K.", said
    assert "FLUX 3" not in said and said.count("“Hero shot”") == 1


def test_a_bubble_line_longer_than_the_bubble_keeps_whole_sentences():
    from services.agent_presence import MAX_SAY_CHARS

    short = "“Hero shot” needs a prompt and an image. Connect both."
    assert main._whole_sentences(short) == short
    long = ("“FLUX Fill (Inpaint)” needs a prompt, a base image, a mask and your fal.ai API key. Connect the prompt, "
            "the base image and the mask, and add the key in Settings.")
    assert len(long) > MAX_SAY_CHARS
    assert main._whole_sentences(long) == "“FLUX Fill (Inpaint)” needs a prompt, a base image, a mask and your fal.ai API key."
    # A size's dot and a quoted name's closing mark never end a sentence.
    route = ("“Hero shot” can’t run on fal.ai with “Resolution” set to 1.5K. Pick 1K, or switch to Black Forest Labs "
             "or Replicate. Then run the node again, and check its other settings too, please.")
    assert main._whole_sentences(route) == ("“Hero shot” can’t run on fal.ai with “Resolution” set to 1.5K. Pick 1K, or "
                                            "switch to Black Forest Labs or Replicate.")
    one = "x" * (MAX_SAY_CHARS + 10) + ". Then more."
    assert main._whole_sentences(one) == one  # left to the bubble's own cut


def test_a_line_with_no_name_of_its_own_follows_cant_run(monkeypatch):
    main.cli_graph.nodes["n-r19"] = {"definitionId": "flux-3-image", "label": "Hero shot"}
    try:
        assert main._bubble_line("n-r19", "Pick 1K.") == "“Hero shot” can’t run. Pick 1K."
        assert main._bubble_line("n-r19", "“FLUX 3 Image” can’t run on fal.ai.") == "“Hero shot” can’t run on fal.ai."
        assert main._bubble_line("n-r19", "“Hero shot” can’t run on fal.ai.") == "“Hero shot” can’t run on fal.ai."
        assert main._bubble_line("n-r19", "") == "“Hero shot” can’t run."
    finally:
        main.cli_graph.nodes.pop("n-r19", None)


# -- GM r38 item 5: the restored line, once, for the person ---------------------------

RESTORED_BECAUSE = ("Nebula restored your settings from its saved copy because the last save didn’t finish. "
                    "The file it replaced is kept at {kept}.")


def test_the_restored_line_waits_at_the_top_of_settings_until_the_person_dismisses_it(home_state, keyed,
                                                                                      monkeypatch, chat_turn):
    monkeypatch.setattr(main, "_settings_notice", None)
    _cut_copy(keyed)
    asyncio.run(main._sweep_settings_temp_files())
    [kept] = _aside(settings.settings_copy_folder())
    path = f"~/.nebula/settings-copy/{kept}"
    expected = {"kind": "restored", "line": RESTORED_BECAUSE.format(kept=path), "path": path}
    with TestClient(main.app, raise_server_exceptions=False) as client:
        monkeypatch.setattr(main, "_settings_notice", dict(expected))  # the app's own start ran the sweep again
        for agent in (MCP, CLI, chat_turn):  # agents never read it, nor dismiss it
            assert client.get("/api/settings/notice", headers=agent).status_code == 403
            assert client.post("/api/settings/notice/dismiss", headers=agent).status_code == 403
        assert client.get("/api/settings/notice", headers=PERSON).json() == {"notice": expected}
        assert client.post("/api/settings/notice/dismiss", headers=PERSON).json() == {"notice": None}
        assert client.get("/api/settings/notice", headers=PERSON).json() == {"notice": None}


def test_the_sweep_sets_the_notice_from_the_restore(home_state, keyed, monkeypatch):
    monkeypatch.setattr(main, "_settings_notice", None)
    _cut_copy(keyed)
    asyncio.run(main._sweep_settings_temp_files())
    [kept] = _aside(settings.settings_copy_folder())
    path = f"~/.nebula/settings-copy/{kept}"
    assert main._settings_notice == {"kind": "restored", "line": RESTORED_BECAUSE.format(kept=path), "path": path}
    assert "fal-kept" not in json.dumps(main._settings_notice)
