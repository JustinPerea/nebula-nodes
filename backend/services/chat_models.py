"""Discover local agent CLI choices without sending a prompt or starting a turn.

Credentials remain owned by the official CLIs. Only sanitized catalog metadata
crosses the backend boundary; RPC/auth payloads and diagnostic output never do.
"""
from __future__ import annotations

import asyncio
import copy
import json
import re
import tempfile
import time
import tomllib
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from services.agent_process import spawn_agent_process, terminate_agent_process_tree
from services.agent_profiles import claude_profile_env
from services.krea_agent_mcp import agent_child_env


DISCOVERY_TIMEOUT = 15.0
CACHE_SECONDS = 60.0
MAX_LINE_BYTES = 1024 * 1024
MAX_PROTOCOL_BYTES = 4 * 1024 * 1024
MAX_PAGES = 20
EFFORT_ID = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_refresh_sequence: dict[str, int] = {}


# The name a person knows each built-in chat's CLI by, as the model picker shows it
# (frontend/src/components/panels/ChatModelPicker.tsx).
CLI_NAMES = {"claude": "Claude Code", "codex": "Codex"}


# The button a person clicks to pick a model or an agent, by its visible label
# (frontend/src/components/panels/ChatModelPicker.tsx: "Choose model"). Lines name this
# button, never the dialog's own heading.
CHOOSE_MODEL = "Choose model"
# The clause that sends a person to the model button when the one they have can't be used (design). The
# button is named by what it is, not by its label, so a line that has no room for a label still reads.
PICK_ANOTHER_MODEL = "Pick another with the model button at the top of the chat, then send again."
# The command each CLI answers "am I signed in?" with, for a line that tells the person to check.
_CLI_AUTH_CHECK = {"claude": "claude auth status", "codex": "codex login status"}
_CLI_SIGN_IN = {
    "claude": "Run `claude` in a terminal and sign in",
    "codex": "Run `codex` in a terminal and sign in with your ChatGPT account",
}
_RELOAD = "Nebula couldn\u2019t read that message. Reload the page, then send again."


# One line per catalog code, said twice from this one table: the model picker shows it beside its own
# Try again button (catalog_message, "then try again."), and the chat shows it when a send is refused for
# the same code (chat_refusal_message, "then send again."). `{again}` is the verb of the surface; `{Again}`
# is the same at the start of a sentence. A code with a line here has both; a test fails on a code in one
# and not the other (tests/test_chat_models.py).
_CATALOG_LINES = {
    "cli_not_installed": "{cli} isn\u2019t installed. Install it, then {again}.",
    "auth_required": "{cli} isn\u2019t signed in, so Nebula can\u2019t list its models. {sign_in}, then {again}.",
    # Codex signed in with an API key: its ChatGPT model list needs a ChatGPT sign-in, which Connect ChatGPT
    # account (above the message box) does.
    "auth_api_key": "{cli} is billed to your API key, so Nebula can\u2019t list its ChatGPT models. "
                    "Use Connect ChatGPT account above the message box, then {again}.",
    "catalog_unavailable": "Nebula couldn\u2019t get the model list from {cli}. Check that it\u2019s installed and signed in, then {again}.",
    "catalog_cleanup_failed": "Nebula couldn\u2019t get the model list from {cli}. Check that it\u2019s installed and signed in, then {again}.",
    "auth_unknown": "Nebula couldn\u2019t tell whether {cli} is signed in. Run `{check}` in a terminal to check, then {again}.",
    "catalog_invalid": "{cli} sent a model list Nebula couldn\u2019t read. Update {cli}, then {again}.",
    "catalog_timeout": "{cli} took too long to list its models. {Again} in a moment.",
}
CATALOG_CODES = frozenset(_CATALOG_LINES)


def _catalog_line(code: str, agent: str, again: str) -> str | None:
    template = _CATALOG_LINES.get(code)
    if template is None:
        return None
    return template.format(
        cli=CLI_NAMES.get(agent, agent.title()), again=again, Again=again[0].upper() + again[1:],
        sign_in=_CLI_SIGN_IN.get(agent, "Sign in to it in a terminal"), check=_CLI_AUTH_CHECK.get(agent, agent))


def catalog_message(code: str, agent: str, fallback: str = "") -> str:
    """The line the model picker shows for a catalog error, beside its Try again button. An unknown
    ``code`` keeps ``fallback``."""
    return _catalog_line(code, agent, "try again") or fallback


def chat_refusal_message(code: str, agent: str, fallback: str) -> str:
    """What the chat shows when a send is refused for its model choice or its
    CLI catalog (the agent never ran). A catalog code reads the same line the model picker shows
    (``catalog_message``), ending "then send again."; the others are the chat's own. An unknown
    ``code`` keeps ``fallback``."""
    if code in {"model_invalid", "effort_invalid"}:
        return _RELOAD
    if code == "model_required":
        return f"No model is selected. Pick one with {CHOOSE_MODEL} at the top of the chat, then send again."
    if code == "model_unsupported":
        return f"That model isn\u2019t offered anymore. {PICK_ANOTHER_MODEL}"
    if code == "effort_unsupported":
        return f"This model doesn\u2019t support that thinking effort. {PICK_ANOTHER_MODEL}"
    return _catalog_line(code, agent, "send again") or fallback


class ChatModelSelectionError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class _DiscoveryError(RuntimeError):
    def __init__(self, code: str, message: str, status: str = "unavailable"):
        super().__init__(message)
        self.code, self.status = code, status


def _catalog_env(agent: str) -> dict[str, str]:
    if agent == "codex":
        from services.codex_session import _codex_exec_env
        env = _codex_exec_env()
        # Runtime-scoped opt-out; the CLI does not change the persisted setting.
        env["CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED"] = "1"
    else:
        env = {**agent_child_env(), **claude_profile_env()}
    # Catalog discovery never receives graph/private-library authority.
    for key in ("NEBULA_AGENT_TOKEN", "NEBULA_COMMONS_TOKEN", "NEBULA_UI_TOKEN"):
        env.pop(key, None)
    return env


async def _discard_stderr(stream: asyncio.StreamReader) -> None:
    while await stream.read(16384):
        pass


@asynccontextmanager
async def _process(args: list[str], cwd: Path, env: dict[str, str]) -> AsyncIterator[Any]:
    proc = await spawn_agent_process(
        *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, cwd=str(cwd), env=env,
        limit=MAX_LINE_BYTES,
    )
    stderr_task = asyncio.create_task(_discard_stderr(proc.stderr))
    try:
        yield proc
    finally:
        async def cleanup() -> None:
            if proc.stdin is not None:
                with suppress(BrokenPipeError, ConnectionResetError):
                    proc.stdin.close()
            try:
                if proc.returncode is None:
                    try:
                        await asyncio.wait_for(proc.wait(), 0.5)
                    except asyncio.TimeoutError:
                        await terminate_agent_process_tree(proc)
            finally:
                stderr_task.cancel()
                with suppress(asyncio.CancelledError):
                    await stderr_task

        # A discovery deadline can expire while an earlier cancellation is
        # already reaping the CLI. Do not let that second cancellation leave
        # its process group alive; finish cleanup before propagating it.
        cleanup_task = asyncio.create_task(cleanup())
        interrupted = False
        while not cleanup_task.done():
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                interrupted = True
        cleanup_task.result()
        if interrupted:
            raise asyncio.CancelledError


async def _capture(args: list[str], cwd: Path, env: dict[str, str]) -> tuple[str, int]:
    async with _process(args, cwd, env) as proc:
        proc.stdin.close()
        chunks, size = [], 0
        while chunk := await proc.stdout.read(16384):
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_LINE_BYTES:
                raise _DiscoveryError("catalog_invalid", "The local CLI returned oversized metadata.")
        return b"".join(chunks).decode("utf-8", errors="replace"), await proc.wait()


class _Protocol:
    def __init__(self, proc: Any):
        self.proc, self.read_bytes = proc, 0

    async def write(self, payload: dict[str, Any]) -> None:
        self.proc.stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode())
        await self.proc.stdin.drain()

    async def read(self) -> dict[str, Any]:
        while True:
            try:
                raw = await self.proc.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError) as exc:
                raise _DiscoveryError("catalog_invalid", "The local CLI returned oversized metadata.") from exc
            if not raw:
                raise _DiscoveryError("catalog_unavailable", "The local CLI closed before returning its model catalog.")
            self.read_bytes += len(raw)
            if self.read_bytes > MAX_PROTOCOL_BYTES:
                raise _DiscoveryError("catalog_invalid", "The local CLI returned oversized metadata.")
            try:
                payload = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(payload, dict):
                return payload

    async def rpc(self, method: str, request_id: int, params: dict[str, Any]) -> dict[str, Any]:
        await self.write({"method": method, "id": request_id, "params": params})
        while True:
            payload = await self.read()
            if payload.get("id") != request_id:
                continue
            if "error" in payload or not isinstance(payload.get("result"), dict):
                raise _DiscoveryError("catalog_unavailable", "The local CLI could not return its model catalog.")
            return payload["result"]


def _text(value: Any, max_length: int = 300) -> str | None:
    return value.strip()[:max_length] if isinstance(value, str) and value.strip() else None


def _efforts(values: Any, codex: bool = False) -> list[dict[str, str]]:
    if not isinstance(values, list):
        return []
    entries = []
    seen = set()
    for raw in values:
        value = raw.get("reasoningEffort") if codex and isinstance(raw, dict) else raw
        if not isinstance(value, str) or not EFFORT_ID.fullmatch(value) or value in seen:
            continue
        seen.add(value)
        item = {"id": value, "label": "Extra high" if value == "xhigh" else value.replace("_", " ").title()}
        description = _text(raw.get("description")) if isinstance(raw, dict) else None
        if description:
            item["description"] = description
        entries.append(item)
    return entries


def _model(raw: dict[str, Any], agent: str) -> dict[str, Any] | None:
    model_id = _text(raw.get("model") or raw.get("id")) if agent == "codex" else _text(raw.get("value"))
    if not model_id or len(model_id) > 200 or any(ord(char) < 32 for char in model_id):
        return None
    # Existing product decision: Fable may bill extra usage in noninteractive
    # mode without a consent prompt, and is not enabled in Nebula Chat.
    if agent == "claude" and ("fable" in model_id.lower() or "fable" in str(raw.get("resolvedModel", "")).lower()):
        return None
    if agent == "codex" and raw.get("hidden") is True:
        return None
    capability = raw.get("supportedReasoningEfforts" if agent == "codex" else "supportedEffortLevels")
    supported = _efforts(capability, codex=agent == "codex")
    supports_effort = isinstance(capability, list)
    if agent == "claude" and raw.get("supportsEffort") is False:
        supported, supports_effort = [], True
    default = raw.get("defaultReasoningEffort") if agent == "codex" else raw.get("defaultEffort")
    default = default if any(item["id"] == default for item in supported) else None
    entry = {
        "id": model_id, "label": _text(raw.get("displayName")) or model_id,
        "isDefault": raw.get("isDefault") is True,
        "defaultEffort": default, "supportedEfforts": supported,
        # Unknown differs from a model explicitly offering no effort control.
        "effortSupported": bool(supported) if supports_effort else None,
    }
    for source, target in (("description", "description"), ("resolvedModel", "resolvedModel")):
        value = _text(raw.get(source))
        if value:
            entry[target] = value
    return entry


def _claude_auth(status: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    mode = _text(status.get("authMethod"))
    # In -p mode environment credentials outrank a saved subscription login.
    # Gateway authentication is a provider selection and outranks these vars.
    if mode != "gateway":
        cloud = next((name for key, name in (("CLAUDE_CODE_USE_BEDROCK", "bedrock"),
                                            ("CLAUDE_CODE_USE_VERTEX", "vertex"),
                                            ("CLAUDE_CODE_USE_FOUNDRY", "foundry"))
                      if env.get(key, "").lower() in {"1", "true"}), None)
        if cloud:
            mode = cloud
        elif env.get("ANTHROPIC_AUTH_TOKEN"):
            mode = "bearer_token"
        elif env.get("ANTHROPIC_API_KEY"):
            mode = "api_key"
    return {"mode": mode, "planType": _text(status.get("subscriptionType")) if mode in {"claude.ai", "oauth_token"} else None,
            "authenticated": status.get("loggedIn") is True}


async def _claude_catalog(cwd: Path, env: dict[str, str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    auth_output, exit_code = await _capture(["claude", "auth", "status", "--json"], cwd, env)
    try:
        auth_status = json.loads(auth_output)
    except json.JSONDecodeError as exc:
        raise _DiscoveryError("auth_unknown", "Claude CLI authentication status is unavailable.") from exc
    if not isinstance(auth_status, dict):
        raise _DiscoveryError("auth_unknown", "Claude CLI authentication status is unavailable.")
    auth = _claude_auth(auth_status, env)
    if exit_code != 0 or auth_status.get("loggedIn") is not True:
        return auth, []
    args = ["claude", "-p", "--restricted", "--safe-mode", "--disable-slash-commands",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "",
            "--no-session-persistence", "--output-format", "stream-json", "--input-format", "stream-json",
            "--verbose"]
    async with _process(args, cwd, env) as proc:
        protocol = _Protocol(proc)
        request_id = "nebula-model-catalog"
        await protocol.write({"type": "control_request", "request_id": request_id,
                              "request": {"subtype": "initialize", "hooks": None}})
        while True:
            payload = await protocol.read()
            response = payload.get("response")
            if payload.get("type") != "control_response" or not isinstance(response, dict) or response.get("request_id") != request_id:
                continue
            info = response.get("response")
            if response.get("subtype") != "success" or not isinstance(info, dict) or not isinstance(info.get("models"), list):
                raise _DiscoveryError("catalog_unavailable", "Claude CLI could not return its model catalog.")
            default_model = info.get("model")
            rows = info["models"]
            default_index = None
            if isinstance(default_model, str):
                default_index = next((index for index, model in enumerate(rows) if isinstance(model, dict)
                                      and model.get("value") == default_model), None)
                if default_index is None:
                    default_index = next((index for index, model in enumerate(rows) if isinstance(model, dict)
                                          and model.get("resolvedModel") == default_model), None)
            models = [{**model, "isDefault": index == default_index} if isinstance(model, dict) and default_index is not None else model
                      for index, model in enumerate(rows)]
            return auth, models


def _codex_metadata_args(env: dict[str, str]) -> list[str]:
    from services.codex_session import CODEX_BIN
    args = [CODEX_BIN, "app-server", "--stdio", "-c", 'model_provider="openai"',
            "--disable", "memories", "--disable", "plugins", "--disable", "hooks", "--disable", "apps",
            "-c", "analytics.enabled=false"]
    # app-server does not support exec's --ignore-user-config. Empty tables
    # deep-merge, so explicitly disable each configured server instead of
    # assuming mcp_servers={} clears user configuration. Read names only;
    # never copy auth files or pass config credential values to the browser.
    config_path = Path(env.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"
    names: set[str] = set()
    try:
        data = config_path.read_bytes()
        if len(data) > MAX_LINE_BYTES:
            raise _DiscoveryError("catalog_unavailable", "The local Codex configuration is too large for model discovery.")
        config = tomllib.loads(data.decode("utf-8"))
        layers = [config, *(config.get("profiles", {}).values() if isinstance(config.get("profiles"), dict) else [])]
        for layer in layers:
            servers = layer.get("mcp_servers") if isinstance(layer, dict) else None
            if isinstance(servers, dict):
                names.update(servers)
    except FileNotFoundError:
        pass
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise _DiscoveryError("catalog_unavailable", "The local Codex configuration could not be read for model discovery.") from exc
    if names:
        disabled = ",".join(f"{json.dumps(name)}={{enabled=false}}" for name in sorted(names))
        args.extend(["-c", f"mcp_servers={{{disabled}}}"])
    return args


async def _codex_catalog(cwd: Path, env: dict[str, str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    args = _codex_metadata_args(env)
    async with _process(args, cwd, env) as proc:
        protocol = _Protocol(proc)
        await protocol.rpc("initialize", 1, {"clientInfo": {"name": "nebula_nodes", "title": "Nebula Nodes", "version": "1"},
                                              "capabilities": {"explicitGatewayOauth": True}})
        await protocol.write({"method": "initialized", "params": {}})
        account_result = await protocol.rpc("account/read", 2, {"refreshToken": False})
        account = account_result.get("account")
        auth = {"mode": _text(account.get("type")) if isinstance(account, dict) else None,
                "planType": _text(account.get("planType")) if isinstance(account, dict) else None,
                "authenticated": isinstance(account, dict)}
        if auth["mode"] != "chatgpt":
            return auth, []
        models: list[dict[str, Any]] = []
        cursor, seen_cursors = None, set()
        for page in range(MAX_PAGES):
            params: dict[str, Any] = {"limit": 100, "includeHidden": False}
            if cursor is not None:
                params["cursor"] = cursor
            result = await protocol.rpc("model/list", page + 3, params)
            if not isinstance(result.get("data"), list):
                raise _DiscoveryError("catalog_invalid", "Codex CLI returned an invalid model catalog.")
            models.extend(result["data"])
            cursor = result.get("nextCursor")
            if cursor is None:
                return auth, models
            if not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
                break
            seen_cursors.add(cursor)
        raise _DiscoveryError("catalog_invalid", "Codex CLI returned an incomplete model catalog.")


async def _discover(agent: str) -> dict[str, Any]:
    from services.codex_session import CODEX_BIN
    binary = CODEX_BIN if agent == "codex" else "claude"
    result: dict[str, Any] = {
        "agent": agent, "status": "unavailable", "auth": {"mode": None, "planType": None, "authenticated": False},
        "catalog": {"source": "codex-app-server" if agent == "codex" else "claude-code-initialize",
                    "runtimeVersion": None, "fetchedAt": datetime.now(timezone.utc).isoformat()},
        "models": [],
    }
    try:
        async with asyncio.timeout(DISCOVERY_TIMEOUT):
            with tempfile.TemporaryDirectory(prefix="nebula-chat-catalog-") as directory:
                cwd, env = Path(directory), _catalog_env(agent)
                version, code = await _capture([binary, "--version"], cwd, env)
                result["catalog"]["runtimeVersion"] = _text(version.splitlines()[0] if version else None, 80) if code == 0 else None
                auth, raw_models = await (_codex_catalog(cwd, env) if agent == "codex" else _claude_catalog(cwd, env))
                result["auth"] = auth
                models, seen = [], set()
                for raw in raw_models:
                    entry = _model(raw, agent) if isinstance(raw, dict) else None
                    if entry and entry["id"] not in seen:
                        models.append(entry)
                        seen.add(entry["id"])
                result["models"] = models
                if models:
                    result["status"] = "ready"
                elif agent == "codex" and auth["authenticated"] and auth["mode"] != "chatgpt":
                    # Signed in, but with an API key: the ChatGPT model list needs a ChatGPT sign-in.
                    raise _DiscoveryError("auth_api_key", "Codex is signed in with an API key.", "not_authenticated")
                elif not auth["authenticated"]:
                    raise _DiscoveryError("auth_required", "Sign in through the local official CLI to select chat models.", "not_authenticated")
                else:
                    raise _DiscoveryError("catalog_unavailable", "The local CLI returned no supported chat models.")
    except (OSError, ValueError, RuntimeError) as exc:
        task = asyncio.current_task()
        if task is not None and task.cancelling():
            # A failed reap must reach the transport as cancellation failure,
            # not a catalog rejection that falsely confirms process cleanup.
            raise _DiscoveryError("catalog_cleanup_failed", "The local CLI model catalog cleanup failed.") from exc
        if isinstance(exc, FileNotFoundError):
            result["status"] = "not_installed"
            result["error"] = {"code": "cli_not_installed", "message": catalog_message("cli_not_installed", agent)}
        elif isinstance(exc, TimeoutError):
            result["error"] = {"code": "catalog_timeout", "message": catalog_message("catalog_timeout", agent)}
        elif isinstance(exc, _DiscoveryError):
            result["status"] = exc.status
            # The picker's line for the code (the chat's line for it, ending "try again"); a code with none keeps the text.
            result["error"] = {"code": exc.code, "message": catalog_message(exc.code, agent, str(exc))}
        else:
            result["error"] = {"code": "catalog_unavailable", "message": catalog_message("catalog_unavailable", agent)}
    return result


async def get_chat_models(agent: str, *, refresh: bool = False) -> dict[str, Any]:
    if agent not in {"claude", "codex"}:
        raise ChatModelSelectionError("agent_invalid", "Chat model discovery supports Claude and Codex.")
    cached = _cache.get(agent)
    if not refresh and cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return copy.deepcopy(cached[1])
    sequence = _refresh_sequence[agent] = _refresh_sequence.get(agent, 0) + 1
    result = await _discover(agent)
    # Failed refresh replaces old data, so stale choices never appear live.
    if _refresh_sequence.get(agent) == sequence:
        _cache[agent] = (time.monotonic(), result)
    return copy.deepcopy(result)


async def validate_chat_model_selection(agent: str, model: Any, effort: Any) -> tuple[str, str | None]:
    """Validate explicit choices against fresh metadata before granting authority."""
    if model is not None and (not isinstance(model, str) or not model.strip()):
        raise ChatModelSelectionError("model_invalid", "model must be a nonempty model identifier.")
    if effort is not None and (not isinstance(effort, str) or not effort.strip()):
        raise ChatModelSelectionError("effort_invalid", "effort must be a supported effort identifier.")
    catalog = await get_chat_models(agent, refresh=True)
    if catalog["status"] != "ready":
        error = catalog.get("error", {})
        raise ChatModelSelectionError(error.get("code", "catalog_unavailable"), error.get("message", "Refresh the local CLI model catalog before sending."))
    models = catalog["models"]
    selected = next((item for item in models if item["id"] == model.strip()), None) if model is not None else next((item for item in models if item["isDefault"]), None)
    if selected is None:
        if model is None:
            raise ChatModelSelectionError("model_required", "Choose a model from the local CLI catalog before sending.")
        raise ChatModelSelectionError("model_unsupported", "That model is no longer available in the local CLI catalog. Refresh and choose a model.")
    requested_effort = effort.strip().lower() if effort is not None else selected["defaultEffort"]
    if requested_effort is not None and not any(item["id"] == requested_effort for item in selected["supportedEfforts"]):
        raise ChatModelSelectionError("effort_unsupported", "That effort is not supported by the selected model. Refresh and choose an available effort.")
    return selected["id"], requested_effort
