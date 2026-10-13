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
from services import agent_connect, backend_address  # noqa: E402
from tests.conftest import FORGED_ORIGIN, PERSON  # noqa: E402

PATHS = agent_connect.CheckoutPaths(python="/repo/backend/.venv/bin/python", server="/repo/backend/mcp_server.py")
URL = "http://127.0.0.1:8000"
TOKEN = "nebula_app_TESTTOKEN"
REPO = Path(__file__).resolve().parents[2]
REAL_BACKEND_DIR = agent_connect._backend_dir


@pytest.fixture(autouse=True)
def fake_checkout(tmp_path_factory, monkeypatch):
    """A checkout with a venv, wherever the tests run. CI installs the
    backend's packages without one, and connect refuses a checkout that has
    none (its configs would name a python that isn't there)."""
    backend = tmp_path_factory.mktemp("checkout") / "backend"
    (backend / ".venv" / "bin").mkdir(parents=True)
    (backend / ".venv" / "bin" / "python").symlink_to(sys.executable)
    (backend / "mcp_server.py").write_text("")
    monkeypatch.setattr(agent_connect, "_backend_dir", lambda: backend)
    return backend


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
    "openclaw": ("openclaw mcp set nebula \\\n  '{\"command\": \"/repo/backend/.venv/bin/python\", \"args\": "
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
    "claude-code": """claude mcp add \\
  --scope user \\
  --env NEBULA_URL=http://127.0.0.1:8000 \\
  --env NEBULA_APP_TOKEN=nebula_app_TESTTOKEN \\
  --transport stdio nebula \\
  -- \\
  /repo/backend/.venv/bin/python \\
  /repo/backend/mcp_server.py""",
    "codex": """codex mcp add nebula \\
  --env NEBULA_URL=http://127.0.0.1:8000 \\
  --env NEBULA_APP_TOKEN=nebula_app_TESTTOKEN \\
  -- \\
  /repo/backend/.venv/bin/python \\
  /repo/backend/mcp_server.py""",
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


@pytest.mark.parametrize("client_id", ["claude-code", "codex", "openclaw"])
def test_shell_snippets_run_as_the_exact_argv(client_id):
    """Pasted into a shell (paths with spaces and all), the command is the argv the CLI would run."""
    spaced = agent_connect.CheckoutPaths(python="/My Repo/backend/.venv/bin/python",
                                         server="/My Repo/backend/mcp_server.py")
    snippet = agent_connect.render(client_id, paths=spaced, url=URL, token=TOKEN, app_name="x")["snippet"]
    entry = agent_connect.server_entry(spaced, URL, TOKEN)
    expected = {"claude-code": agent_connect.claude_code_add_argv(entry), "codex": agent_connect.codex_add_argv(entry),
                "openclaw": ["openclaw", "mcp", "set", "nebula", json.dumps(entry)]}[client_id]
    done = subprocess.run(["/bin/sh", "-c", "printf '%s\\n' " + snippet], capture_output=True, text=True, check=True)
    assert done.stdout.splitlines() == expected


def test_the_warning_names_the_daily_limit():
    assert "its $5 daily limit" in setup("hermes", daily=5)["warnings"][0]
    assert "its $0.50 daily limit" in setup("hermes", daily=0.5)["warnings"][0]
    assert "up to the shared budget" in setup("hermes")["warnings"][0]


def test_checkout_paths_keep_the_venv_symlink_and_refuse_an_app_bundle(tmp_path, fake_checkout):
    assert REAL_BACKEND_DIR() == REPO / "backend"
    paths = agent_connect.checkout_paths()
    assert paths.python == str(fake_checkout / ".venv" / "bin" / "python") and Path(paths.python).is_symlink()
    assert paths.server == str(fake_checkout / "mcp_server.py")
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
def test_connect_merges_one_entry_with_a_backup_and_0600(tmp_path, cli_env, client_id, capsys):
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

    # Disconnect removes only Nebula's entry, and its diff masks the token too.
    capsys.readouterr()
    assert mcp_connect.run_disconnect(args(client_id), home=tmp_path) == 0
    out = capsys.readouterr().out
    assert TOKEN not in out and "blanked out" in out
    # The backup it leaves has the old entry, minus a working token.
    backups = sorted(path.parent.glob(f"{path.name}.nebula-backup-*"))
    assert len(backups) == 2 and all(TOKEN not in b.read_text() for b in backups)
    newest = max(backups, key=lambda b: json.loads(b.read_text()).get("mcpServers", {}).get("nebula") is not None)
    assert json.loads(newest.read_text())["mcpServers"]["nebula"]["env"]["NEBULA_APP_TOKEN"] == mcp_connect.REDACTED
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

    monkeypatch.delenv("CODEX_HOME", raising=False)

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        if argv[:3] == ["codex", "mcp", "add"]:
            fake_codex_add(tmp_path / ".codex" / "config.toml", argv)
        # `mcp get nebula` fails: no server by that name yet.
        return subprocess.CompletedProcess(argv, 1 if argv[1:3] == ["mcp", "get"] else 0, "", "")

    assert mcp_connect.run_connect(args("claude-code"), home=tmp_path, runner=runner) == 0
    assert mcp_connect.run_connect(args("codex"), home=tmp_path, runner=runner) == 0
    assert [argv for argv, _ in calls if argv[2] == "get"] == [["claude", "mcp", "get", "nebula"],
                                                                ["codex", "mcp", "get", "nebula"]]
    (claude_argv, claude_kwargs), (codex_argv, _) = [call for call in calls if call[0][2] == "add"]
    assert claude_argv[:5] == ["claude", "mcp", "add", "--scope", "user"] and "shell" not in claude_kwargs
    assert f"NEBULA_APP_TOKEN={TOKEN}" in claude_argv and claude_argv[claude_argv.index("--") - 1] == "nebula"
    # Codex never sees the token on argv: a one-off placeholder goes there,
    # and the token replaces it in config.toml, with the tool timeout set.
    assert codex_argv[:4] == ["codex", "mcp", "add", "nebula"] and TOKEN not in " ".join(codex_argv)
    assert any(part.startswith("NEBULA_APP_TOKEN=nebula_app_PENDING_") for part in codex_argv)
    toml_path = tmp_path / ".codex" / "config.toml"
    server = __import__("tomllib").loads(toml_path.read_text())["mcp_servers"]["nebula"]
    assert server["env"]["NEBULA_APP_TOKEN"] == TOKEN and server["tool_timeout_sec"] == 150
    assert __import__("tomllib").loads(toml_path.read_text())["mcp_servers"]["other"] == {"command": "a"}
    assert mode(toml_path) == 0o600 and "PENDING" not in toml_path.read_text()

    assert mcp_connect.run_disconnect(args("codex"), home=tmp_path, runner=runner) == 0
    assert calls[-1][0] == ["codex", "mcp", "remove", "nebula"]
    # Claude Code's remove takes no scope, so an older local-scope entry goes too.
    assert mcp_connect.run_disconnect(args("claude-code"), home=tmp_path, runner=runner) == 0
    assert calls[-1][0] == ["claude", "mcp", "remove", "nebula"]


def fake_codex_add(path, argv):
    """What `codex mcp add` 0.160 writes (checked in a temp CODEX_HOME)."""
    env = dict(part.split("=", 1) for part in argv[argv.index("nebula") + 1:argv.index("--")] if "=" in part)
    command, *rest = argv[argv.index("--") + 1:]
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (f'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n\n[mcp_servers.nebula]\ncommand = {json.dumps(command)}\n'
            f"args = {json.dumps(rest)}\n\n[mcp_servers.nebula.env]\n"
            + "".join(f"{key} = {json.dumps(value)}\n" for key, value in sorted(env.items())))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(body)


def test_codex_entry_that_doesnt_parse_back_is_removed(tmp_path, cli_env, monkeypatch, capsys):
    monkeypatch.setattr(mcp_connect.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "ch"))
    calls = []

    def runner(argv, **kwargs):
        calls.append(argv)
        if argv[2] == "add":  # wrote somewhere else: the placeholder isn't in CODEX_HOME
            (tmp_path / "ch").mkdir()
            (tmp_path / "ch" / "config.toml").write_text('model = "x"\n')
        return subprocess.CompletedProcess(argv, 1 if argv[2] == "get" else 0, "", "")

    assert mcp_connect.run_connect(args("codex"), home=tmp_path, runner=runner) == 1
    assert calls[-1] == ["codex", "mcp", "remove", "nebula"]
    assert TOKEN not in (tmp_path / "ch" / "config.toml").read_text() and "--print" in capsys.readouterr().err


def test_a_refused_client_command_is_reported_without_the_token(tmp_path, cli_env, monkeypatch, capsys):
    monkeypatch.setattr(mcp_connect.shutil, "which", lambda name: f"/usr/bin/{name}")

    def runner(argv, **kwargs):
        if argv[2] == "get":
            return subprocess.CompletedProcess(argv, 1, "", "")
        return subprocess.CompletedProcess(argv, 1, "", f"MCP server nebula already exists ({TOKEN})")

    assert mcp_connect.run_connect(args("claude-code"), home=tmp_path, runner=runner) == 1
    err = capsys.readouterr().err
    assert "nebula mcp disconnect claude-code" in err and TOKEN not in err


def test_an_existing_nebula_server_is_never_replaced(tmp_path, cli_env, monkeypatch, capsys):
    monkeypatch.setattr(mcp_connect.shutil, "which", lambda name: f"/usr/bin/{name}")
    calls = []

    def runner(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "nebula: someone else's", "")

    assert mcp_connect.run_connect(args("codex"), home=tmp_path, runner=runner) == 1
    assert calls == [["codex", "mcp", "get", "nebula"]]
    assert "nebula mcp disconnect codex" in capsys.readouterr().err


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


def test_replacing_a_nebula_entry_blanks_the_old_token_in_the_backup(tmp_path, cli_env, capsys):
    path = mcp_connect.config_path("cursor", tmp_path)
    path.parent.mkdir(parents=True)
    old = "nebula_app_OLDTOKEN_still_valid"
    path.write_text(json.dumps({"mcpServers": {"nebula": {"command": "x", "env": {"NEBULA_APP_TOKEN": old}}}}))
    assert mcp_connect.run_connect(args("cursor"), home=tmp_path) == 0
    (backup,) = path.parent.glob("mcp.json.nebula-backup-*")
    assert old not in backup.read_text() and mcp_connect.REDACTED in backup.read_text()
    assert old not in capsys.readouterr().out


def test_connect_refuses_to_write_when_nebula_cant_be_reached(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_APP_TOKEN", TOKEN)
    monkeypatch.setattr(mcp_connect, "check_token", lambda url, token: None)
    assert mcp_connect.run_connect(args("cursor"), home=tmp_path) == 1
    assert "nothing was written" in capsys.readouterr().err and not list(tmp_path.rglob("*"))
    # Printing only still works, with a warning.
    assert mcp_connect.run_connect(args("hermes"), home=tmp_path) == 0
    assert "couldn't reach Nebula" in capsys.readouterr().err


def test_check_token_refuses_what_isnt_nebula(monkeypatch):
    import httpx

    for response in (httpx.Response(404, json={"detail": "Not Found"}), httpx.Response(200, text="<html>hi</html>"),
                     httpx.Response(500, text="boom"), httpx.Response(200, json={"ok": True})):
        monkeypatch.setattr(httpx, "get", lambda *a, _r=response, **k: _r)
        with pytest.raises(SystemExit):
            mcp_connect.check_token(URL, TOKEN)

    def slow(*a, **k):
        raise httpx.ReadTimeout("slow")

    monkeypatch.setattr(httpx, "get", slow)
    assert mcp_connect.check_token(URL, TOKEN) is None


def test_the_cli_writes_the_address_nebula_reports(tmp_path, monkeypatch):
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_APP_TOKEN", TOKEN)
    url_file = str(tmp_path / "state" / "backend-url")
    monkeypatch.setattr(mcp_connect, "check_token", lambda url, token: {
        "budget": "app", "agent": "Desk", "limits": {}, "mcpAddress": {"urlFile": url_file}})
    assert mcp_connect.run_connect(args("cursor", url="http://127.0.0.1:54321"), home=tmp_path) == 0
    env = json.loads(mcp_connect.config_path("cursor", tmp_path).read_text())["mcpServers"]["nebula"]["env"]
    assert env == {"NEBULA_URL_FILE": url_file, "NEBULA_APP_TOKEN": TOKEN}


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
    # The real CLI on this real checkout: CI has no backend/.venv, and then
    # the right answer is a refusal (the config would name a missing python).
    if (REPO / "backend" / ".venv" / "bin" / "python").exists():
        assert done.returncode == 0, done.stderr
        assert agent_connect.TOKEN_PLACEHOLDER in done.stdout and '"type": "stdio"' in done.stdout
        assert '"NEBULA_URL": "http://127.0.0.1:9"' in done.stdout
    else:
        assert done.returncode == 1 and "no backend virtualenv" in done.stderr, done.stderr
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


def test_only_the_person_gets_a_token_and_its_setup(client, fake_checkout):
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
    assert str(fake_checkout / ".venv" / "bin" / "python") in setup_view["snippet"]
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


# -- the desktop app's address, which changes every launch ---------------------------

SECRET = "ab" * 32


def test_backend_address_file_round_trip(tmp_path):
    path = backend_address.publish(tmp_path, "http://127.0.0.1:54321/", SECRET)
    assert path == tmp_path / "backend-url" and mode(path) == 0o600
    assert backend_address.read(path) == ("http://127.0.0.1:54321", SECRET)
    backend_address.withdraw(tmp_path, "cd" * 32)  # a newer launch's file stays
    assert path.exists()
    backend_address.withdraw(tmp_path, SECRET)
    assert not path.exists()
    with pytest.raises(ValueError, match="isn't running"):
        backend_address.read(path)
    for bad in ("http://evil.example:80", "https://127.0.0.1:1", "http://127.0.0.1", "http://u:p@127.0.0.1:1",
                "http://127.0.0.1:1/x"):
        path.write_text(json.dumps({"url": bad, "secret": SECRET}))
        with pytest.raises(ValueError):
            backend_address.read(path)
    for bad in ("http://127.0.0.1:1", json.dumps({"url": "http://127.0.0.1:1"}),
                json.dumps({"url": "http://127.0.0.1:1", "secret": "short"})):
        path.write_text(bad)
        with pytest.raises(ValueError, match="isn't a Nebula address file"):
            backend_address.read(path)
    with pytest.raises(ValueError):
        backend_address.publish(tmp_path, "http://127.0.0.1:1", "not-hex")


def test_only_the_backend_that_wrote_the_file_passes_the_check(tmp_path):
    path = backend_address.publish(tmp_path, "http://127.0.0.1:50009", SECRET)
    seen = []

    def honest(url, challenge):
        seen.append((url, challenge))
        return backend_address.prove(SECRET, challenge)

    assert backend_address.verified_url(path, probe=honest) == "http://127.0.0.1:50009"
    assert backend_address.verified_url(path, probe=honest) == "http://127.0.0.1:50009"
    assert len({challenge for _, challenge in seen}) == 2  # a fresh challenge every time
    with pytest.raises(ValueError, match="isn't running"):
        backend_address.verified_url(path, probe=lambda url, challenge: None)
    for answer in ("", "0" * 64, backend_address.prove("cd" * 32, "ab" * 16)):
        with pytest.raises(ValueError, match="no token was sent"):
            backend_address.verified_url(path, probe=lambda url, challenge, a=answer: a)
    with pytest.raises(ValueError):
        backend_address.prove(SECRET, "not-hex")


def test_the_proof_route_answers_only_with_this_launchs_secret(client, monkeypatch):
    import main

    monkeypatch.setattr(main, "_backend_address_secret", None)
    assert client.get("/api/agent/address-proof", params={"challenge": "ab" * 16}).status_code == 404
    monkeypatch.setattr(main, "_backend_address_secret", SECRET)
    challenge = "0123456789abcdef" * 2
    answered = client.get("/api/agent/address-proof", params={"challenge": challenge})
    assert answered.status_code == 200
    assert answered.json() == {"proof": backend_address.prove(SECRET, challenge)}
    for bad in ("", "xyz", "AB" * 16, "a" * 31, "a" * 129):
        assert client.get("/api/agent/address-proof", params={"challenge": bad}).status_code == 400


def test_desktop_startup_publishes_the_file_and_shutdown_withdraws_it(monkeypatch):
    import asyncio

    import main

    monkeypatch.setattr(main, "_backend_address_secret", None)
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    monkeypatch.setenv("NEBULA_URL", "http://127.0.0.1:50123")
    path = backend_address.url_file(main._STATE_DIR)
    asyncio.run(main._publish_backend_address())
    try:
        published = backend_address.read(path)
        assert published.url == "http://127.0.0.1:50123"
        assert published.secret == main._backend_address_secret and mode(path) == 0o600
    finally:
        asyncio.run(main._withdraw_backend_address())
    assert not path.exists()


class _Recorder:
    """A real HTTP server on a loopback port: either a program that took a dead
    Nebula's port (`secret=None`), or a stand-in for the backend that wrote the
    file. It records every request so a test can see whether a token arrived."""

    def __init__(self, secret=None):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from urllib.parse import parse_qs, urlsplit

        self.requests = []
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                parts = urlsplit(self.path)
                recorder.requests.append((parts.path, self.headers.get("Authorization")))
                if parts.path == backend_address.PROOF_PATH:
                    challenge = parse_qs(parts.query).get("challenge", [""])[0]
                    proof = backend_address.prove(secret, challenge) if secret else "0" * 64
                    body = json.dumps({"proof": proof})
                else:
                    body = json.dumps({"nodes": [], "edges": []})
                data = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def test_a_program_on_a_dead_launchs_port_never_gets_the_token(tmp_path, monkeypatch):
    """The stale-file case: Nebula crashed, its backend-url file stayed, and
    another local program now listens on that port."""
    import mcp_server
    from cli.__main__ import default_url

    squatter = _Recorder(secret=None)
    try:
        backend_address.publish(tmp_path, squatter.url, SECRET)
        monkeypatch.setattr(mcp_server, "_base_url", None)
        monkeypatch.setenv("NEBULA_URL_FILE", str(tmp_path / "backend-url"))
        monkeypatch.setenv("NEBULA_APP_TOKEN", TOKEN)
        with pytest.raises(mcp_server.NebulaAPIError, match="no token was sent"):
            mcp_server.look_at_canvas()
        with pytest.raises(SystemExit):
            default_url({"NEBULA_URL_FILE": str(tmp_path / "backend-url")})
        assert squatter.requests and all(path == backend_address.PROOF_PATH for path, _ in squatter.requests)
        assert all(auth is None for _, auth in squatter.requests)
    finally:
        squatter.close()


def test_the_backend_that_wrote_the_file_gets_the_call_and_proxies_are_ignored(tmp_path, monkeypatch):
    import mcp_server

    backend = _Recorder(secret=SECRET)
    try:
        backend_address.publish(tmp_path, backend.url, SECRET)
        monkeypatch.setattr(mcp_server, "_base_url", None)
        monkeypatch.setenv("NEBULA_URL_FILE", str(tmp_path / "backend-url"))
        monkeypatch.setenv("NEBULA_APP_TOKEN", TOKEN)
        # A proxy that answers nothing: httpx would send even 127.0.0.1 through it.
        for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(name, "http://127.0.0.1:9")
        for name in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(name, raising=False)
        assert mcp_server.look_at_canvas() == {"nodes": [], "edges": []}
        assert backend.requests == [(backend_address.PROOF_PATH, None), ("/api/canvas/snapshot", f"Agent {TOKEN}")]
    finally:
        backend.close()


def test_desktop_configs_carry_the_url_file(client, monkeypatch, tmp_path):
    import main

    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    made = client.post("/api/agent/spend/apps", json={"name": "Desk", "client": "cursor"}, headers=PERSON).json()
    env = json.loads(made["setup"]["snippet"])["mcpServers"]["nebula"]["env"]
    assert env == {"NEBULA_URL_FILE": str(main._STATE_DIR / "backend-url"), "NEBULA_APP_TOKEN": made["token"]}
    status = client.get("/api/agent/spend", headers={"Authorization": f"Agent {made['token']}"}).json()
    assert status["mcpAddress"] == {"urlFile": str(main._STATE_DIR / "backend-url")}
    monkeypatch.delenv("NEBULA_DESKTOP_MODE")
    status = client.get("/api/agent/spend", headers={"Authorization": f"Agent {made['token']}"}).json()
    assert set(status["mcpAddress"]) == {"url"}


def test_the_mcp_server_follows_the_url_file_on_every_call(tmp_path, monkeypatch):
    import mcp_server

    honest = lambda url, challenge: backend_address.prove(SECRET, challenge)  # noqa: E731
    real = backend_address.verified_url
    monkeypatch.setattr(backend_address, "verified_url", lambda path, **kw: real(path, probe=honest))
    monkeypatch.setattr(mcp_server, "_base_url", None)
    monkeypatch.setenv("NEBULA_URL_FILE", str(tmp_path / "backend-url"))
    with pytest.raises(mcp_server.NebulaAPIError, match="isn't running"):
        mcp_server._current_url()
    backend_address.publish(tmp_path, "http://127.0.0.1:50001", SECRET)
    assert mcp_server._current_url() == "http://127.0.0.1:50001"
    backend_address.publish(tmp_path, "http://127.0.0.1:50002", SECRET)  # Nebula reopened on a new port
    assert mcp_server._api().base_url == "http://127.0.0.1:50002"
    monkeypatch.setattr(mcp_server, "_base_url", "http://127.0.0.1:8000")  # NEBULA_URL / --url win
    assert mcp_server._current_url() == "http://127.0.0.1:8000"


def test_cli_default_url_reads_the_url_file(tmp_path, monkeypatch):
    from cli.__main__ import default_url

    honest = lambda url, challenge: backend_address.prove(SECRET, challenge)  # noqa: E731
    real = backend_address.verified_url
    monkeypatch.setattr(backend_address, "verified_url", lambda path, **kw: real(path, probe=honest))
    backend_address.publish(tmp_path, "http://127.0.0.1:50003", SECRET)
    assert default_url({"NEBULA_URL_FILE": str(tmp_path / "backend-url")}) == "http://127.0.0.1:50003"
    assert default_url({"NEBULA_URL": "http://127.0.0.1:9", "NEBULA_URL_FILE": "x"}) == "http://127.0.0.1:9"
    assert default_url({}) == "http://localhost:8000"
    with pytest.raises(SystemExit):
        default_url({"NEBULA_URL_FILE": str(tmp_path / "missing")})
