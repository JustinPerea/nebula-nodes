"""PR #203 round 15: GM r28 and r29, review 14.

- Item 4: a settings file Nebula can read but isn't allowed to change gets a
  409 with the code ``settings_unwritable`` and GM's line, by who asked,
  never a 500: the file read-only, its folder read-only (a save writes a temp
  file there and renames it over the file), or either one turning read-only
  between the read and the write. Every write: PUT and DELETE settings, and
  the desktop's credentials/update with and without ``check``. The read
  failures carry codes too, so the client picks its line by the code.
- Item 1: Vertex's key is the "Vertex AI service account key", from the one
  noun source, and no person line says "Google Cloud credentials".
"""
from __future__ import annotations

import errno
import io
import json
import os
import stat
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
import services.settings as settings
from execution import person_line
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, api  # noqa: F401 - fixture
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture
from tests.test_idol_round10 import sockets  # noqa: F401 - fixture
from tests.test_idol_round12 import _person

BACKEND = Path(__file__).resolve().parents[1]
MCP = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Agent-Session": "round15"}
SHOWN = f"~{os.sep}.nebula{os.sep}settings.json"
PERSON_LINE = (f"Nothing was saved because Nebula isn’t allowed to change {SHOWN}. "
               "Check the file’s permissions, then try again.")
AGENT_LINE = (f"Nothing was saved because Nebula isn’t allowed to change {SHOWN}. "
              "Ask the person to check the file’s permissions.")
SAVED = {"apiKeys": {"FAL_KEY": "fal-kept-1111"}, "favorites": ["nano-banana"]}


@pytest.fixture
def home_file(sockets, tmp_path, monkeypatch):  # noqa: F811
    """~/.nebula/settings.json under a temp home, readable and writable;
    the file and its folder are made writable again after each test, so
    tmp_path can be cleaned."""
    home = tmp_path / "home"
    path = home / ".nebula" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(SAVED), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(path))
    yield path
    path.parent.chmod(0o755)
    if path.exists():
        path.chmod(0o644)


def _writes(client):
    return {
        "put key": client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-new-1111"}}),
        "put setting": client.put("/api/settings", json={"favorites": []}),
        "delete key": client.delete("/api/settings/api-keys/FAL_KEY"),
        "check": client.post("/api/credentials/update",
                             json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111", "check": True}),
        "update": client.post("/api/credentials/update", json={"provider": "OPENAI_API_KEY", "key": "sk-new-1111"}),
    }


def _refused(response) -> tuple[int, str, str | None]:
    body = response.json()
    return response.status_code, body.get("detail"), body.get("code")


# -- item 4: the file read-only ----------------------------------------------------------------


@pytest.mark.unprivileged
def test_a_read_only_file_refuses_every_write_with_the_persons_line_and_a_code(home_file):
    before = home_file.read_bytes()
    home_file.chmod(0o444)
    client = _person()
    for name, response in _writes(client).items():
        assert _refused(response) == (409, PERSON_LINE, "settings_unwritable"), name
    assert home_file.read_bytes() == before
    # The person's GET still reads it: a file Nebula can read is no read failure.
    read = client.get("/api/settings")
    assert read.status_code == 200 and read.json()["favorites"] == ["nano-banana"]


@pytest.mark.unprivileged
def test_the_desktop_path_refuses_too_and_keeps_the_running_keys(home_file, monkeypatch):
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-desktop-0000"})
    home_file.chmod(0o444)
    client = _person()
    for body in ({"provider": "OPENAI_API_KEY", "key": "sk-new-1111", "check": True},
                 {"provider": "OPENAI_API_KEY", "key": "sk-new-1111"}):
        assert _refused(client.post("/api/credentials/update", json=body)) == (409, PERSON_LINE, "settings_unwritable")
    assert _refused(client.put("/api/settings", json={"favorites": []})) == (409, PERSON_LINE, "settings_unwritable")
    assert settings._INJECTED_KEYS == {"OPENAI_API_KEY": "sk-desktop-0000"}


# -- item 4: the folder read-only, where the save writes its temp file ----------------------------


@pytest.mark.unprivileged
def test_a_read_only_folder_refuses_the_save_that_writes_a_temp_file_and_renames_it(home_file):
    before = home_file.read_bytes()
    home_file.parent.chmod(0o555)
    client = _person()
    for name, response in _writes(client).items():
        assert _refused(response) == (409, PERSON_LINE, "settings_unwritable"), name
    home_file.parent.chmod(0o755)
    assert home_file.read_bytes() == before
    assert sorted(p.name for p in home_file.parent.iterdir()) == ["settings.json"]


# -- item 4: read-only between the read and the write ---------------------------------------------


@pytest.mark.unprivileged
@pytest.mark.parametrize("what", ["file", "folder"])
def test_a_file_or_folder_that_turns_read_only_after_the_read_is_refused_at_the_write(home_file, monkeypatch, what):
    before = home_file.read_bytes()
    real = main._saved_settings_or_409

    def read_then_lock():
        current = real()
        (home_file if what == "file" else home_file.parent).chmod(0o444 if what == "file" else 0o555)
        return current

    monkeypatch.setattr(main, "_saved_settings_or_409", read_then_lock)
    client = _person()
    for response in (client.put("/api/settings", json={"favorites": []}), client.delete("/api/settings/api-keys/FAL_KEY")):
        assert _refused(response) == (409, PERSON_LINE, "settings_unwritable")
        home_file.chmod(0o644)
        home_file.parent.chmod(0o755)
    assert home_file.read_bytes() == before
    assert sorted(p.name for p in home_file.parent.iterdir()) == ["settings.json"]


def test_a_rename_refused_by_the_filesystem_is_the_same_409_and_leaves_no_temp_file(home_file, monkeypatch):
    """A read-only filesystem (EROFS) at the rename: no chmod, so as root too."""
    before = home_file.read_bytes()

    def refuse(_src, _dst):
        raise OSError(errno.EROFS, "Read-only file system")

    monkeypatch.setattr(settings.os, "replace", refuse)
    assert _refused(_person().put("/api/settings", json={"favorites": []})) == (409, PERSON_LINE, "settings_unwritable")
    assert home_file.read_bytes() == before
    assert sorted(p.name for p in home_file.parent.iterdir()) == ["settings.json"]


def test_a_failure_that_is_not_about_permission_is_not_called_one(home_file, monkeypatch):
    def full(_src, _dst):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(settings.os, "replace", full)
    with pytest.raises(OSError) as raised:
        settings.save_settings({"favorites": []})
    assert not isinstance(raised.value, settings.SettingsUnwritable)
    assert sorted(p.name for p in home_file.parent.iterdir()) == ["settings.json"]


def test_a_save_replaces_the_file_whole_and_keeps_its_mode(home_file):
    home_file.chmod(0o640)
    settings.save_settings({"favorites": ["a"]})
    assert json.loads(home_file.read_text(encoding="utf-8")) == {"favorites": ["a"]}
    assert stat.S_IMODE(home_file.stat().st_mode) == 0o640
    home_file.unlink()
    settings.save_settings({"favorites": []})
    # A new file holds keys: this user's only.
    assert stat.S_IMODE(home_file.stat().st_mode) == 0o600


def test_a_writable_file_still_saves(home_file):
    response = _person().put("/api/settings", json={"favorites": []})
    assert response.status_code == 200, response.text
    assert json.loads(home_file.read_text(encoding="utf-8"))["favorites"] == []


# -- item 4: agents' line, and the table keyed by audience -------------------------------------------


def test_the_write_lines_come_from_one_table_keyed_by_audience():
    assert main.SETTINGS_UNWRITABLE == {
        "person": "Nothing was saved because Nebula isn’t allowed to change {path}. "
                  "Check the file’s permissions, then try again.",
        "agent": "Nothing was saved because Nebula isn’t allowed to change {path}. "
                 "Ask the person to check the file’s permissions.",
    }


@pytest.mark.parametrize("person,line", [(True, PERSON_LINE), (False, AGENT_LINE)], ids=["person", "agent"])
def test_the_refusal_says_the_line_for_who_asked(home_file, monkeypatch, person, line):
    monkeypatch.setattr(main.refusal_copy, "person_reads", lambda *args: person)
    refusal = main._settings_refusal(main.SETTINGS_UNWRITABLE, main.SETTINGS_UNWRITABLE_CODE)
    fix = (f"Check the permissions of {SHOWN}, then try again." if person
           else f"Ask the person to check the permissions of {SHOWN}.")
    assert (refusal.status_code, refusal.detail, refusal.fields) == (409, line, {"code": "settings_unwritable", "fix": fix})


def test_an_agent_cant_write_settings_at_all_so_meets_the_person_gate_first(home_file):
    for name, response in _writes(TestClient(main.app, headers=MCP)).items():
        assert response.status_code == 403, name
        assert "allowed to change" not in json.dumps(response.json())


@pytest.mark.unprivileged
def test_mcp_get_settings_and_nebula_keys_read_a_read_only_file_as_it_is(home_file, monkeypatch):
    """Agents only read settings: a file Nebula may read but not change reads
    as usual on MCP get_settings and `nebula keys`, with no write line."""
    import mcp_server
    from cli.client import NebulaClient
    from cli.commands import keys
    from nebula_api import NebulaAPI

    home_file.chmod(0o444)
    app = TestClient(main.app, base_url="http://127.0.0.1:9")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://127.0.0.1:9", client=app))
    assert mcp_server.get_settings()["configured"] == {"FAL_KEY": True}
    client = NebulaClient("http://127.0.0.1:9")
    client._client = app
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        keys.run(client)
    assert err.getvalue() == "" and "allowed to change" not in out.getvalue()


# -- item 4: the read failures carry their code ----------------------------------------------------


def test_every_settings_refusal_carries_a_code_beside_its_line(home_file):
    client = _person()
    home_file.write_text('{"apiKeys": {', encoding="utf-8")
    assert _refused(client.get("/api/settings"))[::2] == (409, "settings_unreadable")
    for name, response in _writes(client).items():
        assert _refused(response)[::2] == (409, "settings_unreadable"), name
    home_file.write_text(json.dumps({"apiKeys": ["sk-a"]}), encoding="utf-8")
    assert _refused(client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-new-1111"}}))[::2] \
        == (409, "keys_unreadable")
    assert _refused(client.delete("/api/settings/api-keys/FAL_KEY"))[::2] == (409, "keys_unreadable")


# -- item 1: Vertex says "key", from the one noun source --------------------------------------------


def test_vertex_is_a_service_account_key_in_every_line():
    assert person_line.key_line(["GOOGLE_VERTEX_CREDENTIALS"]) == \
        "Add your Vertex AI service account key in Settings, then run the node again."
    assert person_line.key_line(["GOOGLE_VERTEX_CREDENTIALS", "GOOGLE_API_KEY"]) == \
        "Add your Vertex AI service account key or Gemini API key in Settings, then run the node again."
    # Only the Settings row says "Google ·" in front (providerCatalog).
    assert not person_line.key_phrase(["GOOGLE_VERTEX_CREDENTIALS"]).startswith("Google")


def test_no_person_line_says_google_cloud_credentials_or_vertex_credentials():
    for path in (BACKEND / "handlers" / "veo.py", BACKEND / "services" / "google_vertex.py",
                 BACKEND / "services" / "gemini_cli_setup.py", BACKEND / "execution" / "person_line.py"):
        text = path.read_text(encoding="utf-8")
        assert "Google Cloud credentials" not in text, path
        assert "Vertex AI credentials" not in text, path


def test_the_key_file_lines_name_the_service_account_key():
    from services import google_vertex
    for raw in ("not json", json.dumps({"type": "user"}), json.dumps({"type": "service_account"})):
        with pytest.raises(google_vertex.VertexCredentialsError) as raised:
            google_vertex.parse_service_account(raw)
        line = getattr(raised.value, "nebula_person_line", "")
        assert "Vertex AI service account key" in line and "credentials" not in line, line


# -- review 14, settings-gate: the file's states ------------------------------------------------


def _gate_states(client) -> tuple[int, int, int]:
    """GET /api/settings, start_here and the spend route's statuses."""
    return (client.get("/api/settings").status_code, client.get("/api/agent/start", headers=MCP).status_code,
            client.get("/api/agent/spend", headers=MCP).status_code)


def test_a_folder_on_the_way_that_is_a_file_reads_as_no_file_as_before_round_14(tmp_path, monkeypatch, sockets):  # noqa: F811
    """HIGH-1: ENOTDIR is "the file isn't there", as exists() said before
    round 14: defaults, and the gate's reach is what it was."""
    parent = tmp_path / "f"
    parent.write_text("a file, not a folder", encoding="utf-8")
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(parent / "settings.json"))
    assert settings.load_settings() == {**settings.DEFAULT_SETTINGS, "apiKeys": {}}
    assert settings.load_saved_settings() == settings.DEFAULT_SETTINGS
    assert _person().get("/api/settings").status_code == 200


@pytest.mark.parametrize("content", ["null", "[]", '"x"', "0", "true"])
def test_on_desktop_a_file_that_isnt_an_object_gets_the_read_line_never_a_500(home_file, monkeypatch, content):
    """MEDIUM-1: the injected keys no longer meet a non-object (a TypeError,
    a 500). GET, every write, start_here and spend answer as in the browser."""
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"GOOGLE_API_KEY": "AIza-fixture-0000"})
    home_file.write_text(content, encoding="utf-8")
    client = TestClient(main.app, raise_server_exceptions=False, headers=PERSON)
    assert _refused(client.get("/api/settings"))[::2] == (409, "settings_unreadable")
    for name, response in _writes(client).items():
        if name == "delete key":  # the desktop removes through the credential bridge, as before
            assert response.status_code == 409 and "credential bridge" in response.json()["detail"], name
            continue
        assert _refused(response)[::2] == (409, "settings_unreadable"), name
    clear = client.post("/api/credentials/update", json={"provider": "GOOGLE_API_KEY", "key": ""})
    assert _refused(clear)[::2] == (409, "settings_unreadable")
    start = client.get("/api/agent/start", headers=MCP)
    assert start.status_code == 200 and start.json()["spend"]["code"] == "settings_unreadable"
    spend = client.get("/api/agent/spend", headers=MCP)
    assert spend.status_code == 200 and spend.json()["code"] == "settings_unreadable"
    assert home_file.read_text(encoding="utf-8") == content


def test_the_spend_route_says_the_agents_read_line_through_mcp_and_the_cli(home_file, monkeypatch):
    """LOW-2: GET /api/agent/spend answered 500 on a file Nebula can't read
    (or the default limits for a non-object). Now it says what start_here
    says, with the same status and code."""
    import mcp_server
    from cli.client import NebulaClient
    from cli.commands import spend
    from nebula_api import NebulaAPI

    home_file.write_text('{"apiKeys": {', encoding="utf-8")
    line = f"Nebula can’t read {SHOWN}. Ask the person to fix the file."
    app = TestClient(main.app, base_url="http://127.0.0.1:9")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://127.0.0.1:9", client=app))
    assert mcp_server.get_spend_limits() == {"note": line, "code": "settings_unreadable"}
    client = NebulaClient("http://127.0.0.1:9")
    client._client = app
    out = io.StringIO()
    with redirect_stdout(out):
        spend.run(client)
    assert out.getvalue().strip() == f"Spending limits: {line}"
    home_file.write_text("[]", encoding="utf-8")
    assert mcp_server.get_spend_limits()["code"] == "settings_unreadable"


def test_a_symlink_loop_is_a_file_nebula_cant_read_everywhere(tmp_path, monkeypatch, sockets):  # noqa: F811
    """LOW-3: resolve() raised outside every handler, a 500 everywhere."""
    loop = tmp_path / "loop.json"
    loop.symlink_to(loop)
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(loop))
    client = TestClient(main.app, raise_server_exceptions=False, headers=PERSON)
    line = f"Nebula can’t read {loop}. Fix the file, then try again."
    assert _refused(client.get("/api/settings")) == (409, line, "settings_unreadable")
    for name, response in _writes(client).items():
        assert _refused(response)[::2] == (409, "settings_unreadable"), name
    assert client.get("/api/agent/start", headers=MCP).json()["spend"]["code"] == "settings_unreadable"
    assert client.get("/api/agent/spend", headers=MCP).status_code == 200
    assert settings.settings_file_shown() == str(loop)


def test_a_broken_symlink_reads_as_no_file_and_a_save_writes_through_it(tmp_path, monkeypatch, sockets):  # noqa: F811
    """NIT-1: as before, and pinned now."""
    target = tmp_path / "real" / "settings.json"
    target.parent.mkdir()
    link = tmp_path / "linked-settings.json"
    link.symlink_to(target)
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(link))
    client = _person()
    assert client.get("/api/settings").status_code == 200
    assert client.put("/api/settings", json={"favorites": ["a"]}).status_code == 200
    assert link.is_symlink() and json.loads(target.read_text(encoding="utf-8"))["favorites"] == ["a"]


def test_a_symlink_to_a_folder_is_named_as_configured(tmp_path, monkeypatch, sockets):  # noqa: F811
    """NIT-2: the line names the settings path, never the folder it points to."""
    folder = tmp_path / "adir"
    folder.mkdir()
    link = tmp_path / "linked-settings.json"
    link.symlink_to(folder)
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(link))
    assert _person().get("/api/settings").json()["detail"] == f"Nebula can’t read {link}. Fix the file, then try again."


def test_an_empty_settings_path_is_unset(monkeypatch):
    """NIT-3: "" is the default path, never the working folder."""
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", "")
    assert settings.settings_path() == settings._DEFAULT_SETTINGS_PATH
    monkeypatch.delenv("NEBULA_SETTINGS_PATH")
    assert settings.settings_path() == settings._DEFAULT_SETTINGS_PATH


@pytest.mark.parametrize("headers,audience", [
    (PERSON, "person"),
    ({"Origin": "http://localhost:5173"}, "person"),                                        # a tab, no token
    ({"Origin": "http://localhost:5173", "X-Nebula-Person": "a-token-from-before"}, "person"),  # a stale token
    ({"Sec-Fetch-Site": "same-origin"}, "person"),
    (MCP, "agent"),
    ({"X-Nebula-Agent": "Codex", "X-Nebula-Surface": "cli"}, "agent"),
    ({}, "agent"),
], ids=["person", "tab-no-token", "tab-stale-token", "fetch-site", "mcp", "cli", "bare"])
def test_every_browser_tab_reads_the_persons_line(home_file, headers, audience):
    """LOW-1 and GM r29 item 5: the words by refusal_copy.person_reads."""
    home_file.write_text('{"apiKeys": {', encoding="utf-8")
    line = main.SETTINGS_UNREADABLE_ON_READ[audience].format(path=SHOWN)
    assert TestClient(main.app).get("/api/settings", headers=headers).json()["detail"] == line


# -- GM r29 item 7: saving the same key again is safe -----------------------------------------------


def test_saving_the_same_key_again_changes_nothing_the_second_time(home_file, monkeypatch):
    sent: list[dict] = []

    async def heard(message):
        sent.append(message)

    monkeypatch.setattr(main.manager, "broadcast_browser", heard)
    client = _person()
    assert client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-same-1111"}}).status_code == 200
    first = home_file.read_bytes()
    assert client.put("/api/settings", json={"apiKeys": {"OPENAI_API_KEY": "sk-same-1111"}}).status_code == 200
    assert home_file.read_bytes() == first
    assert [m["keys"] for m in sent if m.get("type") == "settingsChanged"] == [["OPENAI_API_KEY"], []]
    # The desktop path: the running key is the same, and nothing is said changed.
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-desk-2222"})
    sent.clear()
    for _ in range(2):
        assert client.post("/api/credentials/update",
                           json={"provider": "OPENAI_API_KEY", "key": "sk-desk-3333"}).status_code == 200
    assert settings._INJECTED_KEYS == {"OPENAI_API_KEY": "sk-desk-3333"}
    assert [m["keys"] for m in sent if m.get("type") == "settingsChanged"] == [["OPENAI_API_KEY"], []]


# -- review 14, copy MEDIUM-1 and LOW-1: every not-ready line names the node, from one table -------


def test_every_not_ready_line_starts_with_the_quoted_name_and_the_table_is_current():
    import importlib.util

    spec = importlib.util.spec_from_file_location("gen", BACKEND.parent / "scripts" / "generate-not-ready-reasons.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    built = gen.build()
    assert (BACKEND / "tests" / "fixtures" / "not_ready_reasons.json").read_text(encoding="utf-8") == built
    reasons = json.loads(built)["reasons"]
    assert len(reasons) > 40
    for reason in reasons:
        assert reason["line"] == f"“{reason['name']}” {reason['one']}", reason
        assert reason["many"] != reason["one"] or reason["one"].startswith("can't run on"), reason
        assert "Add its key" not in reason["one"] and "doesn't have" not in reason["one"], reason


def test_route_table_auto_with_no_key_names_the_node():
    """MEDIUM-1 and GM r29 item 1; the card keeps its run line."""
    from services import node_readiness, node_route
    from services.node_registry import NodeRegistry

    definitions = NodeRegistry().get_all()
    flux = definitions["flux-2-pro"]
    assert node_readiness.instance_missing_line(flux, {}, [], False, definitions, name="FLUX.2") == \
        "“FLUX.2” needs your Black Forest Labs or fal.ai API key. Add one in Settings."
    assert node_route.route_unavailable_line(flux, {}, {}) == \
        "Add your Black Forest Labs or fal.ai API key in Settings, then run the node again."


def test_merged_not_ready_lines_and_the_run_again_ending():
    reason = person_line.NotReadyReason.of("key", phrase="OpenAI API key", it="it")
    plan = person_line.NotReadyReason.of("krea_plan")
    lines = person_line.merged_not_ready([("GPT Image 2", reason), ("GPT Image 2", reason), ("Krea 2", plan),
                                          ("Writer", reason)])
    assert lines == [("2 “GPT Image 2” nodes and “Writer” need your OpenAI API key. Add it in Settings.", 3),
                     ("“Krea 2” needs your Krea plan. Sign in to Krea in Settings.", 1)]
    assert person_line.run_again(lines[0][0], 3).endswith("Add it in Settings, then run the nodes again.")
    assert person_line.run_again(lines[1][0], 1).endswith("Sign in to Krea in Settings, then run the node again.")
    own = person_line.NotReadyReason(own="You can run “Idol” after you add your Hugging Face token in Settings.")
    assert person_line.merged_not_ready([("Idol", own), ("Idol", own)]) == [(own.own, 1), (own.own, 1)]


# -- review 14, copy MEDIUM-2: the Agent Log merges by the bar's rule -------------------------------


@pytest.mark.parametrize("definitions,line", [
    (["gpt-image-2-generate", "gpt-image-2-generate", "openai-tts"],
     "Nebula couldn’t start the run. 2 “GPT Image 2” nodes and “OpenAI TTS” need your OpenAI API key. "
     "Add it in Settings, then run the nodes again."),
    (["gpt-image-2-generate", "gpt-image-2-generate", "claude-chat"],
     "Nebula couldn’t start the run. 2 “GPT Image 2” nodes need your OpenAI API key. Add it in Settings, then run "
     "the nodes again. “Claude” needs your Anthropic API key. Add it in Settings, then run the node again."),
], ids=["same-reason-two-names", "two-reasons"])
def test_the_agent_log_merges_names_with_one_reason(monkeypatch, agent_log, definitions, line):  # noqa: F811
    from unittest.mock import AsyncMock

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            prompt = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "x"}}).json()["id"]
            for definition in definitions:
                node = client.post("/api/graph/node", json={"definitionId": definition, "params": {}}).json()["id"]
                handle = {"openai-tts": "text", "claude-chat": "messages"}.get(definition, "prompt")
                client.post("/api/graph/connect", json={"source": prompt, "sourceHandle": "text",
                                                        "target": node, "targetHandle": handle})
            client.post("/api/graph/run", json={}, headers=MCP)
            [said] = [text for text in agent_log if text.startswith("Nebula couldn’t start the run.")]
            assert said == line
        finally:
            client.delete("/api/graph?force=true")


# -- review 14, copy NIT-3: the CLI's free part when entries outnumber the count ---------------------


def test_the_cli_tags_no_free_run_when_the_entries_dont_match_the_count():
    from cli.formatter import _cost_line

    entries = [{"ref": "+a", "nodeId": None, "kind": "free", "label": "free · runs locally"},
               {"ref": "+b", "nodeId": None, "kind": "free", "label": "free · fal.ai", "provider": "fal"}]
    cost = {"paidRuns": 0, "freeRuns": 1, "providers": [], "estimate": None, "nodes": entries}
    assert _cost_line(cost) == "1 free run"
    assert _cost_line({**cost, "freeRuns": 2}) == "2 free runs (1 fal, 1 local)"


def test_a_proposals_not_ready_rows_carry_the_reason_the_bar_merges_by(api, monkeypatch):  # noqa: F811
    """The bar merges by `reason` (review 14, copy LOW-1): each row sends the
    line without the name, for one node and for several."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    text = api.graph.add_node("text-input", {"value": "a cat"})
    response = api.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "an image and a voice-over",
        "nodes": [{"ref": "+g", "definitionId": "gpt-image-2-generate"}, {"ref": "+t", "definitionId": "openai-tts"}],
        "edges": [{"source": text, "sourceHandle": "text", "target": "+g", "targetHandle": "prompt"},
                  {"source": text, "sourceHandle": "text", "target": "+t", "targetHandle": "text"}],
        "run": ["+g", "+t"]})
    assert response.status_code == 201, response.text
    rows = response.json()["proposal"]["cost"]["notReady"]
    reason = {"one": "needs your OpenAI API key. Add it in Settings.", "many": "need your OpenAI API key. Add it in Settings."}
    assert [(row["person"], row["reason"]) for row in rows] == [
        ("“GPT Image 2” needs your OpenAI API key. Add it in Settings.", reason),
        ("“OpenAI TTS” needs your OpenAI API key. Add it in Settings.", reason)]


def test_a_route_table_node_on_auto_says_its_routes_own_keys():
    """The route's own missing keys, for a list that names the node (GM r29
    item 1), never None for a key it can name."""
    from services import node_route
    from services.node_registry import NodeRegistry

    flux = NodeRegistry().get_all()["flux-2-pro"]
    reason = node_route.route_unavailable_reason(flux, {}, {})
    assert (reason.one, reason.many) == (
        "needs your Black Forest Labs or fal.ai API key. Add one in Settings.",
        "need your Black Forest Labs or fal.ai API key. Add one in Settings.")
    assert node_route.route_unavailable_reason(flux, {}, {"FAL_KEY": "set"}) is None
