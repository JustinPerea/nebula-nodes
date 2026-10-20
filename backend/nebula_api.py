"""One HTTP layer for Nebula's agent clients: the `nebula` CLI and the MCP server.

Both send the same identity (the agent token, a display name) and turn a
failed request into the backend's own `detail`, which is written as the next
step to take ("over the session limit; propose_change ..."). The CLI prints
it and exits; the MCP server raises it as the tool's error.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:8000"


class NebulaAPIError(RuntimeError):
    """A request Nebula refused (`status` set) or never answered (`kind` connect/timeout)."""

    def __init__(self, detail: str, *, status: int | None = None, kind: str = "http",
                 headers: Any = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status = status
        self.kind = kind
        # The refusal's response headers (case-insensitive), e.g. a preview's
        # X-Nebula-Last-Run-Error; empty when Nebula never answered.
        self.headers = headers if headers is not None else {}


def with_identity(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Add the caller's token (it outranks any name).

    NEBULA_AGENT_TOKEN is an in-app chat's turn token. NEBULA_APP_TOKEN is one
    the person made for an outside app in Settings > Connect your agent: it names
    the app's own spending line (services/app_tokens.py). The turn token wins."""
    headers = dict(headers or {})
    token = os.environ.get("NEBULA_AGENT_TOKEN") or os.environ.get("NEBULA_APP_TOKEN")
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
            raise NebulaAPIError(error_detail(response), status=response.status_code, headers=response.headers)
        return response

    def request(self, method: str, path: str, *, binary: bool = False, **kwargs: Any) -> Any:
        response = self.send(method, path, **kwargs)
        if binary:
            return response.content
        try:
            return response.json()
        except ValueError as exc:
            raise NebulaAPIError(f"Nebula sent a response that isn't JSON for {method} {path}",
                                 status=response.status_code) from exc
