"""The `nebula` CLI twins of #121's MCP tools: `nebula project rename`,
`nebula project show`, `nebula trash list --scope/--project`, `nebula keys`
(get_settings) and `nebula providers` (provider_status).

Justin (2026-10-20): "Every feature we add needs to make sure we include MCP
support for agents", and each MCP tool has its `nebula` twin where the CLI
covers the area. Each command is a thin client of the route its MCP tool
uses, through the same shaping code, so `--json` equals the tool's result.

The CLI runs as an agent does (`nebula --url ... <command>`, NEBULA_AGENT_NAME
set) against the app in-process, with the MCP test's isolated stores
(tests/test_mcp_projects_and_reads.py's `nebula` fixture). Every output is
scanned for the test keys: the CLI never has the person token, so it never
prints any part of a key (Justin, Q55 a: "Only the app (your person token)
gets the endings. Everything else learns which providers are set, and
nothing more").
"""
from __future__ import annotations

import io
import json
import shlex
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from uuid import uuid4

import pytest

import mcp_server
from cli.__main__ import main
from cli.client import NebulaClient
from tests.test_mcp_projects_and_reads import (  # noqa: F401 (the fixture is used by name)
    FAL_KEY,
    OPENAI_KEY,
    _no_key,
    _revision,
    _save,
    nebula,
)

AGENT = "Claude Code"
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def cli(nebula, monkeypatch):
    """`nebula` against the same in-process app the MCP tools reach."""
    http = nebula["http"]
    real_init = NebulaClient.__init__

    def init(self, base_url="http://testserver"):
        real_init(self, "http://testserver")
        self._client = http

    monkeypatch.setattr(NebulaClient, "__init__", init)
    monkeypatch.setenv("NEBULA_AGENT_NAME", AGENT)
    return nebula


def _run(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = 0
    old = sys.argv
    sys.argv = ["nebula", "--url", "http://testserver", *argv]
    try:
        with redirect_stdout(out), redirect_stderr(err):
            main()
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
    finally:
        sys.argv = old
    _no_key(out.getvalue())
    _no_key(err.getvalue())
    return code, out.getvalue(), err.getvalue()


def _json(argv: list[str]):
    code, out, err = _run(argv)
    assert code == 0, err
    return json.loads(out)


def _names() -> dict[str, str]:
    return {row["id"]: row["name"] for row in mcp_server.list_projects()["projects"]}


# -- nebula project rename ---------------------------------------------------------

def test_project_rename_prints_what_changed_journals_the_agent_and_its_hint_renames_back(cli):
    first = mcp_server.new_project("Moodboards for Ana")["project"]
    mcp_server.new_project("Second")
    cursor = mcp_server.look_at_canvas()["events"]["cursor"]

    code, out, err = _run(["project", "rename", first["id"], "Ana:", "spring", "looks"])
    assert code == 0, err
    assert f'Renamed {first["id"]}: "Moodboards for Ana" → "Ana: spring looks"' in out
    assert _names()[first["id"]] == "Ana: spring looks"
    [event] = mcp_server.wait_for_canvas_change(since=cursor, kinds=["project.renamed"], include_self=True,
                                                 timeout_seconds=1)["events"]
    assert event["actor"]["kind"] == "agent" and event["actor"]["name"] == AGENT
    assert (event["data"]["from"], event["data"]["to"]) == ("Moodboards for Ana", "Ana: spring looks")

    # The line it prints to undo is a real command that puts the old name back.
    [hint] = [line for line in out.splitlines() if "puts the old name back" in line]
    undo = hint.split("`")[1]
    assert undo == f"nebula project rename {first['id']} 'Moodboards for Ana'"
    code, out, err = _run(shlex.split(undo)[1:])
    assert code == 0, err
    assert _names()[first["id"]] == "Moodboards for Ana"

    # "current" is the project open on the canvas.
    code, out, _ = _run(["project", "rename", "current", "Second, renamed"])
    assert code == 0 and '"Second" → "Second, renamed"' in out
    # The same name again changes nothing and says so.
    code, out, _ = _run(["project", "rename", "current", "Second, renamed"])
    assert code == 0 and "already named" in out


@pytest.mark.parametrize("old", ["-draft", "--draft", "-x", "-", "-v2 draft", "Moodboards for Ana", "Before"])
def test_the_printed_undo_command_parses_back_to_the_old_name(old):
    """Review: shlex.quote leaves a lone `-draft` bare, and argparse read it as
    an option, so the printed undo exited 2. A name that starts with a dash
    gets `--` before it; any other name prints as before."""
    from cli.__main__ import build_parser
    from project_client import undo_rename_hint

    hint = undo_rename_hint("fddc", old, "cli")
    undo = hint.split("`")[1]
    args = build_parser().parse_args(shlex.split(undo)[1:])
    assert (args.command, args.project_id, " ".join(args.name)) == ("project", "fddc", old)
    assert ("-- " in undo) == old.startswith("-")


def test_project_rename_from_a_dash_name_prints_an_undo_that_works(cli):
    project = mcp_server.new_project("Start")["project"]
    code, out, err = _run(["project", "rename", project["id"], "--", "-draft"])
    assert code == 0, err
    assert _names()[project["id"]] == "-draft"
    code, out, err = _run(["project", "rename", project["id"], "Final"])
    assert code == 0, err
    [hint] = [line for line in out.splitlines() if "puts the old name back" in line]
    undo = hint.split("`")[1]
    assert undo == f"nebula project rename {project['id']} -- -draft"
    code, _, err = _run(shlex.split(undo)[1:])
    assert code == 0, err
    assert _names()[project["id"]] == "-draft"


def test_project_rename_refuses_a_bad_name_and_an_unknown_project(cli):
    project = mcp_server.new_project("Keep me")["project"]
    code, out, err = _run(["project", "rename", project["id"], "   "])
    assert code == 1 and err.startswith("error: ") and not out
    code, _, err = _run(["project", "rename", project["id"], "x" * 121])
    assert code == 1 and err.startswith("error: ")
    code, _, err = _run(["project", "rename", uuid4().hex, "Nope"])
    assert code == 1 and err.startswith("error: ")
    assert _names()[project["id"]] == "Keep me"


def test_project_rename_json_is_rename_projects_result(cli):
    project = mcp_server.new_project("Before")["project"]
    by_cli = _json(["project", "rename", project["id"], "After", "--json"])
    mcp_server.rename_project(project["id"], "Before")
    by_mcp = mcp_server.rename_project(project["id"], "After")
    # Each surface words its undo hint as its own call.
    assert by_cli.pop("note") == f"`nebula project rename {project['id']} Before` puts the old name back."
    assert by_mcp.pop("note") == f"`rename_project('{project['id']}', 'Before')` puts the old name back."
    assert by_cli == by_mcp == {"project": {"id": project["id"], "name": "After"}, "previousName": "Before"}


# -- nebula project show -----------------------------------------------------------

def _seed_show(cli, person) -> dict:
    """A saved, closed project: a universal node configured for a model, a
    Text Input whose error quotes a key, a wire, and one run record whose
    note quotes a key too."""
    from services.model_cache import model_cache

    http = cli["http"]
    model_cache.set("openrouter:models", {"models": [
        {"id": "openai/gpt-4o", "name": "GPT-4o", "input_modalities": ["text", "image"],
         "output_modalities": ["text"]}], "count": 1}, ttl=300)
    project = mcp_server.new_project("Lighthouse")["project"]
    built = mcp_server.edit_canvas(
        nodes=[{"ref": "+p", "definitionId": "text-input", "params": {"value": "a lighthouse at dusk"}},
               {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}}],
        edges=[{"source": "+p", "sourceHandle": "text", "target": "+eye", "targetHandle": "messages"}],
        rename={"+p": "Hero prompt"},
    )
    prompt, eye = built["idMap"]["+p"], built["idMap"]["+eye"]
    looked = mcp_server.look_at_canvas()
    saved = http.get(f"/api/projects/{project['id']}").json()["snapshot"]
    quoted = f"Error code: 401 - Incorrect API key provided: {OPENAI_KEY[:7]}{'*' * 20}{OPENAI_KEY[-4:]} (Key {FAL_KEY})"
    for node in saved["nodes"]:
        if node["id"] == prompt:
            node["data"]["state"] = "error"
            node["data"]["error"] = quoted
    saved["runHistory"] = [{
        "id": "run-1", "trigger": "node", "startedAt": 1_760_000_000_000, "status": "failed",
        "targetNodeId": eye, "durationSec": 1.5, "nodesExecuted": 1, "statusNote": quoted,
        "snapshot": {"nodes": [{"id": prompt}, {"id": eye}], "edges": []},
        "resultOutputs": {prompt: {"text": {"type": "Text", "value": "a lighthouse at dusk"}}},
    }]
    _save(http, project["id"], saved, person)
    return {"project": project, "prompt": prompt, "eye": eye, "looked": looked}


def test_project_show_prints_a_saved_project_as_get_project_reads_it(cli, person):
    from services.model_cache import model_cache

    try:
        seeded = _seed_show(cli, person)
        project, prompt, eye = seeded["project"], seeded["prompt"], seeded["eye"]
        # Its universal node, as `nebula look` showed it while it was open.
        code, look, _ = _run(["look"])
        assert code == 0 and "ports: in messages, images → out text" in look
        mcp_server.new_project("Something else")

        code, out, err = _run(["project", "show", project["id"]])
        assert code == 0, err
        assert out.splitlines()[0].startswith(f"PROJECT Lighthouse ({project['id']}), closed")
        assert f"{prompt:<6}Hero prompt (Text Input) [" in out
        assert "error: Error code: 401 - Incorrect API key provided: " in out
        assert f"{eye:<6}" in out and "ports: in messages, images → out text" in out
        assert f"{prompt}.text → {eye}.messages" in out
        assert "RUN HISTORY (1):" in out and "run-1  failed" in out and f"ran {prompt}, {eye}" in out
        assert "a lighthouse at dusk" not in out.split("RUN HISTORY")[1]  # what a run made stays out
        assert f"nebula project open {project['id']}" in out

        # --json is get_project's result for the same project.
        by_cli = _json(["project", "show", project["id"], "--json"])
        assert by_cli == mcp_server.get_project(project["id"])
        [node] = [node for node in by_cli["nodes"] if node["id"] == eye]
        fields = ("id", "definitionId", "name", "params", "outputs", "inputsFrom", "ports")
        looked = next(node for node in seeded["looked"]["nodes"] if node["id"] == eye)
        assert {key: node.get(key) for key in fields} == {key: looked.get(key) for key in fields}
        # "current" is the open one.
        assert _json(["project", "show", "current", "--json"])["name"] == "Something else"
        code, _, err = _run(["project", "show", uuid4().hex])
        assert code == 1 and err.startswith("error: ")
    finally:
        model_cache.clear()


# -- nebula trash list --scope / --project ------------------------------------------

def test_trash_list_takes_list_trashs_scope_and_project(cli, person):
    http = cli["http"]
    project = mcp_server.new_project("Boards")["project"]
    ids = {}
    for name, scope in (("Theirs", project["id"]), ("Everyone's", None)):
        made = http.post("/api/moodboards", json={"name": name, "projectId": scope}, headers=person.headers)
        assert made.status_code in (200, 201), made.text
        ids[name] = made.json()["id"]
        assert http.delete(f"/api/moodboards/{ids[name]}", headers=person.headers).status_code == 200

    def listed(*flags: str) -> set[str]:
        return {item["id"] for item in _json(["trash", "list", "--kind", "moodboard", *flags, "--json"])["items"]}

    assert listed() >= {ids["Theirs"], ids["Everyone's"]}
    assert ids["Theirs"] in listed("--scope", "project", "--project", project["id"])
    assert ids["Everyone's"] not in listed("--scope", "project", "--project", project["id"])
    # --project alone means that project; "current" is the open one.
    assert ids["Theirs"] in listed("--project", "current")
    assert ids["Theirs"] not in listed("--scope", "global") and ids["Everyone's"] in listed("--scope", "global")
    # MCP's argument name works too.
    assert ids["Theirs"] in listed("--project-id", "current")

    # --json is list_trash's result for the same call.
    for flags, kwargs in ((["--scope", "global"], {"scope": "global"}),
                          (["--project", "current"], {"project_id": "current"}),
                          (["--scope", "project", "--project", project["id"]],
                           {"scope": "project", "project_id": project["id"]})):
        assert _json(["trash", "list", "--kind", "moodboard", *flags, "--json"]) == mcp_server.list_trash(
            kind="moodboard", **kwargs)

    code, out, _ = _run(["trash", "list", "--project", "current"])
    assert code == 0 and "Theirs" in out and "Everyone's" not in out
    assert f"in project Boards ({project['id']})" in out.splitlines()[0]
    code, out, _ = _run(["trash", "list", "--scope", "global", "--kind", "character"])
    assert code == 0 and "Nothing in Recently deleted in Global." in out
    # A project scope needs the project, as the route says.
    code, _, err = _run(["trash", "list", "--scope", "project"])
    assert code == 1 and err.startswith("error: ")


def test_trash_list_scope_global_with_a_project_says_global(cli, person):
    """Review: scope=global ignores the project server-side, so the header
    must say Global, not the project, when both are given."""
    http = cli["http"]
    project = mcp_server.new_project("Alpha")["project"]
    ids = {}
    for name, scope in (("AlphaBoard", project["id"]), ("GlobalBoard", None)):
        made = http.post("/api/moodboards", json={"name": name, "projectId": scope}, headers=person.headers)
        assert made.status_code in (200, 201), made.text
        ids[name] = made.json()["id"]
        assert http.delete(f"/api/moodboards/{ids[name]}", headers=person.headers).status_code == 200

    code, out, err = _run(["trash", "list", "--kind", "moodboard", "--scope", "global", "--project", "current"])
    assert code == 0, err
    assert out.splitlines()[0] == "RECENTLY DELETED in Global (1):"
    assert "GlobalBoard" in out and "AlphaBoard" not in out and "Alpha (" not in out
    # Its --json is list_trash's for the same call.
    assert _json(["trash", "list", "--kind", "moodboard", "--scope", "global", "--project", "current", "--json"]) \
        == mcp_server.list_trash(kind="moodboard", scope="global", project_id="current")
    code, out, _ = _run(["trash", "list", "--kind", "character", "--scope", "global", "--project", "current"])
    assert code == 0 and "Nothing in Recently deleted in Global." in out


# -- nebula keys and nebula providers ------------------------------------------------

def test_keys_says_which_are_set_and_json_is_get_settings(cli):
    code, out, err = _run(["keys"])
    assert code == 0, err
    configured = out.split("NOT CONFIGURED:")[0]
    assert "OPENAI_API_KEY" in configured and "FAL_KEY" in configured
    assert "GOOGLE_API_KEY" in out.split("NOT CONFIGURED:")[1]
    assert "***" not in out  # set or not set, never a mask a reader takes for an ending
    assert "execution mode auto" in out and "Krea via mcp" in out
    assert _json(["keys", "--json"]) == mcp_server.get_settings()


def test_keys_and_providers_print_no_key_ending_even_if_the_route_sent_one(cli, person, monkeypatch):
    """The CLI never has the person token. If a caller's headers did reach the
    route as the person (it then sends `***` + the last 4), the CLI still
    prints only set or not set: it shapes the reply as get_settings does."""
    real = NebulaClient._identity_headers

    def as_person(self, headers=None):
        return {**real(self, headers), **person.headers}

    monkeypatch.setattr(NebulaClient, "_identity_headers", as_person)
    assert cli["http"].get("/api/settings", headers=person.headers).json()["apiKeys"]["OPENAI_API_KEY"].endswith(
        OPENAI_KEY[-4:])
    for argv in (["keys"], ["keys", "--json"], ["providers"], ["providers", "--json"]):
        code, out, err = _run(argv)  # _run scans for every 4-character run of either key
        assert code == 0, err


def test_providers_reads_health_and_the_krea_connection_as_provider_status(cli, monkeypatch):
    import main

    calls: list[bool] = []

    async def fake_validate(*, force_refresh: bool = False, **kwargs):
        calls.append(force_refresh)
        return {"OpenAI": {"configured": True, "status": "valid", "last_checked": "2026-10-20T10:00:00+00:00"},
                "FAL": {"configured": True, "status": "invalid", "last_checked": "2026-10-20T10:00:00+00:00",
                        "detail": "authentication rejected (HTTP 401)"},
                "Google": {"configured": False, "status": "not_configured", "last_checked": "x"}}

    monkeypatch.setattr(main, "validate_provider_keys", fake_validate)
    cli["krea"].state = {"status": "needs_auth", "authorizationUrl": "https://krea.ai/oauth?state=abc",
                         "error": "Krea sign-in expired"}
    code, out, err = _run(["providers"])
    assert code == 0, err
    assert calls == [False]
    rows = {line.split()[0]: line for line in out.splitlines() if line.startswith("  ")}
    assert "valid" in rows["OpenAI"]
    assert "invalid" in rows["FAL"] and "authentication rejected (HTTP 401)" in rows["FAL"]
    assert "not_configured" in rows["Google"]
    assert "Krea account: needs_auth" in out and "sign-in waiting for the person" in out
    assert "oauth" not in out

    code, _, _ = _run(["providers", "--refresh"])
    assert code == 0 and calls == [False, True]
    by_cli = _json(["providers", "--json"])
    assert by_cli == mcp_server.provider_status()
    assert "oauth" not in json.dumps(by_cli)


# -- help and docs -------------------------------------------------------------------

def test_help_and_docs_name_the_new_commands(cli):
    code, out, _ = _run(["--help"])
    assert code == 0 and "providers" in out
    code, out, _ = _run(["project", "--help"])
    assert code == 0 and "rename" in out and "show" in out
    code, out, _ = _run(["trash", "list", "--help"])
    assert code == 0 and "--scope" in out and "--project" in out
    for command in (["keys", "--help"], ["providers", "--help"]):
        code, out, _ = _run(command)
        assert code == 0 and "person token" in " ".join(out.split())

    skill = (ROOT / "skills" / "nebula" / "SKILL.md").read_text(encoding="utf-8")
    setup = (ROOT / "docs" / "MCP-SETUP.md").read_text(encoding="utf-8")
    for text in (skill, setup):
        for command in ("nebula project rename", "nebula project show", "nebula trash list --scope",
                        "nebula providers", "nebula keys"):
            assert command in text, command
