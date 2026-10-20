from __future__ import annotations

import os
import sys
from typing import Any
from urllib.parse import quote

import httpx

from nebula_api import NebulaAPI, NebulaAPIError
from services.agent_params import internal_keys, internal_refusal


DEFAULT_BASE = "http://localhost:8000"


class NebulaClient:
    """HTTP client for the Nebula backend API."""

    def __init__(self, base_url: str = DEFAULT_BASE) -> None:
        self.base_url = base_url.rstrip("/")
        # trust_env=False: Nebula is local, and a proxy must never see the token (nebula_api).
        self._client = httpx.Client(base_url=self.base_url, timeout=300.0, trust_env=False)

    @property
    def api(self) -> NebulaAPI:
        """The shared request layer (nebula_api), on this client's connection."""
        return NebulaAPI(self.base_url, client=self._client)

    def _identity_headers(self, headers: dict | None = None) -> dict:
        # The agent token is added by nebula_api.
        # A display name for this agent's cursor on the canvas; a verified
        # agent token, when present, takes precedence on the backend.
        headers = dict(headers or {})
        agent_name = os.environ.get("NEBULA_AGENT_NAME")
        if agent_name:
            headers.setdefault("X-Nebula-Agent", agent_name)
        return headers

    def _request(self, method: str, path: str, *, binary: bool = False, **kwargs: Any) -> Any:
        kwargs["headers"] = self._identity_headers(kwargs.get("headers"))
        try:
            return self.api.request(method, path, binary=binary, **kwargs)
        except NebulaAPIError as exc:
            if exc.kind == "connect":
                message = f"cannot connect to Nebula backend at {self.base_url} — is the server running?"
            elif exc.kind == "timeout":
                message = (f"Nebula didn't answer {method} {path} in time. A run keeps going on the "
                           "backend; `nebula graph` shows what finished.")
            else:
                message = exc.detail
            print(f"error: {message}", file=sys.stderr)
            sys.exit(1)

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

    def krea_status(self) -> str | None:
        """The Krea account sign-in status ("connected", ...), or None if unknown."""
        try:
            status = self.api.request("GET", "/api/krea/connection", timeout=10,
                                      headers=self._identity_headers()).get("status")
        except (NebulaAPIError, AttributeError):
            return None
        return status if isinstance(status, str) else None

    def get_spend(self) -> dict[str, Any]:
        return self._request("GET", "/api/agent/spend")

    # -- Graph --
    @staticmethod
    def _refuse_internal(label: str, params: dict[str, Any]) -> None:
        """Agents don't write the canvas's internal (``_``) params; apply and
        proposals refuse them too (services/agent_params.py). Checked here
        because a CLI run without a name or token carries no agent marker."""
        for key in internal_keys(params):
            print(f"error: {internal_refusal(label, key)}", file=sys.stderr)
            sys.exit(1)

    def create_node(self, definition_id: str, params: dict[str, Any]) -> dict[str, Any]:
        self._refuse_internal(definition_id, params)
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

    # -- Plans: proposals (only the person accepts, in Nebula) and direct edits --
    def propose(self, body: dict[str, Any], agent_name: str | None = None) -> dict[str, Any]:
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("POST", "/api/canvas/proposals", json=body, headers=headers)

    def apply(self, body: dict[str, Any], agent_name: str | None = None) -> dict[str, Any]:
        """Edit the canvas directly, all of it or none of it (POST /api/graph/apply)."""
        headers = {"X-Nebula-Agent": agent_name} if agent_name else None
        return self._request("POST", "/api/graph/apply", json=body, headers=headers)

    def apply_step(self, body: dict[str, Any], agent_name: str | None = None) -> dict[str, Any]:
        """Like apply(), but a refusal raises NebulaAPIError instead of exiting.

        `nebula apply` with steps needs it to say which step stopped and what
        earlier steps already applied."""
        headers = self._identity_headers({"X-Nebula-Agent": agent_name} if agent_name else None)
        return self.api.request("POST", "/api/graph/apply", json=body, headers=headers)

    def undo_edit(self, token: str, agent_name: str | None = None) -> dict[str, Any]:
        """Undo one of your applies by its undo token (POST /api/graph/apply/undo).
        A refusal raises NebulaAPIError, so `nebula undo` can say which token stopped."""
        headers = self._identity_headers({"X-Nebula-Agent": agent_name} if agent_name else None)
        return self.api.request("POST", "/api/graph/apply/undo", json={"token": token}, headers=headers)

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
        self._refuse_internal(node_id, params)
        return self._request("PUT", f"/api/graph/node/{node_id}", json={"params": params})

    def get_node_image_path(self, node_id: str) -> dict[str, Any]:
        """Call GET /api/graph/node/{id}/path. Raises RuntimeError on HTTP error
        with a message suitable for stderr."""
        try:
            return self.api.request("GET", f"/api/graph/node/{node_id}/path", timeout=10,
                                    headers=self._identity_headers())
        except NebulaAPIError as exc:
            if exc.kind == "connect":
                raise RuntimeError(
                    f"cannot connect to Nebula backend at {self.base_url} — is the server running?"
                ) from exc
            raise RuntimeError(exc.detail) from exc

    def clear_graph(self, force: bool = False) -> dict[str, Any]:
        """Empty the open project. The backend refuses a project that has
        nodes without force (409), whoever asks."""
        return self._request("DELETE", "/api/graph", params={"force": "true"} if force else None)

    def import_graph(self, body: dict[str, Any]) -> dict[str, Any]:
        """Replace the graph with a saved one in one step (POST /api/graph/import)."""
        return self._request("POST", "/api/graph/import", json=body)

    def delete_node(self, node_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/api/graph/node/{quote(node_id, safe='')}")

    def disconnect(self, src: str, src_port: str, dst: str, dst_port: str) -> dict[str, Any]:
        return self._request("DELETE", "/api/graph/edge", json={
            "source": src, "sourceHandle": src_port,
            "target": dst, "targetHandle": dst_port,
        })

    def rename_node(self, node_id: str, label: str) -> dict[str, Any]:
        return self._request("PUT", f"/api/graph/node/{quote(node_id, safe='')}/label", json={"label": label})

    def move_nodes(self, positions: dict[str, dict[str, float]]) -> dict[str, Any]:
        return self._request("PUT", "/api/graph/layout", json={"positions": positions})

    # -- Projects --
    def list_projects(self) -> dict[str, Any]:
        return self._request("GET", "/api/projects")

    def create_project(self, name: str, workspace_revision: str) -> dict[str, Any]:
        return self._request("POST", "/api/projects", json={"name": name, "workspaceRevision": workspace_revision})

    def open_project(self, project_id: str, workspace_revision: str) -> dict[str, Any]:
        return self._request("POST", f"/api/projects/{quote(project_id, safe='')}/open",
                             json={"workspaceRevision": workspace_revision})

    # -- Recently deleted --
    def list_trash(self, kind: str | None = None) -> dict[str, Any]:
        return self._request("GET", "/api/trash", params={"kind": kind} if kind else None)

    def restore_trashed(self, kind: str, item_id: str) -> dict[str, Any]:
        return self._request("POST", f"/api/trash/{quote(kind, safe='')}/{quote(item_id, safe='')}/restore")

    # -- Execution --
    def run_graph(self, target_node_id: str | None = None, wait: float | None = None) -> dict[str, Any]:
        """Start a run. With `wait`, return {"status": "running", "runId"} if it
        is still going after that many seconds (it keeps running)."""
        body: dict[str, Any] = {"targetNodeId": target_node_id} if target_node_id else {}
        if wait is not None:
            body["wait"] = wait
        return self._request("POST", "/api/graph/run", json=body,
                             timeout=None if wait is None else wait + 60)

    def get_run(self, run_id: str, wait: float = 0) -> dict[str, Any]:
        return self._request("GET", f"/api/graph/runs/{quote(run_id, safe='')}",
                             params={"wait": wait}, timeout=wait + 60)

    def cancel_run(self, run_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/api/executions/{quote(run_id, safe='')}")

    def quick(self, definition_id: str, inputs: dict[str, str], params: dict[str, Any]) -> dict[str, Any]:
        body = {
            "definitionId": definition_id,
            "inputs": inputs,
            "params": params,
        }
        return self._request("POST", "/api/quick", json=body)
