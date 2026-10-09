"""Local CLI metadata only: never submit a user prompt or call a provider turn."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from services import chat_models


class Input:
    def __init__(self):
        self.messages = []
        self.closed = False

    def write(self, data):
        self.messages.append(json.loads(data))

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class Process:
    def __init__(self, lines=(), *, text=None, exit_code=0):
        self.stdin = Input()
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stdout.feed_data(text.encode() if text is not None else b"".join((json.dumps(item) + "\n").encode() for item in lines))
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.returncode = None
        self.exit_code = exit_code

    async def wait(self):
        self.returncode = self.exit_code
        return self.exit_code


def model(model_id="runtime-model", *, default=True, efforts=("low", "max", "ultra"), default_effort="low"):
    return {"id": model_id, "label": model_id, "isDefault": default,
            "supportedEfforts": [{"id": effort, "label": effort} for effort in efforts],
            "defaultEffort": default_effort}


def catalog(models=None, *, status="ready"):
    return {"agent": "codex", "status": status, "models": models if models is not None else [model()],
            "auth": {"mode": "chatgpt", "planType": "pro"},
            "catalog": {"source": "codex-app-server", "runtimeVersion": "test", "fetchedAt": "test"}}


@pytest.fixture(autouse=True)
def clear_catalog_cache():
    chat_models._cache.clear()
    chat_models._refresh_sequence.clear()
    yield
    chat_models._cache.clear()
    chat_models._refresh_sequence.clear()


def test_model_capabilities_preserve_future_efforts_and_unknown_support():
    codex = chat_models._model({"id": "opaque", "model": "runtime-model", "isDefault": True,
                                "supportedReasoningEfforts": [{"reasoningEffort": "ultra"}],
                                "defaultReasoningEffort": "ultra"}, "codex")
    assert codex["id"] == "runtime-model"
    assert codex["defaultEffort"] == "ultra"
    assert codex["supportedEfforts"] == [{"id": "ultra", "label": "Ultra"}]
    unknown = chat_models._model({"value": "claude-old", "defaultEffort": "medium"}, "claude")
    assert unknown["effortSupported"] is None and unknown["supportedEfforts"] == []
    assert unknown["defaultEffort"] is None
    disabled = chat_models._model({"value": "haiku", "supportsEffort": False, "supportedEffortLevels": ["high"]}, "claude")
    assert disabled["effortSupported"] is False and disabled["supportedEfforts"] == []
    assert chat_models._model({"value": "default", "resolvedModel": "claude-fable-5-1"}, "claude") is None


@pytest.mark.parametrize("env,mode", [({"ANTHROPIC_API_KEY": "private-key"}, "api_key"),
                                     ({"ANTHROPIC_AUTH_TOKEN": "private-token", "ANTHROPIC_API_KEY": "private-key"}, "bearer_token"),
                                     ({"CLAUDE_CODE_USE_BEDROCK": "1", "ANTHROPIC_API_KEY": "private-key"}, "bedrock")])
def test_claude_effective_auth_overrides_saved_subscription_without_secrets(env, mode):
    auth = chat_models._claude_auth({"loggedIn": True, "authMethod": "claude.ai", "subscriptionType": "max", "email": "private@example.test"}, env)
    assert auth == {"mode": mode, "planType": None, "authenticated": True}
    assert "private" not in json.dumps(auth)


def test_metadata_profile_disables_configured_mcp_names_without_credentials(tmp_path, monkeypatch):
    config = tmp_path / "config.toml"
    config.write_text('[mcp_servers.example]\ncommand="private-command"\nenv={TOKEN="private-value"}\n[profiles.work.mcp_servers."with.dot"]\ncommand="private-command"\n')
    args = chat_models._codex_metadata_args({"CODEX_HOME": str(tmp_path)})
    overrides = [args[index + 1] for index, flag in enumerate(args) if flag == "-c"]
    disabled = next(value for value in overrides if value.startswith("mcp_servers="))
    assert '"example"={enabled=false}' in disabled and '"with.dot"={enabled=false}' in disabled
    assert "private" not in json.dumps(args)
    for feature in ("plugins", "hooks", "apps", "memories"):
        assert any(args[index:index + 2] == ["--disable", feature] for index in range(len(args)))
    assert "--ignore-user-config" not in args and "--strict-config" not in args
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "private-key")
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "private-authority")
    child = chat_models._catalog_env("codex")
    assert child["CODEX_HOME"] == str(tmp_path)
    assert child["CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED"] == "1"
    assert "OPENAI_API_KEY" not in child and "NEBULA_AGENT_TOKEN" not in child


@pytest.mark.asyncio
async def test_codex_discovery_only_initializes_reads_account_and_paginates(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    metadata = Process([
        {"method": "account/updated", "params": {"private": "ignored"}},
        {"id": 1, "result": {}},
        {"id": 2, "result": {"account": {"type": "chatgpt", "planType": "pro", "email": "private@example.test"}}},
        {"id": 3, "result": {"data": [{"model": "runtime-model", "isDefault": True, "supportedReasoningEfforts": [{"reasoningEffort": "ultra"}], "defaultReasoningEffort": "ultra"}], "nextCursor": "second"}},
        {"id": 4, "result": {"data": [{"model": "other-model"}, {"model": "runtime-model"}, {"model": "hidden", "hidden": True}], "nextCursor": None}},
    ])
    processes = [Process(text="codex-cli fixture\n"), metadata]
    calls = []
    async def spawn(*args, **kwargs):
        calls.append((args, kwargs))
        return processes.pop(0)
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", spawn)
    result = await chat_models.get_chat_models("codex", refresh=True)
    assert result["status"] == "ready"
    assert result["auth"] == {"mode": "chatgpt", "planType": "pro", "authenticated": True}
    assert [item["id"] for item in result["models"]] == ["runtime-model", "other-model"]
    assert "private" not in json.dumps(result)
    assert [item["method"] for item in metadata.stdin.messages] == ["initialize", "initialized", "account/read", "model/list", "model/list"]
    assert metadata.stdin.messages[0]["params"]["capabilities"]["explicitGatewayOauth"] is True
    assert metadata.stdin.messages[2]["params"] == {"refreshToken": False}
    assert metadata.stdin.messages[-1]["params"]["cursor"] == "second"
    assert all(kwargs["cwd"] != str(tmp_path) for _, kwargs in calls)
    assert metadata.stdin.closed and metadata.returncode == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("account", [None, {"type": "apiKey"}, {"type": "amazonBedrock"}])
async def test_codex_non_chatgpt_auth_never_requests_models(tmp_path, monkeypatch, account):
    proc = Process([{"id": 1, "result": {}}, {"id": 2, "result": {"account": account}}])
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    auth, models = await chat_models._codex_catalog(tmp_path, {"CODEX_HOME": str(tmp_path)})
    assert not models
    assert [item["method"] for item in proc.stdin.messages] == ["initialize", "initialized", "account/read"]
    assert auth["mode"] != "chatgpt"


@pytest.mark.asyncio
async def test_claude_discovery_has_no_prompt_tools_or_session_persistence(tmp_path, monkeypatch):
    metadata = Process([{"type": "control_response", "response": {"subtype": "success", "request_id": "nebula-model-catalog", "response": {
        "models": [{"value": "default", "resolvedModel": "claude-opus-fixture", "supportedEffortLevels": ["low", "max"]}],
        "account": {"email": "private@example.test"},
    }}}])
    processes = [Process(text='{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'), metadata]
    calls = []
    async def spawn(*args, **kwargs):
        calls.append(args)
        return processes.pop(0)
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", spawn)
    auth, raw = await chat_models._claude_catalog(tmp_path, {})
    assert auth["mode"] == "claude.ai" and raw[0]["value"] == "default"
    assert metadata.stdin.messages == [{"type": "control_request", "request_id": "nebula-model-catalog", "request": {"subtype": "initialize", "hooks": None}}]
    args = calls[1]
    assert args[args.index("--tools") + 1] == ""
    assert "--safe-mode" in args and "--no-session-persistence" in args
    assert "--bare" not in args and "--resume" not in args


@pytest.mark.asyncio
async def test_claude_runtime_default_is_unique_and_malformed_rows_cannot_crash(tmp_path, monkeypatch):
    metadata = Process([{"type": "control_response", "response": {"subtype": "success", "request_id": "nebula-model-catalog", "response": {
        "model": "claude-runtime", "models": [{"value": [], "resolvedModel": {}},
            {"value": "default", "resolvedModel": "claude-runtime"}, {"value": "claude-runtime", "resolvedModel": "claude-runtime"}],
    }}}])
    processes = [Process(text='{"loggedIn":true,"authMethod":"claude.ai"}'), metadata]
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", AsyncMock(side_effect=processes))
    _, raw = await chat_models._claude_catalog(tmp_path, {})
    entries = [chat_models._model(row, "claude") for row in raw]
    assert entries[0] is None
    assert [entry["id"] for entry in entries if entry and entry["isDefault"]] == ["claude-runtime"]


@pytest.mark.asyncio
async def test_repeated_pagination_cursor_fails_closed(tmp_path, monkeypatch):
    proc = Process([{"id": 1, "result": {}}, {"id": 2, "result": {"account": {"type": "chatgpt"}}},
                    {"id": 3, "result": {"data": [], "nextCursor": "loop"}},
                    {"id": 4, "result": {"data": [], "nextCursor": "loop"}}])
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    with pytest.raises(chat_models._DiscoveryError, match="incomplete"):
        await chat_models._codex_catalog(tmp_path, {"CODEX_HOME": str(tmp_path)})
    assert proc.stdin.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_timeout_and_cancellation_reap_discovery_process(tmp_path, monkeypatch, cancel):
    proc = Process()
    proc.stdout = asyncio.StreamReader()  # No metadata/EOF: simulate a wedged CLI.
    async def wait():
        await asyncio.Event().wait()
    proc.wait = wait
    async def terminate(process):
        process.returncode = -9
    kill = AsyncMock(side_effect=terminate)
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", AsyncMock(return_value=proc))
    monkeypatch.setattr(chat_models, "terminate_agent_process_tree", kill)
    monkeypatch.setattr(chat_models, "DISCOVERY_TIMEOUT", 0.01)
    task = asyncio.create_task(chat_models.get_chat_models("codex", refresh=True))
    await asyncio.sleep(0)
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        result = await task
        assert result["status"] == "unavailable" and result["error"]["code"] == "catalog_timeout"
    kill.assert_awaited_once_with(proc)
    assert proc.stdin.closed


@pytest.mark.asyncio
async def test_failed_refresh_replaces_previously_ready_cache(monkeypatch):
    unavailable = catalog(status="unavailable", models=[])
    discover = AsyncMock(side_effect=[catalog(), unavailable])
    monkeypatch.setattr(chat_models, "_discover", discover)
    assert (await chat_models.get_chat_models("codex"))["status"] == "ready"
    await chat_models.get_chat_models("codex", refresh=True)
    assert (await chat_models.get_chat_models("codex"))["status"] == "unavailable"
    assert discover.await_count == 2


@pytest.mark.asyncio
async def test_late_older_refresh_cannot_replace_newer_cache(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0
    async def discover(agent):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await release.wait()
            return catalog()
        return catalog(status="unavailable", models=[])
    monkeypatch.setattr(chat_models, "_discover", discover)
    old = asyncio.create_task(chat_models.get_chat_models("codex", refresh=True))
    await entered.wait()
    await chat_models.get_chat_models("codex", refresh=True)
    release.set()
    await old
    assert (await chat_models.get_chat_models("codex"))["status"] == "unavailable"


@pytest.mark.asyncio
async def test_missing_cli_and_rpc_error_return_sanitized_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", AsyncMock(side_effect=FileNotFoundError("private/path")))
    result = await chat_models.get_chat_models("claude", refresh=True)
    assert result["status"] == "not_installed" and "private" not in json.dumps(result)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    processes = [Process(text="codex-fixture"), Process([{"id": 1, "error": {"message": "private-token"}}])]
    monkeypatch.setattr(chat_models.asyncio, "create_subprocess_exec", AsyncMock(side_effect=processes))
    result = await chat_models.get_chat_models("codex", refresh=True)
    assert result["status"] == "unavailable" and "private" not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_model,raw_effort,code", [(False, None, "model_invalid"), ([], None, "model_invalid"),
                                                    ("", None, "model_invalid"), (None, {}, "effort_invalid")])
async def test_malformed_selection_rejected_without_discovery(monkeypatch, raw_model, raw_effort, code):
    get = AsyncMock()
    monkeypatch.setattr(chat_models, "get_chat_models", get)
    with pytest.raises(chat_models.ChatModelSelectionError) as error:
        await chat_models.validate_chat_model_selection("codex", raw_model, raw_effort)
    assert error.value.code == code
    get.assert_not_awaited()


@pytest.mark.asyncio
async def test_explicit_selection_preserves_ultra_and_runtime_default(monkeypatch):
    get = AsyncMock(return_value=catalog())
    monkeypatch.setattr(chat_models, "get_chat_models", get)
    assert await chat_models.validate_chat_model_selection("codex", "runtime-model", "ultra") == ("runtime-model", "ultra")
    assert await chat_models.validate_chat_model_selection("codex", "runtime-model", None) == ("runtime-model", "low")
    get.assert_awaited_with("codex", refresh=True)
    get.return_value = catalog([model(default_effort=None)])
    assert await chat_models.validate_chat_model_selection("codex", "runtime-model", None) == ("runtime-model", None)
    get.return_value = catalog([model(default=False)])
    with pytest.raises(chat_models.ChatModelSelectionError) as error:
        await chat_models.validate_chat_model_selection("codex", None, "low")
    assert error.value.code == "model_required"


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_model,raw_effort,code", [("unlisted", "low", "model_unsupported"),
                                                    ("runtime-model", "medium", "effort_unsupported")])
async def test_unavailable_selection_never_silently_falls_back(monkeypatch, raw_model, raw_effort, code):
    monkeypatch.setattr(chat_models, "get_chat_models", AsyncMock(return_value=catalog()))
    with pytest.raises(chat_models.ChatModelSelectionError) as error:
        await chat_models.validate_chat_model_selection("codex", raw_model, raw_effort)
    assert error.value.code == code
