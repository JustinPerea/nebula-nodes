"""The extraction page's server: its guards, its routes and the launch line. No model, no network."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from extraction import server
from extraction.intake import IMAGE_CAP

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
TOKEN = "t0ken-" + "x" * 30
PORT = 8870
BASE = f"http://127.0.0.1:{PORT}"
OWN_ORIGIN = BASE
AUTH = {"X-Extraction-Token": TOKEN}
POST = {"X-Extraction-Token": TOKEN, "Origin": OWN_ORIGIN}


def _client(dist: Path | None = None, dev: bool = False, base: str = BASE) -> TestClient:
    return TestClient(server.create_app(TOKEN, port=PORT, dev=dev, dist_dir=dist), base_url=base)


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "records"
    path.mkdir()
    return path


@pytest.fixture
def client():
    return _client()


def _upload(client, folder, fixture="gradient_accent.png", kind="drop", headers=POST, **extra):
    data = (FIXTURES / fixture).read_bytes()
    return client.post(
        "/api/records", headers=headers,
        files={"file": (fixture, data, "image/png")}, data={"folder": str(folder), "kind": kind, **extra},
    )


# -- guards -----------------------------------------------------------------------------------


def test_a_foreign_host_is_421_even_with_the_token(folder):
    bad = _client(base="http://evil.example:8870")
    assert bad.get("/api/folder", params={"path": str(folder)}, headers=AUTH).status_code == 421
    assert bad.get("/").status_code == 421
    wrong_port = _client(base="http://127.0.0.1:9999")
    assert wrong_port.get("/api/folder", params={"path": str(folder)}, headers=AUTH).status_code == 421


def test_localhost_is_an_accepted_host(folder):
    ok = _client(base=f"http://localhost:{PORT}")
    assert ok.get("/api/folder", params={"path": str(folder)}, headers=AUTH).status_code == 200


def test_the_dev_pair_is_accepted_only_with_dev(folder):
    dev_base = f"http://127.0.0.1:{server.DEV_PORT}"
    assert _client(dev=False, base=dev_base).get("/", headers={}).status_code == 421
    dev = _client(dev=True, base=dev_base)
    assert dev.get("/api/folder", params={"path": str(folder)}, headers=AUTH).status_code == 200
    from_vite = {**POST, "Origin": dev_base}
    assert _upload(dev, folder, headers=from_vite).status_code == 200


def test_no_token_or_a_wrong_token_is_401(client, folder):
    params = {"path": str(folder)}
    assert client.get("/api/folder", params=params).status_code == 401
    assert client.get("/api/folder", params=params, headers={"X-Extraction-Token": "nope"}).status_code == 401
    assert client.get("/api/folder", params=params, headers={"X-Extraction-Token": TOKEN + "x"}).status_code == 401
    assert client.get("/api/folder", params={**params, "token": TOKEN}).status_code == 401  # a query string isn't a token
    assert client.get("/api/nothing-here").status_code == 401  # the guard runs before routing
    assert _upload(client, folder, headers={"Origin": OWN_ORIGIN}).status_code == 401


def test_origin_null_is_403(client, folder):
    headers = {**AUTH, "Origin": "null"}
    assert client.get("/api/folder", params={"path": str(folder)}, headers=headers).status_code == 403
    assert _upload(client, folder, headers=headers).status_code == 403


def test_a_foreign_origin_is_403(client, folder):
    for origin in ("http://evil.example", f"http://evil.example:{PORT}", "https://127.0.0.1:8870",
                   "http://127.0.0.1:8871", f"{OWN_ORIGIN}/", "http://127.0.0.1:5870"):
        headers = {**AUTH, "Origin": origin}
        assert client.get("/api/folder", params={"path": str(folder)}, headers=headers).status_code == 403, origin
        assert _upload(client, folder, headers=headers).status_code == 403, origin
    assert client.get("/", headers={"Origin": "http://evil.example"}).status_code == 403


def test_a_post_with_no_origin_is_403(client, folder):
    assert _upload(client, folder, headers=AUTH).status_code == 403
    assert not list(folder.iterdir())


def test_no_response_carries_cors_headers(client, folder):
    replies = [
        client.get("/api/folder", params={"path": str(folder)}, headers={**AUTH, "Origin": OWN_ORIGIN}),
        client.get("/api/folder", params={"path": str(folder)}, headers={**AUTH, "Origin": "http://evil.example"}),
        client.options("/api/records", headers={**AUTH, "Origin": "http://evil.example",
                                                "Access-Control-Request-Method": "POST"}),
        client.get("/"),
    ]
    for reply in replies:
        assert not [k for k in reply.headers if k.lower().startswith("access-control-")]


def test_an_oversize_body_is_413_by_its_length(client, folder):
    body = b"x" * (server.BODY_CAP + 1)
    reply = client.post("/api/records", headers={**POST, "Content-Type": "application/octet-stream"}, content=body)
    assert reply.status_code == 413
    assert reply.json() == {"error": "That upload is too large."}
    assert not list(folder.iterdir())


def test_an_oversize_body_without_a_length_is_413(client):
    def chunks():
        for _ in range(server.BODY_CAP // (1024 * 1024) + 2):
            yield b"x" * (1024 * 1024)

    request = client.build_request("POST", "/api/records", headers={**POST, "Content-Type": "application/octet-stream"},
                                   content=chunks())
    assert "content-length" not in request.headers
    assert request.headers.get("transfer-encoding") == "chunked"
    assert client.send(request).status_code == 413


def test_a_body_under_the_cap_gets_past_the_size_guard(client, folder):
    # The cap is the image cap plus a margin for the form, so a full-size image still gets to intake.
    assert server.BODY_CAP > IMAGE_CAP
    reply = client.post("/api/records", headers={**POST, "Content-Type": "application/octet-stream"}, content=b"x" * 100)
    assert reply.status_code == 400  # not a form: refused by the route, not the guard


# -- routes -----------------------------------------------------------------------------------


def test_upload_list_get_and_rendering(client, folder):
    first = _upload(client, folder, kind="drop")
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["existed"] is False
    record = body["record"]
    assert record["status"] == "proposal"
    assert record["source"]["kind"] == "drop"
    assert record["source"]["name"] == "gradient_accent.png"
    assert record["source"]["path"] is None  # a browser gives no path
    assert (folder / record["id"] / "record.json").is_file()

    again = _upload(client, folder)
    assert again.json()["existed"] is True
    assert again.json()["record"]["id"] == record["id"]

    listing = client.get("/api/folder", params={"path": str(folder)}, headers=AUTH)
    assert listing.status_code == 200
    rows = listing.json()
    assert rows["folder"] == str(folder.resolve())
    assert [r["id"] for r in rows["records"]] == [record["id"]]

    got = client.get(f"/api/records/{record['id']}", params={"folder": str(folder)}, headers=AUTH)
    assert got.status_code == 200
    assert got.json()["record"]["id"] == record["id"]
    assert got.json()["effective"]["structure"]["measured"]["palette"] == record["structure"]["measured"]["palette"]

    image = client.get(f"/api/records/{record['id']}/rendering", params={"folder": str(folder)}, headers=AUTH)
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.headers["cache-control"] == "no-store"
    assert image.content.startswith(b"\x89PNG")
    assert image.content == (folder / record["id"] / "rendering.png").read_bytes()


def test_each_kind_is_kept_and_a_bad_kind_is_a_sentence(client, folder):
    for kind in ("drop", "paste", "file"):
        reply = _upload(client, folder, kind=kind)
        assert reply.status_code == 200
    bad = _upload(client, folder, kind="clipboard")
    assert bad.status_code == 400
    assert re.fullmatch(r"[A-Z][^\n]*\.", bad.json()["error"])


def test_the_name_field_is_kept_without_a_directory(client, folder):
    reply = _upload(client, folder, kind="paste", name="../../etc/pasted.png")
    assert reply.status_code == 200
    assert reply.json()["record"]["source"]["name"] == "pasted.png"


def test_a_file_that_is_not_an_image_is_a_plain_400(client, folder):
    reply = client.post("/api/records", headers=POST, files={"file": ("notes.txt", b"hello there", "text/plain")},
                        data={"folder": str(folder), "kind": "file"})
    assert reply.status_code == 400
    assert "image" in reply.json()["error"]
    assert not list(folder.iterdir())


def test_a_missing_field_is_a_plain_400(client):
    reply = client.post("/api/records", headers=POST, data={"kind": "file"})
    assert reply.status_code == 400
    assert set(reply.json()) == {"error"}


def test_a_folder_that_does_not_exist_is_a_plain_400(client, tmp_path):
    reply = client.get("/api/folder", params={"path": str(tmp_path / "nowhere")}, headers=AUTH)
    assert reply.status_code == 400
    assert reply.json() == {"error": "That folder doesn’t exist. Create it first, then try again."}


def test_the_state_folder_is_refused_as_a_plain_4xx_sentence(client, tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("NEBULA_STATE_DIR", str(state))
    for path in (state, state / "inner"):
        path.mkdir(exist_ok=True)
        listing = client.get("/api/folder", params={"path": str(path)}, headers=AUTH)
        assert 400 <= listing.status_code < 500
        assert re.fullmatch(r"[A-Z][^\n]*\.", listing.json()["error"])
        assert "state folder" in listing.json()["error"]
        posted = _upload(client, path)
        assert 400 <= posted.status_code < 500
        assert "state folder" in posted.json()["error"]
    assert not list(state.rglob("record.json"))


def test_a_record_id_that_is_not_one_is_refused(client, folder):
    for bad in ("..", "ex_short", "ex_" + "g" * 16, "x" * 40):
        got = client.get(f"/api/records/{bad}", params={"folder": str(folder)}, headers=AUTH)
        assert got.status_code in (400, 404)
        assert set(got.json()) == {"error"}
        image = client.get(f"/api/records/{bad}/rendering", params={"folder": str(folder)}, headers=AUTH)
        assert image.status_code in (400, 404)


def test_a_record_that_is_not_there_is_a_plain_400(client, folder):
    missing = "ex_" + "0" * 16
    got = client.get(f"/api/records/{missing}", params={"folder": str(folder)}, headers=AUTH)
    assert got.status_code == 400
    assert "error" in got.json()


def test_a_symlinked_rendering_is_not_served(client, folder, tmp_path):
    record = _upload(client, folder).json()["record"]
    secret = tmp_path / "secret.png"
    secret.write_bytes(b"\x89PNG\r\n\x1a\nsecret")
    rendering = folder / record["id"] / "rendering.png"
    rendering.unlink()
    rendering.symlink_to(secret)
    image = client.get(f"/api/records/{record['id']}/rendering", params={"folder": str(folder)}, headers=AUTH)
    assert image.status_code == 400
    assert b"secret" not in image.content


# -- the built page ---------------------------------------------------------------------------


def test_the_page_is_served_from_dist_and_a_missing_build_says_so(tmp_path):
    missing = _client(dist=tmp_path / "not-built")
    reply = missing.get("/")
    assert reply.status_code == 200
    assert "npm run extraction:build" in reply.text
    assert reply.headers["content-type"].startswith("text/plain")

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "extraction.html").write_text("<!doctype html><title>page</title>")
    (dist / "assets" / "a.js").write_text("console.log(1)")
    built = _client(dist=dist)
    index = built.get("/")
    assert index.status_code == 200 and "<title>page</title>" in index.text
    assert index.headers["content-type"].startswith("text/html")
    assert built.get("/assets/a.js").status_code == 200
    assert built.get("/assets/nope.js").status_code == 404
    assert built.get("/api/missing-route", headers=AUTH).status_code == 404


def test_a_static_path_cannot_leave_dist(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "extraction.html").write_text("page")
    (tmp_path / "secret.txt").write_text("the secret")
    (dist / "link.txt").symlink_to(tmp_path / "secret.txt")
    built = _client(dist=dist)
    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/assets/../../secret.txt",
                 "/link.txt", "//" + str(tmp_path / "secret.txt")):
        reply = built.get(path)
        assert "the secret" not in reply.text, path
        assert reply.status_code in (200, 404), path
    # the handler itself, with the raw path a server would hand it
    assert server._static(dist, "../secret.txt").status_code == 404
    assert server._static(dist, "link.txt").status_code == 404
    assert server._static(dist, str(tmp_path / "secret.txt")).status_code == 404


# -- the token ----------------------------------------------------------------------------------


def test_the_launch_line_has_the_token_only_after_the_hash():
    line = server.launch_line("abc_DEF-123", 8870, dev=False)
    assert line == "http://127.0.0.1:8870/#token=abc_DEF-123"
    path, _, fragment = line.partition("#")
    assert "abc_DEF-123" not in path and "?" not in line
    assert fragment == "token=abc_DEF-123"
    assert server.launch_line("abc", 8870, dev=True) == "http://127.0.0.1:5870/#token=abc"


def test_serve_prints_one_line_binds_loopback_and_keeps_the_log_quiet(monkeypatch, capsys, folder):
    seen = {}

    def fake_run(app, **kwargs):
        seen["app"] = app
        seen["kwargs"] = kwargs

    import uvicorn
    monkeypatch.setattr(uvicorn, "run", fake_run)
    assert server.serve(port=PORT, dev=False) == 0
    out = capsys.readouterr()
    lines = out.out.strip().splitlines()
    assert len(lines) == 1 and out.err == ""
    match = re.fullmatch(r"http://127\.0\.0\.1:8870/#token=([A-Za-z0-9_-]{43})", lines[0])
    assert match, lines[0]
    token = match.group(1)
    assert seen["kwargs"]["host"] == "127.0.0.1"
    assert seen["kwargs"]["port"] == PORT
    assert seen["kwargs"]["access_log"] is False

    live = TestClient(seen["app"], base_url=BASE)
    assert live.get("/api/folder", params={"path": str(folder)}).status_code == 401
    assert live.get("/api/folder", params={"path": str(folder)}, headers={"X-Extraction-Token": token}).status_code == 200


def test_each_launch_makes_a_new_token(monkeypatch, capsys):
    import uvicorn
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: None)
    server.serve(port=PORT)
    server.serve(port=PORT)
    first, second = capsys.readouterr().out.strip().splitlines()
    assert first != second


def test_no_response_body_or_header_contains_the_token(client, folder, tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "extraction.html").write_text("<!doctype html>")
    built = _client(dist=dist)
    record = _upload(client, folder).json()["record"]
    replies = [
        client.get("/api/folder", params={"path": str(folder)}, headers=AUTH),
        client.get(f"/api/records/{record['id']}", params={"folder": str(folder)}, headers=AUTH),
        client.get(f"/api/records/{record['id']}/rendering", params={"folder": str(folder)}, headers=AUTH),
        client.get("/api/folder", params={"path": str(folder)}),
        client.get("/api/folder", params={"path": str(folder)}, headers={**AUTH, "Origin": "null"}),
        client.get("/api/folder", params={"path": str(tmp_path / "nowhere")}, headers=AUTH),
        client.get("/", headers={}),
        _client(base="http://evil.example:8870").get("/api/folder", headers=AUTH),
        _upload(client, folder, headers=AUTH),
        _upload(client, folder, kind="bad"),
        built.get("/"),
        built.get("/missing"),
    ]
    for reply in replies:
        assert TOKEN.encode() not in reply.content
        assert TOKEN not in json.dumps(dict(reply.headers))
