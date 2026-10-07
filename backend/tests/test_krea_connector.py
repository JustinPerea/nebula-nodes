"""Isolated OAuth and real MCP wire tests; no account or generation calls."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import stat
import time
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
import respx
from cryptography.fernet import Fernet
from fastapi import FastAPI

import routes.krea_connector as routes
import services.krea_connector as service


ACCESS = "synthetic-access-secret"
REFRESH = "synthetic-refresh-secret"
TOOLS = [
    {"name": "list_models", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "get_model_schema", "inputSchema": {"type": "object", "properties": {"model": {"type": "string"}},
                                              "required": ["model"], "additionalProperties": False}},
    {"name": "generate", "inputSchema": {"type": "object"}},
]


@pytest_asyncio.fixture
async def connector(tmp_path, monkeypatch):
    monkeypatch.delenv("NEBULA_DESKTOP_MODE", raising=False)
    monkeypatch.delenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", raising=False)
    connection = service.KreaConnector(tmp_path / "krea")
    monkeypatch.setattr(service, "_connector", connection)
    yield connection
    await connection.disconnect()


def oauth(router, *, issuer_required=False):
    resource = router.get(service.RESOURCE_METADATA).mock(return_value=httpx.Response(200, json={
        "resource": service.SERVER, "authorization_servers": [service.ISSUER]}))
    metadata = {"issuer": service.ISSUER, "authorization_endpoint": service.AUTHORIZE,
                "token_endpoint": service.TOKEN, "registration_endpoint": service.REGISTER,
                "token_endpoint_auth_methods_supported": ["none"], "code_challenge_methods_supported": ["S256"],
                "authorization_response_iss_parameter_supported": issuer_required}
    discovery = router.get(service.OAUTH_METADATA).mock(return_value=httpx.Response(200, json=metadata))
    registered = router.post(service.REGISTER).mock(side_effect=lambda request: httpx.Response(201, json={
        "client_id": "client-1", "token_endpoint_auth_method": "none",
        "redirect_uris": json.loads(request.content)["redirect_uris"]}))
    exchanged = router.post(service.TOKEN).mock(return_value=httpx.Response(200, json={
        "access_token": ACCESS, "refresh_token": REFRESH, "token_type": "Bearer", "expires_in": 3600}))
    return resource, discovery, registered, exchanged


async def callback(connector, **overrides):
    pending = connector._pending
    fields = {"state": pending["state"], "code": "synthetic-code", "iss": service.ISSUER, **overrides}
    fields = {key: value for key, value in fields.items() if value is not None}
    target = urlsplit(pending["redirect"])
    reader, writer = await asyncio.open_connection(target.hostname, target.port)
    writer.write(f"GET /callback?{urlencode(fields)} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
    await writer.drain()
    response = await asyncio.wait_for(reader.read(), 10)
    writer.close()
    await writer.wait_closed()
    return response


def seed(connector, *, expires_at=None, refresh=REFRESH):
    revision = str(uuid4())
    connector.vault.write({"issuer": service.ISSUER, "resource": service.SERVER, "client_id": "client-1",
                          "connection_revision": revision,
                          "tokens": {"access_token": ACCESS, "refresh_token": refresh,
                                     "expires_at": time.time() + 3600 if expires_at is None else expires_at}})
    connector._state, connector._error = None, None
    return revision


def protocol(router, *, rejection=None):
    methods = []
    def reply(request):
        assert request.headers["authorization"] == f"Bearer {ACCESS}"
        body = json.loads(request.content)
        methods.append(body["method"])
        if rejection:
            return httpx.Response(rejection, json={"error": "do not expose " + ACCESS})
        if "id" not in body:
            return httpx.Response(202)
        if body["method"] == "initialize":
            result = {"protocolVersion": body["params"]["protocolVersion"], "capabilities": {"tools": {}},
                      "serverInfo": {"name": "Krea fixture", "version": "1"}}
        elif body["method"] == "tools/list":
            result = {"tools": TOOLS}
        elif body["method"] == "tools/call":
            assert body["params"]["name"] in service.READONLY_TOOLS
            result = {"content": [{"type": "text", "text": "Model discovery fixture"}],
                      "structuredContent": {"models": []}, "isError": False}
        else:
            raise AssertionError("Unexpected MCP method")
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result},
                              headers={"content-type": "application/json", "mcp-session-id": "fixture-session"})
    posted = router.post(service.SERVER).mock(side_effect=reply)
    router.get(service.SERVER).mock(return_value=httpx.Response(405))
    router.delete(service.SERVER).mock(return_value=httpx.Response(204))
    return methods, posted


@pytest.mark.asyncio
async def test_connect_native_pkce_callback_and_private_encrypted_restart(connector):
    with respx.mock(assert_all_called=False) as router:
        _, _, registration, exchange = oauth(router, issuer_required=True)
        state = await connector.connect()
        assert state["status"] == "connecting"
        query = parse_qs(urlsplit(state["authorizationUrl"]).query)
        pending = connector._pending
        assert query["resource"] == [service.SERVER]
        assert query["scope"] == ["profile email"]
        assert query["code_challenge_method"] == ["S256"]
        expected = base64.urlsafe_b64encode(hashlib.sha256(pending["verifier"].encode()).digest()).rstrip(b"=").decode()
        assert query["code_challenge"] == [expected]
        registered = json.loads(registration.calls[0].request.content)
        assert registered["application_type"] == "native" and registered["token_endpoint_auth_method"] == "none"
        assert registered["redirect_uris"] == [pending["redirect"]]
        assert urlsplit(pending["redirect"]).hostname == "127.0.0.1"
        assert not service.is_krea_connected()
        assert b"200 OK" in await callback(connector)
        assert exchange.call_count == 1
        fields = parse_qs(exchange.calls[0].request.content.decode())
        assert fields["code_verifier"] == [pending["verifier"]]
        assert fields["redirect_uri"] == [pending["redirect"]]
        assert fields["resource"] == [service.SERVER]
        assert "client_secret" not in fields
        assert connector._server is connector._pending is None
    assert connector.status() == {"status": "connected"}
    assert service.is_krea_connected()
    for path in [connector.vault.path, connector.vault.directory / ".key", connector.vault.directory / ".revision"]:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert ACCESS.encode() not in path.read_bytes() and REFRESH.encode() not in path.read_bytes()
    assert stat.S_IMODE(connector.vault.directory.stat().st_mode) == 0o700
    restored = service.KreaConnector(connector.vault.directory)
    assert restored.status() == {"status": "connected"}
    assert restored.connection_revision() == connector.connection_revision() == service.connection_revision()


@pytest.mark.asyncio
@pytest.mark.parametrize("fields", [{"state": "wrong"}, {"iss": service.ISSUER + "/"}, {"iss": None}])
async def test_callback_state_and_exact_required_issuer_rejected_without_exchange(connector, fields):
    with respx.mock(assert_all_called=False) as router:
        _, _, _, exchange = oauth(router, issuer_required=True)
        await connector.connect()
        assert b"400 Bad Request" in await callback(connector, **fields)
        assert exchange.call_count == 0
        assert connector.status()["status"] == "connecting"
        assert not connector.vault.path.exists()


@pytest.mark.asyncio
async def test_optional_issuer_may_be_absent_but_never_mismatched(connector):
    with respx.mock(assert_all_called=False) as router:
        oauth(router)
        await connector.connect()
        assert b"200 OK" in await callback(connector, iss=None)


@pytest.mark.asyncio
async def test_consent_denied_closes_callback_without_secrets_or_token_request(connector):
    with respx.mock(assert_all_called=False) as router:
        _, _, _, exchange = oauth(router)
        await connector.connect()
        assert b"400 Bad Request" in await callback(connector, error="access_denied", error_description=ACCESS)
        status = connector.status()
        assert status["status"] == "needs_auth" and ACCESS not in json.dumps(status)
        assert connector._pending is connector._server is None
        assert not connector.vault.path.exists()
        assert exchange.call_count == 0


@pytest.mark.asyncio
async def test_consent_expiry_closes_listener_and_does_not_sign_in_again(connector, monkeypatch):
    monkeypatch.setattr(service, "CONSENT_TTL", 0.02)
    with respx.mock(assert_all_called=False) as router:
        _, _, registration, exchange = oauth(router)
        await connector.connect()
        port = urlsplit(connector._pending["redirect"]).port
        await asyncio.sleep(0.05)
        assert connector.status()["status"] == "needs_auth"
        assert connector._pending is connector._server is None
        with pytest.raises(OSError):
            await asyncio.open_connection("127.0.0.1", port)
        assert registration.call_count == 1 and exchange.call_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("issuer", service.ISSUER + "/"), ("token_endpoint", "https://attacker.test/token"),
    ("registration_endpoint", "https://attacker.test/register"), ("authorization_endpoint", "http://www.krea.ai/authorize")])
async def test_discovery_is_fixed_and_fail_closed(connector, field, value):
    with respx.mock(assert_all_called=False) as router:
        _, discovery, registered, exchange = oauth(router)
        metadata = json.loads(discovery.return_value.content)
        metadata[field] = value
        discovery.mock(return_value=httpx.Response(200, json=metadata))
        assert (await connector.connect())["status"] == "error"
        assert registered.call_count == exchange.call_count == 0
        assert len(router.calls) == 2


@pytest.mark.asyncio
async def test_refresh_uses_canonical_token_resource_and_preserves_revision_after_restart(connector):
    revision = seed(connector, expires_at=time.time() - 1)
    restored = service.KreaConnector(connector.vault.directory)
    assert restored.status()["status"] == "connected", "An expired access token with refresh is recoverable"
    with respx.mock(assert_all_called=False) as router:
        refreshed = router.post(service.TOKEN).mock(return_value=httpx.Response(200, json={
            "access_token": ACCESS, "refresh_token": "synthetic-rotated-refresh", "token_type": "Bearer", "expires_in": 3600}))
        methods, _ = protocol(router)
        assert (await restored.check())["status"] == "connected"
        fields = parse_qs(refreshed.calls[0].request.content.decode())
        assert fields == {"grant_type": ["refresh_token"], "refresh_token": [REFRESH],
                          "client_id": ["client-1"], "resource": [service.SERVER]}
        assert methods == ["initialize", "notifications/initialized", "tools/list"]
        assert refreshed.call_count == 1
    assert restored.connection_revision() == revision
    assert restored.vault.read()["tokens"]["refresh_token"] == "synthetic-rotated-refresh"


@pytest.mark.asyncio
async def test_shared_mcp_session_refreshes_between_submit_and_poll_without_resubmitting(connector, monkeypatch):
    now = [time.time()]
    monkeypatch.setattr(service, "time", SimpleNamespace(time=lambda: now[0]))
    revision = seed(connector, expires_at=now[0] + 90)
    renewed = "synthetic-renewed-access"
    calls = []

    def reply(request):
        body = json.loads(request.content)
        method = body["method"]
        name = body.get("params", {}).get("name")
        calls.append((method, name, request.headers["authorization"]))
        if "id" not in body:
            return httpx.Response(202)
        if method == "initialize":
            result = {"protocolVersion": body["params"]["protocolVersion"], "capabilities": {"tools": {}},
                      "serverInfo": {"name": "Krea fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": name, "inputSchema": {"type": "object"}} for name in {"generate", "get_job"}]}
        else:
            assert method == "tools/call" and name in {"generate", "get_job"}
            result = {"content": [], "structuredContent": {"job_id": "accepted-job", "status": "queued" if name == "generate" else "completed"},
                      "isError": False}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result},
                              headers={"content-type": "application/json", "mcp-session-id": "fixture-session"})

    with respx.mock(assert_all_called=False) as router:
        refreshed = router.post(service.TOKEN).mock(return_value=httpx.Response(200, json={
            "access_token": renewed, "refresh_token": "synthetic-rotated-refresh", "token_type": "Bearer", "expires_in": 3600}))
        router.post(service.SERVER).mock(side_effect=reply)
        router.get(service.SERVER).mock(return_value=httpx.Response(405))
        router.delete(service.SERVER).mock(return_value=httpx.Response(204))
        async with connector.session() as session:
            submitted = await session.call_tool("generate", {"model": "fixture-model"})
            assert submitted.structuredContent["job_id"] == "accepted-job"
            assert refreshed.call_count == 0
            now[0] += 40
            polled = await session.call_tool("get_job", {"job_id": "accepted-job"})
            assert polled.structuredContent["status"] == "completed"
        assert refreshed.call_count == 1
        assert [(name, auth) for method, name, auth in calls if method == "tools/call"] == [
            ("generate", f"Bearer {ACCESS}"), ("get_job", f"Bearer {renewed}")]
        fields = parse_qs(refreshed.calls[0].request.content.decode())
        assert fields["resource"] == [service.SERVER] and fields["refresh_token"] == [REFRESH]
    assert connector.connection_revision() == revision


@pytest.mark.asyncio
async def test_requested_connection_revision_is_checked_before_any_mcp_request(connector):
    original = seed(connector)
    replacement = seed(connector)
    with respx.mock(assert_all_called=False) as router:
        with pytest.raises(service.ConnectorError, match="connection changed"):
            async with connector.session(expected_revision=original):
                pytest.fail("A replaced connection must not enter a session")
        assert not router.calls
    assert connector.connection_revision() == replacement
    assert connector.status()["status"] == "connected"


@pytest.mark.asyncio
async def test_open_session_cannot_use_reconnected_workspace_credentials(connector):
    original = seed(connector)
    with respx.mock(assert_all_called=False) as router:
        _, posted = protocol(router)
        with pytest.raises(service.ConnectorError, match="connection changed"):
            async with connector.session(expected_revision=original) as session:
                await session.list_tools()
                await connector.disconnect()
                replacement = seed(connector)
                count = posted.call_count
                await session.list_tools()
        assert posted.call_count == count, "No request may use the replacement workspace token"
    assert connector.connection_revision() == replacement
    assert connector.status()["status"] == "connected"


@pytest.mark.asyncio
async def test_generation_auth_rejection_is_not_refreshed_or_retried(connector):
    seed(connector)
    requests = []
    with respx.mock(assert_all_called=False) as router:
        _, posted = protocol(router)
        refreshed = router.post(service.TOKEN).mock(return_value=httpx.Response(500))
        with pytest.raises(service.ConnectorError, match="authorization was rejected"):
            async with connector.session() as session:
                await session.list_tools()
                def reject(request):
                    requests.append(json.loads(request.content))
                    return httpx.Response(401, json={"error": ACCESS})
                posted.mock(side_effect=reject)
                await session.call_tool("generate", {"model": "fixture-model"})
        assert len(requests) == 1 and requests[0]["params"]["name"] == "generate"
        assert refreshed.call_count == 0
    assert connector.status()["status"] == "needs_auth"


@pytest.mark.asyncio
async def test_late_auth_rejection_does_not_poison_reconnected_workspace(connector):
    original = seed(connector)
    with respx.mock(assert_all_called=False) as router:
        _, posted = protocol(router)
        with pytest.raises(service.ConnectorError, match="authorization was rejected"):
            async with connector.session(expected_revision=original) as session:
                await session.list_tools()
                async def reject_after_reconnect(request):
                    nonlocal replacement
                    await connector.disconnect()
                    replacement = seed(connector)
                    return httpx.Response(401)
                replacement = None
                posted.mock(side_effect=reject_after_reconnect)
                await session.list_tools()
    assert connector.connection_revision() == replacement
    assert connector.status()["status"] == "connected"


@pytest.mark.asyncio
async def test_refresh_error_is_sanitized_and_never_starts_auth_or_mcp(connector):
    seed(connector, expires_at=time.time() - 1)
    with respx.mock as router:
        refreshed = router.post(service.TOKEN).mock(return_value=httpx.Response(400, json={"error_description": REFRESH}))
        state = await connector.check()
        assert state["status"] == "needs_auth"
        assert ACCESS not in json.dumps(state) and REFRESH not in json.dumps(state)
        assert refreshed.call_count == len(router.calls) == 1
        assert not service.is_krea_connected()


@pytest.mark.asyncio
async def test_expired_credentials_without_refresh_need_manual_auth(connector):
    seed(connector, expires_at=time.time() - 1, refresh=None)
    assert connector.status()["status"] == "needs_auth"
    with respx.mock(assert_all_called=False) as router:
        assert (await connector.check())["status"] == "needs_auth"
        assert not router.calls


@pytest.mark.asyncio
async def test_real_mcp_protocol_discovery_is_readonly_and_generation_blocked(connector):
    seed(connector)
    with respx.mock(assert_all_called=False) as router:
        methods, posted = protocol(router)
        assert (await connector.check())["tools"] == [tool["name"] for tool in TOOLS]
        assert [tool["name"] for tool in (await connector.tools())["tools"]] == ["list_models", "get_model_schema"]
        result = await connector.call_readonly("list_models", {})
        assert result["structuredContent"] == {"models": []}
        count = posted.call_count
        with pytest.raises(service.ConnectorError, match="discovery"):
            await connector.call_readonly("generate", {"prompt": "Never submit"})
        assert posted.call_count == count
        with pytest.raises(service.ConnectorError, match="arguments"):
            await connector.call_readonly("get_model_schema", {})
        assert methods.count("tools/call") == 1
        assert "generate" not in methods
        assert ACCESS not in json.dumps(connector.status())


@pytest.mark.asyncio
async def test_disconnect_closes_pending_and_removes_tokens_and_changes_revision(connector):
    first_revision = seed(connector)
    with respx.mock(assert_all_called=False) as router:
        _, _, registered, _ = oauth(router)
        await connector.connect()
        port = urlsplit(connector._pending["redirect"]).port
        assert (await connector.disconnect()) == {"status": "disconnected"}
        with pytest.raises(OSError):
            await asyncio.open_connection("127.0.0.1", port)
        assert not connector.vault.path.exists()
        disconnected_revision = connector.connection_revision()
        assert disconnected_revision != first_revision
        assert service.KreaConnector(connector.vault.directory).connection_revision() == disconnected_revision
        await connector.connect()
        assert b"200 OK" in await callback(connector)
        assert connector.connection_revision() not in {first_revision, disconnected_revision}
        assert registered.call_count == 2


@pytest.mark.asyncio
async def test_desktop_vault_fails_closed_without_master_key(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.delenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", raising=False)
    connection = service.KreaConnector(tmp_path / "desktop")
    assert connection.status()["status"] == "error"
    assert not (tmp_path / "desktop" / ".key").exists()
    with respx.mock(assert_all_called=False) as router:
        assert (await connection.connect())["status"] == "error"
        assert not router.calls


def test_desktop_key_is_used_without_local_key_file(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", Fernet.generate_key().decode())
    connection = service.KreaConnector(tmp_path / "desktop")
    seed(connection)
    assert connection.status()["status"] == "connected"
    assert not (tmp_path / "desktop" / ".key").exists()


@pytest.mark.asyncio
async def test_corrupted_or_nonprivate_vault_is_not_reported_connected(connector):
    seed(connector)
    connector.vault.path.write_bytes(b"corrupt")
    assert connector.status()["status"] == "error"
    connector.vault.path.chmod(0o644)
    assert connector.status()["status"] == "error"
    assert not service.is_krea_connected()


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", ["https://attacker.test", "null", "http://localhost.attacker.test", "http://user@localhost:8000",
    "http://127.0.0.1:99999", "http://localhost:8000/path"])
async def test_remote_browser_origins_cannot_read_or_mutate_connection(connector, origin):
    app = FastAPI()
    app.include_router(routes.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://nebula.test") as client:
        for method, path in [("GET", "/api/krea/connection"), ("POST", "/api/krea/connection/connect"),
                             ("POST", "/api/krea/connection/check"), ("DELETE", "/api/krea/connection"),
                             ("GET", "/api/krea/tools"), ("POST", "/api/krea/tools/call")]:
            response = await client.request(method, path, headers={"Origin": origin}, json={"name": "list_models", "arguments": {}})
            assert response.status_code == 403


@pytest.mark.asyncio
async def test_http_routes_use_real_connector_protocol_and_never_generate(connector):
    app = FastAPI()
    app.include_router(routes.router)
    seed(connector)
    with respx.mock(assert_all_called=False) as router:
        methods, _ = protocol(router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://nebula.test",
                                     headers={"Origin": "http://127.0.0.1:5173"}) as client:
            assert (await client.get("/api/krea/connection")).json()["status"] == "connected"
            assert (await client.post("/api/krea/connection/check")).json()["status"] == "connected"
            response = await client.get("/api/krea/tools")
            assert [tool["name"] for tool in response.json()["tools"]] == ["list_models", "get_model_schema"]
            response = await client.post("/api/krea/tools/call", json={"name": "get_model_schema", "arguments": {"model": "image/krea/krea-2/medium"}})
            assert response.status_code == 200 and response.json()["structuredContent"] == {"models": []}
            assert (await client.post("/api/krea/tools/call", json={"name": "generate", "arguments": {}})).status_code == 400
            assert (await client.delete("/api/krea/connection")).json() == {"status": "disconnected"}
        assert methods.count("tools/call") == 1


@pytest.mark.asyncio
async def test_mcp_unauthorized_is_safe_and_requires_reconnect(connector):
    seed(connector)
    with respx.mock(assert_all_called=False) as router:
        protocol(router, rejection=401)
        status = await connector.check()
    assert status["status"] == "needs_auth"
    assert ACCESS not in json.dumps(status)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [ValueError("model validation fixture"), RuntimeError("job failed fixture"), asyncio.CancelledError()])
async def test_session_preserves_exceptions_from_handler_body(connector, failure):
    seed(connector)
    with respx.mock(assert_all_called=False) as router:
        protocol(router)
        with pytest.raises(type(failure)) as raised:
            async with connector.session():
                raise failure
    assert raised.value is failure
    assert connector.status()["status"] == "connected"


@pytest.mark.asyncio
@pytest.mark.parametrize("desktop,peer,expected", [(True, "127.0.0.1", 200), (False, "127.0.0.1", 403),
    (True, "10.0.0.8", 403), (True, "::1", 200)])
async def test_desktop_null_origin_requires_desktop_and_loopback_peer(connector, monkeypatch, desktop, peer, expected):
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1" if desktop else "0")
    monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "synthetic-desktop-session")
    app = FastAPI()
    app.include_router(routes.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(peer, 123)), base_url="http://nebula.test") as client:
        response = await client.get("/api/krea/connection", headers={"Origin": "null",
            "X-Nebula-Connector-Session": "synthetic-desktop-session"})
    assert response.status_code == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("nonce", ["missing", "wrong", "no-environment"])
async def test_null_origin_requires_private_nonce_for_every_connector_route(connector, monkeypatch, nonce):
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    if nonce == "no-environment":
        monkeypatch.delenv("NEBULA_CONNECTOR_SESSION", raising=False)
    else:
        monkeypatch.setenv("NEBULA_CONNECTOR_SESSION", "synthetic-desktop-session")
    headers = {"Origin": "null"}
    if nonce != "missing":
        headers["X-Nebula-Connector-Session"] = "synthetic-wrong-session"
    app = FastAPI()
    app.include_router(routes.router)
    with respx.mock(assert_all_called=False) as router:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://nebula.test") as client:
            for method, path in [("GET", "/api/krea/connection"), ("POST", "/api/krea/connection/connect"),
                                 ("POST", "/api/krea/connection/check"), ("DELETE", "/api/krea/connection"),
                                 ("GET", "/api/krea/tools"), ("POST", "/api/krea/tools/call")]:
                response = await client.request(method, path, headers=headers, json={"name": "list_models", "arguments": {}})
                assert response.status_code == 403
                assert "synthetic-" not in response.text
        assert not router.calls


@pytest.mark.asyncio
async def test_remote_peer_without_origin_is_rejected(connector):
    app = FastAPI()
    app.include_router(routes.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("203.0.113.8", 123)), base_url="http://nebula.test") as client:
        assert (await client.get("/api/krea/connection")).status_code == 403
        assert (await client.post("/api/krea/connection/connect")).status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("token_response", [{"access_token": ACCESS, "token_type": "Bearer", "expires_in": "3600"},
    {"access_token": ACCESS, "token_type": "Basic", "expires_in": 3600}, {"error_description": REFRESH}])
async def test_bad_token_responses_are_safe_and_not_stored(connector, token_response):
    with respx.mock(assert_all_called=False) as router:
        _, _, _, exchange = oauth(router)
        exchange.mock(return_value=httpx.Response(200, json=token_response))
        await connector.connect()
        assert b"400 Bad Request" in await callback(connector)
        assert connector.status()["status"] == "needs_auth"
        assert not connector.vault.path.exists()
        assert REFRESH not in json.dumps(connector.status())


@pytest.mark.asyncio
async def test_unexpected_registered_redirect_is_rejected(connector):
    with respx.mock(assert_all_called=False) as router:
        _, _, registration, exchange = oauth(router)
        registration.mock(return_value=httpx.Response(201, json={"client_id": "client-1", "redirect_uris": ["https://attacker.test/callback"]}))
        assert (await connector.connect())["status"] == "error"
        assert connector._server is connector._pending is None
        assert exchange.call_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"resource": "https://attacker.test/mcp", "authorization_servers": [service.ISSUER]},
    {"resource": service.SERVER, "authorization_servers": ["https://attacker.test"]}])
async def test_unexpected_resource_metadata_is_rejected_without_following_endpoints(connector, payload):
    with respx.mock(assert_all_called=False) as router:
        resource, discovery, registration, _ = oauth(router)
        resource.mock(return_value=httpx.Response(200, json=payload))
        assert (await connector.connect())["status"] == "error"
        assert resource.call_count == 1
        assert discovery.call_count == registration.call_count == 0


def test_browser_vault_refuses_symlinked_or_shared_key(tmp_path, monkeypatch):
    monkeypatch.delenv("NEBULA_DESKTOP_MODE", raising=False)
    monkeypatch.delenv("NEBULA_CONNECTOR_ENCRYPTION_KEY", raising=False)
    directory = tmp_path / "key-vault"
    connection = service.KreaConnector(directory)
    key = directory / ".key"
    key.chmod(0o644)
    assert service.KreaConnector(directory).status()["status"] == "error"
    key.unlink()
    target = tmp_path / "outside-key"
    target.write_bytes(Fernet.generate_key())
    target.chmod(0o600)
    key.symlink_to(target)
    assert service.KreaConnector(directory).status()["status"] == "error"
