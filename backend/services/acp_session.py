"""Long-lived ACP sessions: the person's own agent, driven from the chat panel.

One ``AcpHostSession`` per open personal chat. It owns:

- the agent subprocess (its own process group, a scrubbed environment, an
  absolute binary, cwd = a private Nebula workspace);
- an ``AcpConnection`` (services/acp_client.py) speaking ACP v1 to it;
- one Nebula session token, minted after ``initialize`` and written to a
  0600 file outside the workspace (services/agent_token_file.py). Only the
  file's path goes to the agent, in the ``nebula`` MCP server entry of
  ``session/new``, because adapters may put that entry's environment in
  argv. The token names the shared outside budget
  (``outside:personal:<agentId>``) and is revoked, and its file deleted,
  whenever the session ends, however it ends.

The process lives across turns. It ends on close_session, /clear, switching
agent, the chat socket disconnecting, the idle timeout, a cancel the agent
ignores, a crash (including one during a cancel), Settings switching the agent
off, removing it or changing its command (``AcpSessionManager.close_stale``),
or backend shutdown; every path goes through ``close``, which revokes the
token and kills the whole process tree in a task of its own (so cancelling
the caller can't skip the kill) and releases the workspace. A close that
lands while the session is still starting wins: ``start`` checks after each
of its awaits and gives up, so it never mints a token or turns "ready" once
the teardown has begun. The agent's
environment drops Nebula's secrets and every provider key in
services/credential_catalog.py.

Nebula declines ``fs`` and ``terminal`` and answers those methods -32601.
That is not a sandbox: the agent still has its own shell, network and files.
Permission requests become Allow once / Deny cards; Nebula never picks an
"always" option, because that would write a rule into the agent's own config,
and a request nobody answers is denied after PERMISSION_TIMEOUT_S.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator
from uuid import uuid4

from services import agent_binaries, agent_spend, agent_token_file, personal_agents
from services.acp_client import (
    AUTH_REQUIRED, METHOD_NOT_FOUND, STREAM_LIMIT_BYTES, AcpConnection, AcpConnectionClosed, AcpError,
)
from services.acp_events import ToolCallState, TurnTextBudget, capped_json, make_redactor, map_session_update
from services.agent_process import spawn_agent_process, terminate_agent_process_tree
from services.child_env import scrubbed_env
from services.krea_agent_mcp import NEBULA_SERVER_NAME, nebula_acp_mcp_server

logger = logging.getLogger(__name__)

ACP_PROTOCOL_VERSION = 1
APP_VERSION = "0.1.0"
CLIENT_INFO = {"name": "nebula-nodes", "title": "Nebula Nodes", "version": APP_VERSION}
CLIENT_CAPABILITIES = {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}
INIT_TIMEOUT_S = 30.0
# An ``authenticate`` on start only refreshes a login the person made in
# Settings; past this it is waiting for a browser sign-in nobody will see.
AUTH_TIMEOUT_S = 45.0
SET_OPTION_TIMEOUT_S = 20.0
MAX_CONFIG_OPTIONS = 4
MAX_OPTION_VALUES = 64
# Config option categories the chat lets the person pick per session.
PICKABLE_CATEGORIES = ("model", "thought_level")
PERMISSION_TIMEOUT_S = 120.0
CANCEL_GRACE_S = 10.0
CLOSE_RPC_TIMEOUT_S = 2.0
IDLE_TIMEOUT_S = 1800.0
IDLE_CHECK_INTERVAL_S = 60.0
MAX_LIVE_SESSIONS = 4
ENDED_MEMORY = 64
STDERR_TAIL_BYTES = 8192
NEBULA_MCP_NAME = NEBULA_SERVER_NAME
MAX_MESSAGE_CHARS = 100_000
# Environment variables the agent must never inherit, beyond child_env's list
# (Nebula's spending tokens and every provider key): personal_agents.AGENT_ENV_DROP.
_AGENT_ENV_DROP = personal_agents.AGENT_ENV_DROP

PERSONAL_AGENT_PRIMER_TAIL = (
    "YOUR SETUP. You are the person's own agent, with your own tools, memory and "
    "settings. Nebula added its `nebula` MCP server to this session: use those "
    "tools for everything on the canvas. They run under the person's spending "
    "limits, shared with every agent outside Nebula's own chats. Your current "
    "directory is a private Nebula workspace, not the person's project."
)


class PersonalSessionError(Exception):
    """A personal session could not start or continue; ``code`` goes to the UI."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def agent_base_env(command: Path) -> dict[str, str]:
    """The environment every personal agent process starts from: the backend's,
    scrubbed of secrets and provider keys, with PATH built around its binary."""
    env = scrubbed_env()
    for key in _AGENT_ENV_DROP:
        env.pop(key, None)
    env["PATH"] = agent_binaries.child_path(Path(command))
    return env


def _short(value: Any, limit: int) -> str:
    return str(value)[:limit] if isinstance(value, (str, int, float)) else ""


def clean_config_options(raw: Any) -> list[dict[str, Any]]:
    """The select options worth a picker (model, thinking level), flattened and capped."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict) or item.get("type") != "select" or item.get("category") not in PICKABLE_CATEGORIES:
            continue
        config_id = item.get("id")
        if not isinstance(config_id, str) or not config_id or len(config_id) > 64:
            continue
        values: list[dict[str, str]] = []
        for entry in item.get("options") or []:
            group = entry.get("options") if isinstance(entry, dict) and isinstance(entry.get("options"), list) else [entry]
            for option in group:
                if isinstance(option, dict) and isinstance(option.get("value"), str) and option["value"] \
                        and len(option["value"]) <= 200 and len(values) < MAX_OPTION_VALUES:
                    values.append({"value": option["value"], "name": _short(option.get("name") or option["value"], 80)})
        current = item.get("currentValue") if isinstance(item.get("currentValue"), str) else None
        if not values:
            continue
        out.append({"id": config_id, "name": _short(item.get("name") or config_id, 40),
                    "category": item["category"], "current": current, "options": values})
        if len(out) >= MAX_CONFIG_OPTIONS:
            break
    return out


LEGACY_MODEL_OPTION = "_session_model"


def legacy_model_option(raw: Any) -> list[dict[str, Any]]:
    """The older ``models`` field (session/set_model), as one picker."""
    if not isinstance(raw, dict) or not isinstance(raw.get("availableModels"), list):
        return []
    values = []
    for model in raw["availableModels"][:MAX_OPTION_VALUES]:
        if isinstance(model, dict) and isinstance(model.get("modelId"), str) and model["modelId"] \
                and len(model["modelId"]) <= 200:
            values.append({"value": model["modelId"], "name": _short(model.get("name") or model["modelId"], 80)})
    if not values:
        return []
    current = raw.get("currentModelId") if isinstance(raw.get("currentModelId"), str) else None
    return [{"id": LEGACY_MODEL_OPTION, "name": "Model", "category": "model", "current": current, "options": values}]


def _primer() -> str:
    from services.chat_session import NEBULA_MCP_PRIMER
    return f"{NEBULA_MCP_PRIMER}\n\n{PERSONAL_AGENT_PRIMER_TAIL}"


async def _spawn(argv: list[str], env: dict[str, str], cwd: Path) -> asyncio.subprocess.Process:
    """The one place an agent process starts: in its own process group, and
    watched by the agent guardian (services/agent_guardian.py), which kills
    the group if the backend dies without running any cleanup."""
    return await spawn_agent_process(
        *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env, cwd=str(cwd), limit=STREAM_LIMIT_BYTES)


async def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    """Close the agent's stdin, then kill it and everything it started."""
    try:
        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
    except Exception:
        pass
    try:
        await terminate_agent_process_tree(proc)
    except Exception:
        logger.warning("Personal agent tree cleanup reported a problem", exc_info=True)
    # The root may already have exited (a crash, or stdin EOF): its process
    # group can still hold grandchildren.
    if os.name == "posix" and isinstance(proc.pid, int) and proc.pid > 0:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


@dataclass
class PendingPermission:
    id: str
    acp_request_id: Any
    future: asyncio.Future
    allow_option: str | None
    reject_option: str | None
    resolved: bool = False


@dataclass
class _Turn:
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    text_budget: TurnTextBudget = field(default_factory=TurnTextBudget)


_TURN_END = object()


class AcpHostSession:
    def __init__(self, *, spec: personal_agents.LaunchSpec, owner: str, state_dir: Path, output_root: Path,
                 backend_url: str, workspace_sessions: Any) -> None:
        self.spec = spec
        self.agent_id = spec.agent_id
        self.owner = owner
        self.display_name = spec.display_name
        self.color = spec.color
        self.state_dir = Path(state_dir)
        self.output_root = Path(output_root)
        self.backend_url = backend_url
        self._workspaces = workspace_sessions
        self.workspace_session = workspace_sessions.acquire(self.state_dir, f"personal:{self.agent_id}", None, None)
        self.id: str = self.workspace_session.id
        self.workdir: Path = self.workspace_session.workspace
        self.proc: asyncio.subprocess.Process | None = None
        self.conn: AcpConnection | None = None
        self.acp_session_id: str | None = None
        self.agent_caps: dict[str, Any] = {}
        self.agent_info: dict[str, Any] = {}
        # What the person may pick for this session (clean_config_options).
        self.options: list[dict[str, Any]] = []
        self.token: str | None = None
        self.token_file: Path | None = None
        self.state = "starting"
        self.last_activity = time.monotonic()
        self.closed_reason: str | None = None
        self._turn: _Turn | None = None
        self._pending_perm: dict[str, PendingPermission] = {}
        self._primed = False
        self._stderr_tail = bytearray()
        self._stderr_task: asyncio.Task | None = None
        self._watch_task: asyncio.Task | None = None
        self._close_task: asyncio.Task | None = None
        self._closing = False
        # What this session was allowed to start as (personal_agents.launch_key);
        # AcpSessionManager.open sets it, close_stale compares it.
        self.launch_key: tuple | None = None
        self._tools = ToolCallState()
        self._redact = make_redactor(*spec.secrets)
        self._background: set[asyncio.Task] = set()

    # -- lifecycle ---------------------------------------------------------------------

    @property
    def prompt_images(self) -> bool:
        """Whether the agent says its prompts may carry images (ACP promptCapabilities.image)."""
        caps = self.agent_caps.get("promptCapabilities")
        return isinstance(caps, dict) and caps.get("image") is True

    def _agent_env(self) -> dict[str, str]:
        env = agent_base_env(Path(self.spec.argv[0]))
        env.update(self.spec.env)
        env["NEBULA_URL"] = self.backend_url
        return env

    def _give_up_if_closing(self) -> None:
        """Raise once close() has begun. start() calls this after each await,
        so a session closed while it starts (Settings switched it off, the
        chat was replaced or the backend is stopping) never mints a token
        after the teardown revoked, and never turns "ready" over "closed"."""
        if self._closing:
            raise PersonalSessionError("personal_session_ended", self.ended_message())

    async def start(self) -> None:
        from commons import actors
        try:
            self._give_up_if_closing()
            proc = await _spawn(self.spec.argv, self._agent_env(), self.workdir)
            if self._closing:
                # The teardown ran during the spawn and found no process to
                # kill, so this one is start's to kill.
                await asyncio.shield(_kill_tree(proc))
                self._give_up_if_closing()
            self.proc = proc
            self._stderr_task = asyncio.create_task(self._drain_stderr())
            self.conn = AcpConnection(self.proc, on_notification=self._on_notification,
                                      on_request=self._on_request, on_cancel_request=self._on_cancel_request)
            self.conn.start()
            try:
                init = await self.conn.request("initialize", {
                    "protocolVersion": ACP_PROTOCOL_VERSION, "clientCapabilities": CLIENT_CAPABILITIES,
                    "clientInfo": CLIENT_INFO}, timeout=max(INIT_TIMEOUT_S, self.spec.startup_timeout))
            except asyncio.TimeoutError as exc:
                raise PersonalSessionError("personal_agent_start_timeout",
                                           f"{self.display_name} didn't answer in time.") from exc
            self._give_up_if_closing()
            init = init if isinstance(init, dict) else {}
            if init.get("protocolVersion") != ACP_PROTOCOL_VERSION:
                raise PersonalSessionError(
                    "acp_version_unsupported",
                    f"{self.display_name} speaks ACP version {init.get('protocolVersion')!r}; Nebula speaks 1.")
            self.agent_caps = init.get("agentCapabilities") if isinstance(init.get("agentCapabilities"), dict) else {}
            self.agent_info = init.get("agentInfo") if isinstance(init.get("agentInfo"), dict) else {}
            # A sign-in the person made in Settings, before any token exists.
            await self._authenticate(init)
            self._give_up_if_closing()
            # From the check above to the file write nothing awaits, so a
            # teardown either starts after this (and revokes the token and
            # deletes the file) or already stopped start() above.
            self.token = actors.agent_registry.mint(
                f"personal:{self.agent_id}", [self.output_root, self.workdir], workspace=self.workdir,
                spend_key=agent_spend.personal_agent_spend_key(self.agent_id, self.id),
                display_name=self.display_name, color=self.color)
            self._redact = make_redactor(self.token, *self.spec.secrets)
            name = str(self.agent_info.get("name") or self.agent_id)[:64]
            version = str(self.agent_info.get("version") or "")[:32]
            actors.agent_registry.set_model(self.token, f"{name}@{version}" if version else name)
            self.token_file = agent_token_file.write(self.state_dir, self.id, self.token)
            mcp = nebula_acp_mcp_server(self.backend_url, self.token_file, self.display_name)
            try:
                created = await self.conn.request("session/new", {"cwd": str(self.workdir), "mcpServers": [mcp]},
                                                  timeout=max(INIT_TIMEOUT_S, self.spec.startup_timeout))
            except AcpError as exc:
                self._give_up_if_closing()
                if exc.code == AUTH_REQUIRED:
                    where = (f"Sign in in Settings > Preferences > Personal agents > {self.display_name}"
                             if self.spec.auth_method else "Open a terminal, sign in to it there")
                    raise PersonalSessionError(
                        "auth_required", f"{self.display_name} needs you to sign in. {where}, then try again.",
                    ) from exc
                raise PersonalSessionError("personal_agent_start_failed",
                                           f"{self.display_name} couldn't start a session: {self._redact(exc.message)}") from exc
            except asyncio.TimeoutError as exc:
                raise PersonalSessionError("personal_agent_start_timeout",
                                           f"{self.display_name} didn't start a session in time.") from exc
            self._give_up_if_closing()
            session_id = created.get("sessionId") if isinstance(created, dict) else None
            if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
                raise PersonalSessionError("personal_agent_start_failed", f"{self.display_name} returned no session id.")
            self.acp_session_id = session_id
            self.options = clean_config_options(created.get("configOptions")) or legacy_model_option(created.get("models"))
            self.state = "ready"
            self.last_activity = time.monotonic()
            self._watch_task = asyncio.create_task(self._watch())
        except AcpConnectionClosed as exc:
            # A close during start kills the agent, which ends the connection:
            # say why Nebula stopped it, not that it exited.
            stopped_by_nebula = self._closing
            await self.close("start_failed")
            if stopped_by_nebula:
                raise PersonalSessionError("personal_session_ended", self.ended_message()) from exc
            raise PersonalSessionError("personal_agent_start_failed",
                                       f"{self.display_name} exited while starting{self._exit_detail()}") from exc
        except PersonalSessionError:
            await self.close("start_failed")
            raise
        except (OSError, ValueError) as exc:
            await self.close("start_failed")
            raise PersonalSessionError("personal_agent_start_failed",
                                       f"{self.display_name} couldn't start: {self._redact(str(exc))}") from exc
        except BaseException:
            await asyncio.shield(self.close("start_failed"))
            raise

    async def _authenticate(self, init: dict[str, Any]) -> None:
        """Re-use a sign-in the person made in Settings (services/antigravity_agent.py).

        Only for agents whose spec names an auth method, and only one the agent
        offers. The agent's own browser flow can't open here (the spec sets
        BROWSER to a no-op), so a timeout means the stored login is gone."""
        method = self.spec.auth_method
        if method is None or self.conn is None:
            return
        offered = init.get("authMethods") if isinstance(init.get("authMethods"), list) else []
        if not any(isinstance(m, dict) and m.get("id") == method for m in offered):
            raise PersonalSessionError("personal_agent_start_failed",
                                       f"{self.display_name} no longer offers the sign-in Nebula used.")
        again = f"Sign in again in Settings > Preferences > Personal agents > {self.display_name}."
        try:
            await self.conn.request("authenticate", {"methodId": method}, timeout=AUTH_TIMEOUT_S)
        except asyncio.TimeoutError as exc:
            try:
                personal_agents.set_signed_in(self.state_dir, self.agent_id, False)
            except personal_agents.PersonalAgentError:
                pass
            raise PersonalSessionError("auth_required",
                                       f"{self.display_name} needs you to sign in with Google again. {again}") from exc
        except AcpError as exc:
            raise PersonalSessionError("auth_required", f"{self.display_name} couldn't use your sign-in: "
                                       f"{self._redact(exc.message)[:200]}. If this keeps happening, {again[0].lower()}{again[1:]}") from exc

    def option_view(self) -> list[dict[str, Any]]:
        return [dict(option, options=list(option["options"])) for option in self.options]

    async def set_option(self, config_id: Any, value: Any) -> list[dict[str, Any]]:
        """The person picked a model (or thinking level) for this session."""
        option = next((o for o in self.options if o["id"] == config_id), None)
        if option is None or not isinstance(value, str) or value not in {v["value"] for v in option["options"]}:
            raise PersonalSessionError("personal_option_invalid", "That choice isn't one this agent offers.")
        if self.state != "ready" or self.conn is None or not self.acp_session_id:
            raise PersonalSessionError("personal_option_busy", "Wait for the agent to finish its turn, then pick again.")
        try:
            if config_id == LEGACY_MODEL_OPTION:
                await self.conn.request("session/set_model", {"sessionId": self.acp_session_id, "modelId": value},
                                        timeout=SET_OPTION_TIMEOUT_S)
                option["current"] = value
            else:
                result = await self.conn.request("session/set_config_option", {
                    "sessionId": self.acp_session_id, "configId": config_id, "value": value},
                    timeout=SET_OPTION_TIMEOUT_S)
                fresh = clean_config_options(result.get("configOptions")) if isinstance(result, dict) else []
                if fresh:
                    self.options = fresh
                else:
                    option["current"] = value
        except (AcpError, asyncio.TimeoutError, AcpConnectionClosed) as exc:
            detail = self._redact(exc.message)[:200] if isinstance(exc, AcpError) else "no answer"
            raise PersonalSessionError("personal_option_failed", f"{self.display_name} didn't switch: {detail}.") from exc
        self.last_activity = time.monotonic()
        return self.option_view()

    async def _drain_stderr(self) -> None:
        stream = self.proc.stderr if self.proc else None
        if stream is None:
            return
        try:
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    return
                self._stderr_tail.extend(chunk)
                if len(self._stderr_tail) > STDERR_TAIL_BYTES:
                    del self._stderr_tail[:-STDERR_TAIL_BYTES]
        except (asyncio.CancelledError, Exception):
            return

    def last_stderr_line(self) -> str:
        text = self._stderr_tail.decode("utf-8", errors="replace")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return self._redact(lines[-1])[:300] if lines else ""

    def _exit_detail(self) -> str:
        code = self.proc.returncode if self.proc else None
        line = self.last_stderr_line()
        detail = f" (code {code})" if code is not None else ""
        return f"{detail}: {line}" if line else detail + "."

    async def _watch(self) -> None:
        """Close the session if the agent exits between turns."""
        assert self.conn is not None
        await self.conn.closed_event.wait()
        if self._closing or self._turn is not None:
            return
        await self._wait_exit()
        await self.close("crashed")

    async def _wait_exit(self) -> None:
        if self.proc is not None and self.proc.returncode is None:
            try:
                await asyncio.wait_for(self.proc.wait(), 2.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                pass

    @property
    def closed(self) -> bool:
        """True from the moment close() begins, whatever start() is doing."""
        return self._closing or self.state == "closed"

    async def close(self, reason: str) -> None:
        """End the session: kill the tree, revoke the token, release the workspace. Idempotent.

        The teardown runs in its own task, started once. Cancelling a caller
        (a websocket task uvicorn cancels on reload, say) stops that caller
        waiting, not the kill, and every later close() waits on the same
        task, so close_all() at shutdown still sees the tree gone."""
        if self._close_task is None:
            self._closing = True
            self.state = "closed"
            self.closed_reason = reason
            self._close_task = asyncio.create_task(self._teardown())
        await asyncio.shield(self._close_task)

    async def _teardown(self) -> None:
        """Kill the tree, revoke the token, release the workspace. Runs once, in its own task."""
        from commons import actors
        # Revoke first: whatever the kill below meets, the token is dead.
        if self.token is not None:
            actors.agent_registry.revoke(self.token)
        for pending in list(self._pending_perm.values()):
            self._settle(pending, "cancelled")
        conn, proc = self.conn, self.proc
        try:
            close_cap = (self.agent_caps.get("sessionCapabilities") or {}).get("close") \
                if isinstance(self.agent_caps.get("sessionCapabilities"), dict) else None
            if conn is not None and not conn.closed and close_cap is not None and self.acp_session_id:
                try:
                    await conn.request("session/close", {"sessionId": self.acp_session_id},
                                       timeout=CLOSE_RPC_TIMEOUT_S)
                except Exception:
                    pass
            if proc is not None:
                await _kill_tree(proc)
            if conn is not None:
                await conn.close()
            for task in (self._stderr_task, self._watch_task):
                if task is not None and task is not asyncio.current_task() and not task.done():
                    task.cancel()
        finally:
            # Again at the end: start() can't mint once closing began, but a
            # token must never outlive its session whatever changes later.
            if self.token is not None:
                actors.agent_registry.revoke(self.token)
            agent_token_file.remove(self.token_file)
            try:
                self._workspaces.release(self.workspace_session)
            except Exception:
                pass

    # -- protocol callbacks ------------------------------------------------------------

    def _emit(self, event: dict[str, Any]) -> None:
        turn = self._turn
        if turn is not None:
            turn.queue.put_nowait(event)

    def _on_notification(self, method: str, params: dict) -> None:
        if method != "session/update" or params.get("sessionId") != self.acp_session_id:
            return
        update = params.get("update")
        if isinstance(update, dict) and update.get("sessionUpdate") == "config_option_update":
            fresh = clean_config_options(update.get("configOptions"))
            if fresh:
                self.options = fresh
                self._emit({"type": "personal_options", "sessionId": self.id, "options": self.option_view()})
            return
        if self._turn is None:
            return
        self.last_activity = time.monotonic()
        for event in map_session_update(params.get("update"), self._tools, redact=self._redact,
                                        budget=self._turn.text_budget):
            self._emit(event)

    async def _on_request(self, method: str, params: dict, request_id: Any) -> Any:
        if method == "session/request_permission":
            return await self._permission(params, request_id)
        # fs/*, terminal/*, elicitation/* and anything else: declined.
        raise AcpError(METHOD_NOT_FOUND, "Method not found")

    def _on_cancel_request(self, request_id: Any) -> None:
        for pending in list(self._pending_perm.values()):
            if pending.acp_request_id == request_id:
                self._settle(pending, "cancelled")

    def _settle(self, pending: PendingPermission, decision: str) -> None:
        if not pending.future.done():
            pending.future.set_result(decision)

    async def _permission(self, params: dict, request_id: Any) -> dict:
        options = [o for o in (params.get("options") or []) if isinstance(o, dict) and isinstance(o.get("optionId"), str)]
        allow = next((o["optionId"] for o in options if o.get("kind") == "allow_once"), None)
        reject = next((o["optionId"] for o in options if o.get("kind") == "reject_once"), None)

        def refuse() -> dict:
            if reject is not None:
                return {"outcome": {"outcome": "selected", "optionId": reject}}
            return {"outcome": {"outcome": "cancelled"}}

        if self._turn is None or self.closed or params.get("sessionId") != self.acp_session_id:
            return refuse()
        tool_call = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
        tool_call_id = tool_call.get("toolCallId") if isinstance(tool_call.get("toolCallId"), str) else ""
        known = self._tools.describe(tool_call_id) if tool_call_id else {}
        title = tool_call.get("title") if isinstance(tool_call.get("title"), str) else known.get("title") or ""
        kind = tool_call.get("kind") if isinstance(tool_call.get("kind"), str) else known.get("kind") or "other"
        raw_input = tool_call.get("rawInput") if tool_call.get("rawInput") is not None else known.get("rawInput")
        pending = PendingPermission(uuid4().hex, request_id, asyncio.get_running_loop().create_future(), allow, reject)
        self._pending_perm[pending.id] = pending
        self._emit({
            "type": "permission_request", "requestId": pending.id, "toolCallId": self._redact(tool_call_id),
            "title": self._redact(str(title))[:200] or "The agent wants to use a tool",
            "kind": kind, "input": capped_json(raw_input if raw_input is not None else {}, 4000, self._redact),
            "canAllow": allow is not None, "timeoutSeconds": int(PERMISSION_TIMEOUT_S),
        })
        self.last_activity = time.monotonic()
        try:
            try:
                decision = await asyncio.wait_for(asyncio.shield(pending.future), PERMISSION_TIMEOUT_S)
            except asyncio.TimeoutError:
                decision = "timed_out"
        except asyncio.CancelledError:
            self._emit({"type": "permission_resolved", "requestId": pending.id, "outcome": "cancelled"})
            raise
        finally:
            self._pending_perm.pop(pending.id, None)
        if decision == "allow" and allow is not None:
            self._emit({"type": "permission_resolved", "requestId": pending.id, "outcome": "allowed"})
            return {"outcome": {"outcome": "selected", "optionId": allow}}
        if decision == "cancelled":
            self._emit({"type": "permission_resolved", "requestId": pending.id, "outcome": "cancelled"})
            return {"outcome": {"outcome": "cancelled"}}
        outcome = "timed_out" if decision == "timed_out" else "denied"
        self._emit({"type": "permission_resolved", "requestId": pending.id, "outcome": outcome})
        if reject is None:
            # Nothing to refuse with but "cancelled": cancel the turn too, so
            # the agent can't read "cancelled" as anything but a no.
            task = asyncio.create_task(self._notify_cancel())
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        return refuse()

    def resolve_permission(self, request_id: Any, decision: Any, owner: str) -> bool:
        """The person's answer to a card. Only the owning chat connection counts."""
        if owner != self.owner or decision not in {"allow", "deny"} or not isinstance(request_id, str):
            return False
        pending = self._pending_perm.get(request_id)
        if pending is None or pending.future.done():
            return False
        pending.future.set_result(decision)
        return True

    async def _notify_cancel(self) -> None:
        if self.conn is None or self.conn.closed or not self.acp_session_id:
            return
        try:
            await self.conn.notify("session/cancel", {"sessionId": self.acp_session_id})
        except AcpConnectionClosed:
            pass

    # -- turns -------------------------------------------------------------------------

    async def prompt(self, message: str, selection_context: str | None = None) -> AsyncIterator[dict[str, Any]]:
        """Run one turn; yields chat events, ending with ``result``."""
        if self.state != "ready" or self.conn is None:
            raise PersonalSessionError("personal_session_ended", "This chat's agent has stopped. Send again to start a new one.")
        self.state = "prompting"
        self.last_activity = time.monotonic()
        turn = _Turn()
        self._turn = turn
        blocks = []
        if not self._primed:
            blocks.append({"type": "text", "text": _primer()})
            self._primed = True
        if selection_context:
            blocks.append({"type": "text", "text": selection_context})
        blocks.append({"type": "text", "text": message[:MAX_MESSAGE_CHARS]})
        prompt_task = asyncio.create_task(
            self.conn.request("session/prompt", {"sessionId": self.acp_session_id, "prompt": blocks}))
        prompt_task.add_done_callback(lambda _t: turn.queue.put_nowait(_TURN_END))
        try:
            while True:
                event = await turn.queue.get()
                if event is _TURN_END:
                    break
                yield event
            while not turn.queue.empty():
                event = turn.queue.get_nowait()
                if event is not _TURN_END:
                    yield event
            try:
                result = prompt_task.result()
            except AcpConnectionClosed:
                if self.closed:
                    # Nebula ended it mid-turn (Settings switched it off, say).
                    self._turn = None
                    yield {"type": "error", "code": "personal_session_ended", "message": self.ended_message()}
                    return
                await self._wait_exit()
                detail = self._exit_detail()
                self._turn = None
                await self.close("crashed")
                yield {"type": "error", "code": "personal_session_ended",
                       "message": f"{self.display_name} exited{detail}"}
                return
            except AcpError as exc:
                yield {"type": "error", "message": f"{self.display_name}: {self._redact(exc.message)}"}
                yield {"type": "result", "text": "", "stopReason": "error"}
                return
            stop = result.get("stopReason") if isinstance(result, dict) else None
            if stop == "refusal":
                yield {"type": "system", "text": f"{self.display_name} declined to continue."}
            elif stop == "max_tokens":
                yield {"type": "system", "text": f"{self.display_name} hit its output limit."}
            elif stop == "max_turn_requests":
                yield {"type": "system", "text": f"{self.display_name} hit its turn limit."}
            yield {"type": "result", "text": "", "stopReason": stop if isinstance(stop, str) else "end_turn"}
        except (asyncio.CancelledError, GeneratorExit):
            await asyncio.shield(self.cancel_turn(prompt_task))
            raise
        finally:
            if self._turn is turn:
                self._turn = None
            if self.conn is not None and self.conn.closed and not self.closed:
                # The agent died during the turn on a path that didn't close
                # the session (a cancel, say). _watch skipped it because a turn
                # was running, so this is the last chance: never go back to
                # "ready" with a dead process and a live token.
                await asyncio.shield(self._close_after_exit())
            if self.state == "prompting":
                self.state = "ready"
            self.last_activity = time.monotonic()

    async def _close_after_exit(self) -> None:
        await self._wait_exit()
        await self.close("crashed")

    def ended_message(self) -> str:
        reason = self.closed_reason
        if reason == "agent_changed":
            return (f"{self.display_name} was switched off, removed or changed in Settings, so Nebula stopped it. "
                    "If it's still on there, send again to start a new conversation.")
        if reason == "commons_enabled":
            return f"Commons is on, so Nebula stopped {self.display_name}."
        return "This chat's agent has stopped. Send again to start a new conversation."

    async def cancel_turn(self, prompt_task: asyncio.Task | None = None) -> None:
        """session/cancel, answer open cards "cancelled", wait for the agent, else kill it."""
        if self.closed:
            return
        await self._notify_cancel()
        for pending in list(self._pending_perm.values()):
            self._settle(pending, "cancelled")
        if prompt_task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(prompt_task), CANCEL_GRACE_S)
        except asyncio.TimeoutError:
            await self.close("cancel_timeout")
        except AcpConnectionClosed:
            # The agent exited while stopping: that ends the session, token and all.
            await self._close_after_exit()
        except Exception:
            pass


class AcpSessionManager:
    """Every live personal session, by id, owned by one chat connection each."""

    def __init__(self) -> None:
        self._sessions: dict[str, AcpHostSession] = {}
        self._reaper: asyncio.Task | None = None
        # Teardowns still running for sessions already pruned (a session
        # leaves _sessions the moment its close begins). Shutdown waits on them.
        self._teardowns: set[asyncio.Task] = set()
        self._shutting_down = False
        # Why recently ended sessions ended, by id: (owner, message), so a send
        # that arrives after a prune can still say why. Bounded.
        self._ended: dict[str, tuple[str, str]] = {}

    def live(self) -> list[AcpHostSession]:
        return [s for s in self._sessions.values() if not s.closed]

    async def open(self, owner: str, agent_id: str, *, state_dir: Path, output_root: Path, backend_url: str,
                   workspace_sessions: Any, home: Path | None = None) -> AcpHostSession:
        if not personal_agents.warning_acknowledged(state_dir):
            raise PersonalSessionError(
                "personal_agent_warning_required",
                "Read and accept the personal agent notice before starting one.")
        # One personal chat per panel: a new one replaces the old.
        await self.close_owned(owner)
        self._prune()
        if self._shutting_down:
            raise PersonalSessionError("personal_agent_shutting_down", "Nebula is shutting down.")
        # The spec is read off the loop: for Gemini it runs `gemini --version`
        # and `--help` (services/gemini_cli_setup.py), which take seconds on a
        # cold start and would freeze every socket if run here.
        key = personal_agents.launch_key(state_dir, agent_id)
        try:
            spec = await asyncio.to_thread(personal_agents.launch_spec, state_dir, agent_id, home)
        except personal_agents.PersonalAgentError as exc:
            raise PersonalSessionError(exc.code, exc.message) from exc
        if self._shutting_down:
            raise PersonalSessionError("personal_agent_shutting_down", "Nebula is shutting down.")
        # Settings may have changed while the spec was read. From this check to
        # registering the session nothing awaits, so a later Settings change
        # can't fall between the check and the moment close_stale can see it.
        if personal_agents.launch_key(state_dir, agent_id) != key:
            raise PersonalSessionError("personal_agent_changed",
                                       f"{spec.display_name}'s settings changed while it started. Send again.")
        if len(self.live()) >= MAX_LIVE_SESSIONS:
            raise PersonalSessionError("personal_agent_limit",
                                       f"At most {MAX_LIVE_SESSIONS} personal agents can run at once. Close one first.")
        session = AcpHostSession(spec=spec, owner=owner, state_dir=state_dir, output_root=output_root,
                                 backend_url=backend_url, workspace_sessions=workspace_sessions)
        session.launch_key = key
        self._sessions[session.id] = session
        try:
            await session.start()
            # A registry change that didn't go through close_stale (another
            # backend process, a hand edit) while it started: stop it now.
            if not self.still_allowed(session, state_dir):
                await session.close("agent_changed")
                raise PersonalSessionError("personal_session_ended", session.ended_message())
            # Shutdown began while it started; close_all may already be done.
            if self._shutting_down:
                await session.close("shutdown")
                raise PersonalSessionError("personal_agent_shutting_down", "Nebula is shutting down.")
        except BaseException:
            self._forget(session.id)
            raise
        self._ensure_reaper()
        return session

    def get(self, session_id: Any, owner: str) -> AcpHostSession | None:
        session = self._sessions.get(session_id) if isinstance(session_id, str) else None
        if session is None or session.owner != owner or session.closed:
            return None
        return session

    def find(self, session_id: Any) -> AcpHostSession | None:
        return self._sessions.get(session_id) if isinstance(session_id, str) else None

    async def close(self, session_id: Any, owner: str, reason: str = "closed") -> bool:
        session = self.get(session_id, owner)
        if session is None:
            return False
        await session.close(reason)
        self._prune()
        return True

    async def close_owned(self, owner: str, reason: str = "replaced") -> None:
        for session in [s for s in self._sessions.values() if s.owner == owner]:
            await session.close(reason)
        self._prune()

    def still_allowed(self, session: AcpHostSession, state_dir: Path) -> bool:
        """Whether Settings still allow what ``session`` was started as."""
        current = personal_agents.launch_key(state_dir, session.agent_id)
        return current is not None and current == session.launch_key

    async def close_stale(self, state_dir: Path) -> list[str]:
        """Stop every live session Settings no longer allow: the agent was
        switched off or removed, or a custom agent's command or args changed.
        Called after every registry write and before reusing a session."""
        stale = [s for s in self.live() if not self.still_allowed(s, state_dir)]
        if stale:
            await asyncio.gather(*(s.close("agent_changed") for s in stale), return_exceptions=True)
        self._prune()
        return [s.id for s in stale]

    async def close_all(self, reason: str = "shutdown") -> None:
        """Close every session and wait for every teardown, including ones a
        reaper or a cancelled caller started for sessions already pruned."""
        sessions = list(self._sessions.values())
        if sessions:
            await asyncio.gather(*(s.close(reason) for s in sessions), return_exceptions=True)
        self._prune()
        if self._teardowns:
            # shield: cancelling close_all must not cancel a kill in progress.
            await asyncio.gather(*(asyncio.shield(t) for t in list(self._teardowns)), return_exceptions=True)
        if self._reaper is not None and not self._reaper.done():
            self._reaper.cancel()
        self._reaper = None

    async def shutdown(self) -> None:
        """Backend shutdown: refuse new sessions from now on (an open() that
        was waiting on close_owned would otherwise start an agent after this
        returns), then close everything."""
        self._shutting_down = True
        await self.close_all("shutdown")

    def _forget(self, session_id: str) -> AcpHostSession | None:
        """Drop a session from the registry, keeping its teardown visible to close_all."""
        session = self._sessions.pop(session_id, None)
        task = session._close_task if session is not None else None
        if task is not None and not task.done():
            self._teardowns.add(task)
            task.add_done_callback(self._teardowns.discard)
        return session

    def _prune(self) -> None:
        for session_id in [k for k, s in self._sessions.items() if s.closed]:
            session = self._forget(session_id)
            if session is not None:
                self._ended[session_id] = (session.owner, session.ended_message())
        while len(self._ended) > ENDED_MEMORY:
            self._ended.pop(next(iter(self._ended)))

    def ended_message(self, session_id: Any, owner: str) -> str | None:
        """Why ``session_id`` ended, for its own owner only."""
        entry = self._ended.get(session_id) if isinstance(session_id, str) else None
        return entry[1] if entry is not None and entry[0] == owner else None

    async def reap_idle(self, now: float | None = None) -> list[str]:
        """Close sessions with no turn and no activity for IDLE_TIMEOUT_S."""
        now = time.monotonic() if now is None else now
        reaped = []
        for session in list(self._sessions.values()):
            if session.state == "ready" and now - session.last_activity > IDLE_TIMEOUT_S:
                await session.close("idle")
                reaped.append(session.id)
        self._prune()
        return reaped

    def _ensure_reaper(self) -> None:
        if self._reaper is not None and not self._reaper.done():
            return

        async def loop() -> None:
            while self._sessions:
                await asyncio.sleep(IDLE_CHECK_INTERVAL_S)
                try:
                    await self.reap_idle()
                except Exception:
                    logger.debug("Idle reaper failed", exc_info=True)

        self._reaper = asyncio.create_task(loop())


acp_sessions = AcpSessionManager()
