"""Remote Commons clients reject disabled servers before reading/writing files."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest

import mcp_server
from cli.__main__ import build_parser
from cli.commands.commons import run


@pytest.mark.parametrize("verb,args", [
    ("search", ["dense grid"]),
    ("fetch", ["ast_1"]),
    ("add", ["missing.png", "--collection", "col_1", "--why", "strong grid"]),
    ("status", []),
])
def test_disabled_cli_stops_before_any_commons_or_file_access(verb, args, tmp_path, monkeypatch, capsys):
    client = Mock()
    client.commons_enabled.return_value = False
    unexpected = Mock(side_effect=AssertionError("inactive Commons read a file"))
    monkeypatch.setattr("cli.commands.commons.require_allowed_path", unexpected)
    with pytest.raises(SystemExit) as exc:
        run(client, build_parser().parse_args(["commons", verb, *args]))
    assert exc.value.code == 1 and "disabled" in capsys.readouterr().err
    client.commons.assert_not_called()
    unexpected.assert_not_called()


@pytest.mark.parametrize("payload", [{"enabled": False}, {"enabled": "true"}, {}, []])
def test_disabled_mcp_upload_never_reads_the_source(tmp_path, monkeypatch, payload):
    calls = []
    def request(method, url, **kwargs):
        calls.append((method, url))
        assert url.endswith("/api/capabilities/commons")
        return httpx.Response(200, json=payload, request=httpx.Request(method, url))
    monkeypatch.setattr(mcp_server.httpx, "request", request)
    no_file = Mock(side_effect=AssertionError("inactive MCP inspected a local file"))
    monkeypatch.setattr(mcp_server, "require_allowed_path", no_file)
    with pytest.raises(RuntimeError, match="disabled"):
        mcp_server._commons_add_impl(str(tmp_path / "missing.png"), "col_1", "reason", "unknown",
                                     client_name="external")
    assert len(calls) == 1
    no_file.assert_not_called()


def test_mcp_agent_add_uses_token_and_backend_path_boundary(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "synthetic-token")
    calls = []
    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        assert kwargs["headers"]["Authorization"] == "Agent synthetic-token"
        payload = {"enabled": True} if url.endswith("/api/capabilities/commons") else {"asset_id": "ast_1"}
        return httpx.Response(200, json=payload, request=httpx.Request(method, url))
    monkeypatch.setattr(mcp_server.httpx, "request", request)
    no_file = Mock(side_effect=AssertionError("scoped MCP read source instead of authenticating backend"))
    monkeypatch.setattr(mcp_server, "require_allowed_path", no_file)
    source = tmp_path / "scoped.png"
    response = mcp_server._commons_add_impl(str(source), "col_1", "reason", "unknown", client_name="codex")
    assert response == {"asset_id": "ast_1"}
    assert calls[1][1].endswith("/api/commons/add")
    assert calls[1][2]["json"]["source"] == str(source)
    assert "files" not in calls[1][2]
    no_file.assert_not_called()


def test_mcp_scoped_pixel_fetch_sends_same_actor_and_brand(monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "synthetic-token")
    calls = []
    key = "a" * 64 + ".png"
    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if "/blobs/" in url:
            return httpx.Response(200, content=b"pixels", request=httpx.Request(method, url))
        return httpx.Response(200, json={"asset": {"media": "image", "blob_key": key}},
                              request=httpx.Request(method, url))
    monkeypatch.setattr(mcp_server.httpx, "request", request)
    parts = mcp_server.commons_get("ast_1", brand="acme")
    assert len(parts) == 2
    assert calls[1][1].endswith("/api/commons/blobs/" + key)
    assert all(call[2]["headers"]["Authorization"] == "Agent synthetic-token" for call in calls)
    assert all(call[2]["params"] == {"brand": "acme"} for call in calls)


def test_cli_keeps_main_discovery_and_graph_parsers():
    parser = build_parser()
    assert parser.parse_args(["selection"]).command == "selection"
    params = parser.parse_args(["create", "batch", "--param", "items_text=red"])
    assert params.node_id == "batch"


@pytest.mark.parametrize("asset_id", ["../../settings", "..", ".", "x?brand=other", "x#fragment", "x/y", "x%2fy", "", "a" * 65])
def test_mcp_asset_ids_cannot_escape_the_scoped_api(monkeypatch, asset_id):
    unexpected = Mock(side_effect=AssertionError("invalid id reached HTTP"))
    monkeypatch.setattr(mcp_server.httpx, "request", unexpected)
    with pytest.raises(ValueError, match="asset id"):
        mcp_server.commons_get(asset_id)
    unexpected.assert_not_called()


@pytest.mark.parametrize("verb", ["get", "fetch"])
def test_cli_asset_ids_cannot_escape_the_scoped_api(verb, capsys):
    client = Mock()
    client.commons_enabled.return_value = True
    with pytest.raises(SystemExit) as exc:
        run(client, build_parser().parse_args(["commons", verb, "../../settings"]))
    assert exc.value.code == 1 and "asset id" in capsys.readouterr().err
    client.commons.assert_not_called()


def test_mcp_scoped_actor_replaces_mixed_case_authorization(monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "synthetic-token")
    sent = {}
    def request(method, url, **kwargs):
        sent.update(kwargs["headers"])
        return httpx.Response(200, json={"results": []}, request=httpx.Request(method, url))
    monkeypatch.setattr(mcp_server.httpx, "request", request)
    mcp_server._commons_call("POST", "/api/commons/search", "codex",
                            headers={"authorization": "Bearer forbidden", "AUTHORIZATION": "other"},
                            json={})
    assert {key: value for key, value in sent.items() if key.lower() == "authorization"} == {
        "Authorization": "Agent synthetic-token"}
