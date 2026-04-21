from __future__ import annotations

import sys
from typing import Any

import httpx


DEFAULT_BASE = "http://localhost:8000"


class NebulaClient:
    """HTTP client for the Nebula backend API."""

    def __init__(self, base_url: str = DEFAULT_BASE) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=300.0)

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
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
        return resp.json()

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

    def update_node(self, node_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"/api/graph/node/{node_id}", json={"params": params})

    def get_node_image_path(self, node_id: str) -> dict[str, Any]:
        """Call GET /api/graph/node/{id}/path. Raises RuntimeError on HTTP error
        with a message suitable for stderr."""
        try:
            resp = self._client.request("GET", f"/api/graph/node/{node_id}/path", timeout=10)
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
        return self._request("POST", "/api/quick", json={
            "definitionId": definition_id,
            "inputs": inputs,
            "params": params,
        })
