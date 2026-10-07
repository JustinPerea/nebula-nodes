from __future__ import annotations

import io
import secrets

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from commons import actors, runtime


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    runtime.reset_for_tests()
    monkeypatch.setattr(actors, "ui_session", actors.UISession())
    from main import app

    yield TestClient(app)
    runtime.reset_for_tests()


def png(seed=1) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (24, 24, 3), dtype=np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def human(client) -> dict:
    token = secrets.token_urlsafe(32)
    actors.ui_session.set(token)
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("origin", [None, "http://localhost:5173", "http://127.0.0.1:5173", "https://evil.example"])
def test_session_endpoint_is_absent(client, origin):
    # Test the router directly too: LocalRequestGuard still rejects foreign origins.
    from fastapi import FastAPI
    from routes.commons import router
    app = FastAPI()
    app.include_router(router)
    headers = {"Origin": origin} if origin else {}
    assert TestClient(app).post("/api/commons/session", headers=headers).status_code in (404, 405)
    if origin != "https://evil.example":
        assert client.post("/api/commons/session", headers=headers).status_code in (404, 405)


def test_human_only_routes_reject_agents_and_forged_humans(client):
    assert client.post("/api/commons/collections", json={"name": "x"}).status_code == 403
    assert client.post("/api/commons/collections", json={"name": "x"},
                       headers={"X-Nebula-Client": "human:justin"}).status_code == 403
    assert client.post("/api/commons/collections", json={"name": "x"},
                       headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.post("/api/commons/collections", json={"name": "x"}, headers=human(client))
    assert r.status_code == 200 and r.json()["name"] == "x"


def test_json_routes_require_json_content_type(client):
    r = client.post("/api/commons/collections", content='{"name": "x"}',
                    headers={**human(client), "Content-Type": "text/plain"})
    assert r.status_code == 415


def test_upload_search_get_comment_flow_with_actor_stamps(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "ui-inspo"}, headers=h).json()
    up = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"], "why": "dense grid"},
                     files=[("files", ("a.png", png(1), "image/png"))]).json()
    asset_id = up["results"][0]["asset_id"]
    results = client.post("/api/commons/search", json={"query": "grid"}).json()["results"]
    assert results[0]["id"] == asset_id
    detail = client.get(f"/api/commons/assets/{asset_id}").json()
    assert detail["memberships"][0]["why"].startswith("<untrusted-commons-text>")  # agent view is wrapped
    assert "path" not in detail
    human_detail = client.get(f"/api/commons/assets/{asset_id}", headers=h).json()
    assert human_detail["memberships"][0]["why"] == "dense grid"
    c = client.post("/api/commons/comments", json={"asset_id": asset_id, "text": "use the gutter"},
                    headers={"X-Nebula-Client": "cursor"}).json()
    assert c["actor"] == "agent:mcp:cursor"
    blob = client.get(detail["blob_url"])
    assert blob.status_code == 200 and blob.content == png(1)


def test_agent_add_goes_to_inbox_and_accept_queues(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    r = client.post("/api/commons/add/upload", headers={"X-Nebula-Client": "cursor"},
                    data={"collection": col["id"], "why": "found a strong grid"},
                    files={"file": ("f.png", png(2), "image/png")}).json()
    assert r["in_inbox"] is True
    assert client.post("/api/commons/search", json={"query": "grid"}).json()["results"] == []
    m = client.post(f"/api/commons/memberships/{r['membership_id']}/accept", headers=h).json()
    assert m["in_inbox"] == 0


def test_agent_path_add_uses_the_turn_token(client, tmp_path):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    allowed = tmp_path / "out"
    allowed.mkdir()
    (allowed / "g.png").write_bytes(png(3))
    token = actors.agent_registry.mint("claude", [allowed])
    ok = client.post("/api/commons/add", headers={"Authorization": f"Agent {token}"},
                     json={"source": str(allowed / "g.png"), "collection": col["id"], "why": "generated ref"})
    assert ok.status_code == 200
    denied = client.post("/api/commons/add", headers={"X-Nebula-Client": "cursor"},
                         json={"source": str(allowed / "g.png"), "collection": col["id"], "why": "x"})
    assert denied.status_code == 403
    actors.agent_registry.revoke(token)


def test_borrow_rejection_is_422_with_reason(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    asset_id = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"]},
                           files=[("files", ("a.png", png(4), "image/png"))]).json()["results"][0]["asset_id"]
    r = client.post("/api/commons/borrow", json={"id": asset_id, "attribute": "layout", "value": "grid",
                                                 "used_in": {"kind": "external", "ref": "x"}, "why": "w"})
    assert r.status_code == 422 and "not in the analysis" in r.json()["detail"]


def test_status_reports_queue_and_meter(client):
    s = client.get("/api/commons/status").json()
    assert s["worker"]["running"] is False
    assert s["meter"]["cap"] == 20 and "resets_at" in s["meter"]


def test_foreign_origin_cannot_write(client):
    r = client.post("/api/commons/collections", json={"name": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403  # LocalRequestGuard, before the route


def test_export_and_purge(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    asset_id = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"]},
                           files=[("files", ("a.png", png(5), "image/png"))]).json()["results"][0]["asset_id"]
    z = client.get("/api/commons/export", headers=h)
    assert z.status_code == 200 and z.headers["content-type"] == "application/zip"
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert "commons.db" in names and any(n.startswith("blobs/") for n in names)
    assert client.delete(f"/api/commons/assets/{asset_id}", headers=h).json() == {"purged": asset_id}
    assert client.get(f"/api/commons/assets/{asset_id}", headers=h).status_code == 404


# -- added in Task 12 for fixes beyond the plan ---------------------------------

def test_agent_detail_keeps_collection_ids_usable_and_wraps_names(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "ui-inspo"}, headers=h).json()
    asset_id = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"]},
                           files=[("files", ("a.png", png(6), "image/png"))]).json()["results"][0]["asset_id"]
    m = client.get(f"/api/commons/assets/{asset_id}").json()["memberships"][0]
    assert m["collection"] == col["id"]
    assert m["collection_name"].startswith("<untrusted-commons-text>")


def test_list_of_names_is_wrapped_for_agents():
    from commons import untrusted
    from routes.commons import TEXT_KEYS

    out = untrusted.wrap_fields({"also_in": ["a", "b"], "id": "ast_1"}, TEXT_KEYS)
    assert all(x.startswith("<untrusted-commons-text>") for x in out["also_in"]) and out["id"] == "ast_1"


def test_settings_reject_bad_values_and_agent_meter_uses_its_own_cap(client):
    h = human(client)
    assert client.patch("/api/commons/settings", json={"daily_cap": "lots"}, headers=h).status_code == 422
    assert client.patch("/api/commons/settings", json={"nope": 1}, headers=h).status_code == 422
    r = client.patch("/api/commons/settings", json={"agent_add_daily_cap": 3}, headers=h)
    assert r.status_code == 200 and r.json()["agent_add_daily_cap"] == 3
    s = client.get("/api/commons/status").json()
    assert s["agent_adds"]["cap"] == 3 and s["meter"]["cap"] == 20


def test_membership_patch_reindexes_and_validates_role(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    up = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"]},
                     files=[("files", ("a.png", png(7), "image/png"))]).json()["results"][0]
    assert client.patch(f"/api/commons/memberships/{up['membership_id']}", json={"role": "bogus"},
                        headers=h).status_code == 422
    assert client.post("/api/commons/search", json={"query": "brutalist"}).json()["results"] == []
    client.patch(f"/api/commons/memberships/{up['membership_id']}", json={"why": "brutalist poster"}, headers=h)
    assert client.post("/api/commons/search", json={"query": "brutalist"}).json()["results"][0]["id"] == up["asset_id"]


def test_multipart_routes_require_multipart(client):
    r = client.post("/api/commons/add/upload", json={"collection": "x", "why": "y"},
                    headers={"X-Nebula-Client": "cursor"})
    assert r.status_code == 415


def test_video_detail_lists_keyframes_with_blob_urls(client, tmp_path):
    import shutil
    import subprocess
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    video = tmp_path / "v.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=2:r=10",
                    "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2:r=10",
                    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
                    "-pix_fmt", "yuv420p", str(video)], check=True, timeout=120)
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "motion"}, headers=h).json()
    up = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"]},
                     files=[("files", ("v.mp4", video.read_bytes(), "video/mp4"))]).json()["results"][0]
    detail = client.get(f"/api/commons/assets/{up['asset_id']}", headers=h).json()
    frames = detail["keyframes"]
    assert len(frames) >= 2 and [f["t"] for f in frames] == sorted(f["t"] for f in frames)
    for f in frames:
        child = client.get(f"/api/commons/assets/{f['asset_id']}", headers=h).json()["asset"]
        assert f["blob_url"] == f"/api/commons/blobs/{child['blob_key']}"
        assert client.get(f["blob_url"]).status_code == 200
    image = client.post("/api/commons/intake/files", headers=h, data={"collection_id": col["id"]},
                        files=[("files", ("a.png", png(9), "image/png"))]).json()["results"][0]
    assert "keyframes" not in client.get(f"/api/commons/assets/{image['asset_id']}", headers=h).json()


def _ready_asset(client, h, collection_id, seed):
    up = client.post("/api/commons/intake/files", headers=h, data={"collection_id": collection_id},
                     files=[("files", ("a.png", png(seed), "image/png"))]).json()
    asset_id = up["results"][0]["asset_id"]
    detail = client.get(f"/api/commons/assets/{asset_id}", headers=h).json()
    return asset_id, detail


def test_agent_cannot_borrow_a_quarantined_asset(client):
    from commons import records

    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    asset_id, detail = _ready_asset(client, h, col["id"], 11)
    hex_ = detail["effective"]["fields"]["palette"][0]["hex"]
    body = {"id": asset_id, "attribute": "palette", "value": hex_, "used_in": {"kind": "external", "ref": "x"},
            "why": "w"}
    records.quarantine_add(runtime.get_store(), [(detail["asset"]["phash"], "eval/x.png")])
    r = client.post("/api/commons/borrow", json=body, headers={"X-Nebula-Client": "cursor"})
    assert r.status_code == 422 and "scope" in r.json()["detail"]


def test_agent_fidelity_is_scoped_to_its_brand(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "acme refs", "brand": "acme"}, headers=h).json()
    asset_id, detail = _ready_asset(client, h, col["id"], 12)
    hex_ = detail["effective"]["fields"]["palette"][0]["hex"]
    b = client.post("/api/commons/borrow", headers=h,
                    json={"id": asset_id, "attribute": "palette", "value": hex_,
                          "used_in": {"kind": "external", "ref": "x"}, "why": "w"}).json()
    agent = {"X-Nebula-Client": "cursor"}
    assert client.post(f"/api/commons/borrowings/{b['id']}/fidelity", headers=agent).status_code == 404
    ok = client.post(f"/api/commons/borrowings/{b['id']}/fidelity?brand=acme", headers=agent)
    assert ok.status_code == 200 and ok.json()["status"] == "unverifiable"


def test_comment_region_must_belong_to_the_asset(client):
    h = human(client)
    col = client.post("/api/commons/collections", json={"name": "x"}, headers=h).json()
    a, _ = _ready_asset(client, h, col["id"], 13)
    b, _ = _ready_asset(client, h, col["id"], 14)
    region = client.post(f"/api/commons/assets/{b}/regions", headers=h,
                         json={"box": [0.1, 0.1, 0.3, 0.3], "label": "button"}).json()
    agent = {"X-Nebula-Client": "cursor"}
    wrong = client.post("/api/commons/comments", headers=agent,
                        json={"asset_id": a, "text": "x", "region_id": region["id"]})
    assert wrong.status_code == 422
    missing = client.post("/api/commons/comments", headers=agent,
                          json={"asset_id": a, "text": "x", "region_id": "reg_nope"})
    assert missing.status_code == 422
    right = client.post("/api/commons/comments", headers=agent,
                        json={"asset_id": b, "text": "x", "region_id": region["id"]})
    assert right.status_code == 200 and right.json()["region"] == region["id"]


def test_blob_authority_scope_quarantine_and_orphans(client):
    from commons import records
    h = human(client)
    col = client.post('/api/commons/collections', headers=h, json={'name': 'private', 'brand': 'acme'}).json()
    parent_id, detail = _ready_asset(client, h, col['id'], 81)
    child_id, child = _ready_asset(client, h, col['id'], 82)
    store = runtime.get_store()
    with store.db.tx() as conn:
        conn.execute('UPDATE assets SET parent_asset = ?, keyframe_t = 1 WHERE id = ?', (parent_id, child_id))
        conn.execute('DELETE FROM memberships WHERE asset = ?', (child_id,))
    token = actors.agent_registry.mint('codex', [])
    agent = {'Authorization': f'Agent {token}'}
    try:
        for url in (detail['blob_url'], child['blob_url']):
            assert client.get(url, headers=agent).status_code == 404
            assert client.get(url + '?brand=acme', headers=agent).status_code == 200
            assert client.get(url, headers=h).status_code == 200
        records.quarantine_add(store, [(detail['asset']['phash'], 'eval/private.png')])
        for url in (detail['blob_url'], child['blob_url']):
            assert client.get(url + '?brand=acme', headers=agent).status_code == 404
            assert client.get(url, headers=h).status_code == 200
        _, key = store.put_blob(b'orphan bytes', 'png')
        assert client.get(f'/api/commons/blobs/{key}', headers=agent).status_code == 404
        assert client.get(f'/api/commons/blobs/{key}', headers=h).status_code == 200
        for headers in (agent, h):
            assert client.get('/api/commons/blobs/' + '0' * 64 + '.png', headers=headers).status_code == 404
        assert client.get(detail['blob_url'], headers={'Authorization': 'Bearer invalid'}).status_code == 401
    finally:
        actors.agent_registry.revoke(token)


def _chat_turn(client, runner_name, monkeypatch):
    from services.chat_session import AGENT_RUNNERS
    captured = {}
    async def runner(*args, **kwargs):
        captured.update(kwargs)
        captured['allowed_dirs'] = actors.agent_registry.lookup(kwargs['agent_token'])['allowed_dirs']
        yield {'type': 'done'}
    monkeypatch.setitem(AGENT_RUNNERS, runner_name, runner)
    events = []
    with client.websocket_connect('/ws/chat') as ws:
        header = human(client)['Authorization']
        ws.send_json({'type': 'send', 'message': 'test', 'agent': runner_name,
                      'commonsToken': header.removeprefix('Bearer ')})
        while True:
            events.append(ws.receive_json())
            if events[-1]['type'] == 'done':
                break
    return captured, events


@pytest.mark.parametrize('runner_name', ['claude', 'codex'])
def test_runner_grants_never_reach_commons_in_production_layout(client, monkeypatch, tmp_path, runner_name):
    """The store sits inside the state dir in both desktop and browser mode, so no
    grant may be the state dir, the commons root, or anything that contains it.

    This checks the grants the dispatcher hands each runner. Permission-profile
    and native alias-denial evidence are covered separately; these fake runners
    establish the dispatched capability and directory contract only."""
    import main
    from commons.paths import commons_root
    from services.agent_profiles import paths_overlap
    state = tmp_path / 'state'
    monkeypatch.delenv('NEBULA_COMMONS_ROOT')
    monkeypatch.setenv('NEBULA_STATE_DIR', str(state))
    monkeypatch.setattr(main, '_STATE_DIR', state)
    root = commons_root()
    assert root == state / 'commons'
    root.mkdir(parents=True)

    captured, _ = _chat_turn(client, runner_name, monkeypatch)

    assert captured['agent_token']
    assert main._STATE_DIR not in captured['extra_dirs']
    assert captured['extra_dirs'] == [main.OUTPUT_ROOT]
    for granted in [*captured['extra_dirs'], captured['workdir'], *captured['allowed_dirs']]:
        assert not paths_overlap(granted, root), granted


def test_chat_turn_refuses_to_start_when_output_root_contains_commons(client, monkeypatch):
    import main
    monkeypatch.setenv('NEBULA_COMMONS_ROOT', str(main.OUTPUT_ROOT / 'commons'))
    captured, events = _chat_turn(client, 'claude', monkeypatch)
    assert captured == {}
    assert any(e['type'] == 'error' and 'overlaps protected storage' in e['message'] for e in events)
