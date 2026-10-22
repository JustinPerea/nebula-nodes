"""Commons refusals: the person reads written copy, agents keep the specific detail.

GM - Design, error-copy round 2: "Raw backend exception text: fix it at the
backend. Log str(exc) and send written copy", and, after the coordinator's
split: "the person/agent split is right. People get the written line and
agents keep the specific detail. Keep it that way." Uploads gain a machine
`reason` per refused file (the frontend maps it to a line); `error` stays.
"""
from __future__ import annotations

import io
import logging
import secrets

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from commons import media, net, person_copy, runtime
from services import person_session

FALLBACK = "That didn't work. Try again, or reload if it keeps happening."


@pytest.fixture()
def client(tmp_path, monkeypatch, fresh_person_session):
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    from main import app

    yield TestClient(app)
    runtime.reset_for_tests()


def human() -> dict:
    token = secrets.token_urlsafe(32)
    person_session.current().set(token)
    return {"Authorization": f"Bearer {token}"}


AGENT = {"X-Nebula-Client": "cursor"}


def png(seed=1) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (24, 24, 3), dtype=np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def collection(client, h) -> str:
    return client.post("/api/commons/collections", json={"name": "refs"}, headers=h).json()["id"]


def test_bad_filters_person_gets_gms_line_agent_keeps_detail(client, caplog):
    h = human()
    with caplog.at_level(logging.INFO, logger="routes.commons"):
        person = client.post("/api/commons/search", json={"filters": {"axes": []}}, headers=h)
    assert person.status_code == 422
    assert person.json()["detail"] == "Those filters didn't work. Clear them and try again."
    assert "axes must be an object" in caplog.text  # str(exc) is logged
    agent = client.post("/api/commons/search", json={"filters": {"axes": []}}, headers=AGENT)
    assert agent.status_code == 422
    assert agent.json()["detail"].startswith("bad filters: ") and "axes must be an object" in agent.json()["detail"]


def test_settings_unknown_and_bad_value(client, caplog):
    h = human()
    with caplog.at_level(logging.INFO, logger="routes.commons"):
        unknown = client.patch("/api/commons/settings", json={"no_such_setting": 1}, headers=h)
    assert unknown.status_code == 422
    assert unknown.json()["detail"] == "That setting isn't available. Reload to get the latest settings."
    assert "no_such_setting" in caplog.text
    bad = client.patch("/api/commons/settings", json={"load_threshold": "loud"}, headers=h)
    assert bad.status_code == 422
    assert bad.json()["detail"] == "That value doesn't work for this setting. Reload to get the latest settings."
    assert "load_threshold" not in bad.json()["detail"]


def test_upload_results_carry_a_reason_code_and_keep_error(client, monkeypatch):
    h = human()
    col = collection(client, h)
    monkeypatch.setattr(media, "IMAGE_CAP", 64)
    big = png(2)  # over the patched 64-byte cap
    broken = b"\x89PNG\r\n\x1a\n" + b"not a png"  # under the patched cap
    r = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col}, files=[
        ("files", ("dusk.png", big, "image/png")),
        ("files", ("notes.txt", b"hello there, plain text", "text/plain")),
        ("files", ("broken.png", broken, "image/png")),
    ])
    assert r.status_code == 200
    results = {row["filename"]: row for row in r.json()["results"]}
    assert results["dusk.png"]["ok"] is False and results["dusk.png"]["reason"] == "too_large"
    assert results["notes.txt"]["ok"] is False and results["notes.txt"]["reason"] == "unsupported_type"
    assert results["broken.png"]["ok"] is False and results["broken.png"]["reason"] == "unreadable"
    # The person's line for each refused file comes from here, the one table
    # (person_copy.INTAKE); the frontend shows it under "Couldn't upload {filename}.".
    assert results["dusk.png"]["person"] == "That's too large to save."
    assert results["notes.txt"]["person"] == person_copy.INTAKE["unsupported_type"]
    assert results["broken.png"]["person"] == "That file couldn't be read. It may be damaged."
    # The raw text stays for agents and the console (additive change).
    assert "25 MB" in results["dusk.png"]["error"] or "cap" in results["dusk.png"]["error"]
    assert results["notes.txt"]["error"].startswith("unsupported file type")


def test_upload_to_a_missing_collection_says_its_code(client):
    h = human()
    r = client.post("/api/commons/intake/files", headers=h, data={"collection_id": "nope"},
                    files=[("files", ("a.png", png(3), "image/png"))])
    row = r.json()["results"][0]
    assert row["ok"] is False and row["reason"] == "unknown_collection"
    assert row["person"] == "That collection isn't there anymore. Reload to get the latest collections."


def test_the_frontend_says_the_same_words_for_the_lines_both_sides_use():
    """GM's 4xx fallback and 413 line are written on both sides of the wire:
    here for refusals the backend words itself, in the frontend for answers
    with no detail. Pin them equal so neither drifts."""
    from pathlib import Path
    ts = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "errorCopy.ts").read_text()
    assert f'REFUSED_FALLBACK_COPY = "{person_copy.FALLBACK}"' in ts
    assert f'TOO_LARGE_COPY = "{person_copy.INTAKE["too_large"]}"' in ts


def test_add_url_that_cant_be_fetched_says_written_copy_to_the_person(client, monkeypatch, caplog):
    h = human()
    col = collection(client, h)

    async def refuse(url, **_kwargs):
        raise net.FetchError("connection refused by 203.0.113.9:443")

    from commons import intake
    # add_url binds net.safe_fetch as its default at import.
    monkeypatch.setitem(intake.add_url.__kwdefaults__, "fetch", refuse)
    with caplog.at_level(logging.INFO, logger="routes.commons"):
        r = client.post("/api/commons/intake/url", json={"url": "https://example.com/a.png", "collection_id": col}, headers=h)
    assert r.status_code == 422
    assert r.json()["detail"] == "Nebula couldn't get that URL. Check the address, or save the image and upload it."
    assert "203.0.113.9" not in r.json()["detail"]
    assert "203.0.113.9" in caplog.text


def test_link_folder_refusals_are_written_copy(client, tmp_path):
    h = human()
    missing = client.post("/api/commons/folders", json={"path": str(tmp_path / "nowhere")}, headers=h)
    assert missing.status_code == 422
    assert missing.json()["detail"] == "That isn't a folder. Check the path and try again."
    assert str(tmp_path) not in missing.json()["detail"]
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    link = client.post("/api/commons/folders", json={"path": str(tmp_path / "link")}, headers=h)
    assert link.status_code == 422
    assert link.json()["detail"] == "Choose the folder itself, not a shortcut to it."  # GM, round 3


def _asset(client, h) -> str:
    col = collection(client, h)
    return client.post("/api/commons/intake/files", headers=h, data={"collection_id": col},
                       files=[("files", ("a.png", png(4), "image/png"))]).json()["results"][0]["asset_id"]


def test_records_refusals_are_written_copy_for_the_person(client):
    h = human()
    asset_id = _asset(client, h)
    region = client.post(f"/api/commons/assets/{asset_id}/regions", json={"box": [0.5, 0.5, 2, 2], "label": "x"}, headers=h)
    assert region.status_code == 422
    assert region.json()["detail"] == "That region is outside the image. Draw it again."
    correction = client.post(f"/api/commons/assets/{asset_id}/corrections",
                             json={"field_path": "summary", "op": "replace", "value": "x"}, headers=h)
    assert correction.status_code == 422
    assert correction.json()["detail"] == FALLBACK
    created = client.post(f"/api/commons/assets/{asset_id}/regions", json={"box": [0.1, 0.1, 0.2, 0.2], "label": "x"},
                          headers=h).json()
    status = client.patch(f"/api/commons/regions/{created['id']}", json={"status": "sparkly"}, headers=h)
    assert status.status_code == 422
    assert status.json()["detail"] == FALLBACK


def test_comment_refusal_person_gets_written_copy_agent_keeps_detail(client):
    h = human()
    asset_id = _asset(client, h)
    person = client.post("/api/commons/comments", json={"asset_id": asset_id, "text": "   "}, headers=h)
    assert person.status_code == 422
    assert person.json()["detail"] == "Write a comment first."
    agent = client.post("/api/commons/comments", json={"asset_id": asset_id, "text": "   "}, headers=AGENT)
    assert agent.status_code == 422
    assert agent.json()["detail"] == "comment text is empty"


def test_evaluation_prepare_raw_errors_become_written_copy(client, tmp_path, monkeypatch, caplog):
    h = human()
    folder = tmp_path / "set"
    folder.mkdir()
    (folder / "a.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"garbage" * 8)
    with caplog.at_level(logging.INFO, logger="routes.commons"):
        r = client.post("/api/commons/evaluation/prepare", json={"path": str(folder)}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == "A file in that folder couldn't be read. Check that it opens, then scan again."
    assert "a.png" in caplog.text

    from commons import evaluation

    def boom(_root):
        raise OSError(13, "Permission denied", str(folder))

    monkeypatch.setattr(evaluation, "_inventory", boom)
    r = client.post("/api/commons/evaluation/prepare", json={"path": str(folder)}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == "Nebula can't read that folder. Check that it exists and that Nebula can open it."
    assert "Permission denied" not in r.json()["detail"]


def test_written_evaluation_reasons_stay_as_they_are(client):
    h = human()
    r = client.post("/api/commons/evaluation/prepare", json={"path": "relative/path"}, headers=h)
    assert r.status_code == 409
    assert r.json()["detail"] == "Enter the folder's full path, starting with /."  # round 3


# -- the specific text reaches the terminal ------------------------------------
# Review of round 2: the backend configures no logging, so `routes.commons`
# inherits the root's WARNING level and a logger.info line is dropped at run
# time. GM: "Log str(exc)". These tests don't lower the level.

def _logged(caplog, needle: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records
            if record.name == "routes.commons" and needle in record.getMessage()]


def test_a_refusal_the_person_reads_as_copy_logs_its_specific_text_at_a_level_that_prints(client, caplog):
    assert not logging.getLogger("routes.commons").isEnabledFor(logging.INFO)  # as uvicorn leaves it
    r = client.post("/api/commons/search", json={"filters": {"axes": []}}, headers=human())
    assert r.json()["detail"] == "Those filters didn't work. Clear them and try again."
    records = _logged(caplog, "axes must be an object")
    assert records and all(record.levelno >= logging.WARNING for record in records)


def test_a_refused_upload_file_logs_its_specific_text_at_a_level_that_prints(client, caplog):
    h = human()
    col = collection(client, h)
    r = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col},
                    files=[("files", ("notes.txt", b"hello there, plain text", "text/plain"))])
    assert r.json()["results"][0]["reason"] == "unsupported_type"
    records = _logged(caplog, "unsupported file type")
    assert records and all(record.levelno >= logging.WARNING for record in records)


def test_a_url_that_cant_be_fetched_is_logged_without_its_query_or_fragment(client, monkeypatch, caplog):
    h = human()
    col = collection(client, h)

    async def refuse(url, **_kwargs):
        raise net.FetchError(f"redirected to {url}&step=2 and then refused by 203.0.113.9:443")

    from commons import intake
    monkeypatch.setitem(intake.add_url.__kwdefaults__, "fetch", refuse)
    signed = "https://user:pw@cdn.example.com/a.png?sig=SECRET123&exp=9#frag-SECRET456"
    r = client.post("/api/commons/intake/url", json={"url": signed, "collection_id": col}, headers=h)
    assert r.status_code == 422
    records = _logged(caplog, "cdn.example.com/a.png")
    assert records and all(record.levelno >= logging.WARNING for record in records)
    assert "203.0.113.9" in caplog.text
    for secret in ("SECRET123", "SECRET456", "user:pw", "exp=9"):
        assert secret not in caplog.text
