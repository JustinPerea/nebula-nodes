"""SQLite for the commons: WAL, busy timeout, foreign keys, one schema.

One connection per process, guarded by an RLock. FastAPI runs the commons
routes as plain `def` handlers, so they execute in the threadpool and never
block the event loop (§9); the lock serializes them.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 4
_SUPPORTED_SCHEMA_VERSIONS = frozenset({"1", "2", "3", "4"})


class CommonsSchemaError(ValueError):
    """An existing database is not a supported, versioned Commons store."""

DDL = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS folder_links (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  ignores TEXT NOT NULL DEFAULT '[]',
  last_scan_at TEXT,
  last_scan_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'folder', 'moodboard', 'system')),
  brand TEXT,
  folder_link TEXT REFERENCES folder_links(id) ON DELETE SET NULL,
  source_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS collections_folder_name
  ON collections(folder_link, name) WHERE folder_link IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collections_source
  ON collections(kind, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  blob_key TEXT NOT NULL UNIQUE,
  media TEXT NOT NULL CHECK (media IN ('image', 'video')),
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration REAL,
  phash TEXT,
  parent_asset TEXT REFERENCES assets(id) ON DELETE CASCADE,
  keyframe_t REAL,
  made_by TEXT NOT NULL DEFAULT 'unknown' CHECK (made_by IN ('human', 'ai', 'unknown')),
  license_note TEXT,
  measurements TEXT,
  code_version TEXT,
  analysis_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (analysis_state IN ('held', 'queued', 'analyzing', 'analysis_failed', 'ready')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_queue ON assets(analysis_state, next_attempt_at);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  collection TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'neutral' CHECK (role IN ('attract', 'avoid', 'evidence', 'neutral')),
  why TEXT,
  actor TEXT NOT NULL,
  in_inbox INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  UNIQUE (asset, collection)
);

CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY,
  membership TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('file', 'folder', 'url', 'moodboard', 'agent', 'keyframe', 'output')),
  url TEXT, page_url TEXT, page_title TEXT,
  original_path TEXT, original_name TEXT,
  folder_link TEXT REFERENCES folder_links(id) ON DELETE CASCADE,
  rel_path TEXT, file_id TEXT, size INTEGER, mtime REAL,
  source_date TEXT, fetched_at TEXT,
  state TEXT NOT NULL DEFAULT 'ok'
    CHECK (state IN ('ok', 'missing_from_folder', 'archived', 'superseded')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sightings_folder_path ON sightings(folder_link, rel_path);

CREATE TABLE IF NOT EXISTS device_state (
  path TEXT PRIMARY KEY,
  folder_link TEXT REFERENCES folder_links(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('downloading', 'download_failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  code_version TEXT NOT NULL,
  vocab_version TEXT NOT NULL,
  fields TEXT,
  raw_output TEXT,
  fewshot_ids TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analyses_asset ON analyses(asset, created_at);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('set', 'add', 'remove')),
  value TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  box TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'deleted')),
  actor TEXT NOT NULL,
  analysis TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  membership TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  region TEXT REFERENCES regions(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  text TEXT NOT NULL,
  source_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS borrowings (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  membership TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  attribute TEXT NOT NULL,
  region TEXT REFERENCES regions(id) ON DELETE SET NULL,
  value TEXT NOT NULL,
  used_in TEXT NOT NULL,
  why TEXT NOT NULL,
  actor TEXT NOT NULL,
  integrity TEXT NOT NULL,
  fidelity TEXT,
  fidelity_asset TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_batch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  manifest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sealed TEXT,
  seal_hash TEXT,
  closed TEXT,
  close_hash TEXT
);

CREATE TABLE IF NOT EXISTS evaluation_items (
  position INTEGER PRIMARY KEY CHECK (position >= 0 AND position < 15),
  image BLOB NOT NULL,
  palette TEXT NOT NULL,
  accents TEXT,
  labels TEXT
);

CREATE TABLE IF NOT EXISTS assisted_reviews (
  position INTEGER PRIMARY KEY REFERENCES evaluation_items(position),
  status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
  revision INTEGER NOT NULL DEFAULT 0,
  proposal TEXT,
  reviewed_labels TEXT,
  reviewer TEXT,
  reviewed_at TEXT,
  error TEXT,
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quarantine (
  phash TEXT PRIMARY KEY,
  source_rel_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commons_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS meter (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS vocab_candidates (
  term TEXT NOT NULL,
  asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  analysis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (term, asset)
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  membership UNINDEXED, asset UNINDEXED,
  summary, keywords, notes, subject, collection, why,
  tokenize = 'porter unicode61'
);
"""

# Columns added to tables that already exist in older stores. CREATE TABLE IF
# NOT EXISTS cannot add them, so each one is added once, nullable and without a
# default: a metadata-only change that rewrites no rows.
ADDED_COLUMNS = (
    ("evaluation_batch", "closed", "TEXT"),       # v4
    ("evaluation_batch", "close_hash", "TEXT"),   # v4
)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class CommonsDB:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        if path.exists():
            # mode=ro sees committed WAL state, unlike immutable=1. It also
            # refuses a hot rollback journal requiring recovery writes.
            probe = None
            try:
                probe = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True,
                                        timeout=30, isolation_level=None)
                probe.row_factory = sqlite3.Row
                self._check_schema_version(probe)
            except sqlite3.DatabaseError as exc:
                raise CommonsSchemaError("Cannot verify existing Commons database schema version using read-only access") from exc
            finally:
                if probe is not None:
                    probe.close()
        self.conn = sqlite3.connect(path, timeout=30, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        try:
            # Refusing a foreign/newer store must not switch its journal mode
            # or create Commons objects before its version is understood.
            self._check_schema_version()
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA busy_timeout=30000")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self._migrate()
        except BaseException:
            self.conn.close()
            raise

    def _check_schema_version(self, conn: sqlite3.Connection | None = None) -> None:
        conn = self.conn if conn is None else conn
        objects = conn.execute("SELECT name, type FROM sqlite_master").fetchall()
        if not objects:
            return  # A new file or an existing schema-empty file is fresh.
        if not any(row["name"] == "meta" and row["type"] == "table" for row in objects):
            raise CommonsSchemaError("Existing Commons database has no schema version")
        try:
            rows = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchall()
        except sqlite3.DatabaseError as exc:
            raise CommonsSchemaError("Existing Commons database has invalid schema version metadata") from exc
        if len(rows) != 1:
            raise CommonsSchemaError("Existing Commons database has no unique schema version")
        version = rows[0]["value"]
        if not isinstance(version, str) or version not in _SUPPORTED_SCHEMA_VERSIONS:
            raise CommonsSchemaError("Commons database schema version is not supported by this build")

    def _migrate(self) -> None:
        with self.tx() as conn:
            # Recheck after taking the writer lock before applying additive DDL.
            self._check_schema_version()
            # executescript() would COMMIT mid-transaction, so run statements one by one.
            for statement in [s.strip() for s in DDL.split(";\n") if s.strip()]:
                conn.execute(statement)
            for table, column, decl in ADDED_COLUMNS:
                if column not in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
            conn.execute(
                "INSERT INTO meta(key, value) VALUES ('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(SCHEMA_VERSION),),
            )

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            yield self.conn

    def close(self) -> None:
        with self._lock:
            self.conn.close()
