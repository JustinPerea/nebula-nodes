"""Live agent cursors and a screenshot-free view of the canvas.

Agents edit the canvas over HTTP. This module turns those requests into a
visible presence: each identified agent gets a cursor that the browser draws
at the node it touched, plus an optional line of narration. It also keeps the
browser's latest report of what the canvas looks like (viewport, node
positions and sizes, run states) so agents can read the canvas as data
instead of taking screenshots.

Identity comes only from request headers, in this order:
1. ``Authorization: Agent <token>``: a token minted for an in-app chat runner
   (verified, named after the runner).
2. ``X-Daedalus-Caller``: set by the Daedalus runtime's CLI.
3. ``X-Nebula-Agent: <name>``: a self-reported name for outside agents.
Requests with none of these (the browser's own requests) never move a cursor.

Everything here is ephemeral and in memory: cursors expire after
``PRESENCE_TTL_SECONDS`` and nothing is written to disk.
"""
from __future__ import annotations

import hashlib
import math
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Mapping

from services.selection_context import _safe_value as safe_value

PRESENCE_TTL_SECONDS = 120.0
VIEW_STALE_SECONDS = 30.0
MAX_SAY_CHARS = 140
MAX_NAME_CHARS = 32
MAX_VIEW_NODES = 2000
MAX_SNAPSHOT_NODES = 300

ACTIONS = ("move", "click", "drag", "look")
NODE_STATES = ("idle", "queued", "executing", "complete", "error")

_KNOWN_AGENTS = {
    "claude": ("Claude", "#E8825A"),
    "codex": ("Codex", "#5B9DFF"),
    "daedalus": ("Daedalus", "#B583FF"),
}
_EXTERNAL_COLORS = ("#3FC1A5", "#F2C14E", "#FF6B9A", "#7AD3FF", "#C3E86B", "#FF9F43")
_NAME_ALLOWED = re.compile(r"[^A-Za-z0-9 ._()\-·]")
_HANDLE_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")
_NODE_ID_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")

_request_headers: ContextVar[Mapping[str, str] | None] = ContextVar("presence_request_headers", default=None)


class PresenceError(ValueError):
    """A presence or view payload the backend refuses."""


@dataclass(frozen=True)
class AgentIdentity:
    id: str
    name: str
    color: str
    verified: bool

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "color": self.color, "verified": self.verified}


class RequestHeadersContext:
    """ASGI middleware that exposes the current request's headers to graph routes.

    Graph endpoints keep their existing signatures (tests call several of
    them directly); presence reads the headers from this request-local value.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        token = _request_headers.set(headers)
        try:
            await self.app(scope, receive, send)
        finally:
            _request_headers.reset(token)


@contextmanager
def request_headers_scope(headers: Mapping[str, str]) -> Iterator[None]:
    """Set request headers outside the middleware (tests and in-process callers)."""
    token = _request_headers.set({k.lower(): v for k, v in headers.items()})
    try:
        yield
    finally:
        _request_headers.reset(token)


def current_request_headers() -> Mapping[str, str] | None:
    return _request_headers.get()


def clean_agent_name(raw: str) -> str:
    name = _NAME_ALLOWED.sub("", " ".join((raw or "").split()))
    name = " ".join(name.split())[:MAX_NAME_CHARS].strip()
    return name


def _external_color(slug: str) -> str:
    digest = hashlib.sha256(slug.encode("utf-8")).digest()
    return _EXTERNAL_COLORS[digest[0] % len(_EXTERNAL_COLORS)]


def _default_token_lookup(token: str) -> dict | None:
    from commons.actors import agent_registry

    return agent_registry.lookup(token)


def identify(
    headers: Mapping[str, str] | None,
    *,
    token_lookup: Callable[[str], dict | None] = _default_token_lookup,
) -> AgentIdentity | None:
    """Name the agent behind a request, or None for the browser and anonymous calls."""
    if not headers:
        return None
    lower = {k.lower(): v for k, v in headers.items()}
    auth = lower.get("authorization", "")
    if auth.startswith("Agent "):
        record = token_lookup(auth[6:].strip())
        if record is not None:
            runner = str(record.get("runner") or "agent").lower()
            name, color = _KNOWN_AGENTS.get(runner, (clean_agent_name(runner.title()) or "Agent", "#E8825A"))
            return AgentIdentity(id=runner, name=name, color=color, verified=True)
    if lower.get("x-daedalus-caller"):
        name, color = _KNOWN_AGENTS["daedalus"]
        return AgentIdentity(id="daedalus", name=name, color=color, verified=True)
    raw = lower.get("x-nebula-agent")
    if raw:
        name = clean_agent_name(raw)
        if name:
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "agent"
            return AgentIdentity(id=f"ext:{slug}", name=name, color=_external_color(slug), verified=False)
    return None


def _finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PresenceError(f"{label} must be a number")
    number = float(value)
    if not math.isfinite(number) or abs(number) > 1e7:
        raise PresenceError(f"{label} must be a finite number")
    return number


def parse_target(raw: Any, graph_nodes: Mapping[str, Any], label: str = "target") -> dict[str, Any]:
    """Validate a cursor target: ``{"nodeId", "handle"?}`` or flow ``{"x", "y"}``."""
    if not isinstance(raw, dict):
        raise PresenceError(f"{label} must be an object with nodeId or x/y")
    if "nodeId" in raw:
        node_id = raw.get("nodeId")
        if not isinstance(node_id, str) or not _NODE_ID_RE.fullmatch(node_id):
            raise PresenceError(f"{label}.nodeId is invalid")
        if node_id not in graph_nodes:
            raise PresenceError(f"{label}.nodeId '{node_id}' is not on the canvas")
        target: dict[str, Any] = {"nodeId": node_id}
        handle = raw.get("handle")
        if handle is not None:
            if not isinstance(handle, str) or not _HANDLE_RE.fullmatch(handle):
                raise PresenceError(f"{label}.handle is invalid")
            target["handle"] = handle
        return target
    if "x" in raw and "y" in raw:
        return {"x": _finite(raw["x"], f"{label}.x"), "y": _finite(raw["y"], f"{label}.y")}
    raise PresenceError(f"{label} must include nodeId or x and y")


def _clean_say(raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise PresenceError("say must be text")
    text = " ".join(raw.split())
    return text[:MAX_SAY_CHARS]


class AgentPresence:
    """In-memory cursor state and the browser's latest view report."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._agents: dict[str, dict[str, Any]] = {}
        self._view: dict[str, Any] | None = None
        self._view_at: float = 0.0

    # -- cursors --------------------------------------------------------
    def point(
        self,
        identity: AgentIdentity,
        *,
        target: dict[str, Any],
        origin: dict[str, Any] | None = None,
        action: str = "move",
        say: Any = None,
    ) -> dict[str, Any]:
        if action not in ACTIONS:
            raise PresenceError(f"action must be one of {', '.join(ACTIONS)}")
        now = self._clock()
        event: dict[str, Any] = {
            "type": "agentPresence",
            "agent": identity.as_dict(),
            "target": target,
            "action": action,
            "say": _clean_say(say),
            "at": int(now * 1000),
        }
        if origin is not None:
            event["from"] = origin
        self._agents[identity.id] = {**event, "_t": now}
        return event

    def active(self) -> list[dict[str, Any]]:
        now = self._clock()
        expired = [key for key, value in self._agents.items() if now - value["_t"] > PRESENCE_TTL_SECONDS]
        for key in expired:
            del self._agents[key]
        return [
            {
                **value["agent"],
                "target": value["target"],
                "action": value["action"],
                "say": value["say"],
                "secondsAgo": round(now - value["_t"], 1),
            }
            for value in sorted(self._agents.values(), key=lambda v: -v["_t"])
        ]

    def last_point(self, node_id: str) -> dict[str, float] | None:
        """Where the browser last drew a node (its centre), for pointing at a deleted node."""
        reported = ((self._view or {}).get("nodes") or {}).get(node_id)
        if reported is None:
            return None
        return {
            "x": reported["x"] + reported.get("width", 0.0) / 2,
            "y": reported["y"] + reported.get("height", 0.0) / 2,
        }

    def forget_node(self, node_id: str) -> None:
        """Re-anchor cursors that pointed at a deleted node to where it was."""
        fallback = self.last_point(node_id)
        for key, value in list(self._agents.items()):
            origin = value.get("from")
            if isinstance(origin, dict) and origin.get("nodeId") == node_id:
                value.pop("from")
            if value["target"].get("nodeId") == node_id:
                if fallback is None:
                    del self._agents[key]
                else:
                    value["target"] = dict(fallback)

    def forget_graph(self) -> None:
        """Drop node anchors after the whole graph is cleared or replaced.

        Node ids restart per graph, so an old anchor like `n2` would land on an
        unrelated node in the next project. Coordinate-only cursors survive.
        """
        for key, value in list(self._agents.items()):
            origin = value.get("from")
            if isinstance(origin, dict) and "nodeId" in origin:
                value.pop("from")
            if "nodeId" in value["target"]:
                del self._agents[key]

    # -- browser view ---------------------------------------------------
    def report_view(self, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise PresenceError("view report must be an object")
        viewport = body.get("viewport")
        if not isinstance(viewport, dict):
            raise PresenceError("viewport must be an object")
        zoom = _finite(viewport.get("zoom"), "viewport.zoom")
        if not 0.01 <= zoom <= 10:
            raise PresenceError("viewport.zoom must be between 0.01 and 10")
        clean: dict[str, Any] = {
            "viewport": {
                "x": _finite(viewport.get("x"), "viewport.x"),
                "y": _finite(viewport.get("y"), "viewport.y"),
                "zoom": zoom,
            }
        }
        screen = body.get("screen")
        if screen is not None:
            if not isinstance(screen, dict):
                raise PresenceError("screen must be an object")
            width = _finite(screen.get("width"), "screen.width")
            height = _finite(screen.get("height"), "screen.height")
            if width < 0 or height < 0:
                raise PresenceError("screen size must not be negative")
            clean["screen"] = {"width": round(width), "height": round(height)}
        raw_nodes = body.get("nodes", [])
        if not isinstance(raw_nodes, list) or len(raw_nodes) > MAX_VIEW_NODES:
            raise PresenceError(f"nodes must be a list of at most {MAX_VIEW_NODES}")
        nodes: dict[str, dict[str, Any]] = {}
        for index, raw in enumerate(raw_nodes):
            if not isinstance(raw, dict):
                raise PresenceError(f"nodes[{index}] must be an object")
            node_id = raw.get("id")
            if not isinstance(node_id, str) or not _NODE_ID_RE.fullmatch(node_id):
                raise PresenceError(f"nodes[{index}].id is invalid")
            entry: dict[str, Any] = {
                "x": _finite(raw.get("x"), f"nodes[{index}].x"),
                "y": _finite(raw.get("y"), f"nodes[{index}].y"),
            }
            if raw.get("width") is not None and raw.get("height") is not None:
                entry["width"] = _finite(raw["width"], f"nodes[{index}].width")
                entry["height"] = _finite(raw["height"], f"nodes[{index}].height")
            state = raw.get("state")
            if state is not None:
                if state not in NODE_STATES:
                    raise PresenceError(f"nodes[{index}].state is invalid")
                entry["state"] = state
            nodes[node_id] = entry
        clean["nodes"] = nodes
        self._view = clean
        self._view_at = self._clock()
        return {"ok": True, "nodes": len(nodes)}

    # -- snapshot -------------------------------------------------------
    def snapshot(
        self,
        graph: Any,
        registry: Any,
        *,
        selected_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        now = self._clock()
        graph_nodes: Mapping[str, Any] = getattr(graph, "nodes", {})
        graph_edges = list(getattr(graph, "edges", []))
        definitions = registry.get_all()
        view = self._view or {}
        view_nodes: Mapping[str, Any] = view.get("nodes", {})
        age = round(now - self._view_at, 1) if self._view else None

        visible_area = None
        viewport = view.get("viewport")
        screen = view.get("screen")
        if viewport and screen:
            zoom = viewport["zoom"]
            visible_area = {
                "x": round(-viewport["x"] / zoom, 1),
                "y": round(-viewport["y"] / zoom, 1),
                "width": round(screen["width"] / zoom, 1),
                "height": round(screen["height"] / zoom, 1),
            }

        incoming: dict[str, list[str]] = {}
        for edge in graph_edges:
            incoming.setdefault(edge.get("target", ""), []).append(
                f"{edge.get('source')}.{edge.get('sourceHandle')}→{edge.get('targetHandle')}"
            )

        nodes: list[dict[str, Any]] = []
        for node_id, node in list(graph_nodes.items())[:MAX_SNAPSHOT_NODES]:
            definition_id = str(node.get("definitionId", ""))
            definition = definitions.get(definition_id, {}) if isinstance(definitions, dict) else {}
            reported = view_nodes.get(node_id)
            entry: dict[str, Any] = {
                "id": node_id,
                "definitionId": definition_id,
                "name": definition.get("displayName") or definition_id,
                "state": (reported or {}).get("state", "unknown" if reported is None else "idle"),
                "params": safe_value(node.get("params") or {}, key="params"),
                # Like the selection surface: what exists, never the values
                # (they can be signed URLs). `nebula path` / `nebula graph` fetch them.
                "outputs": {
                    str(port): {
                        "type": value.get("type") if isinstance(value, dict) else None,
                        "available": bool(value.get("value") if isinstance(value, dict) else value),
                    }
                    for port, value in (node.get("outputs") or {}).items()
                },
                "inputsFrom": incoming.get(node_id, []),
            }
            if reported is not None:
                entry["position"] = {"x": round(reported["x"], 1), "y": round(reported["y"], 1)}
                if "width" in reported:
                    entry["size"] = {"width": round(reported["width"]), "height": round(reported["height"])}
                if visible_area is not None:
                    entry["onScreen"] = _overlaps(reported, visible_area)
            elif isinstance(node.get("position"), dict):
                entry["position"] = node["position"]
            nodes.append(entry)

        return {
            "view": {
                "reported": self._view is not None,
                "secondsAgo": age,
                "stale": age is None or age > VIEW_STALE_SECONDS,
                "viewport": viewport,
                "screen": screen,
                "visibleArea": visible_area,
            },
            "nodeCount": len(graph_nodes),
            "truncated": len(graph_nodes) > MAX_SNAPSHOT_NODES,
            "nodes": nodes,
            "edges": [
                {
                    "source": edge.get("source"),
                    "sourceHandle": edge.get("sourceHandle"),
                    "target": edge.get("target"),
                    "targetHandle": edge.get("targetHandle"),
                }
                for edge in graph_edges
            ],
            "selection": [node_id for node_id in (selected_ids or []) if node_id in graph_nodes],
            "agents": self.active(),
        }


def _overlaps(node: Mapping[str, Any], area: Mapping[str, float]) -> bool:
    width = node.get("width", 0.0)
    height = node.get("height", 0.0)
    return (
        node["x"] + width >= area["x"]
        and node["x"] <= area["x"] + area["width"]
        and node["y"] + height >= area["y"]
        and node["y"] <= area["y"] + area["height"]
    )


agent_presence = AgentPresence()
