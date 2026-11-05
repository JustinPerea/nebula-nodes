"""Live agent cursors and a screenshot-free view of the canvas.

Agents edit the canvas over HTTP. This module turns those requests into a
visible presence: each identified agent gets a cursor that the browser draws
at the node it touched, plus an optional line of narration. It also keeps the
browser's latest report of what the canvas looks like (viewport, node
positions and sizes, run states) so agents can read the canvas as data
instead of taking screenshots.

Identity comes only from request headers, in this order:
1. ``Authorization: Agent <token>``: a token minted for an in-app chat runner
   (verified, named after the runner), or one the person made for an outside
   app (verified, named as the person named it; services/app_tokens.py).
2. ``X-Nebula-Agent: <name>``: a self-reported name for outside agents.
Requests with none of these (the browser's own requests) never move a cursor.

Everything here is ephemeral and in memory: cursors expire after
``PRESENCE_TTL_SECONDS`` and nothing is written to disk.

Sessions (one cursor per agent session, on the person's tabs only): a
request may also say which session of its agent it is (presence_session).
That is display only. It never changes the identity above, the colour, the
person gate, scene keys or spend. Agents read cursors as the per-agent
"agent form" of each event (``active()``, the snapshot, the roster, /ws
listeners), which is exactly what it was before sessions. Only the person's
verified canvas sockets get the "person form" (person_form): the same event
plus an opaque session key and its number ("Claude · 2"), and the action the
backend's own edits really were (a param edit shows as ``type``).
"""
from __future__ import annotations

import hashlib
import hmac
import math
import re
import secrets
import time
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Collection, Iterator, Mapping

from services import node_route, universal_ports
from services.cursor_actions import ACTIONS, SESSION_RE as _SESSION_RE, refusal as action_refusal
from services.file_param_preview import file_param_keys
from services.upload_names import file_param_name
from services.selection_context import _safe_value as safe_value
from services.text_cut import safe_cut

PRESENCE_TTL_SECONDS = 120.0
VIEW_STALE_SECONDS = 30.0
MAX_SAY_CHARS = 140
MAX_NAME_CHARS = 32
MAX_VIEW_NODES = 2000
MAX_SNAPSHOT_NODES = 300


# One cursor per agent session, on the person's tabs (person_form).
SESSIONS_PER_AGENT = 8          # live slots per agent; the frontend caps at the same number
SESSION_IDLE_SECONDS = 20.0     # the tab's idle time (AGENT_CURSOR_IDLE_MS), pinned by tests; nothing here reads it
SESSION_AGENT_MEMORY = 256      # agents whose live sessions are kept (least recently seen go first)
SESSION_KEY_CHARS = 12
# Where a request's session id may come from, besides an agent token's own
# record (presence_session). X-Nebula-Agent-Session is the MCP server's
# per-process id (it also keys scene reads; presence only reads it);
# X-Nebula-Cursor-Session is presence only (the CLI's, under Claude Code).
SESSION_HEADERS = ("x-nebula-agent-session", "x-nebula-cursor-session")
NODE_STATES = ("idle", "queued", "executing", "complete", "error", "skipped")

_KNOWN_AGENTS = {
    "claude": ("Claude", "#E8825A"),
    "codex": ("Codex", "#5B9DFF"),
}
_EXTERNAL_COLORS = ("#3FC1A5", "#F2C14E", "#FF6B9A", "#7AD3FF", "#C3E86B", "#FF9F43")
_NAME_ALLOWED = re.compile(r"[^A-Za-z0-9 ._()\-·]")
_HANDLE_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")
_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
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

    It sees every HTTP request, so it is also where an agent shows it is
    still there (Q125 item 2): ``on_agent`` gets the identity of every
    identified request, whatever the route (main passes the status book's
    ``saw``, which keeps that agent's status line alive). Never fails the
    request.
    """

    def __init__(self, app, on_agent: Callable[["AgentIdentity"], None] | None = None):
        self.app = app
        self.on_agent = on_agent

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        if self.on_agent is not None and (headers.get("authorization", "").startswith("Agent ")
                                          or headers.get("x-nebula-agent")):
            try:
                identity = identify(headers)
                if identity is not None:
                    self.on_agent(identity)
            except Exception:  # noqa: BLE001 - a sign is bookkeeping; the request goes on
                pass
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


def _default_app_lookup(token: str) -> dict | None:
    from services import app_tokens

    return app_tokens.lookup(token)


def identify(
    headers: Mapping[str, str] | None,
    *,
    token_lookup: Callable[[str], dict | None] = _default_token_lookup,
    app_lookup: Callable[[str], dict | None] = _default_app_lookup,
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
            # A personal agent's token carries the name and color the person
            # gave it (services/personal_agents.py), so prefer those.
            recorded_name = clean_agent_name(str(record.get("display_name") or ""))
            recorded_color = record.get("color")
            if recorded_name:
                name = recorded_name
            if isinstance(recorded_color, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", recorded_color):
                color = recorded_color
            return AgentIdentity(id=runner, name=name, color=color, verified=True)
        app = app_lookup(auth[6:].strip())
        if app is not None:
            # Named (and optionally colored) by the person when they made the
            # token, so it is verified.
            name = clean_agent_name(str(app.get("name") or "")) or "App"
            color = app.get("color")
            if not (isinstance(color, str) and _COLOR_RE.fullmatch(color)):
                color = _external_color(f"app-{app['id']}")
            return AgentIdentity(id=f"app:{app['id']}", name=name, color=color, verified=True)
    raw = lower.get("x-nebula-agent")
    if raw:
        name = clean_agent_name(raw)
        if name:
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "agent"
            return AgentIdentity(id=f"ext:{slug}", name=name, color=_external_color(slug), verified=False)
    return None


def _valid_session(raw: Any) -> str | None:
    return raw if isinstance(raw, str) and _SESSION_RE.fullmatch(raw) else None


def presence_session(
    headers: Mapping[str, str] | None,
    *,
    token_lookup: Callable[[str], dict | None] = _default_token_lookup,
) -> str | None:
    """Which session of its agent a request comes from, for its cursor only.

    In order, skipping a missing or invalid value (at most 64 of
    ``[A-Za-z0-9_.:-]``):
    1. an in-app chat's agent token: its record's chat session, set by
       Nebula when it minted the turn's token (never by the agent), as
       ``chat:<id>``;
    2. ``X-Nebula-Agent-Session``: an MCP server's own id, one per process
       (or ``NEBULA_AGENT_SESSION``);
    3. ``X-Nebula-Cursor-Session``: the CLI's, derived from the Claude Code
       session it runs in.
    None gives the agent's one cursor, as before sessions. Display only: the
    caller uses it for person_form and nothing else.
    """
    if not headers:
        return None
    lower = {k.lower(): v for k, v in headers.items()}
    auth = lower.get("authorization", "")
    if auth.startswith("Agent "):
        record = token_lookup(auth[6:].strip())
        chat = record.get("session") if isinstance(record, dict) else None
        if isinstance(chat, str) and chat:
            found = _valid_session(f"chat:{chat}")
            if found is not None:
                return found
    for header in SESSION_HEADERS:
        found = _valid_session(lower.get(header))
        if found is not None:
            return found
    return None


def _finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PresenceError(f"{label} must be a number")
    try:
        number = float(value)
    except OverflowError:  # an int past float's range
        number = math.inf
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
            raise PresenceError(f"{label}.nodeId {node_id} is not on the canvas")
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


def _clean_did(raw: Mapping[str, Any]) -> dict[str, Any]:
    """What an action was, for the Agents panel: a past-tense verb, and the
    node it names (its id while it is on the canvas, and its name)."""
    verb = " ".join(str(raw.get("verb") or "").split())[:40]
    node_id = raw.get("nodeId")
    label = raw.get("label")
    return {
        "verb": verb,
        "nodeId": node_id if isinstance(node_id, str) and _NODE_ID_RE.fullmatch(node_id) else None,
        "label": " ".join(label.split())[:80] if isinstance(label, str) and label.strip() else None,
    }


def _clean_say(raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise PresenceError("say must be text")
    text = " ".join(raw.split())
    # Never through a character (an accent, an emoji sequence, a flag): review 7, L5.
    return text[:safe_cut(text, MAX_SAY_CHARS)]


# The same cleaning for words said alongside the cursor's (main._show_agent's `log`).
clean_say = _clean_say


@dataclass
class _SessionSlot:
    """One live session's cursor, as the person's tabs draw it."""
    key: str
    ordinal: int
    last_t: float
    target: dict[str, Any] | None
    # The latest person form sent for it: what a person tab that connects
    # later is shown (replay), so every tab draws the same live cursors.
    event: dict[str, Any] | None = None
    # When its cursor came to where it is (ms, AgentPresence._arrival): the
    # backend's arrival order, which every tab stacks by, before and after a
    # reload (GM - Design, PR #211 r21). A move to the same node, or within
    # ARRIVAL_RADIUS of the point it arrived at (`anchor`), keeps it.
    since: int = 0
    # Where it arrived (its target then): the spot later moves are measured
    # from, so a run of small moves can't keep the arrival over any
    # distance (#211 review 9, LOW-1).
    anchor: dict[str, Any] | None = None


# A cursor's new target within this many flow px of its last point keeps its
# arrival (_SessionSlot.since): the tab's stack radius at zoom 1
# (AGENT_CURSOR_STACK.radiusPx), so a nudge never sends it to the back. It
# is also the link of the target chain (carry_nodes), in canvas units at
# zoom 1. The chain decides arrival only: which cursors join one column is
# the tab's, in screen px, with arrow and label overlaps (GM - Design, #219
# r24 Q2).
ARRIVAL_RADIUS = 16.0

# Where a tab points at a node with no handle (agentCursorMotion.resolveAnchor):
# its middle across, this far down into the header, or half its height.
NODE_POINT_DOWN = 44.0


def _header_point(x: float, y: float, width: float, height: float) -> tuple[float, float]:
    """Where a cursor aimed at a node (no handle) points, as the tab draws it
    (agentCursorMotion.nodeHeaderPoint): across its middle, NODE_POINT_DOWN
    into its header, or half its height. The shared fixture
    tests/fixtures/cursor_chains.json holds both to it."""
    return x + width / 2, y + min(NODE_POINT_DOWN, height / 2)


def _target_chains(points: Mapping[str, tuple[float, float]]) -> dict[str, frozenset[str]]:
    """Each cursor's target chain: the other cursors linked to it through
    targets ARRIVAL_RADIUS apart or less, one link after another."""
    keys = list(points)
    parent = {key: key for key in keys}

    def find(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for i, a in enumerate(keys):
        ax, ay = points[a]
        for b in keys[i + 1:]:
            bx, by = points[b]
            if math.hypot(ax - bx, ay - by) <= ARRIVAL_RADIUS + 1e-9:
                parent[find(a)] = find(b)
    groups: dict[str, set[str]] = {}
    for key in keys:
        groups.setdefault(find(key), set()).add(key)
    return {key: frozenset(groups[find(key)] - {key}) for key in keys}


def _same_spot(before: dict[str, Any] | None, after: dict[str, Any]) -> bool:
    """Whether ``after`` keeps a cursor at ``before``, the spot it arrived
    at, for its arrival order: the same node, or two points ARRIVAL_RADIUS
    apart or less."""
    if before is None:
        return False
    if "nodeId" in before or "nodeId" in after:
        return before.get("nodeId") is not None and before.get("nodeId") == after.get("nodeId")
    try:
        return math.hypot(float(after["x"]) - float(before["x"]), float(after["y"]) - float(before["y"])) <= ARRIVAL_RADIUS
    except (KeyError, TypeError, ValueError):
        return False


def _forget_in_event(slot: _SessionSlot, gone: Callable[[dict[str, Any]], bool]) -> None:
    """A slot's kept event loses a node that went, as _agents' copy does:
    its drag origin, and the node in its last action (the name stays)."""
    event = slot.event
    if event is None:
        return
    origin = event.get("from")
    if isinstance(origin, dict) and gone(origin):
        event.pop("from")
    did = event.get("did")
    if isinstance(did, dict) and did.get("nodeId") and gone({"nodeId": did["nodeId"]}):
        event["did"] = {**did, "nodeId": None}


class AgentPresence:
    """In-memory cursor state and the browser's latest view report."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._agents: dict[str, dict[str, Any]] = {}
        self._view: dict[str, Any] | None = None
        self._view_at: float = 0.0
        # Sessions (person_form). Apart from _agents, so nothing an agent
        # reads (active, here, the snapshot) ever sees them.
        self._session_secret = secrets.token_bytes(16)
        # agent id -> raw session ('' for none) -> its live slot, oldest first.
        # The one source of every session's number: tabs show it as given.
        self._slots: OrderedDict[str, OrderedDict[str, _SessionSlot]] = OrderedDict()
        # The last arrival handed out (ms): each new one is later, so no two
        # sessions share one and a clock stepped back never puts a new
        # arrival ahead of the old ones (#211 review 9, LOW-2, NIT-3).
        self._last_arrival = 0
        # Each person form's id (``eventId``): the Agent log lists an action
        # once by it, a live event and its replay alike, and never drops a
        # real repeat (review 9, LOW-5). Per boot, so a restart can't reuse one.
        self._boot = secrets.token_hex(4)
        self._event_seq = 0
        # Every node's box as the last graph sync had it (carry_nodes): what
        # the next one's moves are measured from.
        self._boxes: dict[str, dict[str, float]] | None = None

    # -- cursors --------------------------------------------------------
    def point(
        self,
        identity: AgentIdentity,
        *,
        target: dict[str, Any] | None,
        origin: dict[str, Any] | None = None,
        action: str = "move",
        say: Any = None,
        did: Mapping[str, Any] | None = None,
        project_id: str | None = None,
        log: Any = None,
    ) -> dict[str, Any]:
        """The broadcast event for one agent action.

        ``target=None`` is an action with no place on the canvas (a moodboard
        write): the event carries no ``target``, so the browser lists it in
        the Agent log and moves no cursor, and the agent's cursor here keeps
        its last place.

        ``did`` names what the action was in the Agents panel's words (Q125
        item 2): ``{"verb": "Added", "nodeId", "label"}``, the verb past
        tense, the node's name when it has one. With none (a line said in
        place, or a pointer gesture GM cut: a click, a drag, a bare move to a
        spot), the cursor keeps the agent's last action wherever it goes,
        with that action's own time: the event's ``did`` carries
        ``secondsAgo``, 0 for an action that just happened.
        ``project_id`` is the project open when it happened: the roster
        lists a cursor only in its own project. ``log`` is the Agent log's
        line when it isn't ``say`` (PR #198 r1): an action whose bubble says
        nothing still has one; the event carries it only when given.
        """
        if not isinstance(action, str) or action not in ACTIONS:
            raise PresenceError(action_refusal(action))
        now = self._clock()
        event: dict[str, Any] = {
            "type": "agentPresence",
            "agent": identity.as_dict(),
            "action": action,
            "say": _clean_say(say),
            "at": int(now * 1000),
            "projectId": project_id,
        }
        logged = _clean_say(log)
        if logged:
            event["log"] = logged
        if target is None:
            return event
        event["target"] = target
        if origin is not None:
            event["from"] = origin
        previous = self._agents.get(identity.id)
        if previous is not None and now - previous["_t"] > PRESENCE_TTL_SECONDS:
            previous = None  # expired: its action went with it
        did_at = now
        # Carried only within its own project: a rename in A never shows in B.
        if did is None and previous is not None and previous.get("did") and previous.get("projectId") == project_id:
            did = previous["did"]
            did_at = previous.get("_did_t", previous["_t"])
        stored: dict[str, Any] = {**event, "_t": now}
        if did is not None:
            clean = _clean_did(did)
            event["did"] = {**clean, "secondsAgo": round(now - did_at, 1)}
            stored["did"] = clean
            stored["_did_t"] = did_at
        self._agents[identity.id] = stored
        return event

    def here(self, identity: AgentIdentity) -> tuple[dict[str, Any], str]:
        """Where a line said with no target goes, and which place that is:
        the agent's own cursor (`cursor`, so it doesn't move), else the
        middle of the person's view when the browser reported one (`view`),
        else (0, 0) (`origin`)."""
        self.active()  # drops expired cursors first
        current = self._agents.get(identity.id)
        if current is not None:
            return dict(current["target"]), "cursor"
        return self._view_middle()

    def _view_middle(self) -> tuple[dict[str, Any], str]:
        view = self._view or {}
        viewport, screen = view.get("viewport"), view.get("screen")
        if viewport and screen:
            zoom = viewport["zoom"]
            return {"x": round((screen["width"] / 2 - viewport["x"]) / zoom, 1),
                    "y": round((screen["height"] / 2 - viewport["y"]) / zoom, 1)}, "view"
        return {"x": 0.0, "y": 0.0}, "origin"

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
                "projectId": value.get("projectId"),
                **({"did": {**value["did"], "secondsAgo": round(now - value.get("_did_t", value["_t"]), 1)}}
                   if value.get("did") else {}),
            }
            for value in sorted(self._agents.values(), key=lambda v: -v["_t"])
        ]

    # -- sessions (the person's tabs only) ------------------------------
    def session_key(self, agent_id: str, raw: str) -> str:
        """The opaque key a tab gets for a session: never the raw id, and
        different per agent and per backend process."""
        message = f"{agent_id}\0{raw}".encode("utf-8")
        return hmac.new(self._session_secret, message, hashlib.sha256).hexdigest()[:SESSION_KEY_CHARS]

    def _slot(self, agent_id: str, raw: str, now: float) -> _SessionSlot | None:
        """This session's live slot, made on its first event with a target.

        Numbers go among the agent's live sessions (GM - Design, PR #211 r1):
        a new session takes the lowest number no live one holds, and the
        agent's plain cursor counts as 1 ("Claude"). A live session keeps its
        number until its cursor leaves, so nothing renumbers under the person.
        A cursor leaves when it has had no event for PRESENCE_TTL_SECONDS (the
        frontend's AGENT_CURSOR_EXPIRE_MS, when the tab prunes it too), or
        when the cap below pushes it out. Its number is free from then on.

        At most SESSION_AGENT_MEMORY agents keep slots. Past that, the least
        recently seen agent with no live cursor goes; an agent with a live
        cursor is never pushed out, so its numbers never change under the
        person (GM - Design, PR #211 r5). When every kept agent is live, a new
        agent gets None: its events go out with no session, the plain agent
        cursor, until room frees.
        """
        slots = self._slots.get(agent_id)
        if slots is None:
            if len(self._slots) >= SESSION_AGENT_MEMORY:
                gone = next((other for other, kept in self._slots.items()
                             if all(now - live.last_t > PRESENCE_TTL_SECONDS for live in kept.values())), None)
                if gone is None:
                    return None
                del self._slots[gone]
            slots = self._slots[agent_id] = OrderedDict()
        else:
            self._slots.move_to_end(agent_id)
        for stale in [k for k, slot in slots.items() if now - slot.last_t > PRESENCE_TTL_SECONDS]:
            del slots[stale]
        slot = slots.get(raw)
        if slot is None:
            if len(slots) >= SESSIONS_PER_AGENT:
                # An agent can't flood the canvas with cursors: the least
                # recently seen session goes. That is an idle one (quiet for
                # SESSION_IDLE_SECONDS) whenever any is idle, since idle means
                # seen longest ago; no separate idle rule is needed (review 2,
                # N5 was an equivalent mutant of one).
                victim = min(slots.items(), key=lambda item: item[1].last_t)[0]
                del slots[victim]
            taken = {live.ordinal for live in slots.values()}
            number = 1
            while number in taken:
                number += 1
            slot = _SessionSlot(key=self.session_key(agent_id, raw), ordinal=number, last_t=now, target=None)
            slots[raw] = slot
        slot.last_t = now
        return slot

    def session_tag(self, identity: AgentIdentity, session: str | None) -> dict[str, Any] | None:
        """``{key, ordinal}`` of this session's live cursor, read only (no slot
        is made or touched), or None when it has none: for main._person_form
        when the person form fails, so the tab gets the real number or none."""
        raw = session if session is not None and _valid_session(session) else ""
        slot = (self._slots.get(identity.id) or {}).get(raw)
        if slot is None or self._clock() - slot.last_t > PRESENCE_TTL_SECONDS:
            return None
        return {"key": slot.key, "ordinal": slot.ordinal}

    def live_sessions(self, agent_id: str) -> list[tuple[str, int]]:
        """(key, number) of an agent's live sessions, oldest first (tests, diagnostics)."""
        return [(slot.key, slot.ordinal) for slot in (self._slots.get(agent_id) or {}).values()]

    def _arrival(self, now: float) -> int:
        """A new arrival time (ms): the wall clock, kept comparable with the
        events' own ``at`` (a tab falls back to it for a cursor with no
        arrival), but always after the last one handed out."""
        self._last_arrival = max(int(now * 1000), self._last_arrival + 1)
        return self._last_arrival

    def _event_id(self) -> str:
        self._event_seq += 1
        return f"{self._boot}-{self._event_seq}"

    def _target_point(self, target: Mapping[str, Any], boxes: Mapping[str, Mapping[str, float]]) -> tuple[float, float] | None:
        """A cursor target as a point in canvas units, where a tab draws it
        (agentCursorMotion.resolveAnchor): a point as it is; a node at its
        header's middle, sized from the browser's last view report (none
        reported: its corner). A handle counts as its node's point: the
        backend doesn't know where ports sit, and the cursors on one node
        move together anyway."""
        node_id = target.get("nodeId")
        if node_id is None:
            try:
                return float(target["x"]), float(target["y"])
            except (KeyError, TypeError, ValueError):
                return None
        box = boxes.get(node_id)
        if box is None:
            return None
        seen = ((self._view or {}).get("nodes") or {}).get(node_id) or {}
        width = float(seen.get("width") or 0.0)
        height = float(seen.get("height") or 0.0)
        return _header_point(box["x"], box["y"], width, height)

    def carry_nodes(self, positions: Mapping[str, Mapping[str, Any]] | None,
                    placed: Collection[str] | None = None) -> list[dict[str, Any]]:
        """Every graph sync (main._carry_cursors, whatever moved the nodes:
        a drag, an arrange, an agent's move or apply, an undo or redo)
        passes the node positions it sent. A session cursor whose node moved
        arrives now only when the move changed its target chain: the other
        cursors linked to it through targets ARRIVAL_RADIUS apart, from
        targets alone, in canvas units at zoom 1 (GM - Design, #219 r24 Q2).
        A node moving with all its cursors keeps their places, however far.
        The backend holds every input, so every tab and a reload agree.
        The cursors one move makes arrive keep their order among themselves.
        ``None`` (the graph replaced or cleared) forgets the positions: node
        ids restart, and nothing is carried. Returns the person-only arrival
        updates (``[{agentId, key, ordinal, since}]``) for the person's tabs.

        ``placed`` (when given) names the nodes with a stored position. A node
        without one is drawn where main._display_positions computes it, and
        that spot shifts when a sibling gets a position or is deleted; an open
        canvas keeps such a node where it drew it (only a sync's ``moved``
        moves it), so it keeps the box it had here too: no false carry
        (#219 review 2, LOW-3). Its first stored position is its first move."""
        previous = self._boxes
        if positions is None:
            self._boxes = None
            return []
        current: dict[str, dict[str, float]] = {}
        for node_id, position in positions.items():
            node_id = str(node_id)
            if placed is not None and node_id not in placed and previous and node_id in previous:
                current[node_id] = previous[node_id]  # unplaced: nothing moved it
                continue
            try:
                current[node_id] = {"x": float(position["x"]), "y": float(position["y"])}
            except (KeyError, TypeError, ValueError):
                continue
        self._boxes = current
        if not previous:
            return []
        moved = {node_id for node_id, box in current.items()
                 if node_id in previous and (previous[node_id]["x"], previous[node_id]["y"]) != (box["x"], box["y"])}
        if not moved:
            return []
        now = self._clock()
        live = [(agent_id, slot) for agent_id, slots in self._slots.items() for slot in slots.values()
                if slot.target is not None and now - slot.last_t <= PRESENCE_TTL_SECONDS]
        if not any((slot.target or {}).get("nodeId") in moved for _, slot in live):
            return []
        before: dict[str, tuple[float, float]] = {}
        after: dict[str, tuple[float, float]] = {}
        for _, slot in live:
            was = self._target_point(slot.target, {**current, **previous})
            now_at = self._target_point(slot.target, current)
            if was is not None and now_at is not None:
                before[slot.key] = was
                after[slot.key] = now_at
        chains_before = _target_chains(before)
        chains_after = _target_chains(after)
        updates = [(slot.since, agent_id, slot) for agent_id, slot in live
                   if slot.target.get("nodeId") in moved and slot.key in before
                   and chains_before[slot.key] != chains_after[slot.key]]
        out: list[dict[str, Any]] = []
        for _, agent_id, slot in sorted(updates, key=lambda u: (u[0], u[1], u[2].key)):
            slot.since = self._arrival(now)
            out.append({"agentId": agent_id, "key": slot.key, "ordinal": slot.ordinal, "since": slot.since})
        return out

    def person_form(
        self,
        event: dict[str, Any],
        identity: AgentIdentity,
        *,
        session: str | None,
        shown: str | None = None,
        in_place: bool = False,
        live_only: bool = False,
    ) -> dict[str, Any] | None:
        """The person tabs' copy of ``event`` (the agent form point returned).

        It adds ``session`` ({key, ordinal}), the plain cursor's too: the
        backend is the one place that numbers, so a tab never works out a
        number for itself (GM - Design, PR #211 r3). The one event with no
        session is a new agent's past the agent cap (``_slot``): the tab
        draws it as the plain agent cursor, with no number. It shows ``shown`` (the
        action a backend edit really was) in place of ``action``. With
        ``in_place`` (a line said with no target), the target is this
        session's own cursor, else the middle of the view, never another
        session's cursor. The result is kept on the slot for ``replay``.

        With ``live_only`` (an accept, main._accepted_person_form) it lands
        only on a cursor this session already has, live, and returns None
        otherwise: no slot is made, and an agent past the agent cap gets no
        click either (GM - Design, PR #211 review 4: an unnumbered cursor
        can't be tied to the session). Liveness and the slot are read at one
        time, so a cursor whose TTL runs out between two reads never comes
        back (review 4, NIT-1).
        """
        if "target" not in event:
            # The Agent log only: no cursor, no session. Its id is for the
            # person's tabs; agents read the event as it was.
            return {**event, "eventId": self._event_id()}
        raw = session if session is not None and _valid_session(session) else ""
        now = self._clock()
        if live_only:
            kept = (self._slots.get(identity.id) or {}).get(raw)
            if kept is None or now - kept.last_t > PRESENCE_TTL_SECONDS:
                return None
        slot = self._slot(identity.id, raw, now)
        person = dict(event)
        if shown is not None and shown in ACTIONS:
            person["action"] = shown
        if slot is None:
            return person  # past the agent cap: the plain agent cursor, with no session or number
        if in_place:
            if slot.target is not None:
                person["target"] = dict(slot.target)
            elif raw or len(self._slots.get(identity.id) or {}) > 1:
                # A session's first words: not on another session's cursor.
                person["target"] = self._view_middle()[0]
        if not _same_spot(slot.anchor, person["target"]):
            slot.since = self._arrival(now)
            slot.anchor = dict(person["target"])
        slot.target = dict(person["target"])
        person["session"] = {"key": slot.key, "ordinal": slot.ordinal}
        person["since"] = slot.since
        person["eventId"] = self._event_id()
        slot.event = person
        return person

    def replay(self) -> list[dict[str, Any]]:
        """Every live cursor in its person form, for one person tab that just
        connected (its verified hello), oldest first so the newest paints on
        top. Person-only: it carries sessions and numbers, so it never goes to
        a socket without a verified hello. Each has ``replay: true`` (the tab
        draws it where it is, no flight) and ``secondsAgo`` (how old its last
        event is, so the tab shows a say only while it is still current). A
        drag's ``from`` is left out: there is nothing to replay."""
        now = self._clock()
        out: list[dict[str, Any]] = []
        for slots in self._slots.values():
            for raw, slot in list(slots.items()):
                if now - slot.last_t > PRESENCE_TTL_SECONDS:
                    del slots[raw]  # it left: its number is free, as _slot drops it
                    continue
                if slot.event is None or slot.target is None:
                    continue
                age = now - slot.last_t
                cursor = {key: value for key, value in slot.event.items() if key != "from"}
                cursor["target"] = dict(slot.target)
                cursor["session"] = {"key": slot.key, "ordinal": slot.ordinal}
                cursor["since"] = slot.since
                if isinstance(cursor.get("did"), dict):
                    did = cursor["did"]
                    cursor["did"] = {**did, "secondsAgo": round(float(did.get("secondsAgo") or 0) + age, 1)}
                cursor["secondsAgo"] = round(age, 1)
                cursor["replay"] = True
                out.append(cursor)
        out.sort(key=lambda cursor: cursor["at"])
        return out

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
            did = value.get("did")
            if isinstance(did, dict) and did.get("nodeId") == node_id:
                value["did"] = {**did, "nodeId": None}  # its name stays: "Removed “Hero”"
            if value["target"].get("nodeId") == node_id:
                if fallback is None:
                    del self._agents[key]
                else:
                    value["target"] = dict(fallback)
        for slots in self._slots.values():
            for raw, slot in list(slots.items()):
                _forget_in_event(slot, lambda anchor: anchor.get("nodeId") == node_id)
                if slot.target is not None and slot.target.get("nodeId") == node_id:
                    if fallback is None:
                        del slots[raw]  # it leaves, as the agent's cursor does: its number is free
                    else:
                        slot.target = dict(fallback)
                        # Where the node was is where it is now: its arrival stays.
                        if (slot.anchor or {}).get("nodeId") == node_id:
                            slot.anchor = dict(fallback)

    def forget_graph(self) -> None:
        """Drop node anchors after the whole graph is cleared or replaced.

        Node ids restart per graph, so an old anchor like `n2` would land on an
        unrelated node in the next project. Coordinate-only cursors survive.
        """
        self._boxes = None  # node positions too: carry_nodes measures from none
        for key, value in list(self._agents.items()):
            origin = value.get("from")
            if isinstance(origin, dict) and "nodeId" in origin:
                value.pop("from")
            did = value.get("did")
            if isinstance(did, dict) and did.get("nodeId"):
                value["did"] = {**did, "nodeId": None}
            if "nodeId" in value["target"]:
                del self._agents[key]
        # A session cursor on a node leaves with it, as the agent's cursor
        # does above and the tab's does (agentPresenceStore.forgetGraph): a
        # /clear that clears the canvas frees the old chat's number.
        for slots in self._slots.values():
            for raw, slot in list(slots.items()):
                _forget_in_event(slot, lambda anchor: "nodeId" in anchor)
                if slot.target is not None and "nodeId" in slot.target:
                    del slots[raw]

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
            entry = redacted_node(node_id, node, definition, incoming.get(node_id, []))
            entry["state"] = (reported or {}).get("state", "unknown" if reported is None else "idle")
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


def output_availability(outputs: Any) -> dict[str, Any]:
    """Like the selection surface: what exists, never the values (they can be
    signed URLs). `nebula path` / `nebula graph` fetch them."""
    return {
        str(port): {
            "type": value.get("type") if isinstance(value, dict) else None,
            "available": bool(value.get("value") if isinstance(value, dict) else value),
        }
        for port, value in (outputs if isinstance(outputs, Mapping) else {}).items()
    }


def redacted_node(node_id: str, node: Mapping[str, Any], definition: Mapping[str, Any],
                  inputs_from: list[str]) -> dict[str, Any]:
    """One node as agents read it (look_at_canvas, and get_project for a saved
    project): its name, redacted params, which outputs exist, its wires in, an
    input's `fileName` (the name its file was uploaded with), and a universal
    node's `ports` (from its model).
    `node` is a canvas node: definitionId, params, outputs and the label the
    person or an agent gave it (none when it goes by the model's name)."""
    definition_id = str(node.get("definitionId", ""))
    name = node_route.node_name(definition, node.get("label"), definition_id)
    entry: dict[str, Any] = {
        "id": node_id,
        "definitionId": definition_id,
        # The person's (or an agent's) name for it, else its canvas title
        # (review 18 M-D: the name the canvas shows).
        "name": name,
        "params": safe_value(node.get("params") or {}, key="params"),
        "outputs": output_availability(node.get("outputs") or {}),
        "inputsFrom": inputs_from,
    }
    if node.get("label") and name == node.get("label"):
        entry["model"] = definition.get("displayName") or definition_id
    # An agent's placeholder (Q125 item 3): whose; runs skip it.
    from services.pending_nodes import owner as pending_owner  # imports this module

    who = pending_owner(node)
    if who is not None:
        entry["pending"] = {"agent": who["name"], "agentId": who["id"]}
    # The name each file param shows the person (GM r48 Q1 on #222,
    # services/upload_names.py): the name it was uploaded with, else the
    # path's base name, never a bare content hash ("Uploaded file"). Params
    # keep only the stored (hashed) path, and the private `_fileName` isn't
    # copied above. `fileName` is filePath's (an input node's file).
    params = node.get("params")
    if isinstance(params, Mapping):
        keys = file_param_keys(definition)
        if "filePath" not in keys and isinstance(params.get("filePath"), str):
            keys = ["filePath", *keys]
        names = {key: name for key in keys if (name := file_param_name(params, key))}
        if names.get("filePath"):
            entry["fileName"] = names["filePath"]
        if any(key != "filePath" for key in names):
            entry["fileNames"] = names
    # A universal node's ports come from its model: say which, once
    # (its `_model_ports` record isn't repeated in params).
    model_ports = universal_ports.stored_ports(definition_id, node.get("params"))
    if model_ports is not None:
        if isinstance(entry["params"], dict):
            entry["params"].pop(universal_ports.PORTS_PARAM, None)
        entry["ports"] = {"inputs": universal_ports.port_ids(model_ports[0]),
                          "outputs": universal_ports.port_ids(model_ports[1])}
        # Ports typed without the model's data saying so (a Replicate
        # file output with no hint or example): model_schema's `note`.
        guessed = [str(port["id"]) for port in [*model_ports[0], *model_ports[1]]
                   if port.get("typeUnconfirmed")]
        if guessed:
            entry["ports"]["unconfirmed"] = guessed
            # What that means and what to do (re-send an old stamp's model).
            note = universal_ports.stored_port_note(definition_id, node.get("params"))
            if note:
                entry["ports"]["note"] = note
    return entry


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
