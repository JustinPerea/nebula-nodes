"""Connect your agent: per-client config, the CLI's merge into JSON configs,
and the person gate on making a token (services/agent_connect.py,
cli/commands/mcp_connect.py)."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cli.commands import mcp_connect  # noqa: E402
from services import agent_connect  # noqa: E402
from tests.conftest import FORGED_ORIGIN, PERSON  # noqa: E402

PATHS = agent_connect.CheckoutPaths(python="/repo/backend/.venv/bin/python", server="/repo/backend/mcp_server.py")
URL = "http://127.0.0.1:8000"
TOKEN = "nebula_app_TESTTOKEN"
REPO = Path(__file__).resolve().parents[2]


def setup(client_id, daily=None):
    return agent_connect.render(client_id, paths=PATHS, url=URL, token=TOKEN, app_name="My Agent", daily_usd=daily)


# -- golden snippets -------------------------------------------------------------

GOLDEN = {
    "hermes": '''mcp_servers:
  nebula:
    command: "/repo/backend/.venv/bin/python"
    args: ["/repo/backend/mcp_server.py"]
    env:
      NEBULA_URL: "http://127.0.0.1:8000"
      NEBULA_APP_TOKEN: "nebula_app_TESTTOKEN"
    trust: untrusted
''',
    "openclaw": ("openclaw mcp set nebula '{\"command\": \"/repo/backend/.venv/bin/python\", \"args\": "
                 "[\"/repo/backend/mcp_server.py\"], \"env\": {\"NEBULA_URL\": \"http://127.0.0.1:8000\", "
                 "\"NEBULA_APP_TOKEN\": \"nebula_app_TESTTOKEN\"}}'"),
    "claude-desktop": '''{
  "mcpServers": {
    "nebula": {
      "command": "/repo/backend/.venv/bin/python",
      "args": [
        "/repo/backend/mcp_server.py"
      ],
      "env": {
        "NEBULA_URL": "http://127.0.0.1:8000",
        "NEBULA_APP_TOKEN": "nebula_app_TESTTOKEN"
      }
    }
  }
}''',
    "cursor": '''{
  "mcpServers": {
    "nebula": {
      "type": "stdio",
      "command": "/repo/backend/.venv/bin/python",
      "args": [
        "/repo/backend/mcp_server.py"
      ],
      "env": {
        "NEBULA_URL": "http://127.0.0.1:8000",
        "NEBULA_APP_TOKEN": "nebula_app_TESTTOKEN"
      }
    }
  }
}''',
    "claude-code": ("claude mcp add --scope user --env NEBULA_URL=http://127.0.0.1:8000 "
                    "--env NEBULA_APP_TOKEN=nebula_app_TESTTOKEN --transport stdio nebula -- "
                    "/repo/backend/.venv/bin/python /repo/backend/mcp_server.py"),
    "codex": ("codex mcp add nebula --env NEBULA_URL=http://127.0.0.1:8000 --env NEBULA_APP_TOKEN=nebula_app_TESTTOKEN "
              "-- /repo/backend/.venv/bin/python /repo/backend/mcp_server.py"),
    "other": '''{
  "mcpServers": {
    "nebula": {
      "command": "/repo/backend/.venv/bin/python",
      "args": [
        "/repo/backend/mcp_server.py"
      ],
      "env": {
        "NEBULA_URL": "http://127.0.0.1:8000",
        "NEBULA_APP_TOKEN": "nebula_app_TESTTOKEN"
      }
    }
  }
}''',
}

CODEX_TOML = '''[mcp_servers.nebula]
command = "/repo/backend/.venv/bin/python"
args = ["/repo/backend/mcp_server.py"]
tool_timeout_sec = 150

[mcp_servers.nebula.env]
NEBULA_URL = "http://127.0.0.1:8000"
NEBULA_APP_TOKEN = "nebula_app_TESTTOKEN"
'''


@pytest.mark.parametrize("client_id", list(agent_connect.CLIENTS))
def test_each_client_gets_its_golden_snippet(client_id):
    result = setup(client_id)
    assert result["snippet"] == GOLDEN[client_id]
    assert result["label"] == agent_connect.CLIENTS[client_id].label
    # Every client is warned about unattended spending and where the token lives.
    assert any("scheduled jobs" in w and "while you aren't watching" in w for w in result["warnings"])
    assert any("plain text" in w and "My Agent" in w for w in result["warnings"])


def test_snippets_parse_in_their_own_format():
    import tomllib

    for client_id in ("claude-desktop", "cursor", "other"):
        assert json.loads(setup(client_id)["snippet"])["mcpServers"]["nebula"]["env"]["NEBULA_APP_TOKEN"] == TOKEN
    toml = setup("codex")["alternative"]["snippet"]
    assert toml == CODEX_TOML
    parsed = tomllib.loads(toml)["mcp_servers"]["nebula"]
    assert parsed["env"] == {"NEBULA_URL": URL, "NEBULA_APP_TOKEN": TOKEN} and parsed["tool_timeout_sec"] == 150
    yaml = pytest.importorskip("yaml")
    hermes = yaml.safe_load(setup("hermes")["snippet"])["mcp_servers"]["nebula"]
    assert hermes["trust"] == "untrusted" and hermes["env"]["NEBULA_APP_TOKEN"] == TOKEN
    assert hermes["command"] == PATHS.python and hermes["args"] == [PATHS.server]


def test_shell_snippets_quote_paths_with_spaces():
    spaced = agent_connect.CheckoutPaths(python="/My Repo/backend/.venv/bin/python",
                                         server="/My Repo/backend/mcp_server.py")
    snippet = agent_connect.render("claude-code", paths=spaced, url=URL, token=TOKEN, app_name="x")["snippet"]
    assert "'/My Repo/backend/.venv/bin/python' '/My Repo/backend/mcp_server.py'" in snippet


def test_the_warning_names_the_daily_limit():
    assert "its $5 daily limit" in setup("hermes", daily=5)["warnings"][0]
    assert "its $0.50 daily limit" in setup("hermes", daily=0.5)["warnings"][0]
    assert "up to the shared budget" in setup("hermes")["warnings"][0]


def test_checkout_paths_keep_the_venv_symlink_and_refuse_an_app_bundle(tmp_path):
    paths = agent_connect.checkout_paths()
    assert paths.python == str(REPO / "backend" / ".venv" / "bin" / "python")
    assert paths.server == str(REPO / "backend" / "mcp_server.py")
    bundle = tmp_path / "Nebula Nodes.app" / "Contents" / "Resources" / "backend"
    bundle.mkdir(parents=True)
    (bundle / "mcp_server.py").write_text("")
    with pytest.raises(agent_connect.ConnectError, match="packaged app"):
        agent_connect.checkout_paths(bundle)
    bare = tmp_path / "backend"
    bare.mkdir()
    (bare / "mcp_server.py").write_text("")
    with pytest.raises(agent_connect.ConnectError, match="virtualenv"):
        agent_connect.checkout_paths(bare)


# -- the CLI merging into JSON configs (temp HOME) -------------------------------

def args(client_id, **overrides):
    base = {"client": client_id, "url": URL, "name": None, "daily_usd": None, "print_only": False, "yes": True}
    return SimpleNamespace(**{**base, **overrides})


@pytest.fixture
def cli_env(monkeypatch):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_APP_TOKEN", TOKEN)
    monkeypatch.setattr(mcp_connect, "check_token", lambda url, token: {
        "budget": "app", "agent": "My Cursor", "limits": {"appDailyUsd": 2}})


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


@pytest.mark.parametrize("client_id", ["cursor", "claude-desktop"])
def test_connect_merges_one_entry_with_a_backup_and_0600(tmp_path, cli_env, client_id):
    path = mcp_connect.config_path(client_id, tmp_path)
    assert str(path).startswith(str(tmp_path))
    path.parent.mkdir(parents=True)
    original = {"mcpServers": {"github": {"command": "npx", "args": ["gh"], "env": {"GITHUB_TOKEN": "keep"}}},
                "globalShortcut": "Ctrl+Space"}
    path.write_text(json.dumps(original))
    os.chmod(path, 0o644)

    assert mcp_connect.run_connect(args(client_id), home=tmp_path) == 0
    data = json.loads(path.read_text())
    assert data["mcpServers"]["github"] == original["mcpServers"]["github"]
    assert data["globalShortcut"] == "Ctrl+Space"
    entry = data["mcpServers"]["nebula"]
    assert entry["env"] == {"NEBULA_URL": URL, "NEBULA_APP_TOKEN": TOKEN}
    assert entry["command"].endswith("backend/.venv/bin/python") and entry["args"][0].endswith("backend/mcp_server.py")
    assert (entry.get("type") == "stdio") is (client_id == "cursor")
    assert mode(path) == 0o600
    backups = list(path.parent.glob(f"{path.name}.nebula-backup-*"))
    assert len(backups) == 1 and json.loads(backups[0].read_text()) == original and mode(backups[0]) == 0o600

    # Running it again changes nothing and makes no second backup.
    assert mcp_connect.run_connect(args(client_id), home=tmp_path) == 0
    assert len(list(path.parent.glob(f"{path.name}.nebula-backup-*"))) == 1

    # Disconnect removes only Nebula's entry.
    assert mcp_connect.run_disconnect(args(client_id), home=tmp_path) == 0
    data = json.loads(path.read_text())
    assert "nebula" not in data["mcpServers"] and data["mcpServers"]["github"] == original["mcpServers"]["github"]
    assert data["globalShortcut"] == "Ctrl+Space" and mode(path) == 0o600


def test_connect_creates_a_missing_config_without_a_backup(tmp_path, cli_env, capsys):
    path = mcp_connect.config_path("cursor", tmp_path)
    assert mcp_connect.run_connect(args("cursor"), home=tmp_path) == 0
    assert json.loads(path.read_text())["mcpServers"]["nebula"]["env"]["NEBULA_APP_TOKEN"] == TOKEN
    assert mode(path) == 0o600 and not list(path.parent.glob("*.nebula-backup-*"))
    out = capsys.readouterr().out
    # The diff shown before writing masks the token.
    assert TOKEN not in out and "nebula_app_TEST…OKEN" in out


@pytest.mark.parametrize("content", ["{not json", "[1, 2]", '{"mcpServers": []}'])
def test_connect_never_overwrites_a_config_it_cant_read(tmp_path, cli_env, content):
    path = mcp_connect.config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(content)
    assert mcp_connect.run_connect(args("cursor"), home=tmp_path) == 1
    assert path.read_text() == content and not list(path.parent.glob("*.nebula-backup-*"))


def test_connect_asks_before_writing(tmp_path, cli_env, monkeypatch):
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    path = mcp_connect.config_path("cursor", tmp_path)
    assert mcp_connect.run_connect(args("cursor", yes=False), home=tmp_path, ask=lambda _q: "n") == 1
    assert not path.exists()
    assert mcp_connect.run_connect(args("cursor", yes=False), home=tmp_path, ask=lambda _q: "y") == 0
    assert path.exists()


def test_connect_uses_the_clients_own_command(tmp_path, cli_env, monkeypatch):
    calls = []
    monkeypatch.setattr(mcp_connect.shutil, "which", lambda name: f"/usr/bin/{name}")

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, "", "")

    assert mcp_connect.run_connect(args("claude-code"), home=tmp_path, runner=runner) == 0
    assert mcp_connect.run_connect(args("codex"), home=tmp_path, runner=runner) == 0
    (claude_argv, claude_kwargs), (codex_argv, _) = calls
    assert claude_argv[:5] == ["claude", "mcp", "add", "--scope", "user"] and "shell" not in claude_kwargs
    assert f"NEBULA_APP_TOKEN={TOKEN}" in claude_argv and claude_argv[claude_argv.index("--") - 1] == "nebula"
    assert codex_argv[:4] == ["codex", "mcp", "add", "nebula"] and f"NEBULA_APP_TOKEN={TOKEN}" in codex_argv
    assert not list(tmp_path.rglob("*"))  # nothing written by Nebula itself

    assert mcp_connect.run_disconnect(args("codex"), home=tmp_path, runner=runner) == 0
    assert calls[-1][0] == ["codex", "mcp", "remove", "nebula"]


def test_a_refused_client_command_is_reported_without_the_token(tmp_path, cli_env, monkeypatch, capsys):
    monkeypatch.setattr(mcp_connect.shutil, "which", lambda name: f"/usr/bin/{name}")

    def runner(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, "", f"MCP server nebula already exists ({TOKEN})")

    assert mcp_connect.run_connect(args("claude-code"), home=tmp_path, runner=runner) == 1
    err = capsys.readouterr().err
    assert "nebula mcp disconnect claude-code" in err and TOKEN not in err


def test_manual_clients_only_print(tmp_path, cli_env, capsys):
    assert mcp_connect.run_connect(args("hermes"), home=tmp_path) == 0
    out = capsys.readouterr().out
    assert "trust: untrusted" in out and TOKEN in out and "My Cursor" in out
    assert not list(tmp_path.rglob("*"))


def test_an_in_app_agent_cant_connect_apps(tmp_path, cli_env, monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "turn-token")
    assert mcp_connect.run_connect(args("cursor"), home=tmp_path) == 1
    assert mcp_connect.run_disconnect(args("cursor"), home=tmp_path) == 1
    assert not list(tmp_path.rglob("*"))


def test_connect_without_a_token_says_where_to_make_one(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(""))
    assert mcp_connect.run_connect(args("cursor", name="Desk", daily_usd=5), home=tmp_path) == 1
    err = capsys.readouterr().err
    assert "Settings > Connect your agent" in err and "name it Desk" in err and "$5" in err
    assert "can't make tokens" in err


def test_check_token_refuses_a_revoked_token(monkeypatch):
    import httpx

    monkeypatch.setattr(httpx, "get", lambda *a, **k: httpx.Response(401, json={"detail": "invalid"}))
    with pytest.raises(SystemExit):
        mcp_connect.check_token(URL, TOKEN)
    monkeypatch.setattr(httpx, "get", lambda *a, **k: httpx.Response(200, json={"budget": "shared"}))
    with pytest.raises(SystemExit):
        mcp_connect.check_token(URL, TOKEN)

    def down(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(httpx, "get", down)
    assert mcp_connect.check_token(URL, TOKEN) is None


def test_cli_print_mode_changes_nothing(tmp_path):
    env = {k: v for k, v in os.environ.items() if k not in ("NEBULA_APP_TOKEN", "NEBULA_AGENT_TOKEN")}
    env["HOME"] = str(tmp_path)
    done = subprocess.run([sys.executable, "-m", "nebula", "--url", "http://127.0.0.1:9", "mcp", "connect", "cursor",
                           "--print"], cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert agent_connect.TOKEN_PLACEHOLDER in done.stdout and '"type": "stdio"' in done.stdout
    assert '"NEBULA_URL": "http://127.0.0.1:9"' in done.stdout
    assert not list(tmp_path.rglob("*"))


# -- the person gate on making a token ---------------------------------------------

@pytest.fixture
def client(monkeypatch, tmp_path, person):
    from fastapi.testclient import TestClient

    import main
    from services import app_tokens

    store = app_tokens.AppTokens(tmp_path / "app-tokens.json")
    monkeypatch.setattr(main, "app_token_store", store)
    monkeypatch.setattr(app_tokens, "_store", store)
    return TestClient(main.app)


def test_only_the_person_gets_a_token_and_its_setup(client):
    body = {"name": "My Hermes", "dailyUsd": 3, "client": "hermes", "color": "#3fc1a5"}
    for headers in ({}, FORGED_ORIGIN, {**PERSON, "X-Nebula-Agent": "Hermes"},
                    {**PERSON, "Authorization": "Agent nebula_app_x"}):
        # A made-up agent token is refused before the gate (401); everything else at it (403).
        assert client.post("/api/agent/spend/apps", json=body, headers=headers).status_code in (401, 403)
    response = client.post("/api/agent/spend/apps", json=body, headers=PERSON)
    assert response.status_code == 200, response.text
    payload = response.json()
    token, app, setup_view = payload["token"], payload["app"], payload["setup"]
    assert app["client"] == "hermes" and app["color"] == "#3FC1A5" and app["dailyUsd"] == 3
    assert setup_view["format"] == "yaml" and f'NEBULA_APP_TOKEN: "{token}"' in setup_view["snippet"]
    assert "trust: untrusted" in setup_view["snippet"] and "its $3 daily limit" in setup_view["warnings"][0]
    assert str(REPO / "backend" / ".venv" / "bin" / "python") in setup_view["snippet"]
    # The listing never repeats the token or the setup, and says what the picker offers.
    listing = client.get("/api/agent/spend/apps", headers=PERSON).json()
    assert token not in json.dumps(listing) and listing["connect"]["available"] is True
    assert [c["id"] for c in listing["connect"]["clients"]] == list(agent_connect.CLIENTS)


def test_a_bad_client_or_color_makes_no_token(client):
    assert client.post("/api/agent/spend/apps", json={"name": "x", "client": "netscape"},
                       headers=PERSON).status_code == 400
    assert client.post("/api/agent/spend/apps", json={"name": "x", "color": "red"}, headers=PERSON).status_code == 400
    assert client.get("/api/agent/spend/apps", headers=PERSON).json()["apps"] == []


def test_a_packaged_app_cant_make_a_setup(client, monkeypatch):
    import main

    def bundled(backend_dir=None):
        raise agent_connect.ConnectError("Nebula is running from the packaged app")

    monkeypatch.setattr(main.agent_connect, "checkout_paths", bundled)
    response = client.post("/api/agent/spend/apps", json={"name": "x", "client": "cursor"}, headers=PERSON)
    assert response.status_code == 400 and "packaged app" in response.json()["detail"]
    assert client.get("/api/agent/spend/apps", headers=PERSON).json()["connect"]["available"] is False


def test_the_apps_name_and_color_are_its_cursor(client):
    import main

    made = client.post("/api/agent/spend/apps", json={"name": "My Hermes", "client": "hermes", "color": "#FF6B9A"},
                       headers=PERSON).json()
    as_app = {"Authorization": f"Agent {made['token']}"}
    identity = main.identify_agent(as_app)
    assert identity.name == "My Hermes" and identity.color == "#FF6B9A" and identity.verified
    app_id = made["app"]["id"]
    assert client.put(f"/api/agent/spend/apps/{app_id}", json={"color": "#123456"}, headers=as_app).status_code == 403
    assert client.put(f"/api/agent/spend/apps/{app_id}", json={"color": "blue"}, headers=PERSON).status_code == 400
    assert client.put(f"/api/agent/spend/apps/{app_id}", json={"dailyUsd": 2, "color": "nope"},
                      headers=PERSON).status_code == 400
    assert client.get("/api/agent/spend/apps", headers=PERSON).json()["apps"][0]["dailyUsd"] is None
    changed = client.put(f"/api/agent/spend/apps/{app_id}", json={"color": "#123456", "dailyUsd": 2}, headers=PERSON)
    assert changed.status_code == 200 and changed.json()["app"]["color"] == "#123456"
    assert main.identify_agent(as_app).color == "#123456"
    # Back to the default color: one derived from the app id.
    client.put(f"/api/agent/spend/apps/{app_id}", json={"color": None}, headers=PERSON)
    assert main.identify_agent(as_app).color.startswith("#") and main.identify_agent(as_app).color != "#123456"
    assert client.put(f"/api/agent/spend/apps/{app_id}", json={}, headers=PERSON).status_code == 400


def test_a_store_written_before_client_and_color_still_loads(tmp_path):
    from services import app_tokens

    path = tmp_path / "app-tokens.json"
    path.write_text(json.dumps({"apps": [{"id": "abcdef123456", "name": "Old", "hash": "0" * 64, "dailyUsd": None}]}))
    (old,) = app_tokens.AppTokens(path).list()
    assert old["name"] == "Old" and old["client"] is None and old["color"] is None
