"""Native Krea MCP OAuth connection; credentials never enter settings or graphs."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import secrets
import stat
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

import httpx
from cryptography.fernet import Fernet
from jsonschema import Draft202012Validator
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from services.krea_agent_mcp import KREA_READONLY_TOOLS as READONLY_TOOLS

SERVER = "https://api.krea.ai/mcp"
ISSUER = "https://www.krea.ai"
RESOURCE_METADATA = ISSUER + "/.well-known/oauth-protected-resource"
OAUTH_METADATA = ISSUER + "/.well-known/oauth-authorization-server"
AUTHORIZE = ISSUER + "/auth/v1/oauth/authorize"
TOKEN = ISSUER + "/auth/v1/oauth/token"
REGISTER = ISSUER + "/auth/v1/oauth/clients/register"
CONSENT_TTL = 300


class ConnectorError(RuntimeError):
    """Only fixed, user-safe messages may cross the HTTP boundary."""


class Vault:
    def __init__(self, directory: Path):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._owned(directory, directory=True)
        self.path = directory / "oauth.enc"
        key = os.environ.get("NEBULA_CONNECTOR_ENCRYPTION_KEY")
        if not key:
            if os.environ.get("NEBULA_DESKTOP_MODE") == "1":
                raise ConnectorError("Desktop connector encryption is unavailable")
            key_path = directory / ".key"
            if not key_path.exists():
                self._atomic(key_path, Fernet.generate_key(), exclusive=True)
            self._owned(key_path)
            key = key_path.read_bytes()
        try:
            self.cipher = Fernet(key.encode() if isinstance(key, str) else key)
        except Exception as exc:
            raise ConnectorError("Connector encryption key is invalid") from exc

    @staticmethod
    def _owned(path: Path, *, directory=False):
        info = path.lstat()
        if path.is_symlink() or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ConnectorError("Connector storage must be private and owned by this user")
        if directory and not stat.S_ISDIR(info.st_mode) or not directory and not stat.S_ISREG(info.st_mode):
            raise ConnectorError("Connector storage is invalid")

    @staticmethod
    def _atomic(path: Path, value: bytes, *, exclusive=False):
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
            if exclusive:
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            else:
                os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def read(self):
        if not self.path.exists():
            return None
        self._owned(self.path)
        try:
            value = json.loads(self.cipher.decrypt(self.path.read_bytes()))
            if not isinstance(value, dict) or value.get("issuer") != ISSUER or value.get("resource") != SERVER:
                raise ValueError("invalid vault")
            return value
        except Exception as exc:
            raise ConnectorError("Stored Krea connection cannot be decrypted; reconnect") from exc

    def write(self, value):
        self._atomic(self.path, self.cipher.encrypt(json.dumps(value).encode()))

    def clear(self):
        self.path.unlink(missing_ok=True)

    def set_revision(self, revision):
        self._atomic(self.directory / ".revision", revision.encode())

    def revision(self):
        path = self.directory / ".revision"
        if not path.exists():
            return None
        self._owned(path)
        return path.read_text()


def _auth_rejected(exc):
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in {401, 403}:
        return True
    return isinstance(exc, BaseExceptionGroup) and any(_auth_rejected(child) for child in exc.exceptions)


def _connector_error(exc):
    if isinstance(exc, ConnectorError):
        return exc
    if isinstance(exc, BaseExceptionGroup):
        return next((found for child in exc.exceptions if (found := _connector_error(child)) is not None), None)
    return None


class _KreaAuth(httpx.Auth):
    """Refresh before a new request without ever retrying a submitted request."""

    def __init__(self, connector, revision):
        self.connector = connector
        self.revision = revision

    async def async_auth_flow(self, request):
        if request.url != httpx.URL(SERVER):
            raise ConnectorError("Krea authentication requires the fixed MCP server")
        request.headers["Authorization"] = f"Bearer {await self.connector._access_token(expected_revision=self.revision)}"
        yield request


class KreaConnector:
    def __init__(self, directory: Path | None = None):
        self._error = None
        self._state = None
        self._pending = None
        self._server = None
        self._expiry_task = None
        self._lock = asyncio.Lock()
        self._tools = []
        try:
            self.vault = Vault(directory or Path(os.environ.get("NEBULA_STATE_DIR", Path.home() / ".nebula")) / "krea")
        except Exception as exc:
            self.vault = None
            self._state = "error"
            self._error = str(exc) if isinstance(exc, ConnectorError) else "Connector storage is unavailable"
        self._storage_error = self._error if self.vault is None else None

    def connection_revision(self):
        try:
            saved = self.vault.read() if self.vault else None
            return saved.get("connection_revision") if saved else self.vault.revision() if self.vault else None
        except Exception:
            return None

    def status(self):
        status = self._state
        if status is None:
            try:
                saved = self.vault.read() if self.vault else None
                tokens = saved.get("tokens", {}) if saved else {}
                expiry = tokens.get("expires_at")
                ready = tokens.get("access_token") and (expiry is None or expiry > time.time() or tokens.get("refresh_token"))
                status = "connected" if ready else "needs_auth" if tokens else "disconnected"
            except Exception:
                status = "error"
                self._error = "Stored Krea connection cannot be read; reconnect"
        result = {"status": status}
        if self._pending:
            result["authorizationUrl"] = self._pending["url"]
        if self._error:
            result["error"] = self._error
        if self._tools:
            result["tools"] = [tool.name for tool in self._tools]
        return result

    async def _discover(self):
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            resource_response = await client.get(RESOURCE_METADATA)
            resource_response.raise_for_status()
            resource = resource_response.json()
            if resource.get("resource") != SERVER or resource.get("authorization_servers") != [ISSUER]:
                raise ConnectorError("Krea advertised an unexpected OAuth resource")
            response = await client.get(OAUTH_METADATA)
            response.raise_for_status()
            metadata = response.json()
        expected = {"issuer": ISSUER, "authorization_endpoint": AUTHORIZE,
                    "token_endpoint": TOKEN, "registration_endpoint": REGISTER}
        if any(metadata.get(key) != value for key, value in expected.items()):
            raise ConnectorError("Krea advertised unexpected OAuth endpoints")
        if "S256" not in metadata.get("code_challenge_methods_supported", []) or "none" not in metadata.get("token_endpoint_auth_methods_supported", []):
            raise ConnectorError("Krea does not advertise the required public PKCE client")
        return metadata

    async def connect(self):
        async with self._lock:
            await self._close_pending()
            if not self.vault:
                self._state, self._error = "error", self._storage_error
                return self.status()
            self._error = None
            try:
                metadata = await self._discover()
                self._server = await asyncio.start_server(self._callback, "127.0.0.1", 0, limit=16384)
                port = self._server.sockets[0].getsockname()[1]
                redirect = f"http://127.0.0.1:{port}/callback"
                registration = {"client_name": "Nebula Nodes", "application_type": "native",
                                "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"],
                                "response_types": ["code"], "token_endpoint_auth_method": "none", "scope": "profile email"}
                async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
                    response = await client.post(REGISTER, json=registration)
                    response.raise_for_status()
                    registered = response.json()
                client_id = registered.get("client_id")
                if not isinstance(client_id, str) or not client_id or registered.get("token_endpoint_auth_method", "none") != "none" or registered.get("redirect_uris") != [redirect]:
                    raise ConnectorError("Krea returned an invalid public client registration")
                state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
                query = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect,
                         "scope": "profile email", "state": state, "resource": SERVER,
                         "code_challenge": challenge, "code_challenge_method": "S256"}
                self._pending = {"state": state, "verifier": verifier, "redirect": redirect,
                                 "client_id": client_id, "requires_issuer": metadata.get("authorization_response_iss_parameter_supported", False),
                                 "expires": time.time() + CONSENT_TTL, "url": AUTHORIZE + "?" + urlencode(query)}
                self._state = "connecting"
                self._expiry_task = asyncio.create_task(self._expire(state))
            except Exception:
                await self._close_pending()
                self._state, self._error = "error", "Could not start Krea authorization; try connecting again"
            return self.status()

    async def _expire(self, state):
        await asyncio.sleep(CONSENT_TTL)
        async with self._lock:
            if self._pending and self._pending["state"] == state:
                await self._close_pending()
                self._state, self._error = "needs_auth", "Krea authorization expired; connect again"

    async def _close_pending(self):
        if self._expiry_task and self._expiry_task is not asyncio.current_task():
            self._expiry_task.cancel()
        self._expiry_task = None
        self._pending = None
        if self._server:
            self._server.close()
            # wait_closed() waits for active callback streams on Python 3.12.
            # Their finally blocks close them after sending the response.
            self._server = None

    async def _callback(self, reader, writer):
        code = 400
        message = "Krea authorization could not be accepted. Return to Nebula."
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            line = raw.decode("ascii").split("\r\n", 1)[0].split(" ")
            if len(line) != 3 or line[0] != "GET" or len(raw) > 16384:
                raise ConnectorError("Invalid callback")
            target = urlsplit(line[1])
            query = parse_qs(target.query, keep_blank_values=True)
            async with self._lock:
                pending = self._pending
                state = query.get("state", [])
                if target.path != "/callback" or target.scheme or target.netloc or not pending or len(state) != 1 or not secrets.compare_digest(state[0], pending["state"]):
                    raise ConnectorError("Invalid callback state")
                if pending["expires"] <= time.time():
                    await self._close_pending()
                    self._state, self._error = "needs_auth", "Krea authorization expired; connect again"
                    raise ConnectorError("Expired callback")
                issuer = query.get("iss", [])
                if (pending["requires_issuer"] and not issuer) or issuer and (len(issuer) != 1 or issuer[0] != ISSUER):
                    raise ConnectorError("Invalid callback issuer")
                if "error" in query:
                    await self._close_pending()
                    self._state, self._error = "needs_auth", "Krea authorization was declined; connect again"
                else:
                    codes = query.get("code", [])
                    if len(codes) != 1 or not codes[0]:
                        raise ConnectorError("Invalid callback code")
                    data = {"grant_type": "authorization_code", "code": codes[0], "redirect_uri": pending["redirect"],
                            "client_id": pending["client_id"], "code_verifier": pending["verifier"], "resource": SERVER}
                    try:
                        tokens = await self._exchange(data)
                        revision = str(uuid4())
                        self.vault.write({"issuer": ISSUER, "resource": SERVER, "connection_revision": revision,
                                          "client_id": pending["client_id"], "tokens": tokens})
                        self.vault.set_revision(revision)
                        self._state, self._error = None, None
                        code, message = 200, "Krea is connected. You can close this window and return to Nebula."
                    except Exception:
                        self._state, self._error = "needs_auth", "Krea authorization could not be completed; connect again"
                    await self._close_pending()
        except Exception:
            pass
        finally:
            body = message.encode()
            writer.write(f"HTTP/1.1 {code} {'OK' if code == 200 else 'Bad Request'}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
            try:
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

    async def _exchange(self, fields, old_refresh=None):
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.post(TOKEN, data=fields)
            response.raise_for_status()
            data = response.json()
        access = data.get("access_token")
        if not isinstance(access, str) or not access or str(data.get("token_type", "")).lower() != "bearer":
            raise ConnectorError("Krea returned invalid OAuth credentials")
        expiry = data.get("expires_in")
        if expiry is not None and (isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry) or expiry <= 0):
            raise ConnectorError("Krea returned an invalid credential expiry")
        refresh = data.get("refresh_token") or old_refresh
        if refresh is not None and (not isinstance(refresh, str) or not refresh):
            raise ConnectorError("Krea returned invalid refresh credentials")
        return {"access_token": access, "refresh_token": refresh,
                "expires_at": time.time() + expiry if expiry is not None else None}

    async def _session_revision(self, expected_revision):
        async with self._lock:
            saved = self.vault.read() if self.vault else None
            if not saved or not saved.get("tokens"):
                raise ConnectorError("Connect your Krea account first")
            revision = saved.get("connection_revision")
            if not isinstance(revision, str) or not revision:
                raise ConnectorError("Stored Krea connection is invalid; reconnect")
            if expected_revision is not None and expected_revision != revision:
                raise ConnectorError("Krea connection changed; rerun with the current connection")
            return revision

    async def _access_token(self, *, expected_revision=None):
        async with self._lock:
            saved = self.vault.read() if self.vault else None
            if expected_revision is not None and (not saved or saved.get("connection_revision") != expected_revision):
                raise ConnectorError("Krea connection changed; rerun with the current connection")
            if not saved or not saved.get("tokens"):
                raise ConnectorError("Connect your Krea account first")
            tokens = saved["tokens"]
            if tokens.get("expires_at") is not None and tokens["expires_at"] <= time.time() + 60:
                if not tokens.get("refresh_token"):
                    self._state = "needs_auth"
                    raise ConnectorError("Krea authorization expired; reconnect")
                try:
                    tokens = await self._exchange({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                                                   "client_id": saved["client_id"], "resource": SERVER}, tokens["refresh_token"])
                    self.vault.write({**saved, "tokens": tokens})
                except Exception as exc:
                    self._state, self._error = "needs_auth", "Krea authorization could not be refreshed; reconnect"
                    raise ConnectorError(self._error) from exc
            return tokens["access_token"]

    @asynccontextmanager
    async def session(self, *, expected_revision=None):
        revision = await self._session_revision(expected_revision)
        body_error = None
        try:
            async with httpx.AsyncClient(auth=_KreaAuth(self, revision),
                                         timeout=httpx.Timeout(30, read=300), follow_redirects=False) as client:
                async with streamable_http_client(SERVER, http_client=client) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        try:
                            yield session
                        except BaseException as exc:
                            body_error = exc
                            raise
        except BaseException as exc:
            if body_error is not None and not isinstance(body_error, asyncio.CancelledError):
                raise body_error from None
            if _auth_rejected(exc):
                message = "Krea authorization was rejected; reconnect"
                async with self._lock:
                    if self.connection_revision() == revision:
                        self._state, self._error = "needs_auth", message
                raise ConnectorError(message) from exc
            connection_error = _connector_error(exc)
            if connection_error is not None:
                raise connection_error from None
            if body_error is not None:
                raise body_error from None
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise ConnectorError("Krea MCP connection failed; check or reconnect") from exc

    async def _list_tools(self, session):
        tools, cursor = [], None
        for _ in range(10):
            page = await session.list_tools(cursor=cursor)
            tools.extend(page.tools)
            cursor = page.nextCursor
            if not cursor:
                return tools
        raise ConnectorError("Krea tool discovery exceeded its limit")

    async def list_tools(self, session):
        """Discover all tools in the caller's shared initialized session."""
        return await self._list_tools(session)

    async def check(self):
        if self._pending:
            return self.status()
        try:
            async with self.session() as session:
                self._tools = await self.list_tools(session)
            self._state, self._error = None, None
        except Exception:
            self._state = "needs_auth" if self.status()["status"] in {"disconnected", "needs_auth"} else "error"
            self._error = "Krea connection could not be checked; reconnect or try again"
        return self.status()

    async def tools(self):
        async with self.session() as session:
            self._tools = await self.list_tools(session)
        return {"tools": [tool.model_dump(mode="json") for tool in self._tools if tool.name in READONLY_TOOLS]}

    async def call_readonly(self, name, arguments):
        if name not in READONLY_TOOLS:
            raise ConnectorError("Only read-only Krea discovery tools may be called here")
        async with self.session() as session:
            tools = await self.list_tools(session)
            tool = next((tool for tool in tools if tool.name == name), None)
            if tool is None:
                raise ConnectorError("Krea discovery tool is unavailable")
            if not Draft202012Validator(tool.inputSchema).is_valid(arguments):
                raise ConnectorError("Invalid Krea discovery arguments")
            result = await session.call_tool(name, arguments)
            return result.model_dump(mode="json")

    async def disconnect(self):
        async with self._lock:
            await self._close_pending()
            if self.vault:
                self.vault.clear()
                self.vault.set_revision(str(uuid4()))
            self._tools = []
            self._state, self._error = "disconnected", None
            return self.status()


_connector = None


def get_connector():
    global _connector
    if _connector is None:
        _connector = KreaConnector()
    return _connector


def is_krea_connected():
    return get_connector().status()["status"] == "connected"


def connection_revision():
    return get_connector().connection_revision()
