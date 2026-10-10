from __future__ import annotations

import os
import sys
from typing import Any
from urllib.parse import quote

import httpx


DEFAULT_BASE = "http://localhost:8000"


class NebulaClient:
    """HTTP client for the Nebula backend API."""

    def __init__(self, base_url: str = DEFAULT_BASE) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=300.0)

    def _identity_headers(self, headers: dict | None = None) -> dict:
        headers = dict(headers or {})
        # When the CLI is invoked from inside a Daedalus subprocess, the parent
        # hermes runtime sets DAEDALUS_APPROVAL in env. Pass that through as a
        # header so backend guards (e.g. the §1.5 iteration-integrity check on
        # /api/graph/run) can distinguish agent callers from human callers.
        if os.environ.get("DAEDALUS_APPROVAL"):
            headers.setdefault("X-Daedalus-Caller", "1")
        # A display name for this agent's cursor on the canvas. A verified
        # agent token, when present, takes precedence on the backend.
        agent_name = os.environ.get("NEBULA_AGENT_NAME")
        if agent_name:
            headers.setdefault("X-Nebula-Agent", agent_name)
        token = os.environ.get("NEBULA_AGENT_TOKEN")
        if token:
            headers = {key: value for key, value in headers.items() if key.lower() != "authorization"}
            headers["Authorization"] = f"Agent {token}"
        return headers

    def _request(self, method: str, path: str, *, binary: bool = False, **kwargs: Any) -> Any:
        kwargs["headers"] = self._identity_headers(kwargs.get("headers"))
        try:
            resp = self._client.request(method, path, **kwargs)
        except httpx.ConnectError:
            print("error: cannot connect to Nebula backend at "
                  f"{self.base_url} — is the server running?", file=sys.stderr)
            sys.exit(1)
        if resp.status_code >= 400:
            detail = ""
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            print(f"error: {detail}", file=sys.stderr)
            sys.exit(1)
        return resp.content if binary else resp.json()

    def commons_enabled(self) -> bool:
        capability = self._request("GET", "/api/capabilities/commons")
        return isinstance(capability, dict) and capability.get("enabled") is True

    def commons(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        if not os.environ.get("NEBULA_AGENT_TOKEN"):
            headers["X-Nebula-Client"] = "nebula-cli"
        return self._request(method, f"/api/commons{path}", headers=headers, **kwargs)

    def get_agent_context(self) -> dict[str, Any]:
        return self._request("GET", "/api/agent/context")

    # -- Discovery --
    def get_nodes(self) -> dict[str, Any]:
        return self._request("GET", "/api/nodes")

    def get_node(self, node_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/nodes/{node_id}")

    def get_settings(self) -> dict[str, Any]:
        return self._request("GET", "/api/settings")

    # -- Graph --
    def create_node(self, definition_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/graph/node", json={
            "definitionId": definition_id,
            "params": params,
        })

    def connect(self, src: str, src_port: str, dst: str, dst_port: str) -> dict[str, Any]:
        return self._request("POST", "/api/graph/connect", json={
            "source": src, "sourceHandle": src_port,
            "target": dst, "targetHandle": dst_port,
        })

    def get_graph(self) -> dict[str, Any]:
        return self._request("GET", "/api/graph")

    def get_selection(self) -> dict[str, Any]:
        return self._request("GET", "/api/canvas/selection")

    def get_canvas_snapshot(self) -> dict[str, Any]:
        return self._request("GET", "/api/canvas/snapshot")

    def get_canvas_events(
        self,
        params: dict[str, Any],
        timeout: float = 300.0,
        agent_name: str | None = None,
    ) -> dict[str, Any]:
        """Long-poll GET /api/canvas/events; `timeout` must exceed the server-side wait."""
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("GET", "/api/canvas/events", params=params, timeout=timeout, headers=headers)

    def list_pins(self) -> dict[str, Any]:
        return self._request("GET", "/api/canvas/pins")

    def resolve_pin(self, pin_id: str, reply: str, agent_name: str | None = None) -> dict[str, Any]:
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("POST", f"/api/canvas/pins/{quote(pin_id, safe='')}/resolve",
                             json={"reply": reply}, headers=headers)

    # -- Proposals (agents propose; only the person accepts, in Nebula) --
    def propose(self, body: dict[str, Any], agent_name: str | None = None) -> dict[str, Any]:
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("POST", "/api/canvas/proposals", json=body, headers=headers)

    def get_proposal(self, proposal_id: str, wait: float = 0.0, agent_name: str | None = None) -> dict[str, Any]:
        """GET one proposal; `wait` (≤25 s) blocks until the person decides."""
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        params = {"wait": round(wait, 1)} if wait > 0 else None
        return self._request("GET", f"/api/canvas/proposals/{quote(proposal_id, safe='')}",
                             params=params, headers=headers, timeout=wait + 15)

    def withdraw_proposal(self, proposal_id: str, agent_name: str | None = None) -> dict[str, Any]:
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("DELETE", f"/api/canvas/proposals/{quote(proposal_id, safe='')}", headers=headers)

    def list_proposals(self) -> dict[str, Any]:
        return self._request("GET", "/api/canvas/proposals")

    def point_cursor(self, body: dict[str, Any], agent_name: str | None = None) -> dict[str, Any]:
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("POST", "/api/canvas/cursor", json=body, headers=headers)

    def update_node(self, node_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"/api/graph/node/{node_id}", json={"params": params})

    def get_node_image_path(self, node_id: str) -> dict[str, Any]:
        """Call GET /api/graph/node/{id}/path. Raises RuntimeError on HTTP error
        with a message suitable for stderr."""
        try:
            resp = self._client.request("GET", f"/api/graph/node/{node_id}/path", timeout=10,
                                        headers=self._identity_headers())
        except httpx.ConnectError:
            raise RuntimeError(
                f"cannot connect to Nebula backend at {self.base_url} — is the server running?"
            )
        if resp.status_code == 200:
            return resp.json()
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise RuntimeError(detail or f"HTTP {resp.status_code}")

    def clear_graph(self) -> dict[str, Any]:
        return self._request("DELETE", "/api/graph")

    # -- Execution --
    def run_graph(self, target_node_id: str | None = None) -> dict[str, Any]:
        body = {"targetNodeId": target_node_id} if target_node_id else {}
        return self._request("POST", "/api/graph/run", json=body)

    def quick(self, definition_id: str, inputs: dict[str, str], params: dict[str, Any]) -> dict[str, Any]:
        body = {
            "definitionId": definition_id,
            "inputs": inputs,
            "params": params,
        }
        return self._request("POST", "/api/quick", json=body)
