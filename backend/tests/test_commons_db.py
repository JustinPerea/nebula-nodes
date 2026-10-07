from __future__ import annotations

import re
import sqlite3
import subprocess
import sys
import threading

import pytest

from commons import ids
from commons import db as db_module
from commons.db import DDL, SCHEMA_VERSION, CommonsDB


def test_new_id_is_prefixed_sortable_and_unique():
    a = ids.new_id("ast")
    b = ids.new_id("ast")
    assert re.fullmatch(r"ast_[0-9a-hjkmnp-tv-z]{26}", a)
    assert a != b
    early = ids.new_id("ast", now_ms=1_000, rand=b"\x00" * 10)
    late = ids.new_id("ast", now_ms=2_000, rand=b"\x00" * 10)
    assert early < late


def test_schema_created_in_wal_with_fts5(tmp_path):
    db = CommonsDB(tmp_path / "commons.db")
    with db.read() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table')")}
        version = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    for name in (
        "assets", "collections", "memberships", "sightings", "device_state", "folder_links",
        "analyses", "corrections", "regions", "comments", "borrowings", "quarantine",
        "commons_events", "meter", "settings", "vocab_candidates", "search_fts",
    ):
        assert name in tables, name
    assert version == str(SCHEMA_VERSION)


def test_reopen_is_idempotent(tmp_path):
    CommonsDB(tmp_path / "c.db").close()
    CommonsDB(tmp_path / "c.db").close()


def test_tx_rolls_back_on_error(tmp_path):
    db = CommonsDB(tmp_path / "c.db")
    try:
        with db.tx() as conn:
            conn.execute("INSERT INTO settings(key, value) VALUES ('x', '1')")
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    with db.read() as conn:
        assert conn.execute("SELECT count(*) FROM settings").fetchone()[0] == 0


def test_tx_is_safe_across_threads(tmp_path):
    db = CommonsDB(tmp_path / "c.db")

    def write(i: int) -> None:
        with db.tx() as conn:
            conn.execute("INSERT INTO settings(key, value) VALUES (?, ?)", (f"k{i}", str(i)))

    threads = [threading.Thread(target=write, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    with db.read() as conn:
        assert conn.execute("SELECT count(*) FROM settings").fetchone()[0] == 20


def test_check_constraints_reject_bad_states(tmp_path):
    db = CommonsDB(tmp_path / "c.db")
    try:
        with db.tx() as conn:
            conn.execute(
                "INSERT INTO collections(id, name, kind, created_at) VALUES ('col_x', 'x', 'inbox', 'now')"
            )
        raise AssertionError("kind 'inbox' must be rejected (decision 3)")
    except sqlite3.IntegrityError:
        pass


@pytest.mark.parametrize("version", ["99", "5", "0", "-1", "", "no", "4.0", "04", " 4 ", b"4"])
def test_rejects_unsupported_version_before_changing_existing_database(tmp_path, monkeypatch, version):
    path = tmp_path / "existing.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("INSERT INTO meta VALUES ('schema_version', ?)", (version,))
        conn.execute("CREATE TABLE sentinel (value TEXT NOT NULL)")
        conn.execute("INSERT INTO sentinel VALUES ('keep this row')")
    before = path.read_bytes()
    captured = []
    statements = []
    connect = sqlite3.connect

    def capture(*args, **kwargs):
        conn = connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        captured.append(conn)
        return conn

    monkeypatch.setattr(db_module.sqlite3, "connect", capture)
    with pytest.raises(ValueError, match="schema version"):
        CommonsDB(path)

    assert path.read_bytes() == before
    assert not any("JOURNAL_MODE=" in sql.upper() or sql.lstrip().upper().startswith(
        ("CREATE ", "ALTER ", "INSERT ", "UPDATE ", "DELETE ")) for sql in statements)
    assert list(tmp_path.iterdir()) == [path]
    for conn in captured:
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            conn.execute("SELECT 1")
    with connect(path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == version
        assert conn.execute("SELECT value FROM sentinel").fetchall() == [("keep this row",)]
        assert {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} == {
            "meta", "sentinel",
        }


@pytest.mark.parametrize("with_meta", [False, True])
def test_rejects_existing_schema_without_version_and_keeps_data(tmp_path, with_meta):
    path = tmp_path / "unversioned.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE sentinel (value TEXT NOT NULL)")
        conn.execute("INSERT INTO sentinel VALUES ('keep')")
        if with_meta:
            conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            conn.execute("INSERT INTO meta VALUES ('other', 'keep metadata')")
    before = path.read_bytes()
    with pytest.raises(ValueError, match="schema version"):
        CommonsDB(path)
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("meta_sql, rows", [
    ("CREATE TABLE meta (key TEXT, value TEXT)", [("schema_version", None)]),
    ("CREATE TABLE meta (key TEXT, value TEXT)", [("schema_version", "4"), ("schema_version", "4")]),
    ("CREATE TABLE meta (other TEXT)", []),
    ("CREATE VIEW meta AS SELECT 'schema_version' AS key, '4' AS value", []),
])
def test_malformed_version_metadata_does_not_mutate_database(tmp_path, meta_sql, rows):
    path = tmp_path / "malformed.db"
    with sqlite3.connect(path) as conn:
        conn.execute(meta_sql)
        if rows:
            conn.executemany("INSERT INTO meta VALUES (?, ?)", rows)
    before = path.read_bytes()
    with pytest.raises(ValueError, match="schema version"):
        CommonsDB(path)
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]


def test_empty_existing_sqlite_file_is_initialized(tmp_path):
    path = tmp_path / "empty.db"
    sqlite3.connect(path).close()
    db = CommonsDB(path)
    try:
        with db.read() as conn:
            assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "4"
            assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        db.close()


def _historical_ddl(version: int) -> str:
    # Verified against 27972325 (v1), fda31973 (v2), 99b873d0 (v3),
    # f26ee86f (v4): only these tables and nullable columns were added.
    ddl = DDL
    if version < 4:
        ddl = ddl.replace("  seal_hash TEXT,\n  closed TEXT,\n  close_hash TEXT", "  seal_hash TEXT")
    if version < 3:
        ddl = re.sub(r"CREATE TABLE IF NOT EXISTS assisted_reviews \(.*?\n\);\n", "", ddl, flags=re.S)
    if version < 2:
        for table in ("evaluation_batch", "evaluation_items"):
            ddl = re.sub(rf"CREATE TABLE IF NOT EXISTS {table} \(.*?\n\);\n", "", ddl, flags=re.S)
    return ddl


@pytest.mark.parametrize("version", [1, 2, 3, 4])
def test_supported_historical_schemas_upgrade_without_losing_rows(tmp_path, version):
    path = tmp_path / "historical.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(_historical_ddl(version))
        conn.execute("INSERT INTO meta VALUES ('schema_version', ?)", (str(version),))
        conn.execute("INSERT INTO settings VALUES ('sentinel', 'keep')")
        conn.execute("INSERT INTO quarantine VALUES ('preserved_hash', 'synthetic.png', 'then')")
        if version >= 2:
            conn.execute("INSERT INTO evaluation_batch(id, manifest, manifest_hash, revision) VALUES (1, '{}', 'keep_hash', 7)")
            conn.execute("INSERT INTO evaluation_items(position, image, palette, labels) VALUES (0, ?, '[]', '{}')", (b"keep image",))
        if version == 4:
            conn.execute("UPDATE evaluation_batch SET closed='keep close record', close_hash='keep close hash'")
        if version >= 3:
            conn.execute("INSERT INTO assisted_reviews(position, status, revision, proposal, started_at) VALUES (0, 'ready', 3, '{}', 'then')")

    for _ in range(2):
        db = CommonsDB(path)
        try:
            with db.read() as conn:
                assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "4"
                assert tuple(conn.execute("SELECT * FROM settings").fetchone()) == ("sentinel", "keep")
                assert tuple(conn.execute("SELECT * FROM quarantine").fetchone()) == ("preserved_hash", "synthetic.png", "then")
                assert {row[1] for row in conn.execute("PRAGMA table_info(evaluation_batch)")} >= {"closed", "close_hash"}
                if version >= 2:
                    closure = ("keep close record", "keep close hash") if version == 4 else (None, None)
                    assert tuple(conn.execute("SELECT manifest, manifest_hash, revision, closed, close_hash FROM evaluation_batch").fetchone()) == ("{}", "keep_hash", 7, *closure)
                    assert tuple(conn.execute("SELECT image, palette, labels FROM evaluation_items").fetchone()) == (b"keep image", "[]", "{}")
                else:
                    assert conn.execute("SELECT count(*) FROM evaluation_batch").fetchone()[0] == 0
                if version >= 3:
                    assert tuple(conn.execute("SELECT status, revision, proposal, started_at FROM assisted_reviews").fetchone()) == ("ready", 3, "{}", "then")
                else:
                    assert conn.execute("SELECT count(*) FROM assisted_reviews").fetchone()[0] == 0
        finally:
            db.close()


def test_constructor_closes_connection_after_migration_failure(tmp_path, monkeypatch):
    captured = []
    connect = sqlite3.connect

    def capture(*args, **kwargs):
        conn = connect(*args, **kwargs)
        captured.append(conn)
        return conn

    def fail(self):
        raise RuntimeError("synthetic migration failure")

    monkeypatch.setattr(db_module.sqlite3, "connect", capture)
    monkeypatch.setattr(CommonsDB, "_migrate", fail)
    with pytest.raises(RuntimeError, match="synthetic migration failure"):
        CommonsDB(tmp_path / "failure.db")
    for conn in captured:
        with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
            conn.execute("SELECT 1")


def test_failed_additive_migration_rolls_back_ddl_and_preserves_version(tmp_path, monkeypatch):
    path = tmp_path / "rollback.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(_historical_ddl(1))
        conn.execute("INSERT INTO meta VALUES ('schema_version', '1')")
        conn.execute("INSERT INTO settings VALUES ('sentinel', 'keep')")
    monkeypatch.setattr(db_module, "ADDED_COLUMNS", (("no_such_table", "closed", "TEXT"),))
    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        CommonsDB(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "1"
        assert conn.execute("SELECT value FROM settings WHERE key='sentinel'").fetchone()[0] == "keep"
        assert conn.execute("SELECT name FROM sqlite_master WHERE name IN ('evaluation_batch', 'evaluation_items', 'assisted_reviews')").fetchall() == []


def test_read_only_preflight_sees_future_version_in_current_wal(tmp_path, monkeypatch):
    path = tmp_path / "future.db"
    connect = sqlite3.connect
    writer = connect(path)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        writer.execute("INSERT INTO meta VALUES ('schema_version', '4')")
        writer.execute("CREATE TABLE sentinel (value TEXT)")
        writer.execute("INSERT INTO sentinel VALUES ('keep')")
        writer.commit()
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        main_before = path.read_bytes()
        writer.execute("UPDATE meta SET value='99' WHERE key='schema_version'")
        writer.commit()
        wal_path = path.with_name(path.name + "-wal")
        wal_before = wal_path.read_bytes()
        assert wal_before and path.read_bytes() == main_before
        calls = []
        captured = []

        def capture(*args, **kwargs):
            calls.append((args, kwargs))
            conn = connect(*args, **kwargs)
            captured.append(conn)
            return conn

        monkeypatch.setattr(db_module.sqlite3, "connect", capture)
        with pytest.raises(ValueError, match="schema version"):
            CommonsDB(path)
        assert len(calls) == 1 and calls[0][1]["uri"] is True
        assert str(calls[0][0][0]).endswith("?mode=ro")
        assert path.read_bytes() == main_before
        assert wal_path.read_bytes() == wal_before
        assert writer.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "99"
        for conn in captured:
            with pytest.raises(sqlite3.ProgrammingError, match="closed database"):
                conn.execute("SELECT 1")
    finally:
        writer.close()


def test_read_only_preflight_does_not_recover_a_hot_rollback_journal(tmp_path, monkeypatch):
    path = tmp_path / "hot.db"
    script = """
import os, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute('PRAGMA journal_mode=DELETE')
conn.execute('PRAGMA synchronous=FULL')
conn.execute('PRAGMA cache_size=5')
conn.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
conn.execute("INSERT INTO meta VALUES ('schema_version', '99')")
conn.execute('CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT)')
conn.executemany('INSERT INTO sentinel(value) VALUES (?)', [('keep ' + 'x' * 4000,) for _ in range(100)])
conn.commit()
conn.execute('BEGIN IMMEDIATE')
conn.execute("UPDATE sentinel SET value='uncommitted ' || value")
os._exit(0)
"""
    subprocess.run([sys.executable, "-c", script, str(path)], check=True, timeout=10)
    journal_path = path.with_name(path.name + "-journal")
    journal_before = journal_path.read_bytes()
    before = path.read_bytes()
    # A nonzero rollback header after an abrupt exit and released process lock
    # forces SQLite recovery before it can read the database consistently.
    assert journal_before[:8] == bytes.fromhex("d9d505f920a163d7")
    calls = []
    connect = sqlite3.connect

    def capture(*args, **kwargs):
        calls.append((args, kwargs))
        return connect(*args, **kwargs)

    monkeypatch.setattr(db_module.sqlite3, "connect", capture)
    with pytest.raises(ValueError, match="schema version using read-only access"):
        CommonsDB(path)
    assert len(calls) == 1 and str(calls[0][0][0]).endswith("?mode=ro")
    assert path.read_bytes() == before
    assert journal_path.read_bytes() == journal_before
