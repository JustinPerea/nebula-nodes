"""One HTTP layer for Nebula's agent clients: the `nebula` CLI and the MCP server.

Both send the same identity (the agent token, a display name) and turn a
failed request into the backend's own `detail`, which is written as the next
step to take ("over the session limit; propose_change ..."). The CLI prints
it and exits; the MCP server raises it as the tool's error.
"""
from __future__ import annotations

import os
from typing import Any, Iterator

import httpx

DEFAULT_URL = "http://127.0.0.1:8000"


class NebulaAPIError(RuntimeError):
    """A request Nebula refused (`status` set) or never answered (`kind` connect/timeout)."""

    def __init__(self, detail: str, *, status: int | None = None, kind: str = "http",
                 headers: Any = None, payload: Any = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status
        self.kind = kind
        # The refusal's response headers (case-insensitive), e.g. a preview's
        # X-Nebula-Last-Run-Error; empty when Nebula never answered.
        self.headers = headers if headers is not None else {}
        # The refusal's JSON body when it had one (a size 413's `limit` and
        # `scope`, a person gate's `code`); None otherwise.
        self.payload = payload


# A wait for the person's answers (MCP get_answers, `nebula answers --wait`)
# rides through a Nebula restart: question sets are kept with the project, so
# within the wait's own budget a request Nebula never answered is tried again
# after a short backoff (doubling from RETRY_FIRST_SECONDS to RETRY_MAX_SECONDS).
RETRY_FIRST_SECONDS = 0.25
RETRY_MAX_SECONDS = 2.0


def unanswered(exc: BaseException) -> bool:
    """Whether Nebula never answered: refused, reset, closed mid-request or no
    answer in time (`kind` connect/timeout, no status). A real HTTP answer
    (a 404, 403, or a 5xx with a body) has a status and is never retried."""
    return isinstance(exc, NebulaAPIError) and exc.status is None and exc.kind in ("connect", "timeout")


def dropped_mid_request(exc: BaseException) -> bool:
    """Whether Nebula took the request, then went away before answering it
    (closed, reset, or no answer in time after the connect). Nebula was there,
    so this is a restart, not a Nebula that was never running: a refused or
    timed-out connect (httpx.ConnectError, ConnectTimeout) is not this."""
    return unanswered(exc) and isinstance(
        exc.__cause__, (httpx.RemoteProtocolError, httpx.ReadError, httpx.WriteError,
                        httpx.ReadTimeout, httpx.WriteTimeout))


def never_reached(exc: BaseException) -> bool:
    """Whether Nebula couldn't be reached at all: a connect it never took (not
    running, or nothing behind the address file), not a request it took and
    dropped, a timeout or a real answer."""
    return (isinstance(exc, NebulaAPIError) and exc.status is None and exc.kind == "connect"
            and not dropped_mid_request(exc))


def offline_read_only(reread: str) -> str:
    """What an unreachable Nebula means for the person's canvas (round 14 of
    PR #114): the tab is read-only until Nebula reconnects, and blocks edits
    rather than queueing them (a restarted backend refuses replayed writes).
    `reread` is the caller's way to read the canvas again ("call start_here",
    "run `nebula graph`")."""
    return ("While Nebula is offline the person's canvas is read-only: nothing you or they edit is saved or "
            f"queued. Once it's back, {reread} to re-read the canvas before assuming your plan landed.")


def next_backoff(previous: float | None) -> float:
    """The next pause before retrying: RETRY_FIRST_SECONDS, then doubling up to RETRY_MAX_SECONDS."""
    if previous is None:
        return RETRY_FIRST_SECONDS
    return min(previous * 2, RETRY_MAX_SECONDS)


def _payload(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


APP_TOKEN_FILE_ENV = "NEBULA_APP_TOKEN_FILE"
# The token read from NEBULA_APP_TOKEN_FILE, per path, for this process only:
# never put back in the environment (a child process would inherit it).
_file_token: tuple[str, str] | None = None


def app_token_from_file(environ: Any = None) -> str | None:
    """The token in NEBULA_APP_TOKEN_FILE (J2, Justin 2026-11-04): the
    `nebula` CLI run from the listening Claude Code's own shell, whose
    launch command sets the path the MCP config already names. Read with
    the MCP server's strict reader (services/agent_token_file.read: a
    regular file of this user's, mode 600, no symlink), so the shell and
    the MCP tools are one agent. None when the variable isn't set, or a
    personal agent's token file is (load_app_token_file's order). Fails
    closed: a bad file raises NebulaAPIError naming the variable and the
    reason, never the token."""
    global _file_token
    env = os.environ if environ is None else environ
    path = env.get(APP_TOKEN_FILE_ENV)
    if path is None or env.get("NEBULA_AGENT_TOKEN_FILE") is not None:
        return None
    if _file_token is not None and _file_token[0] == path:
        return _file_token[1]
    from services import agent_token_file

    if not path.strip():
        raise NebulaAPIError(f"{APP_TOKEN_FILE_ENV} is empty. Unset it, or point it at the token file that Settings "
                             "› Connect your agent saved.", kind="token")
    try:
        token = agent_token_file.read(path)
    except agent_token_file.TokenFileError as exc:
        # GM r97: r94's shape, the reason as a clause, the command on its own line.
        raise NebulaAPIError(f"Nebula couldn’t read this agent’s token because {APP_TOKEN_FILE_ENV} {exc.clause}. "
                             "Copy a new one from Settings › Connect your agent, then run this command.\n"
                             "nebula mcp connect claude-code --channel", kind="token") from exc
    _file_token = (path, token)
    return token


def _token_source(env: Any) -> str | None:
    """Which variable with_identity sends a token from, in the MCP server's
    order (mcp_server.load_app_token_file; D3, round 5): NEBULA_AGENT_TOKEN
    (an in-app chat's turn token); else NEBULA_APP_TOKEN_FILE, unless a
    personal agent's NEBULA_AGENT_TOKEN_FILE is set (the file replaces any
    NEBULA_APP_TOKEN also set, and a bad one fails closed); else
    NEBULA_APP_TOKEN (a config made before token files). None: no token."""
    if env.get("NEBULA_AGENT_TOKEN"):
        return "NEBULA_AGENT_TOKEN"
    if env.get(APP_TOKEN_FILE_ENV) is not None and env.get("NEBULA_AGENT_TOKEN_FILE") is None:
        return APP_TOKEN_FILE_ENV
    if env.get("NEBULA_APP_TOKEN"):
        return "NEBULA_APP_TOKEN"
    return None


def has_token(environ: Any = None) -> bool:
    """Whether a request from here sends an agent token (with_identity's
    sources, in its order: NIT, review 3)."""
    return _token_source(os.environ if environ is None else environ) is not None


def with_identity(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Add the caller's token (it outranks any name).

    NEBULA_AGENT_TOKEN is an in-app chat's turn token. NEBULA_APP_TOKEN_FILE
    names the token file of an outside app the person made in Settings >
    Connect your agent (it names the app's own spending line,
    services/app_tokens.py); NEBULA_APP_TOKEN is such a token itself. Their
    order is the MCP server's (_token_source), so the CLI in the listening
    Claude's shell and its MCP tools are always one agent (D3)."""
    headers = dict(headers or {})
    source = _token_source(os.environ)
    token = app_token_from_file() if source == APP_TOKEN_FILE_ENV else (os.environ.get(source) if source else None)
    if token:
        headers = {key: value for key, value in headers.items() if key.lower() != "authorization"}
        headers["Authorization"] = f"Agent {token}"
    return headers


def error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text or f"HTTP {response.status_code}"
    detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
    if isinstance(detail, dict):
        detail = detail.get("message") or detail
    return detail if isinstance(detail, str) else str(detail)


class NebulaAPI:
    """Requests to one Nebula backend.

    With `client` (an httpx.Client, or a TestClient in tests) requests reuse
    it; without one each request is a one-shot `httpx.request`, which suits
    the MCP server, whose URL is set after import.

    Nebula is always on this machine, so requests ignore HTTP_PROXY and the
    like (`trust_env=False`): httpx otherwise routes even 127.0.0.1 through a
    configured proxy, and the proxy would see the agent token.
    """

    def __init__(self, base_url: str = DEFAULT_URL, *, timeout: float = 300.0,
                 client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._client = client

    def send(self, method: str, path: str, *, headers: dict[str, str] | None = None, **kwargs: Any) -> httpx.Response:
        """The raw response for a 2xx; NebulaAPIError otherwise."""
        headers = with_identity(headers)
        kwargs.setdefault("timeout", self.timeout)
        try:
            if self._client is not None:
                response = self._client.request(method, path, headers=headers, **kwargs)
            else:
                response = httpx.request(method, f"{self.base_url}{path}", headers=headers,
                                         trust_env=False, **kwargs)
        except httpx.ConnectError as exc:
            raise NebulaAPIError(f"Nebula isn't running at {self.base_url}. Start Nebula, then retry.",
                                 kind="connect") from exc
        except httpx.TimeoutException as exc:
            raise NebulaAPIError(f"Nebula didn't answer {method} {path} in time.", kind="timeout") from exc
        except httpx.HTTPError as exc:
            raise NebulaAPIError(f"{method} {path} failed: {exc}", kind="connect") from exc
        if response.status_code >= 400:
            raise NebulaAPIError(error_detail(response), status=response.status_code, headers=response.headers,
                                 payload=_payload(response))
        return response

    def stream_lines(self, method: str, path: str, *, headers: dict[str, str] | None = None,
                     **kwargs: Any) -> Iterator[str]:
        """Each line of a streamed 2xx answer (NDJSON) as it arrives;
        NebulaAPIError for a refusal, which comes before any line."""
        headers = with_identity(headers)
        kwargs.setdefault("timeout", self.timeout)
        try:
            if self._client is not None:
                context = self._client.stream(method, path, headers=headers, **kwargs)
            else:
                context = httpx.stream(method, f"{self.base_url}{path}", headers=headers, trust_env=False, **kwargs)
            with context as response:
                if response.status_code >= 400:
                    response.read()
                    raise NebulaAPIError(error_detail(response), status=response.status_code)
                for line in response.iter_lines():
                    if line.strip():
                        yield line
        except httpx.ConnectError as exc:
            raise NebulaAPIError(f"Nebula isn't running at {self.base_url}. Start Nebula, then retry.",
                                 kind="connect") from exc
        except httpx.TimeoutException as exc:
            raise NebulaAPIError(f"Nebula didn't answer {method} {path} in time.", kind="timeout") from exc
        except httpx.HTTPError as exc:
            raise NebulaAPIError(f"{method} {path} failed: {exc}", kind="connect") from exc

    def request(self, method: str, path: str, *, binary: bool = False, **kwargs: Any) -> Any:
        response = self.send(method, path, **kwargs)
        if binary:
            return response.content
        try:
            return response.json()
        except ValueError as exc:
            raise NebulaAPIError(f"Nebula sent a response that isn't JSON for {method} {path}",
                                 status=response.status_code) from exc
