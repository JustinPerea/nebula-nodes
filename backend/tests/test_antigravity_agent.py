"""Antigravity: Google's ACP server, downloaded pinned and checked, and its sign-in."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import stat
import sys
import zipfile
from pathlib import Path

import httpx
import pytest

from commons import actors
from services import acp_session, antigravity_agent as ag, personal_agents
from services.acp_session import AcpSessionManager, PersonalSessionError
from services.agent_workspaces import WorkspaceSessions

FAKE = Path(__file__).parent / "fixtures" / "fake_acp_agent.py"


def test_the_pin_is_exact_googles_and_never_latest():
    assert re.fullmatch(r"\d+\.\d+\.\d+", ag.VERSION)
    assert set(ag.RELEASES) == {"darwin-aarch64", "darwin-x86_64"}
    for rel in ag.RELEASES.values():
        assert rel.url.startswith("https://dl.google.com/agy-extensions/releases/macos/")
        assert f"-{ag.VERSION}-" in rel.url and "latest" not in rel.url
        assert re.fullmatch(r"[0-9a-f]{64}", rel.sha256) and rel.size > 10_000_000
        assert [f.name for f in rel.files] == ["agy_acp_server.par", "localharness_external"]
        for pinned in rel.files:
            assert re.fullmatch(r"[0-9a-f]{64}", pinned.sha256) and pinned.size > 10_000_000
    assert ag.platform_id("darwin", "arm64") == "darwin-aarch64"
    assert ag.platform_id("darwin", "x86_64") == "darwin-x86_64"
    assert ag.platform_id("linux", "x86_64") is None


def test_the_terms_note_says_whose_risk_it_is():
    preset = personal_agents.PRESETS["antigravity"]
    for words in ("Google AI plan", "not supported under consumer plans", "suspend", "Your Google account carries"):
        assert words in preset.terms_note
    assert preset.sign_in == "oauth-personal" and preset.kind == "download"
    assert dict(preset.env)["BROWSER"] == "/usr/bin/true %s"


# -- a test release built on the fly ---------------------------------------------------------


def agent_script(tmp_path: Path, script: dict) -> str:
    script_file = tmp_path / "agent-script.json"
    script_file.write_text(json.dumps({"log": str(tmp_path / "agent-log.jsonl"), **script}))
    return f"#!/bin/sh\nexec {sys.executable} {FAKE} {script_file}\n"


def build_release(tmp_path: Path, par_body: str, *, extra: dict[str, bytes] | None = None,
                  symlink: bool = False) -> tuple[ag.Release, bytes]:
    files = {"agy_acp_server.par": par_body.encode(), "localharness_external": b"#!/bin/sh\nexit 0\n"}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, data in {**files, **(extra or {})}.items():
            info = zipfile.ZipInfo(name)
            mode = stat.S_IFLNK | 0o777 if symlink and name == "localharness_external" else stat.S_IFREG | 0o755
            info.external_attr = mode << 16
            bundle.writestr(info, data)
    archive = buffer.getvalue()
    rel = ag.Release("test-platform", "https://dl.google.com/agy-extensions/releases/macos/test.zip",
                     hashlib.sha256(archive).hexdigest(), len(archive),
                     tuple(ag.PinnedFile(name, hashlib.sha256(data).hexdigest(), len(data))
                           for name, data in files.items()))
    return rel, archive


@pytest.fixture
def pinned(monkeypatch):
    def use(rel: ag.Release) -> None:
        monkeypatch.setattr(ag, "RELEASES", {"test-platform": rel})
        monkeypatch.setattr(ag, "platform_id", lambda system=None, machine=None: "test-platform")
    return use


def serve(archive: bytes, seen: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(str(request.url))
        return httpx.Response(200, content=archive)
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def install(state: Path, factory) -> ag.Job:
    job = ag.start_install(state, client_factory=factory)
    await job.task
    return job


@pytest.fixture(autouse=True)
def no_jobs(monkeypatch):
    monkeypatch.setattr(ag, "_jobs", {})


@pytest.mark.asyncio
async def test_install_checks_the_hash_and_installs_only_the_pinned_files(tmp_path, pinned):
    rel, archive = build_release(tmp_path, "#!/bin/sh\nexit 0\n")
    pinned(rel)
    state = tmp_path / "state"
    assert ag.install_state(state)[0] == "missing"
    seen: list[str] = []
    job = await install(state, serve(archive, seen))
    assert job.state == "done", job.message
    assert seen == [rel.url]
    folder = ag.version_dir(state)
    assert sorted(p.name for p in folder.iterdir()) == [ag.MARKER, "agy_acp_server.par", "localharness_external"]
    assert os.access(folder / "agy_acp_server.par", os.X_OK)
    assert ag.install_state(state)[0] == "installed"
    assert ag.installed_command(state) == folder / ag.COMMAND
    assert not [p for p in ag.root(state).iterdir() if p.name.startswith(".download-")]
    # A changed file stops it from running until it's downloaded again.
    (folder / "localharness_external").write_bytes(b"#!/bin/sh\necho swapped\n")
    assert ag.install_state(state)[0] == "changed" and ag.installed_command(state) is None
    assert ag.remove(state) and not ag.root(state).exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", ["archive", "extra", "symlink", "member"])
async def test_a_download_that_does_not_match_installs_nothing(tmp_path, pinned, tamper):
    rel, archive = build_release(tmp_path, "#!/bin/sh\nexit 0\n")
    if tamper == "archive":
        archive = archive[:-1] + bytes([archive[-1] ^ 1])
    elif tamper == "extra":
        _, archive = build_release(tmp_path, "#!/bin/sh\nexit 0\n", extra={"../evil": b"x"})
        rel = ag.Release(rel.platform, rel.url, hashlib.sha256(archive).hexdigest(), len(archive), rel.files)
    elif tamper == "symlink":
        _, archive = build_release(tmp_path, "#!/bin/sh\nexit 0\n", symlink=True)
        rel = ag.Release(rel.platform, rel.url, hashlib.sha256(archive).hexdigest(), len(archive), rel.files)
    elif tamper == "member":
        # The archive hash is right but a file in it isn't what was pinned.
        rel = ag.Release(rel.platform, rel.url, rel.sha256, rel.size,
                         (ag.PinnedFile("agy_acp_server.par", "0" * 64, rel.files[0].size), rel.files[1]))
    pinned(rel)
    state = tmp_path / "state"
    job = await install(state, serve(archive))
    assert job.state == "failed" and "nothing was installed" in job.message
    assert not ag.version_dir(state).exists()
    assert not [p for p in ag.root(state).iterdir() if p.name.startswith(".download-")]
    assert ag.install_state(state)[0] == "missing"


@pytest.mark.asyncio
async def test_a_download_bigger_than_the_pin_is_cut_off(tmp_path, pinned):
    rel, archive = build_release(tmp_path, "#!/bin/sh\nexit 0\n")
    pinned(rel)
    job = await install(tmp_path / "state", serve(archive + b"x" * 10))
    assert job.state == "failed" and "bigger" in job.message


def test_unsupported_platform_offers_no_download(tmp_path, monkeypatch):
    monkeypatch.setattr(ag, "platform_id", lambda system=None, machine=None: None)
    state, message = ag.install_state(tmp_path)
    assert state == "unsupported" and "macOS" in message
    with pytest.raises(ag.AntigravityError):
        ag.start_install(tmp_path)


# -- the preset, its sign-in and a session ----------------------------------------------------


@pytest.fixture
def installed(tmp_path, pinned):
    async def make(script: dict) -> Path:
        rel, archive = build_release(tmp_path, agent_script(tmp_path, script))
        pinned(rel)
        state = tmp_path / "state"
        job = await install(state, serve(archive))
        assert job.state == "done", job.message
        return state
    return make


def log_methods(tmp_path: Path) -> list[str]:
    path = tmp_path / "agent-log.jsonl"
    if not path.exists():
        return []
    return [json.loads(line).get("method") for line in path.read_text().splitlines() if line.strip()]


@pytest.mark.asyncio
async def test_status_walks_from_download_to_sign_in_to_ready(tmp_path, installed, pinned):
    state = tmp_path / "state"
    rel, _ = build_release(tmp_path, "#!/bin/sh\n")
    pinned(rel)
    view = personal_agents.get_agent(state, "antigravity")
    assert view.status == "not_installed" and view.install["state"] == "missing"
    assert view.termsNote == ag.TERMS_NOTE and view.signIn["state"] == "signed_out"
    env_file = tmp_path / "agent-env.json"
    await installed({"authMethods": [{"id": "oauth-personal", "name": "Log in with Google"}],
                     "env_file": str(env_file)})
    view = personal_agents.get_agent(state, "antigravity")
    assert view.status == "needs_setup" and "Sign in with Google" in view.note
    with pytest.raises(personal_agents.PersonalAgentError):
        personal_agents.update_agent(state, "antigravity", {"signedIn": True})

    flips: list[bool] = []

    def record(value: bool) -> None:
        flips.append(value)
        personal_agents.set_signed_in(state, "antigravity", value)

    job = ag.start_sign_in(state, record)
    await job.task
    assert job.state == "done", job.message
    assert flips == [True] and log_methods(tmp_path)[:2] == ["initialize", "authenticate"]
    # Sign-in lets Google's server open the browser: BROWSER is left alone.
    assert json.loads(env_file.read_text())["BROWSER"] in (None, os.environ.get("BROWSER"))
    personal_agents.update_agent(state, "antigravity", {"enabled": True})
    view = personal_agents.get_agent(state, "antigravity")
    assert view.status == "ready" and view.command.endswith(ag.COMMAND) and Path(view.command).is_absolute()
    spec = personal_agents.launch_spec(state, "antigravity")
    assert spec.argv == [str(ag.version_dir(state) / ag.COMMAND)]
    assert spec.auth_method == "oauth-personal" and spec.env["BROWSER"] == ag.NO_BROWSER
    key_before = personal_agents.launch_key(state, "antigravity")
    personal_agents.set_signed_in(state, "antigravity", False)
    assert personal_agents.launch_key(state, "antigravity") != key_before


@pytest.mark.asyncio
async def test_a_sign_in_that_fails_stays_signed_out(tmp_path, installed):
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "authenticate": "error"})
    flips: list[bool] = []
    job = ag.start_sign_in(state, flips.append)
    await job.task
    assert job.state == "failed" and "didn't finish" in job.message and flips == []


@pytest.mark.asyncio
async def test_a_server_that_is_slow_to_start_says_so(tmp_path, installed, monkeypatch):
    monkeypatch.setattr(ag, "START_TIMEOUT_S", 0.5)
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "initDelay": 3})
    job = ag.start_sign_in(state, lambda _value: None)
    await job.task
    assert job.state == "failed" and "didn't start" in job.message and "TimeoutError" not in job.message


@pytest.mark.asyncio
async def test_sign_out_still_signs_out_when_the_server_is_slow_to_start(tmp_path, installed, monkeypatch):
    monkeypatch.setattr(ag, "START_TIMEOUT_S", 0.5)
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "initDelay": 3, "logoutCap": True})
    personal_agents.set_signed_in(state, "antigravity", True)
    message = await ag.sign_out(state, lambda value: personal_agents.set_signed_in(state, "antigravity", value))
    assert "didn't start" in message
    assert personal_agents.get_agent(state, "antigravity").signIn["state"] == "signed_out"


@pytest.mark.asyncio
async def test_a_stopped_sign_in_drops_its_link_and_says_it_stopped(tmp_path, installed):
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "authenticate": "hang"})
    job = ag.start_sign_in(state, lambda _value: None)
    for _ in range(200):
        if "browser" in job.message:
            break
        await asyncio.sleep(0.05)
    job.url = "https://accounts.google.com/o/oauth2/v2/auth?state=x"
    assert job.view()["signInUrl"].startswith("https://accounts.google.com/")
    assert await ag.cancel(state, "sign_in")
    view = job.view()
    # Its loopback port closed with the server, so the link leads nowhere now.
    assert view["state"] == "cancelled" and "signInUrl" not in view and view["message"] == "Sign-in stopped."


def test_the_server_gets_as_long_to_start_as_a_session_does():
    # A 280 MB server can be slow to start on a busy Mac; sign-in waits as long as a chat start does.
    assert ag.START_TIMEOUT_S >= personal_agents.STARTUP_TIMEOUT_S


@pytest.mark.asyncio
async def test_sign_out_asks_the_server_to_forget_the_login(tmp_path, installed):
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "logoutCap": True})
    personal_agents.set_signed_in(state, "antigravity", True)
    message = await ag.sign_out(state, lambda value: personal_agents.set_signed_in(state, "antigravity", value))
    assert "deleted" in message and "logout" in log_methods(tmp_path)
    assert personal_agents.get_agent(state, "antigravity").signIn["state"] == "signed_out"


class SessionEnv:
    def __init__(self, tmp_path: Path, state: Path) -> None:
        self.state = state
        self.out = tmp_path / "out"
        self.out.mkdir(exist_ok=True)
        self.workspaces = WorkspaceSessions()
        self.manager = AcpSessionManager()

    async def open(self):
        return await self.manager.open("owner", "antigravity", state_dir=self.state, output_root=self.out,
                                       backend_url="http://127.0.0.1:8142", workspace_sessions=self.workspaces)


@pytest.fixture
def registry(monkeypatch):
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())


OPTIONS = [
    {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "gemini-4-argon-medium",
     "options": [{"value": "gemini-4-argon-low", "name": "Argon (low)"},
                 {"value": "gemini-4-argon-medium", "name": "Argon (medium)"}]},
    {"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "default",
     "options": [{"value": "default", "name": "Default"}]},
]


@pytest.mark.asyncio
async def test_a_session_reuses_the_sign_in_without_a_browser_and_offers_its_models(tmp_path, installed, registry):
    env_file = tmp_path / "agent-env.json"
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "env_file": str(env_file),
                             "promptCapabilities": {"image": True}, "configOptions": OPTIONS})
    personal_agents.acknowledge_warning(state)
    personal_agents.set_signed_in(state, "antigravity", True)
    personal_agents.update_agent(state, "antigravity", {"enabled": True})
    env = SessionEnv(tmp_path, state)
    host = await env.open()
    try:
        methods = log_methods(tmp_path)
        assert methods[:3] == ["initialize", "authenticate", "session/new"]
        assert json.loads(env_file.read_text())["BROWSER"] == ag.NO_BROWSER
        assert host.prompt_images is True
        [model] = host.option_view()
        assert model["id"] == "model" and model["current"] == "gemini-4-argon-medium"
        assert [o["value"] for o in model["options"]] == ["gemini-4-argon-low", "gemini-4-argon-medium"]
        updated = await host.set_option("model", "gemini-4-argon-low")
        assert updated[0]["current"] == "gemini-4-argon-low"
        assert "session/set_config_option" in log_methods(tmp_path)
        with pytest.raises(PersonalSessionError):
            await host.set_option("model", "gemini-9-unknown")
        with pytest.raises(PersonalSessionError):
            await host.set_option("mode", "default")
    finally:
        await env.manager.close_all()


@pytest.mark.asyncio
async def test_a_lost_login_says_sign_in_again_and_never_waits_on_a_browser(tmp_path, installed, registry, monkeypatch):
    monkeypatch.setattr(acp_session, "AUTH_TIMEOUT_S", 1.0)
    state = await installed({"authMethods": [{"id": "oauth-personal"}], "authenticate": "hang"})
    personal_agents.acknowledge_warning(state)
    personal_agents.set_signed_in(state, "antigravity", True)
    personal_agents.update_agent(state, "antigravity", {"enabled": True})
    env = SessionEnv(tmp_path, state)
    with pytest.raises(PersonalSessionError) as info:
        await env.open()
    assert info.value.code == "auth_required" and "Sign in again in Settings" in info.value.message
    assert "session/new" not in log_methods(tmp_path)
    assert personal_agents.get_agent(state, "antigravity").signIn["state"] == "signed_out"
    assert not env.manager.live()
    await env.manager.close_all()
