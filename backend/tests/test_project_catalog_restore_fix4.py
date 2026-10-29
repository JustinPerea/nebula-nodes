"""PR #199 review 4: what fix round 4 makes true (2026-10-27).

- M-2. No single bit flip of any structural byte (a record's opening ``{``
  included) silently reverts a project: a record whose opener broke is
  found by its key and its own ``"id"``.
- M-3. The base copy never trusts a date from the future: ``.bak`` wins
  unless ``.bak.1`` holds later dates that aren't ahead of the clock, and a
  whole record never loses to a copy's on a future date.
- L-2. An older, damaged catalog.json never brings back a project deleted
  for good after it.
- L-3. A delete for good as the last commit survives a zeroed catalog.json
  (catalog-purged.json).
- L-4. A broken ``"deletedAt"`` key never says "in Recently deleted again".
- L-5. Two flips never add a phantom project (review 4's 1,500 set).
- L-1. Restoring past the project limit is refused with the limit's 413
  and its number; allowing it is one switch.
- Nits: a damaged or missing canvas-waiting.json keeps ``since`` and the
  one event; start_here says when there is room; needs_reading() and
  projection() see an in-place rewrite.
- GM r6: no agent text says the waiting canvas is open or reachable.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from cli.formatter import format_start  # noqa: E402
from services import catalog_recovery  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.project_store import ProjectStore, make_project, move_to_trash  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, _rev, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _journal_kinds, _restart, _unfiled_at_the_limit  # noqa: E402

AGENT = {**PERSON, "X-Nebula-Agent": "Probe"}


def _record(store: ProjectStore) -> dict:
    return json.loads(store.record_path.read_text())["restores"][-1]


def _names(catalog: dict) -> dict:
    return {"projects": sorted(p["name"] for p in catalog["projects"].values()),
            "trash": sorted(p["name"] for p in (catalog.get("trash") or {}).values())}


@pytest.fixture
def quick_disk(monkeypatch):
    """The sweeps restore thousands of times: fsync costs nothing to what they check."""
    monkeypatch.setattr(store_module.os, "fsync", lambda fd: None)


# -- review 4's fuzz base -------------------------------------------------------------

SHADOW, SHADOW2, FAKE = "5" * 32, "6" * 32, "7" * 32


def _fuzz_base(tmp_path: Path):
    """Review 4's base (test_r4_fuzz): Logo renamed "Logo v2" after the copy,
    Old in Recently deleted, a name holding record-shaped text, a project's
    params holding a whole project, and a record-shaped object one level
    under Hero's record."""
    store = ProjectStore(tmp_path / "base")
    with store.transaction() as catalog:
        logo, hero, dunes, old = (make_project(name) for name in ("Logo", "Hero", "Dunes", "Old"))
        weird = make_project(f'{{"id":"{FAKE}","name":"Fake","createdAt":"2026-10-27T00:00:00+00:00"}}')
        for project in (logo, hero, weird, dunes, old):
            catalog["projects"][project["id"]] = project
        shadow = make_project("Shadow")
        shadow["id"] = SHADOW
        shadow2 = {"id": SHADOW2, "name": "Shadow2", "createdAt": "2026-10-27T00:00:00+00:00", "x": 1}
        dunes["snapshot"]["nodes"] = [
            {"id": "n1", "data": {"params": {"refs": {hero["id"]: {"url": "/x.png"}}, "embedded": shadow,
                                             "list": [shadow2]}}},
        ]
        hero["extra"] = {"copy": {**make_project("Shadow3"), "id": uuid4().hex}}
        catalog["activeProjectId"] = logo["id"]
        store.commit(catalog)
    with store.transaction() as catalog:
        move_to_trash(catalog, old["id"])
        store.commit(catalog)
    time.sleep(0.002)
    with store.transaction() as catalog:
        catalog["projects"][logo["id"]]["name"] = "Logo v2"
        catalog["projects"][logo["id"]]["updatedAt"] = store_module.now()
        store.commit(catalog)
    return store, {"logo": logo["id"], "hero": hero["id"], "dunes": dunes["id"], "old": old["id"], "weird": weird["id"]}


def _restore_with(base: ProjectStore, root: Path, damaged: bytes):
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for name in (store_module.BACKUP_NAME, store_module.OLDER_BACKUP_NAME):
        if (base.root / name).exists():
            shutil.copy2(base.root / name, root / name)
    (root / "catalog.json").write_bytes(damaged)
    store = ProjectStore(root)
    try:
        return store, store.read(), None
    except Exception as exc:  # noqa: BLE001 - the verdict says it
        return store, None, exc


def _verdict(store, catalog, ids, error) -> str:
    """Review 4's verdict: ok / no-restore, or every way it went wrong."""
    if catalog is None:
        return f"REFUSED:{type(error).__name__}"
    restore = store.restore_notice()
    held = set(catalog["projects"]) | set(catalog.get("trash") or {})
    if restore is None:
        return "no-restore" if held == set(ids.values()) else "IDS-DIFFER-NO-RESTORE"
    problems = []
    if held - set(ids.values()):
        problems.append("WRONG-ID")
    for key in ("logo", "hero", "dunes", "weird"):
        if ids[key] not in catalog["projects"]:
            problems.append(f"{key}-NOT-IN-LIST")
    if ids["old"] not in (catalog.get("trash") or {}):
        problems.append("old-NOT-IN-TRASH")
    said = {row["id"] for row in [*restore["reverted"], *restore["notAddedBack"]]}
    logo = catalog["projects"].get(ids["logo"])
    if logo is not None and logo["name"] != "Logo v2" and ids["logo"] not in said:
        problems.append("SILENT-REVERT")
    for key in ("cameBack", "backInTrash", "keptDeleted", "addedBack"):
        if restore.get(key):
            problems.append(f"FALSE-{key}")
    names = {p.get("name") for p in catalog["projects"].values()}
    if names & {"Shadow", "Shadow2", "Shadow3", "Fake"}:
        problems.append("PHANTOM-NAME")
    return ";".join(problems) or "ok"


def _flip(raw: bytes, at: int, bit: int) -> bytes:
    return raw[:at] + bytes([raw[at] ^ (1 << bit)]) + raw[at + 1:]


def _structural(raw: bytes) -> list[int]:
    """Every structural byte of a compact catalog: braces, brackets, colons
    and commas outside strings, and the quotes that open and close strings."""
    positions: list[int] = []
    inside = escaped = False
    for at, byte in enumerate(raw):
        char = chr(byte)
        if inside:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                inside = False
                positions.append(at)
        elif char == '"':
            inside = True
            positions.append(at)
        elif char in "{}[]:,":
            positions.append(at)
    return positions


# -- M-2: a record's opening brace ----------------------------------------------------


@pytest.mark.parametrize("bit", range(8))
def test_m2_a_flip_of_a_records_opening_brace_keeps_its_newest_version(tmp_path, bit):
    """Review 4's M-2: 8 of 8 flips of Logo's `{` reverted it to "Logo"."""
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    brace = raw.index(f'"{ids["logo"]}":{{'.encode()) + 35
    assert raw[brace:brace + 1] == b"{"
    store, catalog, error = _restore_with(base, tmp_path / "t", _flip(raw, brace, bit))
    assert error is None
    assert catalog["projects"][ids["logo"]]["name"] == "Logo v2"
    assert _verdict(store, catalog, ids, error) == "ok"


def test_m2_a_flipped_opener_in_recently_deleted_keeps_it_there(tmp_path):
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    brace = raw.index(f'"{ids["old"]}":{{'.encode()) + 35
    for bit in range(8):
        store, catalog, error = _restore_with(base, tmp_path / "t", _flip(raw, brace, bit))
        assert _verdict(store, catalog, ids, error) == "ok", bit
        assert ids["old"] in catalog["trash"]


def test_m2_every_bit_of_every_structural_byte_never_reverts_silently(tmp_path, quick_disk):
    """The full 8-bit sweep of every structural byte of review 4's base."""
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    positions = _structural(raw)
    assert len(positions) > 300
    bad: dict[str, list[str]] = {}
    for at in positions:
        for bit in range(8):
            store, catalog, error = _restore_with(base, tmp_path / "t", _flip(raw, at, bit))
            verdict = _verdict(store, catalog, ids, error)
            if verdict not in ("ok", "no-restore"):
                bad.setdefault(verdict, []).append(f"@{at} {raw[at:at + 1]!r} bit{bit} ctx {raw[max(0, at - 12):at + 12]!r}")
    assert bad == {}, {verdict: (len(cases), cases[:4]) for verdict, cases in bad.items()}


# -- L-5: two flips never add a phantom -----------------------------------------------


def test_l5_the_reviews_1500_two_flip_set_adds_no_phantom_and_no_wrong_id(tmp_path, quick_disk):
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    rng = random.Random(4403)
    bad: dict[str, list[str]] = {}
    for _ in range(1500):
        a, b = rng.randrange(len(raw)), rng.randrange(len(raw))
        damaged = _flip(_flip(raw, a, rng.randrange(8)), b, rng.randrange(8))
        store, catalog, error = _restore_with(base, tmp_path / "t", damaged)
        verdict = _verdict(store, catalog, ids, error)
        if any(word in verdict for word in ("PHANTOM", "WRONG-ID", "FALSE-", "NOT-IN")):
            bad.setdefault(verdict, []).append(f"@{a} @{b}")
    assert bad == {}, bad


def test_l5_a_broken_quote_after_a_nested_record_shaped_object_never_counts_it(tmp_path):
    """Review 4's case @613/@2193: a flip right after Hero's id stops its
    read before Shadow3 (a whole record-shaped object in Hero's `extra`), and
    a broken quote in Dunes after it hides every brace that closes it."""
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    first = raw.index(f'"id":"{ids["hero"]}",'.encode()) + 39
    assert raw[first:first + 1] == b","
    second = raw.index(f'"{ids["hero"]}":{{"url"'.encode()) + 33
    assert raw[second:second + 1] == b'"'
    damaged = _flip(_flip(raw, first, 0), second, 6)
    assert damaged[first:first + 1] == b"-" and damaged[second:second + 1] == b"b"
    found = catalog_recovery.salvage(damaged)
    assert not any(entry.get("name") == "Shadow3" for _key, _own, entry, _group in found.misfiled)
    assert "Shadow3" not in [entry.get("name") for entry in found.entries.values()]
    store, catalog, error = _restore_with(base, tmp_path / "t", damaged)
    assert "PHANTOM" not in _verdict(store, catalog, ids, error)


def test_l5_a_record_whose_key_and_id_both_changed_is_never_a_new_project(tmp_path):
    """Fix round 4's run of the 1,500 set (@2896/@2846): a flip in Old's key
    (a hex digit to "i") and another in its own id (a hex digit to another)
    filed Old under the changed id as a project added back."""
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    key = raw.index(f'"{ids["old"]}":{{"id"'.encode()) + 1
    own = raw.index(f'"id":"{ids["old"]}"'.encode(), key) + 6
    damaged = bytearray(raw)
    damaged[key + 8] = ord("i")  # no longer hex: the key scan can't read it
    damaged[own + 31] = ord("2" if chr(raw[own + 31]) != "2" else "3")
    store, catalog, error = _restore_with(base, tmp_path / "t", bytes(damaged))
    assert _verdict(store, catalog, ids, error) == "ok"
    assert ids["old"] in catalog["trash"]


def test_torn_page_after_a_whole_record_never_makes_it_look_nested():
    """Fix round 4's run: a torn record's leftover text after a whole record
    read as broken, so with a torn record before it too, neither count could
    be read and the whole record was dropped."""
    text = ('{"version":1,"projects":{"' + "a" * 32 + '":{"id":"' + "a" * 32 + '","snapshot":{' + "\0" * 16
            + '"x":1}},"' + "b" * 32 + '":{"id":"' + "b" * 32 + '","n":{}},"' + "c" * 32 + '":{"id":"' + "c" * 32
            + '","snapshot":{' + "\0" * 16 + 'y":[]}}}}')
    assert catalog_recovery._at_record_place(text, text.index('{"id":"' + "b" * 32), [text.index('"' + "a" * 32)])


# -- L-4: a broken "deletedAt" key ----------------------------------------------------


def test_l4_a_broken_deleted_at_key_never_says_in_recently_deleted_again(tmp_path):
    base, ids = _fuzz_base(tmp_path)
    raw = base.path.read_bytes()
    start = raw.index(f'"{ids["old"]}":{{'.encode())
    key = raw.index(b'"deletedAt"', start)
    bad = {}
    for at in range(key, key + len(b'"deletedAt"')):
        for bit in range(8):
            store, catalog, error = _restore_with(base, tmp_path / "t", _flip(raw, at, bit))
            verdict = _verdict(store, catalog, ids, error)
            if verdict not in ("ok", "no-restore"):
                bad[(at - key, bit)] = verdict
    assert bad == {}


def test_l4_a_trash_record_without_deleted_at_is_damaged_not_restored():
    alpha = make_project("Old")
    alpha["deletedAt"] = store_module.now()
    entry = {key: value for key, value in alpha.items() if key != "deletedAt"}
    entry["deletedQt"] = alpha["deletedAt"]
    whole = {"version": 1, "activeProjectId": None, "workspaceRevision": "r", "projects": {},
             "trash": {alpha["id"]: entry}}
    found = catalog_recovery.salvage(json.dumps(whole).encode(), whole)
    assert alpha["id"] not in found.entries
    assert found.failed[alpha["id"]] == "invalid" and found.groups[alpha["id"]] == "trash"


# -- M-3: a clock that ran ahead never chooses the base --------------------------------


def _skewed_older_copy(tmp_path: Path, monkeypatch):
    """Review 4's a3: .bak.1 written while the clock was 3 h ahead, the clock
    corrected, Alpha and Beta edited again and Gamma made (all in .bak)."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as c:
        a, b = make_project("Alpha"), make_project("Beta")
        c["projects"][a["id"]] = a
        c["projects"][b["id"]] = b
        store.commit(c)
    real_now = store_module.now
    monkeypatch.setattr(store_module, "now", lambda: (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat())
    old = time.time() - 7200
    os.utime(store.older_backup_path, (old, old))  # so this commit rewrites .bak.1
    with store.transaction() as c:
        c["projects"][a["id"]]["name"] = "Alpha (edited while ahead)"
        store_module.refresh_metadata(c["projects"][a["id"]])
        store.commit(c)
    monkeypatch.setattr(store_module, "now", real_now)
    with store.transaction() as c:
        c["projects"][a["id"]]["name"] = "Alpha final"
        store_module.refresh_metadata(c["projects"][a["id"]])
        c["projects"][b["id"]]["name"] = "Beta final"
        store_module.refresh_metadata(c["projects"][b["id"]])
        store.commit(c)
    with store.transaction() as c:
        g = make_project("Gamma (new)")
        c["projects"][g["id"]] = g
        store.commit(c)
    with store.transaction() as c:  # one more, so .bak holds Gamma
        store_module.refresh_metadata(c["projects"][g["id"]])
        store.commit(c)
    bak = json.loads(store.backup_path.read_text())
    bak1 = json.loads(store.older_backup_path.read_text())
    assert "Gamma (new)" in _names(bak)["projects"]
    assert "Alpha (edited while ahead)" in _names(bak1)["projects"]
    return store, {"alpha": a["id"], "beta": b["id"], "gamma": g["id"]}


def test_m3_a_zeroed_catalog_restores_bak_not_the_older_copy_from_the_future(tmp_path, monkeypatch):
    store, ids = _skewed_older_copy(tmp_path, monkeypatch)
    size = store.path.stat().st_size
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * size)
    fresh = ProjectStore(store.root)
    catalog = fresh.read()
    assert _record(fresh)["source"] == store_module.BACKUP_NAME
    assert _names(catalog)["projects"] == ["Alpha final", "Beta final", "Gamma (new)"]


def test_m3_a_torn_catalog_keeps_its_newest_records(tmp_path, monkeypatch):
    store, ids = _skewed_older_copy(tmp_path, monkeypatch)
    store.path.write_bytes(store.path.read_bytes()[:-2])
    fresh = ProjectStore(store.root)
    catalog = fresh.read()
    assert _record(fresh)["source"] == store_module.BACKUP_NAME
    assert catalog["projects"][ids["alpha"]]["name"] == "Alpha final"
    assert ids["gamma"] in catalog["projects"]


def test_m3_the_bak_only_project_survives_the_next_two_commits(tmp_path, monkeypatch):
    """Review 4's a3c: the next commit after the restore replaced .bak, and
    Gamma, whole in a valid copy, was gone from every file."""
    store, ids = _skewed_older_copy(tmp_path, monkeypatch)
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)
    fresh = ProjectStore(store.root)
    fresh.read()
    for _ in range(2):
        with fresh.transaction() as c:
            fresh.commit(c)
    assert ids["gamma"] in json.loads(fresh.path.read_text())["projects"]


def test_m3_a_future_dated_copy_record_never_beats_a_whole_one(monkeypatch):
    """reconcile's newer(): a copy record whose only later date is ahead of
    the clock doesn't win over the damaged file's whole record."""
    now = datetime.now(timezone.utc)
    copy_record = make_project("Alpha (edited while ahead)")
    copy_record["updatedAt"] = copy_record["lastOpenedAt"] = (now + timedelta(hours=3)).isoformat()
    whole = {**copy_record, "name": "Alpha final", "updatedAt": now.isoformat(), "lastOpenedAt": now.isoformat()}
    base = {"version": 1, "activeProjectId": None, "workspaceRevision": "r",
            "projects": {copy_record["id"]: copy_record}, "trash": {}}
    found = catalog_recovery.Salvage()
    found.take(whole["id"], whole)
    merged = catalog_recovery.reconcile(base, [found], max_projects=500, room_bytes=10**9, until=now)
    assert merged.catalog["projects"][whole["id"]]["name"] == "Alpha final"


def test_m3_bak_wins_a_tie_and_an_older_copy_with_truly_later_dates_still_wins(tmp_path):
    """.bak is preferred; .bak.1 is chosen only for later dates that aren't
    in the future (a .bak a sync tool rolled back)."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as c:
        a = make_project("Alpha")
        c["projects"][a["id"]] = a
        store.commit(c)
    with store.transaction() as c:
        c["projects"][a["id"]]["name"] = "Alpha 2"
        store_module.refresh_metadata(c["projects"][a["id"]])
        store.commit(c)
    # .bak.1 holds a later (past) edit than .bak: a .bak put back by hand.
    newer = json.loads(store.path.read_text())
    newer["projects"][a["id"]]["name"] = "Alpha newest"
    newer["projects"][a["id"]]["updatedAt"] = store_module.now()
    store.older_backup_path.write_text(json.dumps(newer, separators=(",", ":")))
    store.path.write_bytes(b"\0" * 64)
    fresh = ProjectStore(store.root)
    assert fresh.read()["projects"][a["id"]]["name"] == "Alpha newest"
    assert _record(fresh)["source"] == store_module.OLDER_BACKUP_NAME


# -- L-2 and L-3: deleted for good stays deleted ---------------------------------------


def test_l2_an_older_damaged_catalog_never_brings_back_a_project_deleted_for_good(tmp_path):
    """Review 4's a1: catalog.json rolled back to a file from before the
    delete for good (a sync tool), and torn; .bak holds the tombstone."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as c:
        alpha, x = make_project("Alpha"), make_project("Xgone")
        c["projects"][alpha["id"]] = alpha
        c["projects"][x["id"]] = x
        store.commit(c)
    with store.transaction() as c:
        move_to_trash(c, x["id"])
        store.commit(c)
    old = store.path.read_bytes()  # X in Recently deleted
    time.sleep(0.01)
    with store.transaction() as c:
        del c["trash"][x["id"]]
        store.commit(c)
    with store.transaction() as c:
        c["projects"][alpha["id"]]["name"] = "Alpha 2"
        c["projects"][alpha["id"]]["updatedAt"] = store_module.now()
        store.commit(c)
    assert x["id"] in json.loads(store.backup_path.read_text()).get("purged", {})
    os.replace(store.path, store.path.with_suffix(".gone"))
    store.path.write_bytes(old[:-2])
    fresh = ProjectStore(store.root)
    catalog = fresh.read()
    assert x["id"] not in catalog["projects"] and x["id"] not in catalog["trash"]
    record = _record(fresh)
    assert not record["addedBack"]
    assert [row["id"] for row in record["keptDeleted"]] == [x["id"]]


def test_l3_a_delete_for_good_as_the_last_commit_survives_a_zeroed_catalog(tmp_path):
    """Review 4's a2: .bak is one commit behind; the tombstone was only in
    catalog.json's head. It is in catalog-purged.json too now."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as c:
        a, x = make_project("Alpha"), make_project("Xgone")
        c["projects"][a["id"]] = a
        c["projects"][x["id"]] = x
        store.commit(c)
    with store.transaction() as c:
        move_to_trash(c, x["id"])
        store.commit(c)
    with store.transaction() as c:
        del c["trash"][x["id"]]
        store.commit(c)
    assert x["id"] in json.loads((store.root / store_module.PURGED_NAME).read_text())["purged"]
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)
    fresh = ProjectStore(store.root)
    catalog = fresh.read()
    assert x["id"] not in catalog["trash"] and x["id"] not in catalog["projects"]
    assert [row["id"] for row in _record(fresh)["keptDeleted"]] == [x["id"]]


def test_l3_a_project_made_again_after_its_delete_for_good_is_never_dropped_by_the_side_file(tmp_path):
    """The same id made again (a retried recovery) takes its tombstone out of
    catalog-purged.json too, so a restore keeps it."""
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as c:
        x = make_project("Xgone")
        c["projects"][x["id"]] = x
        store.commit(c)
    with store.transaction() as c:
        move_to_trash(c, x["id"])
        store.commit(c)
    with store.transaction() as c:
        del c["trash"][x["id"]]
        store.commit(c)
    with store.transaction() as c:
        again = make_project("Xgone (recovered)")
        again["id"] = x["id"]
        c["projects"][x["id"]] = again
        store.commit(c)
    with store.transaction() as c:  # so .bak holds it
        store_module.refresh_metadata(c["projects"][x["id"]])
        store.commit(c)
    side_path = store.root / store_module.PURGED_NAME
    side = json.loads(side_path.read_text()) if side_path.exists() else {"purged": {}}
    assert x["id"] not in side["purged"]
    with open(store.path, "r+b") as handle:
        handle.write(b"\0" * store.path.stat().st_size)
    fresh = ProjectStore(store.root)
    assert x["id"] in fresh.read()["projects"]


def test_l3_a_damaged_side_file_is_ignored(tmp_path):
    store = ProjectStore(tmp_path / "p")
    with store.transaction() as c:
        a = make_project("Alpha")
        c["projects"][a["id"]] = a
        store.commit(c)
    with store.transaction() as c:
        store_module.refresh_metadata(c["projects"][a["id"]])
        store.commit(c)
    (store.root / store_module.PURGED_NAME).write_bytes(b"\0{not json")
    store.path.write_bytes(store.path.read_bytes()[:-1])
    fresh = ProjectStore(store.root)
    assert a["id"] in fresh.read()["projects"]


# -- L-1 / GM bug 3: restoring past the project limit ----------------------------------
# Justin, 2026-10-29 (fix round 12): Undo of a delete may go over the limit
# when the recovered canvas took the freed slot. RESTORE_MAY_PASS_THE_PROJECT_LIMIT
# is on, so this is the default path; no switch is flipped here.


def _undo_past_the_limit(client, store, graph, state, monkeypatch) -> list[str]:
    """At the limit (3) with the live canvas waiting: delete a project, the
    canvas takes the freed slot, then Undo it. Returns the ids."""
    ids = _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["projectLimit"] == 3
    client.request("DELETE", f"/api/projects/{ids[0]}", headers=PERSON, json={"workspaceRevision": _rev(client)})
    after = client.get("/api/projects", headers=PERSON).json()
    assert after["canvasSaved"]["name"] == "Recovered canvas"
    assert len(after["projects"]) == 3
    undo = client.post(f"/api/projects/{ids[0]}/restore", headers=PERSON)
    assert undo.status_code == 200, undo.text
    return ids


def test_l1_undo_after_the_canvas_took_the_slot_passes_the_limit(app, monkeypatch):
    assert store_module.RESTORE_MAY_PASS_THE_PROJECT_LIMIT is True
    client, store, graph, state = app
    ids = _undo_past_the_limit(client, store, graph, state, monkeypatch)
    listing = client.get("/api/projects", headers=PERSON).json()
    assert len(listing["projects"]) == 4
    assert ids[0] in [project["id"] for project in listing["projects"]]
    assert ids[0] not in [entry["id"] for entry in listing["trash"]]
    # The listing no longer carries a restore verdict.
    assert "restoreRoom" not in listing and "restoreMayPassTheProjectLimit" not in listing
    _add_text(client, "after the restore")  # the open project still saves
    # It survives a restart: the list past the limit reads back.
    _restart(monkeypatch, state, store)
    assert len(client.get("/api/projects", headers=PERSON).json()["projects"]) == 4


def test_l1_over_the_limit_after_undo_the_next_create_is_refused_with_the_limit_line(app, monkeypatch):
    """Over the limit after such an Undo is like any other list over it: a
    new project is still refused (413, the existing limit body), nothing
    changes."""
    client, store, graph, state = app
    _undo_past_the_limit(client, store, graph, state, monkeypatch)
    before = client.get("/api/projects", headers=PERSON).json()
    created = client.post("/api/projects", json={"name": "New", "workspaceRevision": _rev(client)}, headers=PERSON)
    assert created.status_code == 413
    assert created.json() == {"detail": "Project limit reached", "limit": "projects", "projectLimit": 3}
    after = client.get("/api/projects", headers=PERSON).json()
    assert [project["id"] for project in after["projects"]] == [project["id"] for project in before["projects"]]


# -- nits: the waiting record, start_here, in-place rewrites ---------------------------


@pytest.mark.parametrize("damage", [None, b"\x00{not json", b"[1,2]",
                                    b'{"reason":"projects","since":5,"journaled":"yes","from":["x"]}'],
                         ids=["missing", "garbage", "a list", "wrong types"])
def test_nit1_a_damaged_or_missing_waiting_record_keeps_since_and_the_one_event(app, monkeypatch, damage):
    client, store, graph, state = app
    kinds = _journal_kinds(monkeypatch)
    _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    first = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    path = store.root / store_module.CANVAS_WAITING_NAME
    if damage is None:
        path.unlink()
    else:
        path.write_bytes(damage)
    _restart(monkeypatch, state, store)
    again = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert again["since"] == first["since"]
    assert isinstance(again["since"], str)
    assert kinds.count("project.canvasNotFiled") == 1


def test_nit1_the_wait_journals_its_since(app, monkeypatch):
    """The one `project.canvasNotFiled` event carries `since`, as the
    listing does, so a watcher has it without a listing."""
    client, store, graph, state = app
    seen: list[dict] = []
    real = main_module._journal

    def capture(kind, **kwargs):
        if kind == "project.canvasNotFiled":
            seen.append(kwargs.get("data") or {})
        return real(kind, **kwargs)

    monkeypatch.setattr(main_module, "_journal", capture)
    _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    first = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    assert [data.get("since") for data in seen] == [first["since"]]


def test_nit2_start_here_says_when_room_has_freed(app, monkeypatch):
    """Review 4's b2b: after an agent's delete with no listing, start_here
    still said opening was refused (413) until then; the open succeeded."""
    client, store, graph, state = app
    ids = _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    revision = client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    deleted = client.request("DELETE", f"/api/projects/{ids[1]}", headers=AGENT, json={"workspaceRevision": revision})
    assert deleted.status_code == 200
    start = client.get("/api/agent/start", headers=AGENT).json()
    waiting = start["canvasNotFiled"]
    assert waiting["roomNow"] is True
    assert "refused (413)" not in waiting["note"]
    assert "room now" in waiting["note"]


def test_nit3_needs_reading_and_projection_see_an_in_place_rewrite(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        a = make_project("Alpha")
        catalog["projects"][a["id"]] = a
        catalog["activeProjectId"] = a["id"]
        store.commit(catalog)
    view = store.projection()
    assert view.project_id == a["id"] and not store.needs_reading()
    raw = store.path.read_bytes()
    info = store.path.stat()
    changed = raw.replace(view.revision.encode(), b"f" * len(view.revision))
    assert len(changed) == len(raw) and changed != raw
    with open(store.path, "r+b") as handle:  # rewritten in place, its time put back
        handle.write(changed)
    os.utime(store.path, ns=(info.st_atime_ns, info.st_mtime_ns))
    assert store.path.stat().st_mtime_ns == info.st_mtime_ns and store.path.stat().st_ino == info.st_ino
    assert store.needs_reading()
    assert store.projection().revision == "f" * len(view.revision)


# -- GM r6: the waiting canvas isn't open or reachable ---------------------------------


def test_gm_no_agent_text_says_the_waiting_canvas_is_open(app, monkeypatch):
    client, store, graph, state = app
    _unfiled_at_the_limit(client, store, graph, state, monkeypatch, "e" * 32)
    waiting = client.get("/api/projects", headers=PERSON).json()["canvasNotFiled"]
    start = client.get("/api/agent/start", headers=AGENT).json()
    texts = [waiting["note"], start["canvasNotFiled"]["note"], format_start(start),
             main_module._catalog_restore_note({"canvasNotFiled": {"reason": "projects"}, "kind": "restored"})]
    for text in texts:
        lowered = text.lower()
        assert "stays the live canvas" not in lowered and "stays open" not in lowered, text
    assert "Nothing in it is lost" in waiting["note"]
    assert "can't see" in waiting["note"]


def test_agents_get_the_limit_and_room_now_from_the_listing():
    """MCP list_projects passes the listing's projectLimit and roomNow on, and
    `nebula context` says "room now" instead of the limit once room is free."""
    import project_client

    class _Api:
        def request(self, method, path, **_kwargs):
            return {"projects": [], "activeProjectId": None, "projectLimit": 500,
                    "canvasNotFiled": {"reason": "projects", "roomNow": True, "note": "n"}}

    reply = project_client.list_projects(_Api())
    assert reply["projectLimit"] == 500 and reply["canvasNotFiled"]["roomNow"] is True
    text = format_start({"canvasNotFiled": {"reason": "projects", "roomNow": True, "note": "n"}})
    assert "CANVAS NOT SAVED AS A PROJECT (room now): n" in text
