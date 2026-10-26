"""A failed Commons analysis says why, by kind (GM - Design, error-copy round 3, item 4).

GM: heading "Couldn't analyze this reference.", with the reason mapped from
last_error's kind:
  - network, timeout or provider 5xx -> "The analysis service didn't respond."
  - the model refused or couldn't read the image -> "The analyzer couldn't read this image."
  - anything else -> "Something went wrong during analysis."
"Keep Retry. Put the raw last_error behind a collapsed 'Details' toggle."

The kind is decided where the analysis fails (the worker and the reader),
stored next to last_error (assets.last_error_kind, an additive column), and
read in the asset detail as `last_error_kind`: "unavailable", "unreadable"
or "other". A row from before the column says the kind its last_error text
names (every last_error is one of this backend's own messages), else
"other". last_error itself is unchanged, for agents and the Details toggle.
No real reader runs here: every reader is a fake.
"""
from __future__ import annotations

import io
import json
import secrets
import sqlite3

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from commons import intake, reader
from commons.db import CommonsDB
from commons.store import CommonsStore
from commons.vocab import load_vocabulary
from commons.worker import AnalysisWorker


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def add(store, seed=1):
    col = store.ensure_collection("x", "manual")
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (40, 40, 3), dtype=np.uint8)).save(buf, "PNG")
    return intake.add_bytes(store, buf.getvalue(), filename="a.png", collection_id=col["id"], actor="human:justin",
                            source={"kind": "file"}).asset["id"]


def result_reader(result: reader.ReaderResult):
    async def run(png, palette, fewshots, *, vocab, **kw):
        return result

    return run


def raising_reader(exc: BaseException):
    async def run(png, palette, fewshots, *, vocab, **kw):
        raise exc

    return run


async def fail_once(store, read) -> dict:
    aid = add(store)
    assert await AnalysisWorker(store, reader=read, load_avg=lambda: 1.0, budget=5).run_once() == "failed"
    return store.get_asset(aid)


@pytest.mark.asyncio
@pytest.mark.parametrize("exc", [httpx.ConnectError("connection refused"), httpx.ReadTimeout("slow"),
                                 TimeoutError("timed out"), ConnectionResetError("reset")],
                         ids=["connect", "read-timeout", "timeout", "reset"])
async def test_a_network_failure_is_unavailable(store, exc):
    asset = await fail_once(store, raising_reader(exc))
    assert asset["last_error_kind"] == "unavailable"
    assert asset["last_error"].startswith("reader crashed:")  # unchanged for agents


@pytest.mark.asyncio
async def test_a_provider_5xx_is_unavailable(store):
    request = httpx.Request("POST", "https://api.example.test/v1/messages")
    exc = httpx.HTTPStatusError("overloaded", request=request, response=httpx.Response(529, request=request))
    asset = await fail_once(store, raising_reader(exc))
    assert asset["last_error_kind"] == "unavailable"


@pytest.mark.asyncio
async def test_some_other_crash_is_other(store):
    asset = await fail_once(store, raising_reader(RuntimeError("pipe closed")))
    assert asset["last_error_kind"] == "other"


@pytest.mark.asyncio
async def test_a_reader_result_carries_its_kind_to_the_asset(store):
    asset = await fail_once(store, result_reader(reader.ReaderResult(
        None, None, None, 5, [], "reader timed out", error_kind="unavailable")))
    assert asset["last_error_kind"] == "unavailable"
    assert asset["last_error"] == "reader timed out"


@pytest.mark.asyncio
async def test_an_image_nebula_cant_load_is_unreadable(store, monkeypatch):
    from commons import media

    def broken(*a, **k):
        raise media.MediaError("cannot decode")

    aid = add(store)
    monkeypatch.setattr(media, "load_image", broken)
    read = result_reader(reader.ReaderResult(None, None, None, 5, [], "unused"))
    assert await AnalysisWorker(store, reader=read, load_avg=lambda: 1.0, budget=5).run_once() == "failed"
    asset = store.get_asset(aid)
    assert asset["last_error_kind"] == "unreadable"
    assert asset["last_error"].startswith("cannot load image:")


@pytest.mark.asyncio
async def test_output_that_fails_validation_is_other(store):
    asset = await fail_once(store, result_reader(reader.ReaderResult({"summary": 1}, "{}", "m", 5, [], None)))
    assert asset["last_error_kind"] == "other"


@pytest.mark.asyncio
async def test_a_success_clears_the_kind(store):
    from tests.test_commons_worker import fake_reader

    aid = add(store)
    w = AnalysisWorker(store, reader=raising_reader(httpx.ConnectError("x")), load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "failed"
    with store.db.tx() as conn:
        conn.execute("UPDATE assets SET next_attempt_at = NULL WHERE id = ?", (aid,))
    w = AnalysisWorker(store, reader=fake_reader(), load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "analyzed"
    asset = store.get_asset(aid)
    assert asset["last_error"] is None and asset["last_error_kind"] is None


# -- the reader classifies where it fails ---------------------------------------

def _proc(lines=None, *, hang=False, rc=0, err=b""):
    import asyncio

    class Proc:
        returncode = rc

        async def communicate(self, data):
            if hang:
                await asyncio.sleep(10)
            return ("\n".join(json.dumps(line) for line in lines or []).encode(), err)

        def kill(self):
            pass

    proc = Proc()

    async def spawn(*a, **k):
        return proc

    return spawn


INIT = {"type": "system", "subtype": "init", "model": "m", "tools": ["StructuredOutput"]}


@pytest.mark.asyncio
async def test_reader_timeout_is_unavailable(monkeypatch):
    async def no_kill(proc):
        return None

    monkeypatch.setattr(reader, "_kill", no_kill)
    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=_proc(hang=True), timeout=0.01)
    assert res.error == "reader timed out" and res.error_kind == "unavailable"


@pytest.mark.asyncio
async def test_reader_that_cant_start_is_unavailable():
    async def spawn(*a, **k):
        raise FileNotFoundError("claude")

    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=spawn)
    assert res.error_kind == "unavailable"


@pytest.mark.asyncio
async def test_reader_with_no_result_is_unavailable():
    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=_proc([INIT], rc=1, err=b"boom"))
    assert res.error_kind == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["API Error: 529 Overloaded", "API Error: 503 Service Unavailable",
                                  "Request timed out", "Connection error."])
async def test_a_provider_error_result_is_unavailable(text):
    lines = [INIT, {"type": "result", "subtype": "error_during_execution", "is_error": True, "result": text}]
    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=_proc(lines))
    assert res.error_kind == "unavailable"


@pytest.mark.asyncio
async def test_a_refusal_is_unreadable():
    lines = [INIT, {"type": "result", "subtype": "success", "is_error": False, "stop_reason": "refusal",
                    "result": "I can't help with describing this image."}]
    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=_proc(lines))
    assert res.error_kind == "unreadable"


@pytest.mark.asyncio
async def test_an_answer_without_the_structure_is_unreadable():
    lines = [INIT, {"type": "result", "subtype": "success", "is_error": False, "result": "No."}]
    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=_proc(lines))
    assert res.error_kind == "unreadable"


@pytest.mark.asyncio
async def test_an_unexpected_tool_is_other():
    lines = [{"type": "system", "subtype": "init", "model": "m", "tools": ["Read"]}]
    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=_proc(lines))
    assert res.error_kind == "other"


def test_a_video_nebula_cant_probe_is_unreadable(store, monkeypatch):
    from commons import media

    def broken(*a, **k):
        raise media.MediaError("no stream")

    monkeypatch.setattr(media, "probe_video", broken)
    col = store.ensure_collection("v", "manual")
    data = b"\x00\x00\x00\x18ftypmp42" + b"0" * 64
    assert media.sniff(data).media == "video"
    aid = intake.add_bytes(store, data, filename="a.mp4", collection_id=col["id"], actor="human:justin",
                           source={"kind": "file"}).asset["id"]
    asset = store.get_asset(aid)
    assert asset["analysis_state"] == "analysis_failed"
    assert asset["last_error_kind"] == "unreadable"


# -- old rows and the migration -------------------------------------------------

def test_an_old_database_gains_the_column_and_old_rows_read_their_kind(tmp_path):
    from commons.db import DDL

    path = tmp_path / "old.db"
    old_ddl = DDL.replace("  last_error_kind TEXT,\n", "")
    assert "last_error_kind" not in old_ddl
    with sqlite3.connect(path) as conn:
        conn.executescript(old_ddl)
        conn.execute("INSERT INTO meta VALUES ('schema_version', '4')")
        for aid, error in (("a1", "reader timed out"), ("a2", "cannot load image: bad"),
                           ("a3", "missing field summary (summary and all others are required)"),
                           ("a4", "video probe failed: no stream"),
                           ("a5", "no result event (rc=1): x"), ("a6", None)):
            conn.execute("INSERT INTO assets(id, sha256, blob_key, media, mime, analysis_state, last_error, "
                         "created_at) VALUES (?, ?, ?, 'image', 'image/png', ?, ?, 'then')",
                         (aid, aid, aid, "analysis_failed" if error else "ready", error))
    store = CommonsStore(CommonsDB(path), tmp_path / "blobs")
    with store.db.read() as conn:
        assert "last_error_kind" in {r[1] for r in conn.execute("PRAGMA table_info(assets)")}
        assert conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "4"
    kinds = {aid: store.get_asset(aid)["last_error_kind"] for aid in ("a1", "a2", "a3", "a4", "a5", "a6")}
    assert kinds == {"a1": "unavailable", "a2": "unreadable", "a3": "other", "a4": "unreadable",
                     "a5": "unavailable", "a6": None}
    assert store.get_asset("a1")["last_error"] == "reader timed out"


# -- the asset detail -------------------------------------------------------------

@pytest.fixture()
def client(tmp_path, monkeypatch, fresh_person_session):
    from commons import runtime

    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    from main import app

    yield TestClient(app)
    runtime.reset_for_tests()


def test_the_asset_detail_carries_the_kind_for_the_person_and_agents(client):
    from commons import runtime
    from services import person_session

    token = secrets.token_urlsafe(32)
    person_session.current().set(token)
    human = {"Authorization": f"Bearer {token}"}
    col = client.post("/api/commons/collections", json={"name": "refs"}, headers=human).json()["id"]
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(7).integers(0, 255, (24, 24, 3), dtype=np.uint8)).save(buf, "PNG")
    asset_id = client.post("/api/commons/intake/files", headers=human, data={"collection_id": col},
                           files=[("files", ("a.png", buf.getvalue(), "image/png"))]).json()["results"][0]["asset_id"]
    store = runtime.get_store()
    with store.db.tx() as conn:
        conn.execute("UPDATE assets SET analysis_state='analysis_failed', last_error='reader timed out', "
                     "last_error_kind='unavailable' WHERE id = ?", (asset_id,))
    person = client.get(f"/api/commons/assets/{asset_id}", headers=human).json()["asset"]
    assert person["last_error"] == "reader timed out" and person["last_error_kind"] == "unavailable"
    agent = client.get(f"/api/commons/assets/{asset_id}", headers={"X-Nebula-Client": "cursor"})
    if agent.status_code == 200:
        body = agent.json()["asset"]
        assert body["last_error_kind"] == "unavailable"
