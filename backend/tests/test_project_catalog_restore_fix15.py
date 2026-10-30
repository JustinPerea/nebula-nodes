"""PR #199 fix round 15 (review 13), the backend's part.

- NIT-2 (GM's call): kept mode outlasts the person's kept tab's socket by
  KEPT_GRACE_SECONDS, so an agent's write in a network blip waits as it
  would with the tab connected. A tab that said kept:false before closing
  ends it at once; a tab back within the grace that says kept:true carries
  it on, kept:false ends it. Agents' sockets can neither extend nor end it.
- LOW-3: `nebula project new` past the limit prints the limit's fields, as
  MCP's new_project does.
- Merge-integrity LOW-2 B2: an open's change note carries `droppedPorts`
  and the agent's open says the stray-port line in the Agent log.
"""
from __future__ import annotations

import json
import sys
import time
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from cli.commands import projects as projects_cli  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON, PERSON_HELLO  # noqa: E402
from tests.test_params_version_gate import workspace  # noqa: E402,F401 - fixture
from tests.test_pr198_fix5 import PAID, WIRE, _rf_scene, _scene  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix9 import _drain  # noqa: E402
from tests.test_project_catalog_restore_fix12 import AGENT_WRITES, CODEX, _kept, _settles  # noqa: E402


# -- NIT-2: the kept grace ------------------------------------------------------------------

class _Clock:
    """A monotonic clock the test moves on."""

    def __init__(self) -> None:
        self.ahead = 0.0

    def monotonic(self) -> float:
        return time.monotonic() + self.ahead


@pytest.fixture
def clock(monkeypatch):
    """main's time module, its monotonic clock moved on by `clock.ahead`."""
    moved = _Clock()
    module = types.SimpleNamespace(**{name: getattr(time, name) for name in dir(time) if not name.startswith("_")})
    module.monotonic = moved.monotonic
    monkeypatch.setattr(main_module, "_time_module", module)
    return moved


def _person_tab(client):
    socket = client.websocket_connect("/ws", headers=PERSON)
    tab = socket.__enter__()
    tab.receive_json()
    tab.send_json(PERSON_HELLO)
    _drain(tab, "proposalSync")
    return socket, tab


def _closed(socket) -> None:
    socket.__exit__(None, None, None)
    assert _settles(lambda: not main_module.manager.kept_tabs)


def _agent_add(client):
    return AGENT_WRITES["add"](client)


def _refused_kept(response) -> bool:
    return response.status_code == 409 and response.json().get("code") == "canvas_kept_in_tab"


def _kept_canvas(client) -> None:
    _create(client, "Delta")
    _add_text(client, "delta-1")


def test_nit2_a_blip_holds_kept_mode_for_the_grace(app, clock):
    client, *_ = app
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _closed(socket)
    clock.ahead = main_module.KEPT_GRACE_SECONDS - 1
    refused = _agent_add(client)
    assert _refused_kept(refused), refused.text
    assert refused.json()["detail"] == main_module.CANVAS_KEPT_IN_TAB_DETAIL


def test_nit2_past_the_grace_the_agents_write_goes(app, clock):
    client, *_ = app
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _closed(socket)
    assert _refused_kept(_agent_add(client))
    clock.ahead = main_module.KEPT_GRACE_SECONDS + 0.5
    assert _agent_add(client).status_code == 200


def test_nit2_the_grace_is_the_module_constant(app, clock, monkeypatch):
    client, *_ = app
    monkeypatch.setattr(main_module, "KEPT_GRACE_SECONDS", 30.0)
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _closed(socket)
    clock.ahead = 20.0
    assert _refused_kept(_agent_add(client))
    clock.ahead = 31.0
    assert _agent_add(client).status_code == 200


def test_nit2_kept_false_before_closing_ends_it_at_once(app, clock):
    client, *_ = app
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _kept(tab, False)
    _closed(socket)
    assert not main_module.manager.kept_in_tab()
    assert _agent_add(client).status_code == 200


def test_nit2_a_tab_back_within_the_grace_carries_it_on(app, clock):
    client, *_ = app
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _closed(socket)
    clock.ahead = 5.0
    again, tab = _person_tab(client)
    _kept(tab, True)
    # Long past the first socket's grace: the tab that came back holds it.
    clock.ahead = 60.0
    assert _refused_kept(_agent_add(client))
    _kept(tab, False)
    assert _agent_add(client).status_code == 200
    _closed(again)


def test_nit2_a_tab_back_within_the_grace_that_says_kept_false_ends_it(app, clock):
    client, *_ = app
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _closed(socket)
    clock.ahead = 5.0
    again, tab = _person_tab(client)
    assert _refused_kept(_agent_add(client))
    tab.send_json({"type": "keptEdits", "kept": False})
    assert _settles(lambda: not main_module.manager.kept_in_tab())
    assert _agent_add(client).status_code == 200
    _closed(again)


def test_nit2_an_agents_socket_can_neither_end_nor_extend_the_grace(app, clock):
    client, *_ = app
    _kept_canvas(client)
    socket, tab = _person_tab(client)
    _kept(tab, True)
    _closed(socket)
    with client.websocket_connect("/ws", headers=CODEX) as agent_socket:
        agent_socket.receive_json()
        agent_socket.send_json({"type": "keptEdits", "kept": False})
        agent_socket.send_json(PERSON_HELLO | {"personToken": "forged"})
        agent_socket.send_json({"type": "keptEdits", "kept": False})
        time.sleep(0.2)
        assert _refused_kept(_agent_add(client))
        # Nor extend it: its kept:true near the grace's end, then the grace runs out.
        clock.ahead = main_module.KEPT_GRACE_SECONDS - 1
        agent_socket.send_json({"type": "keptEdits", "kept": True})
        time.sleep(0.2)
        clock.ahead = main_module.KEPT_GRACE_SECONDS + 0.5
        assert _agent_add(client).status_code == 200
    # An agent socket closing never starts a grace either.
    assert main_module.manager.kept_grace_until is None


# -- LOW-3: `nebula project new` past the limit ---------------------------------------------

def test_low3_the_cli_says_the_project_limit_whole(app, monkeypatch, capsys):
    client, *_ = app
    for name in ("A", "B", "C"):
        _create(client, name)
    monkeypatch.setattr(store_module, "MAX_PROJECTS", 3)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    cli = NebulaClient.__new__(NebulaClient)
    cli.base_url = "http://testserver"
    cli._client = client
    with pytest.raises(SystemExit):
        projects_cli.run_new(cli, "Fourth")
    assert capsys.readouterr().err.strip() == (
        'error: Project limit reached (413, {"limit": "projects", "projectLimit": 3})')


# -- Merge-integrity LOW-2 B2: an open's dropped ports, said ---------------------------------

def test_b2_an_agents_open_notes_its_dropped_ports_and_says_the_line(workspace, person):  # noqa: F811
    client, _graph, store, _ = workspace
    a = client.post("/api/projects", headers=PERSON, json={"name": "A"}).json()
    b = client.post("/api/projects", headers=PERSON,
                    json={"name": "B", "workspaceRevision": a["workspaceRevision"]}).json()
    with store.transaction() as catalog:
        catalog["projects"][a["project"]["id"]]["snapshot"] = {
            "nodes": [_rf_scene("n1", "Opening", _scene("s1"), {"shot_s2": {"type": "Image", "value": PAID}}),
                      _rf_scene("n2", "Next", _scene("t1"), {})],
            "edges": [WIRE], "runHistory": [], "viewport": None, "createSessionId": None}
        store.commit(catalog)
    start = main_module.canvas_events.read(after=None)["cursor"]
    main_module.manager.broadcast_raw.reset_mock()
    opened = client.post(f"/api/projects/{a['project']['id']}/open", headers=CODEX,
                         json={"workspaceRevision": b["workspaceRevision"]})
    assert opened.status_code == 200, opened.text
    line = ("Removed the connection to shot port s2 on “Opening”, node n1 while loading the project. "
            "That shot no longer exists.")
    assert opened.json()["warnings"] == [line]
    replaced = [event for event in main_module.canvas_events.read(after=start, limit=100)["events"]
                if event["kind"] == "canvas.replaced"][-1]
    assert replaced["data"]["droppedPorts"] == [
        {"nodeId": "n1", "handle": "shot_s2", "port": True, "connections": 1}]
    said = [call.args[0].get("say") for call in main_module.manager.broadcast_raw.call_args_list
            if call.args and isinstance(call.args[0], dict) and call.args[0].get("type") == "agentPresence"]
    assert line in said


# -- GM r19, 6a: whether the damaged file held project records Nebula couldn’t read --------------

from services import catalog_recovery  # noqa: E402
from tests.test_project_catalog_restore_fix1 import _add as _store_add, _records, _store  # noqa: E402


def _restored(tmp_path, damage) -> dict:
    """Alpha in the copy, Beta after it; catalog.json damaged by ``damage``
    (its bytes in, the damaged bytes out); the restore's record."""
    store = _store(tmp_path)
    _store_add(store, "Alpha")
    copy = store.path.read_bytes()
    _store_add(store, "Beta")
    store.path.write_bytes(damage(store.path.read_bytes()))
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)
    store.read()
    [record] = _records(store)
    return record


@pytest.mark.parametrize("cut", [1, 3], ids=["inside-the-top-level-object", "the-live-shape-trash-cut"])
def test_6a_a_cut_after_the_projects_group_closed_lost_no_project(tmp_path, cut):
    """The live fixture: catalog.json cut by its last 3 bytes leaves
    `…}},"trash":`. Lost Recently deleted entries aren't in the notice (GM):
    no project record was unread."""
    record = _restored(tmp_path, lambda raw: raw[:-cut])
    assert record["damagedReadWhole"] is False
    assert record["damagedRecordsUnread"] is False
    assert main_module._catalog_restore_view(record)["damagedRecordsUnread"] is False


def test_6a_trailing_garbage_after_a_whole_file_lost_no_record(tmp_path):
    record = _restored(tmp_path, lambda raw: raw + b"\x7fgarbage{")
    assert record["damagedReadWhole"] is False
    assert record["damagedRecordsUnread"] is False


def test_6a_a_cut_inside_a_record_is_unread(tmp_path):
    record = _restored(tmp_path, lambda raw: raw[:raw.index(b'"snapshot"', raw.index(b'"Beta"'))])
    assert record["damagedReadWhole"] is False
    assert record["damagedRecordsUnread"] is True


def test_6a_a_zeroed_file_is_unread(tmp_path):
    record = _restored(tmp_path, lambda raw: b"\0" * len(raw))
    assert record["damagedReadWhole"] is False
    assert record["damagedRecordsUnread"] is True


def test_6a_a_file_read_whole_has_nothing_unread(tmp_path):
    def shaped(raw: bytes) -> bytes:
        catalog = json.loads(raw)
        catalog["workspaceRevision"] = 7  # damaged, but it parses
        return json.dumps(catalog).encode("utf-8")
    record = _restored(tmp_path, shaped)
    assert record["damagedReadWhole"] is True
    assert record["damagedRecordsUnread"] is False


def test_6a_the_listing_carries_it_and_an_old_record_leaves_it_out(app):
    client, store, *_ = app
    _create(client, "Alpha")
    client.get("/api/projects", headers=PERSON)
    copy = store.path.read_bytes()
    _create(client, "Beta")
    client.get("/api/projects", headers=PERSON)
    store.path.write_bytes(store.path.read_bytes()[:-1])
    store.backup_path.write_bytes(copy)
    store.older_backup_path.unlink(missing_ok=True)
    restore = client.get("/api/projects", headers=PERSON).json()["catalogRestore"]
    assert restore["damagedReadWhole"] is False and restore["damagedRecordsUnread"] is False
    old = {key: value for key, value in _records(store)[-1].items() if key != "damagedRecordsUnread"}
    assert "damagedRecordsUnread" not in main_module._catalog_restore_view(old)


@pytest.mark.parametrize(("text", "closed"), [
    ('{"version":1,"projects":{"a":{"id":"a"}},"trash":{}}', True),
    ('{"version":1,"projects":{"a":{"id":"a"}},"trash":{}', True),
    ('{"version":1,"projects":{"a":{"id":"a"}},"trash":', True),  # the live shape: trash cut
    ('{"version":1,"projects":{"a":{"id":"a"}},"trash":{"b":{"id"', True),  # cut inside trash
    ('{"version":1,"projects":{"a":{"id":"a"}}\x00\x00\x00,"trash":{}}', True),  # zeroed after projects
    ('{"version":1,"projects":{"a":{"id":"a"}},"trash":{}}\x00\x00junk', True),
    ('{"version":1,"projects":{"a":{"id":"a"}', False),  # cut inside projects
    ('{"version":1,"projects":{"a":{"id":"a"}},"tr', True),
    ('{"version":1,"projects":{"a":{"id":"a', False),  # cut inside a record
    ('{"version":1,"trash":{},"projects":{"a":{"id":"a"}', False),  # trash first, projects cut
    ('{"version":1,"trash":{},"projects":{}}', True),  # trash first, both whole
    ('{"version":1,"pro\x00ects":{"a":{"id":"a"}},"trash":{}}', False),  # the group key damaged
    ('{"version":1,"projectz":{"a":{"id":"a"}},"trash":{}}', False),  # the group key never seen
    ('{"version":1,"trash":{}}', False),  # no projects group
    ('{"version":1,"projects":5,"trash":{}}', False),  # not a group
    ('{"version":1,"x":{"projects":{}},"trash":{}}', False),  # not at depth 1
    ('{"version":1,"projects":{"a":{"id":"}"}},"trash":{}}', True),  # brackets in strings
    ('{"version":1,"projects":{"a":{"id":"a\\"}"}},"trash":{}}', True),  # an escaped quote
    ('{"version":1,"projects":{"a":{"id":"a\x00"}},"trash":{}}', False),  # a zero inside a record
    ('{"version":1,"projects":{"a":{"id":"a"} \x01 }},"trash":{}}', False),  # junk inside projects
    ("\x00" * 40, False),
    ("garbage", False),
    ("", False),
    ('[{"projects":{}},{"trash":{}}]', False),
])
def test_6a_the_tracker_says_closed_only_when_the_projects_group_closed_before_the_damage(text, closed):
    assert catalog_recovery._projects_closed_before_damage(text) is closed


def test_6a_a_failed_project_record_is_unread_and_a_failed_trash_record_isnt():
    raw = b'{"version":1,"projects":{"a":{"id":"a"}},"trash":{"b":'
    found = catalog_recovery.Salvage()
    assert catalog_recovery.records_unread(raw, found, read_whole=False) is False
    found.failed["b" * 32], found.groups["b" * 32] = "incomplete", "trash"
    assert catalog_recovery.records_unread(raw, found, read_whole=False) is False
    found.failed["c" * 32], found.groups["c" * 32] = "invalid", "projects"
    assert catalog_recovery.records_unread(raw, found, read_whole=False) is True
    assert catalog_recovery.records_unread(raw, found, read_whole=True) is False
    del found.failed["c" * 32], found.groups["c" * 32]
    found.failed["d" * 32] = "invalid"  # its group can't be told
    assert catalog_recovery.records_unread(raw, found, read_whole=False) is True
    assert catalog_recovery.records_unread(None, None, read_whole=False) is True


@pytest.mark.parametrize("unread", [False, True, None])
def test_6a_agents_say_may_be_missing_only_when_project_records_were_unread(unread):
    from cli.formatter import catalog_restore_lines

    record = {"kind": "restored", "reason": "corrupt", "source": "catalog.json.bak", "damagedReadWhole": False}
    if unread is not None:
        record["damagedRecordsUnread"] = unread
    note = main_module._catalog_restore_note(record)
    cli_lines = "\n".join(catalog_restore_lines(record))
    if unread is False:
        assert "no project is missing" in note and "may be missing" not in note
        assert "no project is missing" in cli_lines and "may be missing" not in cli_lines
    else:  # unread, or an older record without the field
        assert "may be missing" in note and "no project is missing" not in note
        assert "may be missing" in cli_lines
