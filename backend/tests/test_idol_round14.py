"""PR #203 round 14: GM r26 and r27, and review 13.

- Review 13, HIGH-1: a settings.json that is exactly `null` fails closed
  again, as every other file that isn't an object: GET and every write get
  the 409, and runs don't go through.
- Review 13, LOW-3 and GM r27 item 3: a file Nebula may not read (no
  permission, a folder at the path) gets the same 409, never a 500, and
  start_here answers with the read line.
- GM r27 item 2: agents read their own line, "Ask the person to fix the
  file."; the person keeps "Fix the file, then try again.".
- Review 13, LOW-2: nothing reloads services.settings; the path is read from
  the environment at each call.
- Review 13, LOW-4: "~" only under a real home folder other than "/".
- Review 13, NIT-2: `check` is a boolean or a 422.
- Review 13, MEDIUM-1 and GM r27 item 1: every quoted Krea connection is a
  real option label ("API key", "Krea account").
- Review 13, copy LOW-5: the Agent Log's refused-run line names up to 3
  nodes and counts from 4.
- Review 13, copy LOW-2 and GM r27 item 5: the CLI counts every free run
  once, and a lone local run is "(local)" beside another class.
- GM r26 item 5: Replicate's run-failure line says "token".
"""
from __future__ import annotations

import io
import json
import os
import re
import stat
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from cli.formatter import _cost_line
from tests.conftest import PERSON
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import _person

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
MCP = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": "round14"}
CLI = {"X-Nebula-Agent": "Codex", "X-Nebula-Surface": "cli"}
SHOWN = f"~{os.sep}.nebula{os.sep}settings.json"
PERSON_READ = f"Nebula can’t read {SHOWN}. Fix the file, then try again."
AGENT_READ = f"Nebula can’t read {SHOWN}. Ask the person to fix the file."
SAVE_LINE = f"Nothing was saved because Nebula can’t read {SHOWN}. Fix the file, then try again."


@pytest.fixture
def home_file(sockets, tmp_path, monkeypatch):  # noqa: F811
    """~/.nebula/settings.json under a temp home, holding a readable file."""
    home = tmp_path / "home"
    path = home / ".nebula" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"apiKeys": {"FAL_KEY": "fal-kept-1111"}}), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(path))
    return path


# -- review 13, HIGH-1: `null` fails closed, as before round 13 ----------------------------------


def _writes(client):
    return [client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-new-1111"}}),
            client.put("/api/settings", json={"favorites": []}),
            client.delete("/api/settings/api-keys/FAL_KEY"),
            client.post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111", "check": True}),
            client.post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111"})]


def test_a_null_file_is_no_settings_never_no_file(home_file):
    home_file.write_text("null", encoding="utf-8")
    # Every reader gets what the file holds, as before: no defaults to run with.
    assert settings.load_settings() is None and settings.load_saved_settings() is None
    client = _person()
    assert (client.get("/api/settings").status_code, client.get("/api/settings").json()["detail"]) == (409, PERSON_READ)
    for response in _writes(client):
        assert (response.status_code, response.json()["detail"]) == (409, SAVE_LINE)
    assert home_file.read_text(encoding="utf-8") == "null"


def test_no_file_still_reads_as_the_defaults(home_file):
    home_file.unlink()
    assert settings.load_settings() == {**settings.DEFAULT_SETTINGS, "apiKeys": {}}
    assert _person().get("/api/settings").status_code == 200


@pytest.mark.parametrize("injected,target", [({}, "prompt"), ({"GOOGLE_API_KEY": "AIza-fixture-0000"}, "image")],
                         ids=["browser-free-node", "desktop-keychain-key"])
def test_an_agent_run_fails_closed_on_a_null_file(home_file, monkeypatch, injected, target):
    """A run the gate lets through on a readable file (a free text node; a
    model with its key in the Keychain) doesn't start on a null file: on
    389a7c76 both went through under the default limits (review 13,
    HIGH-1)."""
    monkeypatch.setattr(settings, "_INJECTED_KEYS", injected)
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app, raise_server_exceptions=False) as client:
        client.delete("/api/graph?force=true", headers=PERSON)
        try:
            nodes = {}
            for name, definition, params in (("prompt", "text-input", {"value": "a dune"}), ("image", "nano-banana", {})):
                added = client.post("/api/graph/node", json={"definitionId": definition, "params": params}, headers=PERSON)
                assert added.status_code == 200, added.text
                nodes[name] = added.json()["id"]
            wired = client.post("/api/graph/connect", json={"source": nodes["prompt"], "sourceHandle": "text",
                                                           "target": nodes["image"], "targetHandle": "prompt"},
                                headers=PERSON)
            assert wired.status_code == 200, wired.text
            # On a readable file the same run goes through.
            home_file.write_text("{}", encoding="utf-8")
            readable = client.post("/api/graph/run", json={"targetNodeId": nodes[target]}, headers=MCP)
            assert readable.status_code == 200 and readable.json().get("status") != "failed", readable.text
            home_file.write_text("null", encoding="utf-8")
            refused = client.post("/api/graph/run", json={"targetNodeId": nodes[target]}, headers=MCP)
            assert refused.status_code >= 400 or refused.json().get("status") == "failed", refused.text
        finally:
            home_file.write_text("{}", encoding="utf-8")
            client.delete("/api/graph?force=true", headers=PERSON)


# -- review 13, LOW-3; GM r27 item 3: no permission, or a folder at the path ----------------------


@pytest.mark.unprivileged
def test_a_file_nebula_may_not_read_gets_the_409_never_a_500(home_file):
    home_file.chmod(0)
    try:
        client = TestClient(main.app, headers=PERSON, raise_server_exceptions=False)
        assert (client.get("/api/settings").status_code, client.get("/api/settings").json()["detail"]) == (409, PERSON_READ)
        for response in _writes(client):
            assert (response.status_code, response.json()["detail"]) == (409, SAVE_LINE)
        with pytest.raises(settings.SettingsUnreadable):
            settings.load_settings()
    finally:
        home_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    assert json.loads(home_file.read_text(encoding="utf-8")) == {"apiKeys": {"FAL_KEY": "fal-kept-1111"}}


def test_a_folder_at_the_settings_path_gets_the_409_never_a_500(home_file):
    home_file.unlink()
    home_file.mkdir()
    client = TestClient(main.app, headers=PERSON, raise_server_exceptions=False)
    assert (client.get("/api/settings").status_code, client.get("/api/settings").json()["detail"]) == (409, PERSON_READ)
    for response in _writes(client):
        assert (response.status_code, response.json()["detail"]) == (409, SAVE_LINE)
    assert home_file.is_dir()


@pytest.mark.parametrize("content", ['{"apiKeys": {', "null", "[1, 2]"], ids=["cut-short", "null", "list"])
def test_start_here_says_the_read_line_instead_of_a_500(home_file, content):
    home_file.write_text(content, encoding="utf-8")
    client = TestClient(main.app, raise_server_exceptions=False)
    for headers in (MCP, CLI):
        response = client.get("/api/agent/start", headers=headers)
        assert response.status_code == 200, response.text
        start = response.json()
        assert start["spend"] == {"note": AGENT_READ, "code": "settings_unreadable"}
        assert start["nodes"]["notes"] == [AGENT_READ] and start["nodes"]["ready"] == 0
    from cli.formatter import format_start
    printed = format_start(start)
    assert f"SPEND: {AGENT_READ}" in printed and f"  {AGENT_READ}" in printed


# -- GM r27 item 2: agents read their own line -----------------------------------------------------


def test_the_read_line_is_worded_for_who_reads_it(home_file):
    home_file.write_text('{"apiKeys": {', encoding="utf-8")
    client = TestClient(main.app)
    assert client.get("/api/settings", headers=PERSON).json()["detail"] == PERSON_READ
    for headers in (MCP, CLI, {}):
        response = client.get("/api/settings", headers=headers)
        assert (response.status_code, response.json()["detail"]) == (409, AGENT_READ)


def test_mcp_get_settings_and_nebula_keys_say_the_agents_line(home_file, monkeypatch):
    import mcp_server
    import project_client
    from cli.client import NebulaClient
    from cli.commands import keys
    from nebula_api import NebulaAPI, NebulaAPIError

    home_file.write_text('{"apiKeys": {', encoding="utf-8")
    app = TestClient(main.app, base_url="http://127.0.0.1:9")
    api = NebulaAPI("http://127.0.0.1:9", client=app)
    monkeypatch.setattr(mcp_server, "_api", lambda: api)
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.get_settings()
    assert refused.value.detail == AGENT_READ
    with pytest.raises(NebulaAPIError):
        project_client.get_settings(api, headers=MCP)

    client = NebulaClient("http://127.0.0.1:9")
    client._client = app
    err = io.StringIO()
    with redirect_stdout(io.StringIO()), redirect_stderr(err), pytest.raises(SystemExit):
        keys.run(client)
    assert err.getvalue().strip() == f"error: {AGENT_READ}"


def test_the_read_lines_come_from_one_place_keyed_by_audience():
    assert main.SETTINGS_UNREADABLE_ON_READ == {
        "person": "Nebula can’t read {path}. Fix the file, then try again.",
        "agent": "Nebula can’t read {path}. Ask the person to fix the file.",
    }
    source = (BACKEND / "main.py").read_text(encoding="utf-8")
    assert source.count("Ask the person to fix the file.") == 1


# -- review 13, LOW-2: no module reload, the path read at each call -------------------------------


def test_the_settings_path_is_read_at_each_call(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(tmp_path / "a.json"))
    assert settings.settings_file() == (tmp_path / "a.json").resolve()
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(tmp_path / "b.json"))
    assert settings.settings_file() == (tmp_path / "b.json").resolve()
    assert not hasattr(settings, "SETTINGS_PATH")


def test_no_test_reloads_the_settings_module_and_main_catches_the_imported_class():
    reloads = re.compile(r"reload\(\s*(settings_mod|_s|settings|settings_service|services\.settings|main_mod|main)\s*\)")
    found = [f"{path.name}:{number}" for path in sorted((BACKEND / "tests").glob("*.py"))
             for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
             if reloads.search(line) and path.name != Path(__file__).name]
    assert found == []
    source = (BACKEND / "main.py").read_text(encoding="utf-8")
    assert "settings_service" not in source
    assert main.SettingsUnreadable is settings.SettingsUnreadable


# -- review 13, LOW-4: "~" only under a real home folder -------------------------------------------


@pytest.mark.parametrize("home", ["/", "", "."], ids=["root", "empty", "relative"])
def test_no_tilde_when_home_is_the_root_or_empty(tmp_path, monkeypatch, home):
    # The file sits under the working folder, which an empty or relative
    # HOME would resolve to.
    monkeypatch.chdir(tmp_path)
    path = tmp_path / "settings.json"
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(path))
    monkeypatch.setenv("HOME", home)
    assert settings.settings_file_shown() == str(path.resolve())


def test_a_tilde_under_a_real_home_folder(tmp_path, monkeypatch):
    (tmp_path / "home").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(tmp_path / "home" / "s.json"))
    assert settings.settings_file_shown() == f"~{os.sep}s.json"
    # A home that isn't a folder (removed, a typo) shortens nothing.
    monkeypatch.setenv("HOME", str(tmp_path / "gone"))
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(tmp_path / "gone" / "s.json"))
    assert settings.settings_file_shown() == str((tmp_path / "gone" / "s.json").resolve())


# -- review 13, NIT-2: `check` is true or false -----------------------------------------------------


@pytest.mark.parametrize("check", [1, "true", "yes", [1], None], ids=["one", "text", "yes", "list", "null"])
def test_check_must_be_a_boolean(sockets, monkeypatch, check):  # noqa: F811
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-injected-0000"})
    response = _person().post("/api/credentials/update",
                              json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111", "check": check})
    assert (response.status_code, response.json()["detail"]) == (422, "check must be true or false")
    assert settings._INJECTED_KEYS == {"OPENAI_API_KEY": "sk-injected-0000"}
    assert _person().post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111",
                                                           "check": False}).json() == {"status": "updated"}


# -- review 13, MEDIUM-1; GM r27 item 1: Krea's connections by their labels -----------------------


def _connection_heads() -> set[str]:
    from services.node_registry import NodeRegistry

    heads: set[str] = set()
    two = 0
    for definition in NodeRegistry().get_all().values():
        for param in definition.get("params") or []:
            if param.get("key") != "_kreaAuth":
                continue
            options = {str(o["value"]): str(o["label"]) for o in param.get("options") or []}
            heads |= {label.split(" · ")[0] for label in options.values()}
            if len(options) == 2:
                two += 1
                assert options == {"api-token": "API key · API balance", "mcp": "Krea account · workspace compute"}
    assert two > 100
    return heads


def test_the_krea_connection_names_are_the_option_labels():
    from handlers.krea import KREA_CONNECTION_DEFINITION, connection_label, connection_name, unset_connection_line

    assert _connection_heads() == {"API key", "Krea account"}
    assert (connection_name("api-token"), connection_name("mcp")) == ("“API key”", "“Krea account”")
    assert connection_label("api-token") == "API key"
    assert unset_connection_line() == "This node’s Krea connection isn’t set. Choose “API key” or “Krea account”."
    from services.node_registry import NodeRegistry
    assert any(p.get("key") == "_kreaAuth" and len(p.get("options") or []) == 2
               for p in NodeRegistry().get_all()[KREA_CONNECTION_DEFINITION]["params"])


def test_every_quoted_connection_is_a_real_label():
    """Every person or agent line that quotes a Krea connection by name
    quotes one the node shows, in the code and the docs alike."""
    heads = _connection_heads()
    # Round 15 (review 14, copy LOW-3): any quoted name, curly or straight,
    # in a sentence that says "connection" or "Choose" (B7: "Choose “API
    # token” or …"; B8: `Switch to the "API token" connection.`), and the bare
    # phrase "the API token" in agent text.
    quoted = re.compile(r"“([^”{}\n]{1,40})”|\"([^\"{}\n]{1,40})\"")
    sentence = re.compile(r"[^.!?\n]*(?:connection|Choose)[^.!?\n]*", re.IGNORECASE)
    krea_words = re.compile(r"\b(API (key|token)|Krea (account|plan))\b", re.IGNORECASE)
    found: list[str] = []
    for root, suffixes in ((BACKEND, (".py",)), (REPO / "frontend" / "src", (".ts", ".tsx")), (REPO / "docs", (".md",))):
        for path in root.rglob("*"):
            if path.suffix not in suffixes or ".venv" in path.parts or "notes" in path.parts or "tests" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for said in sentence.findall(text):
                for name in (curly or straight for curly, straight in quoted.findall(said)):
                    if krea_words.search(name) and name not in heads:
                        found.append(f"{path.relative_to(REPO)}: “{name}”")
            if path.suffix == ".py" and re.search(r"\bthe API token\b(?! balance)", text):
                found.append(f"{path.relative_to(REPO)}: says “the API token”")
    assert found == []
    # The billing value the bar shows for the API key's connection.
    bar = (REPO / "frontend" / "src" / "lib" / "canvasProposals.ts").read_text(encoding="utf-8")
    assert "'api-token': 'API balance'" in bar and "API token balance" not in bar


def test_the_out_of_compute_reason_names_the_api_key_connection():
    from services.krea_mcp_generation import _balance_reason

    reason = _balance_reason({"status": 402, "availableUnits": 0})
    assert "switch this node to the “API key” connection" in reason
    assert "→" not in reason and "API token" not in reason


# -- review 13, copy LOW-5: the Agent Log's refused-run line, by the shared rule ----------------


@pytest.mark.parametrize("count,line", [
    # GM, PR #203 r29 item 3: the card's heading, same-named nodes merged.
    (3, "Nebula couldn’t start the run. 3 “GPT Image 2” nodes need your OpenAI API key. "
        "Add it in Settings, then run the nodes again."),
    (4, "Nebula couldn’t start the run. 4 nodes can’t run here yet."),
], ids=["three-named", "four-counted"])
def test_the_agent_logs_refused_run_line_names_up_to_3_and_counts_from_4(monkeypatch, agent_log, count, line):  # noqa: F811
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            prompt = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "x"}}).json()["id"]
            images = []
            for _ in range(count):
                image = client.post("/api/graph/node", json={"definitionId": "gpt-image-2-generate", "params": {}}).json()["id"]
                client.post("/api/graph/connect", json={"source": prompt, "sourceHandle": "text",
                                                        "target": image, "targetHandle": "prompt"})
                images.append(image)
            client.post("/api/graph/run", json={}, headers=MCP)
            [said] = [text for text in agent_log if text.startswith("Nebula couldn’t start the run.")]
            assert said == line
            assert "can't" not in said
        finally:
            client.delete("/api/graph?force=true")


def test_the_backend_and_frontend_share_the_count_rule():
    from execution.person_line import NAMED_AT_MOST, counts_instead

    source = (REPO / "frontend" / "src" / "lib" / "errorCopy.ts").read_text(encoding="utf-8")
    assert f"export const NAMED_AT_MOST = {NAMED_AT_MOST};" in source
    assert (counts_instead(3), counts_instead(4)) == (False, True)


# -- review 13, copy LOW-2; GM r27 item 5: every free run counted once ----------------------------


def _entry(kind, provider=None, label=None, **extra):
    return {"ref": f"+{kind}{provider}", "nodeId": None, "kind": kind, "provider": provider,
            "label": label or kind, **extra}


LOCAL = "free · runs locally"


@pytest.mark.parametrize("cost,line", [
    ({"paidRuns": 1, "freeRuns": 1, "nodes": [_entry("paid", "openai"), _entry("free", None, LOCAL)]},
     "1 paid run (openai) and 1 free (local), no list price"),
    # A free entry with no place runs locally: counted, never dropped.
    ({"paidRuns": 0, "freeRuns": 2, "nodes": [_entry("free", "fal", "free · fal.ai"), _entry("free", None, "free")]},
     "2 free runs (1 fal, 1 local)"),
    ({"paidRuns": 1, "freeRuns": 2, "nodes": [_entry("paid", "openai"), _entry("free", "fal", "free · fal.ai"),
                                               _entry("free", None, "free")]},
     "1 paid run (openai) and 2 free (1 fal, 1 local), no list price"),
    # Alone and local: said in words, as before.
    ({"paidRuns": 0, "freeRuns": 1, "nodes": [_entry("free", None, LOCAL)]}, "1 free run (runs locally)"),
    # An older backend's cost, with no entry for each free run: no tag by place.
    ({"paidRuns": 1, "freeRuns": 2, "providers": ["openai"], "nodes": [_entry("paid", "openai")]},
     "1 paid run (openai) and 2 free, no list price"),
], ids=["lone-local", "no-place", "mixed", "alone", "older-backend"])
def test_every_free_run_is_counted_once(cost, line):
    assert _cost_line(cost) == line
