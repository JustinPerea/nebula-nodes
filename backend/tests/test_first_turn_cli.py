"""The `nebula` CLI points an agent to the right option (plan v2.7, PR26, §5.10.1).

GM's headless run (docs/agent-runs/2026-10-20-cli-headless.md) lost two turns
to options the CLI didn't have: `nebula nodes preview` ("unrecognized
arguments: preview") and `nebula propose ... --rename +g="Lake hero"`
("unrecognized arguments"). Both work now, and any other mistake gets a
"Did you mean ...?" and only that command's usage line.
"""
from __future__ import annotations

import io
import json
import re
import shlex
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cli.__main__ import build_parser, main
from cli.client import NebulaClient
from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

START_LINE = "New here? Start with `nebula context`: canvas, boards, node types and prices in one call."
SKILL = Path(__file__).resolve().parents[2] / "skills" / "nebula" / "SKILL.md"
KEY = "X-Nebula-Proposal-Key"


def _parse(argv: list[str]):
    return build_parser().parse_args(argv)


def _fail(argv: list[str]) -> str:
    err = io.StringIO()
    with redirect_stderr(err), pytest.raises(SystemExit) as exc:
        _parse(argv)
    assert exc.value.code == 2
    return err.getvalue()


@pytest.fixture
def cli(tmp_path, monkeypatch, person):
    """`nebula` against the app in-process, as GM's agent ran it."""
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Good Machines")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    browser: list[dict] = []

    async def ignore(data):
        return None

    async def capture_browser(data):
        browser.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture_browser)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    http = TestClient(main_module.app)
    real_init = NebulaClient.__init__

    def init(self, base_url="http://testserver"):
        real_init(self, base_url)
        self._client = http

    monkeypatch.setattr(NebulaClient, "__init__", init)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.http = http
    ctx.graph = graph
    ctx.browser = browser
    ctx.main = main_module
    return ctx


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
    return code, out.getvalue(), err.getvalue()


# -- GM's two mistakes ---------------------------------------------------------

def test_nodes_takes_a_plain_search_word(cli):
    code, out, err = _run(["nodes", "preview"])
    assert code == 0, err
    listed = re.findall(r"^\s+([a-z0-9-]+)\s", out, flags=re.M)
    assert "preview" in listed
    assert all("preview" in line.lower() for line in out.splitlines() if line.startswith("  "))
    code, both, _ = _run(["nodes", "image", "compare"])
    assert code == 0 and "image-compare" in both


def test_propose_rename_names_the_new_node(cli):
    code, out, err = _run(["propose", "--note", "Make the hero at dawn", "--add", "+p=text-input",
                           "--param", "+p.value=a quiet lake at dawn", "--add", "+g=nano-banana",
                           "--wire", "+p:text", "+g:prompt", "--rename", '+g=Lake hero', "--json"])
    assert code == 0, err
    view = json.loads(out)["proposal"]
    ghost = next(node for node in view["nodes"] if node["ref"] == "+g")
    assert ghost["name"] == "Lake hero" and ghost["model"] == "Nano Banana"

    # Accepting it applies the name.
    key = next(m["acceptKey"] for m in cli.browser if m.get("type") == "proposalOpened")
    accepted = cli.http.post(f"/api/canvas/proposals/{view['id']}/accept", headers={**PERSON, KEY: key}, json={})
    assert accepted.status_code == 200, accepted.text
    new_id = accepted.json()["idMap"]["+g"]
    assert cli.graph.nodes[new_id]["label"] == "Lake hero"


def test_a_proposal_that_renames_an_existing_node_is_refused(cli):
    existing = cli.graph.add_node("text-input", {"value": "x"})
    refused = cli.http.post("/api/canvas/proposals", headers={"X-Nebula-Agent": "Codex"}, json={
        "note": "Rename it", "nodes": [{"ref": "+p", "definitionId": "text-input"}],
        "rename": {existing: "New name"}})
    assert refused.status_code == 422
    assert "Rename existing nodes with edit_canvas (or `nebula rename`)" in refused.json()["detail"]
    code, _out, err = _run(["propose", "--note", "Rename it", "--add", "+p=text-input",
                            "--rename", f"{existing}=New name"])
    assert code == 1 and "Rename existing nodes with edit_canvas (or `nebula rename`)" in err


@pytest.mark.parametrize("flag", [["--move", "n1=1,2"], ["--remove", "n1"], ["--unwire", "n1:text", "n2:prompt"],
                                  ["--arrange"]])
def test_apply_only_options_on_propose_get_a_named_error(cli, flag):
    code, _out, err = _run(["propose", "--note", "x", "--add", "+p=text-input", *flag])
    assert code == 1
    assert f"`nebula propose` doesn't take {flag[0]}" in err
    assert "unrecognized arguments" not in err


# -- suggestions -----------------------------------------------------------------

def test_cli_suggests_close_option():
    err = _fail(["nodes", "--qeury", "upscale"])
    assert "Did you mean --query?" in err
    # Only that command's usage line, not the whole tree.
    usage = [line for line in err.splitlines() if line.startswith("usage:")]
    assert usage and usage[0].startswith("usage: nebula nodes")
    assert "moodboard" not in err and "run-all" not in err
    # And the option it suggests works.
    assert _parse(["nodes", "--query", "upscale"]).query == "upscale"


def test_cli_suggests_a_close_command_and_subcommand():
    err = _fail(["nodez"])
    assert "Did you mean nodes?" in err and "choose from" not in err
    err = _fail(["moodboard", "sho", "x"])
    assert "Did you mean show?" in err


def test_a_suggestion_names_a_second_choice_only_when_it_is_as_close():
    from cli.parser import _closest
    assert _closest("nodez", ["nodes", "note"]) == ["nodes"]
    assert sorted(_closest("nod", ["node", "nods"])) == ["node", "nods"]  # a tie keeps both
    assert _closest("zzz", ["nodes", "note"]) == []


def test_aliases_run_the_mcp_named_commands():
    assert _parse(["describe", "nano-banana"]).command == "info"
    assert _parse(["find", "upscale"]).command == "nodes"
    assert _parse(["--url", "http://x", "find", "--query", "upscale"]).query == "upscale"


def test_aliases_stay_out_of_help():
    for argv in (["--help"], ["nodes", "--help"]):
        out = io.StringIO()
        with redirect_stdout(out), pytest.raises(SystemExit):
            _parse(argv)
        text = out.getvalue()
        assert "describe" not in text and "--query" not in text
        assert not re.search(r"\bfind\b", text)


def test_cli_category_short_name_matches(cli):
    # --all: with no key set here, no image node runs (tests/test_cli_nodes_ready.py has the default).
    for category in ("image", "Image", "image-gen"):
        code, out, err = _run(["nodes", "--category", category, "--all"])
        assert code == 0, err
        assert "IMAGE GENERATION" in out and "nano-banana" in out and "VIDEO" not in out


def test_nodes_with_no_match_lists_the_categories(cli):
    code, out, _err = _run(["nodes", "zzzzqqq"])
    assert code == 0
    assert "No nodes match" in out and "image-gen" in out and "utility" in out


def test_start_line_in_bare_help_apply_nodes_and_info(cli):
    code, out, _ = _run([])
    assert code == 0 and START_LINE in out.splitlines()[0]
    code, out, _ = _run(["--help"])
    assert START_LINE in out.splitlines()[0]
    code, out, _ = _run(["apply", "--help"])
    assert START_LINE in out.splitlines()[0]
    code, out, _ = _run(["nodes", "preview"])
    assert out.splitlines()[0] == START_LINE
    code, out, err = _run(["info", "text-input"])
    assert code == 0, err
    assert out.splitlines()[0] == START_LINE


# -- the skill's examples --------------------------------------------------------

def _skill_commands() -> list[str]:
    text = SKILL.read_text(encoding="utf-8")
    lines: list[str] = []
    for block in re.findall(r"```(?:bash)?\n(.*?)```", text, flags=re.S):
        joined = re.sub(r"\\\n\s*", " ", block)
        lines.extend(line.split("  #")[0].split(" # ")[0].strip() for line in joined.splitlines())
    lines.extend(re.findall(r"`(nebula [^`]+)`", text))
    commands = []
    for line in lines:
        # "nebula <command>" is how the skill names every command, not an example.
        if not line.startswith("nebula ") or "<checkout>" in line or line.startswith("nebula <command>"):
            continue
        commands.append(line)
    return commands


def _concrete(command: str) -> list[str]:
    """Placeholders as an agent would fill them in."""
    filled = (command.replace("<board>", "mb1").replace("<character>", "ch1").replace("<id>", "x1")
              .replace("<run-id>", "r1").replace("<pin-id>", "pin_1").replace("<node-id>", "nano-banana")
              .replace("<project id or exact\n  name>", "p1").replace("\"<name>\"", "\"New\"")
              .replace("<category>", "image").replace("<definitionId>", "nano-banana")
              .replace("<file>", "f.json").replace("...", "x"))
    filled = re.sub(r"\|[a-z|<> ]+", "", filled)  # "--to global|current|..." -> "--to global"
    return shlex.split(filled)[1:]


def _is_mention(command: str) -> bool:
    """`nebula info` in a sentence names the command; it isn't an example to run."""
    words = command.split()[1:]
    return 0 < len(words) <= 2 and not any(word.startswith(("-", "<", "+", '"')) or "=" in word for word in words)


def test_skill_category_examples_list_nodes(cli):
    """Every `--category X` the skill shows lists nodes: on main its `--category image` matched nothing
    (categories are image-gen, video-gen, ...), so an agent copying it got "No matching nodes found"."""
    categories = sorted(set(re.findall(r"--category\s+([A-Za-z0-9-]+)", SKILL.read_text(encoding="utf-8"))))
    assert categories
    for category in categories:
        code, out, err = _run(["nodes", "--category", category])
        assert code == 0, err
        assert not re.search(r"no (matching )?nodes", out, flags=re.I), (category, out[:300])
        # Nothing may run here with no key set; --all lists the category either way.
        code, out, err = _run(["nodes", "--category", category, "--all"])
        assert code == 0 and re.search(r"^  [a-z0-9]", out, flags=re.M), (category, out[:300])


def test_skill_examples_parse():
    commands = _skill_commands()
    assert len(commands) > 40
    failures = []
    for command in commands:
        argv = _concrete(command)
        err = io.StringIO()
        try:
            with redirect_stderr(err), redirect_stdout(io.StringIO()):
                _parse(argv)
        except SystemExit as exc:
            if exc.code == 0 and "--help" in argv:
                continue
            if _is_mention(command) and "the following arguments are required" in err.getvalue():
                continue  # a real command named in prose, without its arguments
            failures.append(f"{command!r}: {err.getvalue().strip()}")
    assert not failures, "\n".join(failures)
