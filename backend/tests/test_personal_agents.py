"""The personal-agent registry and its person-only routes."""
from __future__ import annotations

import re
import stat
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import main
from services import personal_agents
from tests.conftest import PERSON, PERSON_TOKEN
from tests.test_commons_integration import isolated_app  # noqa: F401

pytestmark = pytest.mark.usefixtures("person")


@pytest.fixture
def client(isolated_app):
    with TestClient(main.app) as c:
        yield c


ROUTES = [
    ("get", "/api/personal-agents", None),
    ("post", "/api/personal-agents", {"id": "mine", "command": "/bin/echo"}),
    ("put", "/api/personal-agents/claude", {"enabled": True}),
    ("delete", "/api/personal-agents/mine", None),
    ("post", "/api/personal-agents/acknowledge-warning", None),
]


@pytest.mark.parametrize("method,path,body", ROUTES)
@pytest.mark.parametrize("headers", [{}, {"Origin": "http://localhost:5173"},
                                     {**PERSON, "Authorization": "Agent whatever"},
                                     {**PERSON, "X-Nebula-Agent": "Sneaky"}])
def test_routes_refuse_everyone_but_the_person(client, method, path, body, headers):
    kwargs = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    response = getattr(client, method)(path, **kwargs)
    # An unknown agent token is already refused (401) before the person gate.
    assert response.status_code in {401, 403}
    assert not (main._STATE_DIR / personal_agents.FILE_NAME).exists()


def test_person_can_list_create_update_delete_and_acknowledge(client):
    listed = client.get("/api/personal-agents", headers=PERSON).json()
    assert listed["warningAcknowledged"] is False
    ids = [a["id"] for a in listed["agents"]]
    assert ids == ["claude", "codex", "gemini", "hermes"]
    hermes = next(a for a in listed["agents"] if a["id"] == "hermes")
    assert hermes["status"] == "needs_setup" and hermes["startable"] is False
    assert all(not a["enabled"] for a in listed["agents"])

    made = client.post("/api/personal-agents", headers=PERSON, json={
        "id": "fake", "displayName": "Fake <b>Agent</b>", "color": "#112233",
        "command": sys.executable, "args": ["-c", "print(1)"]})
    assert made.status_code == 200, made.text
    agent = made.json()["agent"]
    assert agent["displayName"] == "Fake bAgentb" and agent["status"] == "ready" and agent["kind"] == "custom"

    assert client.post("/api/personal-agents", headers=PERSON, json={"id": "fake", "command": "x"}).status_code == 409
    assert client.post("/api/personal-agents", headers=PERSON, json={"id": "claude", "command": "x"}).status_code == 409
    assert client.put("/api/personal-agents/claude", headers=PERSON, json={"args": ["--evil"]}).status_code == 400
    toggled = client.put("/api/personal-agents/claude", headers=PERSON, json={"enabled": True, "color": "#000000"})
    assert toggled.status_code == 200 and toggled.json()["agent"]["enabled"] is True
    assert toggled.json()["agent"]["args"] == ["-y", "@agentclientprotocol/claude-agent-acp@0.84.0"]
    assert client.delete("/api/personal-agents/claude", headers=PERSON).status_code == 400
    assert client.delete("/api/personal-agents/fake", headers=PERSON).status_code == 200
    assert client.delete("/api/personal-agents/fake", headers=PERSON).status_code == 404

    acked = client.post("/api/personal-agents/acknowledge-warning", headers=PERSON)
    assert acked.status_code == 200 and acked.json()["warningAcknowledgedAt"]
    assert client.get("/api/personal-agents", headers=PERSON).json()["warningAcknowledged"] is True
    mode = stat.S_IMODE((main._STATE_DIR / personal_agents.FILE_NAME).stat().st_mode)
    assert mode == 0o600


@pytest.mark.parametrize("body", [
    {"id": "Bad Id", "command": "/bin/echo"},
    {"id": "x" * 33, "command": "/bin/echo"},
    {"id": "ok", "command": "rm -rf /"},
    {"id": "ok", "command": "relative/path"},
    {"id": "ok", "command": "/bin/echo", "color": "red"},
    {"id": "ok", "command": "/bin/echo", "args": "--flag"},
    {"id": "ok", "command": "/bin/echo", "args": ["a"] * 33},
    {"id": "ok", "command": "/bin/echo", "args": ["x" * 513]},
    {"id": "ok", "command": "/bin/echo", "args": ["nul\x00"]},
    {"id": "ok", "command": "/bin/echo", "env": {"A": "1"}},
    {"id": "ok", "command": "/bin/echo", "displayName": "!!!"},
])
def test_validation(tmp_path, body):
    with pytest.raises(personal_agents.PersonalAgentError):
        personal_agents.create_custom(tmp_path, body)


def test_custom_agent_cap(tmp_path):
    for index in range(personal_agents.MAX_AGENTS):
        personal_agents.create_custom(tmp_path, {"id": f"a{index}", "command": "/bin/echo"})
    with pytest.raises(personal_agents.PersonalAgentError):
        personal_agents.create_custom(tmp_path, {"id": "one-more", "command": "/bin/echo"})


def test_presets_are_exactly_pinned_and_npx_holds_the_14_day_rule():
    for preset in personal_agents.PRESETS.values():
        for arg in preset.args:
            if arg.startswith("@"):
                assert re.fullmatch(r"@[a-z0-9-]+/[a-z0-9-]+@\d+\.\d+\.\d+", arg), arg
    now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
    env = personal_agents.npx_env(now)
    before = datetime.strptime(env["npm_config_before"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert now - before >= timedelta(days=14)
    assert env["npm_config_update_notifier"] == "false"


def test_launch_spec_refuses_what_cannot_start(tmp_path):
    with pytest.raises(personal_agents.PersonalAgentError) as info:
        personal_agents.launch_spec(tmp_path, "hermes")
    assert info.value.code == "personal_agent_needs_setup"
    with pytest.raises(personal_agents.PersonalAgentError) as info:
        personal_agents.launch_spec(tmp_path, "nope")
    assert info.value.code == "personal_agent_unknown"
    personal_agents.create_custom(tmp_path, {"id": "off", "command": sys.executable, "enabled": False})
    with pytest.raises(personal_agents.PersonalAgentError) as info:
        personal_agents.launch_spec(tmp_path, "off")
    assert info.value.code == "personal_agent_disabled"
    personal_agents.update_agent(tmp_path, "off", {"enabled": True})
    spec = personal_agents.launch_spec(tmp_path, "off")
    assert spec.argv == [sys.executable] and spec.startup_timeout == personal_agents.STARTUP_TIMEOUT_S


def test_npx_preset_launch_spec(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in [("npx", "#!/bin/sh\n"), ("node", "#!/bin/sh\necho v22.1.0\n"), ("codex", "#!/bin/sh\n")]:
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    from services import agent_binaries
    agent_binaries.node_major.cache_clear()
    monkeypatch.setattr(agent_binaries, "_FIXED_DIRS", ())
    monkeypatch.setattr(agent_binaries, "login_shell_path", lambda: "")
    monkeypatch.setenv("PATH", str(bin_dir))
    personal_agents.update_agent(tmp_path, "codex", {"enabled": True})
    spec = personal_agents.launch_spec(tmp_path, "codex", home=tmp_path / "home")
    assert spec.argv == [str(bin_dir / "npx"), "-y", "@agentclientprotocol/codex-acp@2.0.0"]
    assert spec.env["CODEX_PATH"] == str(bin_dir / "codex") and spec.env["NO_BROWSER"] == "1"
    assert "npm_config_before" in spec.env and spec.startup_timeout == personal_agents.NPX_STARTUP_TIMEOUT_S
    (bin_dir / "node").write_text("#!/bin/sh\necho v20.0.0\n")
    agent_binaries.node_major.cache_clear()
    claude = personal_agents.get_agent(tmp_path, "claude", home=tmp_path / "home")
    assert claude.status == "needs_node"
    agent_binaries.node_major.cache_clear()


def test_spend_view_lists_personal_agents(client):
    response = client.get("/api/agent/spend/apps", headers=PERSON).json()
    assert [p["id"] for p in response["personal"]] == ["claude", "codex", "gemini", "hermes"]
    assert all(p["spentUsd"] == 0 for p in response["personal"])
    assert PERSON_TOKEN  # the fixture's token is what PERSON carries
