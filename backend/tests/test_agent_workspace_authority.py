"""Session binding is enforced by authenticated state, never caller brand/path hints."""
from __future__ import annotations

import io
import os
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from commons import actors, intake, runtime


@pytest.fixture
def scoped_api(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "commons"))
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())
    runtime.reset_for_tests()
    from routes.commons import router
    app = FastAPI()
    app.include_router(router)
    store = runtime.get_store()
    collections = {brand: store.ensure_collection(str(brand), "manual", brand=brand, actor=actors.HUMAN)
                   for brand in (None, "acme", "other", "good-machines", "mitamaton")}
    assets = {}
    for i, (brand, collection) in enumerate(collections.items()):
        image = io.BytesIO()
        Image.new("RGB", (20, 20), (i * 30, 60, 180)).save(image, "PNG")
        assets[brand] = intake.add_bytes(store, image.getvalue(), filename=f"{i}.png",
                                         collection_id=collection["id"], actor=actors.HUMAN,
                                         source={"kind": "file"})
    yield TestClient(app), store, collections, assets
    runtime.reset_for_tests()


def _headers(tmp_path, brand):
    token = actors.agent_registry.mint("codex", [tmp_path], brand=brand, workspace=tmp_path)
    return {"Authorization": f"Agent {token}"}


def test_registry_binding_survives_model_updates_and_rejects_aliases(tmp_path, monkeypatch):
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError):
        actors.agent_registry.mint("codex", [alias], brand="acme", workspace=alias)
    token = actors.agent_registry.mint("codex", [real], brand="acme", workspace=real)
    actors.agent_registry.set_model(token, "reported-model")
    actor = actors.resolve_actor({"Authorization": f"Agent {token}"})
    assert actor.brand == "acme" and actor.workspace == real
    assert actor.allowed_dirs == (real,) and actor.id == "agent:codex/reported-model"
    assert actor.workspace_identity is not None
    actors.agent_registry.revoke(token)
    with pytest.raises(actors.AuthError):
        actors.resolve_actor({"Authorization": f"Agent {token}"})


@pytest.mark.parametrize("replacement", ["new_directory", "symlink"])
def test_registry_rejects_workspace_replacement(tmp_path, monkeypatch, replacement):
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    token = actors.agent_registry.mint("codex", [workspace], workspace=workspace)
    workspace.rename(tmp_path / "previous")
    if replacement == "new_directory":
        workspace.mkdir()
    else:
        workspace.symlink_to(tmp_path / "previous", target_is_directory=True)
    with pytest.raises(actors.AuthError, match="workspace"):
        actors.resolve_actor({"Authorization": f"Agent {token}"})


@pytest.mark.parametrize("brand,visible", [(None, {None}), ("acme", {None, "acme"}),
                                          ("mitamaton", {None, "mitamaton", "good-machines"})])
def test_bound_reads_use_session_brand_even_when_omitted(scoped_api, tmp_path, brand, visible):
    client, _, collections, assets = scoped_api
    headers = _headers(tmp_path, brand)
    response = client.post("/api/commons/search", headers=headers, json={})
    assert response.status_code == 200
    assert {row["id"] for row in response.json()["results"]} == {assets[b].asset["id"] for b in visible}
    listed = client.get("/api/commons/collections", headers=headers)
    assert {row["id"] for row in listed.json()} == {collections[b]["id"] for b in visible}
    for asset_brand, result in assets.items():
        expected = 200 if asset_brand in visible else 404
        assert client.get(f"/api/commons/assets/{result.asset['id']}", headers=headers).status_code == expected
        assert client.get(f"/api/commons/blobs/{result.asset['blob_key']}", headers=headers).status_code == expected
    conflict = "acme" if brand is None else "other"
    assert client.post("/api/commons/search", headers=headers, json={"brand": conflict}).status_code == 403
    assert client.get(f"/api/commons/collections?brand={conflict}", headers=headers).status_code == 403
    result = assets[None]
    assert client.get(f"/api/commons/assets/{result.asset['id']}?brand={conflict}", headers=headers).status_code == 403
    assert client.get(f"/api/commons/blobs/{result.asset['blob_key']}?brand={conflict}", headers=headers).status_code == 403
    assert client.post("/api/commons/search", headers=headers, json={"all_scopes": True}).status_code == 403


def test_unbound_clients_retain_explicit_brand_scope(scoped_api):
    client, _, _, assets = scoped_api
    token = actors.agent_registry.mint("external-test", [])
    for headers in ({"X-Nebula-Client": "external"}, {"Authorization": f"Agent {token}"}):
        asset = assets["other"].asset
        assert client.get(f"/api/commons/assets/{asset['id']}", headers=headers).status_code == 404
        assert client.get(f"/api/commons/assets/{asset['id']}?brand=other", headers=headers).status_code == 200


def test_bound_add_target_checked_before_fetch_or_meter(scoped_api, tmp_path, monkeypatch):
    client, store, collections, _ = scoped_api
    headers = _headers(tmp_path, "acme")
    fetch = Mock(side_effect=AssertionError("out-of-scope source must not be fetched"))
    monkeypatch.setattr(intake.net, "safe_fetch", fetch)
    body = {"source": "https://example.com/ref.png", "collection": collections["other"]["id"], "why": "ref"}
    assert client.post("/api/commons/add", headers=headers, json=body).status_code == 403
    assert client.post("/api/commons/add/upload", headers=headers,
                       data={"collection": body["collection"], "why": "ref"},
                       files={"file": ("ref.png", b"must not decode")}).status_code == 403
    actor = actors.resolve_actor(headers)
    with pytest.raises(intake.PathNotAllowed):
        intake.agent_add_bytes(store, actor=actor, data=b"never decode", filename="ref.png",
                               collection_id=body["collection"], why="ref")
    fetch.assert_not_called()


def test_bound_detail_and_concentration_hide_other_brand_borrowings(scoped_api, tmp_path):
    from commons import borrow
    from commons.effective import effective
    client, store, collections, assets = scoped_api
    shared = assets[None].asset
    shared_other = intake.add_bytes(store, store.blob_path(shared["blob_key"]).read_bytes(),
                                    filename="shared.png", collection_id=collections["other"]["id"],
                                    actor=actors.HUMAN, source={"kind": "file"})
    value = effective(store, shared["id"])["fields"]["palette"][0]["hex"]
    rows = []
    for collection in (collections[None], collections["other"]):
        rows.append(borrow.record_borrow(store, actor_id=actors.HUMAN, asset_id=shared["id"],
                                         attribute="palette", value=value, region_id=None,
                                         used_in={"kind": "external", "ref": "synthetic-work"}, why="palette",
                                         scope_ids={collection["id"]}))
    assert rows[1]["membership"] == shared_other.membership["id"]
    headers = _headers(tmp_path, "acme")
    detail = client.get(f"/api/commons/assets/{shared['id']}", headers=headers).json()
    assert [row["id"] for row in detail["borrowings"]] == [rows[0]["id"]]
    summary = client.get("/api/commons/concentration", headers=headers).json()
    assert summary["total"] == 1 and summary["by_asset"] == {shared["id"]: 1.0}
    assert client.get("/api/commons/borrowings?brand=other", headers=headers).status_code == 403
    assert client.post("/api/commons/comments", headers=headers,
                       json={"asset_id": shared["id"], "text": "comment", "brand": "other"}).status_code == 403


def test_bound_local_add_checks_protected_aliases_and_accepts_ordinary_files(scoped_api, tmp_path):
    client, store, collections, assets = scoped_api
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    headers = _headers(workspace, "acme")
    source = store.blob_path(assets[None].asset["blob_key"])
    alias = workspace / "alias.png"
    os.link(source, alias)
    body = {"collection": collections["acme"]["id"], "why": "synthetic ref", "source": str(alias)}
    assert client.post("/api/commons/add", headers=headers, json=body).status_code == 403
    normal = workspace / "ordinary.png"
    normal.write_bytes(source.read_bytes())
    body["source"] = str(normal)
    response = client.post("/api/commons/add", headers=headers, json=body)
    assert response.status_code == 200 and response.json()["in_inbox"] is True


def test_every_cli_request_propagates_turn_identity(monkeypatch):
    from cli.client import NebulaClient
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "scoped-token")
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={})
    client = NebulaClient()
    client._client.close()
    client._client = httpx.Client(base_url=client.base_url, transport=httpx.MockTransport(respond))
    try:
        client.get_agent_context()
        client.get_graph()
        client.get_node_image_path("n1")
        client.commons("GET", "/status")
        client._request("GET", "/api/graph", headers={"authorization": "forged"})
    finally:
        client._client.close()
    assert len(calls) == 5
    assert all(request.headers["Authorization"] == "Agent scoped-token" for request in calls)


def test_cli_dispatch_uses_server_workspace_and_restores_context(tmp_path, monkeypatch):
    from cli import __main__ as cli_main
    from cli.commands import graph
    from services.agent_workspaces import active_workspace
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    fake = Mock()
    fake.get_agent_context.return_value = {"workspace": str(workspace), "brand": "acme"}
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "scoped-token")
    monkeypatch.setenv("NEBULA_AGENT_WORKSPACE", str(tmp_path / "forged"))
    monkeypatch.setattr(cli_main, "NebulaClient", lambda url: fake)
    monkeypatch.setattr("sys.argv", ["nebula", "graph"])
    seen = []
    monkeypatch.setattr(graph, "run_show", lambda client: seen.append(active_workspace()))
    cli_main.main()
    assert seen == [workspace]
    assert active_workspace() is None


@pytest.mark.parametrize("context", [None, {}, {"workspace": ""}, {"workspace": "relative"}])
def test_cli_invalid_context_fails_before_dispatch(tmp_path, monkeypatch, context):
    from cli import __main__ as cli_main
    from cli.commands import graph
    fake = Mock()
    fake.get_agent_context.return_value = context
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "scoped-token")
    monkeypatch.setattr(cli_main, "NebulaClient", lambda url: fake)
    monkeypatch.setattr("sys.argv", ["nebula", "graph"])
    handler = Mock()
    monkeypatch.setattr(graph, "run_show", handler)
    with pytest.raises(SystemExit) as error:
        cli_main.main()
    assert error.value.code == 1
    handler.assert_not_called()


def test_cli_context_auth_failure_does_not_fallback(monkeypatch):
    from cli import __main__ as cli_main
    from cli.commands import graph
    fake = Mock()
    fake.get_agent_context.side_effect = SystemExit(1)
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "expired-token")
    monkeypatch.setattr(cli_main, "NebulaClient", lambda url: fake)
    monkeypatch.setattr("sys.argv", ["nebula", "graph"])
    handler = Mock()
    monkeypatch.setattr(graph, "run_show", handler)
    with pytest.raises(SystemExit):
        cli_main.main()
    handler.assert_not_called()


@pytest.mark.parametrize("escape", ["absolute", "parent", "symlink"])
def test_cli_fetch_rejects_outside_destination_before_requests(tmp_path, monkeypatch, escape):
    from cli.__main__ import build_parser
    from cli.commands.commons import run
    from services.agent_workspaces import workspace_scope
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = workspace / "escape"
    link.symlink_to(outside, target_is_directory=True)
    destination = {"absolute": outside, "parent": workspace / ".." / "outside", "symlink": link}[escape]
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "scoped-token")
    args = build_parser().parse_args(["commons", "fetch", "ast_any", "--out", str(destination)])
    client = Mock()
    client.commons_enabled.return_value = True
    with workspace_scope(workspace), pytest.raises((SystemExit, ValueError)):
        run(client, args)
    client.commons.assert_not_called()
    assert list(outside.iterdir()) == []


def test_cli_fetch_defaults_to_authenticated_workspace_not_cwd(tmp_path, monkeypatch, capsys):
    from cli.__main__ import build_parser
    from cli.commands.commons import run
    from services.agent_workspaces import workspace_scope
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "scoped-token")
    client = Mock()
    client.commons_enabled.return_value = True
    client.commons.side_effect = [{"asset": {"blob_key": "a" * 64 + ".png"}}, b"synthetic pixels"]
    with workspace_scope(workspace):
        run(client, build_parser().parse_args(["commons", "fetch", "ast_any"]))
    destination = Path(capsys.readouterr().out.strip())
    assert destination.parent == workspace and destination.read_bytes() == b"synthetic pixels"


def test_bound_cli_fetch_without_context_fails_before_requests(monkeypatch):
    from cli.__main__ import build_parser
    from cli.commands.commons import run
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "scoped-token")
    client = Mock()
    with pytest.raises(SystemExit):
        run(client, build_parser().parse_args(["commons", "fetch", "ast_any"]))
    client.commons.assert_not_called()
