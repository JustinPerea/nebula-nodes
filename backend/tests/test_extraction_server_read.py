"""The read and corrections endpoints. A read only ever goes through a fake process or the fake reader."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from commons import reader as commons_reader
from extraction import reader, server, store
from tests.extraction_fakes import (LANDING, Spawner, answering, block_real_spawn, failing, landing_structured)

pytestmark = pytest.mark.usefixtures("block_real_spawn")

TOKEN = "t0ken-" + "x" * 30
PORT = 8870
BASE = f"http://127.0.0.1:{PORT}"
POST = {"X-Extraction-Token": TOKEN, "Origin": BASE}
AUTH = {"X-Extraction-Token": TOKEN}


def _client(spawn=None, fake_reader=None):
    app = server.create_app(TOKEN, port=PORT, spawn=spawn, fake_reader=fake_reader)
    return TestClient(app, base_url=BASE)


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


def _add(client, folder):
    reply = client.post("/api/records", headers=POST, files={"file": ("landing.png", LANDING.read_bytes(), "image/png")},
                        data={"folder": str(folder), "kind": "drop"})
    assert reply.status_code == 200, reply.text
    return reply.json()["record"]["id"]


def _read(client, folder, record_id, **body):
    return client.post(f"/api/records/{record_id}/read", headers=POST, json={"folder": str(folder), **body})


def _correct(client, folder, record_id, corrections):
    return client.post(f"/api/records/{record_id}/corrections", headers=POST,
                       json={"folder": str(folder), "corrections": corrections})


def test_a_read_through_a_fake_process_saves_the_reading(folder):
    spawner = answering()
    client = _client(spawner)
    record_id = _add(client, folder)
    reply = _read(client, folder, record_id)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    read = body["record"]["structure"]["read"]
    assert read["model"] == commons_reader.MODEL_ID and read["prompt_version"] == "extract-1"
    assert len(read["regions"]) == 10 and len(body["record"]["shows"]) == 3
    assert body["effective"]["structure"]["measured"]["region_measures"]["r6"]["origin"] == "code"
    assert len(spawner.calls) == 1
    cmd = spawner.calls[0][0]
    assert cmd[cmd.index("--tools") + 1] == "" and "--restricted" in cmd
    saved = client.get(f"/api/records/{record_id}", params={"folder": str(folder)}, headers=AUTH).json()["record"]
    assert saved["structure"]["read"]["regions"]["r6"]["box_px"] == [96, 410, 200, 56]
    assert TOKEN not in reply.text


def test_a_record_that_has_a_read_needs_again(folder):
    spawner = answering()
    client = _client(spawner)
    record_id = _add(client, folder)
    assert _read(client, folder, record_id).status_code == 200
    again = _read(client, folder, record_id)
    assert again.status_code == 409 and "already been read" in again.json()["error"]
    assert len(spawner.calls) == 1
    assert _read(client, folder, record_id, again=True).status_code == 200
    assert len(spawner.calls) == 2


def test_a_second_request_while_a_read_runs_gets_409(folder):
    spawner = answering()
    client = _client(spawner)
    record_id = _add(client, folder)
    asyncio.run(client.app.state.read_lock.acquire())  # a read is "running"
    reply = _read(client, folder, record_id)
    assert reply.status_code == 409 and "already running" in reply.json()["error"]
    assert spawner.calls == []


def test_a_correction_made_during_a_read_is_kept(folder):
    holder = {}

    def correct_meanwhile():
        store.correct(holder["dir"], [{"path": "brand", "op": "set", "value": "acme"}], "person")

    spawner = answering(on_run=correct_meanwhile)
    client = _client(spawner)
    record_id = _add(client, folder)
    holder["dir"] = str(folder / record_id)
    assert _read(client, folder, record_id).status_code == 200
    saved = store.load(holder["dir"])
    assert saved["structure"]["read"] is not None and saved["corrections"][0]["value"] == "acme"


def test_a_failed_read_is_a_sentence_and_changes_nothing(folder):
    client = _client(failing())
    record_id = _add(client, folder)
    before = (folder / record_id / "record.json").read_bytes()
    reply = _read(client, folder, record_id)
    assert reply.status_code == 502 and "didn't answer" in reply.json()["error"]
    assert (folder / record_id / "record.json").read_bytes() == before
    # the lock is free again
    assert not client.app.state.read_lock.locked()


def test_an_answer_that_does_not_fit_is_a_sentence_and_changes_nothing(folder):
    bad = landing_structured()
    bad["regions"][0]["role"] = "sidebar"
    client = _client(answering(bad))
    record_id = _add(client, folder)
    before = (folder / record_id / "record.json").read_bytes()
    reply = _read(client, folder, record_id)
    assert reply.status_code == 502 and "didn't fit" in reply.json()["error"]
    assert (folder / record_id / "record.json").read_bytes() == before


def test_a_read_needs_the_token_and_the_pages_own_origin(folder):
    spawner = answering()
    client = _client(spawner)
    record_id = _add(client, folder)
    url = f"/api/records/{record_id}/read"
    body = {"folder": str(folder)}
    assert client.post(url, headers={"Origin": BASE}, json=body).status_code == 401
    assert client.post(url, headers={"X-Extraction-Token": "wrong", "Origin": BASE}, json=body).status_code == 401
    assert client.post(url, headers=AUTH, json=body).status_code == 403
    assert client.post(url, headers={**AUTH, "Origin": "null"}, json=body).status_code == 403
    assert client.post(url, headers={**AUTH, "Origin": "http://evil.example"}, json=body).status_code == 403
    assert client.post(f"/api/records/{record_id}/corrections", headers=AUTH,
                       json={**body, "corrections": []}).status_code == 403
    assert spawner.calls == []


def test_a_bad_record_id_or_body_is_a_plain_400(folder):
    client = _client(answering())
    assert _read(client, folder, "not-an-id").status_code == 400
    assert client.post("/api/records/ex_0123456789abcdef/read", headers=POST, json={}).status_code == 400
    assert _read(client, folder, "ex_0123456789abcdef").status_code == 400  # no such record


def test_the_fake_reader_answers_without_a_process_and_says_so(folder):
    spawner = Spawner([])  # would fail the test if called: it returns no events
    client = _client(spawner, fake_reader=landing_structured())
    record_id = _add(client, folder)
    reply = _read(client, folder, record_id)
    assert reply.status_code == 200
    read = reply.json()["record"]["structure"]["read"]
    assert read["model"] == "fake-reader" and read["prompt_version"] == "extract-1"
    assert spawner.calls == []
    # the same validation path: a fake file that doesn't validate is refused like a real answer
    bad = landing_structured()
    bad["spacing"]["outer_margin"] = 5
    bad_client = _client(fake_reader=bad)
    assert _read(bad_client, folder, record_id, again=True).status_code == 502


def test_corrections_are_the_persons_through_the_store(folder):
    client = _client(answering())
    record_id = _add(client, folder)
    _read(client, folder, record_id)
    reply = _correct(client, folder, record_id, [
        {"path": "structure.read.regions.r6.role", "op": "set", "value": "control"},
        {"path": "structure.read.regions.r6.label", "op": "set", "value": "Main action"}])
    assert reply.status_code == 200
    body = reply.json()
    assert [c["actor"] for c in body["record"]["corrections"]] == ["person", "person"]
    assert body["effective"]["structure"]["read"]["regions"]["r6"]["role"] == "control"
    assert body["record"]["structure"]["read"]["regions"]["r6"]["role"] == "button"  # the read itself is untouched
    assert body["record"]["status"] == "proposal"
    kept = client.get(f"/api/records/{record_id}", params={"folder": str(folder)}, headers=AUTH).json()
    assert kept["effective"]["structure"]["read"]["regions"]["r6"]["label"] == "Main action"


def test_an_actor_in_the_body_is_ignored(folder):
    client = _client(answering())
    record_id = _add(client, folder)
    reply = client.post(f"/api/records/{record_id}/corrections", headers=POST, json={
        "folder": str(folder), "actor": "agent", "corrections": [{"path": "brand", "op": "set", "value": "acme", "actor": "agent"}]})
    assert reply.status_code == 200 and reply.json()["record"]["corrections"][0]["actor"] == "person"


def test_refused_corrections_are_plain_sentences(folder):
    client = _client(answering())
    record_id = _add(client, folder)
    for corrections in ([{"path": "status", "op": "set", "value": "approved"}],
                        [{"path": "structure.measured.palette", "op": "set", "value": []}],
                        [{"path": "structure.read.regions.r1.role", "op": "set", "value": "x"}],  # no read yet
                        []):
        reply = _correct(client, folder, record_id, corrections)
        assert reply.status_code == 400 and reply.json()["error"].endswith((".", ")")), corrections
    assert json.loads((folder / record_id / "record.json").read_text())["corrections"] == []
