"""A node type named by its display name (docs/agent-runs/2026-10-20-pr26-first-turn-measurement.md,
"Rerun after PR26b"): three of the four usage errors left were `nebula info moodboard`. The
Moodboard node's id is `nebula-moodboard`; the error listed it and the agent used it next turn.

- Lookups (`nebula info`/`describe`, MCP `describe_node`) take a node type's exact display
  name, ignoring case and outer spaces, when exactly one node has it, and say which id they
  used in one line. An id always wins. A name two nodes share keeps refusing, listing them.
- Writes (`edit_canvas`, `propose_change`, `nebula apply`/`propose`/`create`/`quick`, a Style's
  `modelId` through `style_create`/`style_update` and `nebula style new/set --model`) stay
  strict: they store and bill by id, and a display name can be renamed or become shared later.
  Their refusal names the exact-name match first ("did you mean nebula-moodboard (Moodboard)?").
"""
from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from mcp.server.fastmcp.exceptions import ToolError

import mcp_server
from tests.test_first_turn_cli import _run, cli  # noqa: F401 - fixture
from tests.test_mcp_tools import nebula  # noqa: F401 - fixture

NOTE = "moodboard is the Moodboard node: nebula-moodboard"
HINT = "did you mean nebula-moodboard (Moodboard)?"


@pytest.fixture
def shared_name(monkeypatch):
    """A second node type named "Moodboard", as a later catalog could have."""
    import main

    twin = copy.deepcopy(main.node_registry.get("nebula-moodboard"))
    twin["id"] = "zz-moodboard-twin"
    monkeypatch.setitem(main.node_registry.get_all(), "zz-moodboard-twin", twin)
    return twin


@pytest.fixture
def shadow(monkeypatch):
    """A node type whose display name is another node's id."""
    import main

    fake = copy.deepcopy(main.node_registry.get("text-input"))
    fake.update(id="zz-shadow", displayName="nebula-moodboard")
    monkeypatch.setitem(main.node_registry.get_all(), "zz-shadow", fake)
    return fake


# -- the lookup itself ----------------------------------------------------------

def test_resolve_takes_an_id_or_a_unique_display_name():
    import main
    from services import node_lookup

    defs = main.node_registry.get_all()
    assert node_lookup.resolve("nebula-moodboard", defs) == node_lookup.Lookup("nebula-moodboard", None, ())
    for asked in ("moodboard", "Moodboard", "  MOODBOARD "):
        found = node_lookup.resolve(asked, defs)
        assert found.definition_id == "nebula-moodboard"
        assert found.note == f"{asked.strip()} is the Moodboard node: nebula-moodboard"
    assert node_lookup.resolve("moodbord", defs).definition_id is None


def test_an_id_is_never_shadowed_by_a_display_name(shadow):
    import main
    from services import node_lookup

    found = node_lookup.resolve("nebula-moodboard", main.node_registry.get_all())
    assert found.definition_id == "nebula-moodboard" and found.note is None


def test_a_shared_display_name_resolves_to_nothing(shared_name):
    import main
    from services import node_lookup

    found = node_lookup.resolve("Moodboard", main.node_registry.get_all())
    assert found.definition_id is None
    assert found.named == ("nebula-moodboard", "zz-moodboard-twin")


# -- nebula info / describe ----------------------------------------------------

@pytest.mark.parametrize("argv", [["info", "moodboard"], ["info", "Moodboard"], ["describe", "moodboard"],
                                  ["info", " Moodboard "]])
def test_nebula_info_takes_the_display_name(cli, argv):
    code, out, err = _run(argv)
    assert code == 0, err
    lines = out.splitlines()
    assert f"{argv[1].strip()} is the Moodboard node: nebula-moodboard" in lines[1]
    assert lines[2] == "Moodboard (nebula-moodboard)"
    assert "INPUTS:" in out or "OUTPUTS:" in out


def test_nebula_info_by_id_says_nothing_extra(cli):
    code, out, err = _run(["info", "nebula-moodboard"])
    assert code == 0, err
    assert " is the " not in out and out.splitlines()[1] == "Moodboard (nebula-moodboard)"


def test_nebula_info_takes_a_name_with_a_slash(cli):
    import main

    name = next(d["displayName"] for d in main.node_registry.get_all().values() if "/" in d["displayName"])
    code, out, err = _run(["info", name.lower()])
    assert code == 0, err
    assert f"is the {name} node:" in out


def test_nebula_info_by_id_is_not_shadowed(cli, shadow):
    code, out, err = _run(["info", "nebula-moodboard"])
    assert code == 0, err
    assert out.splitlines()[1] == "Moodboard (nebula-moodboard)"


def test_nebula_info_refuses_a_shared_name_listing_both_first(cli, shared_name):
    code, out, err = _run(["info", "moodboard"])
    assert code == 1
    assert "Node moodboard not found" in err
    listed = [line.split()[1] for line in err.splitlines() if line.strip().startswith("- ")]
    assert listed[:2] == ["nebula-moodboard", "zz-moodboard-twin"], err
    assert "2 node types are named Moodboard" in err


def test_unknown_text_keeps_todays_error(cli):
    code, _, err = _run(["info", "moodbord"])
    assert code == 1
    assert "Node moodbord not found. Did you mean:" in err
    code, _, err = _run(["info", "xyzzy-quux-nothing"])
    assert code == 1 and "Did you mean" not in err


def test_info_help_says_it_takes_a_name(cli):
    code, out, _ = _run(["info", "--help"])
    assert code == 0
    assert "exact name" in out and "Moodboard" in out


def test_the_http_answer_carries_the_note():
    import main

    http = TestClient(main.app)
    body = http.get("/api/nodes/moodboard").json()
    assert body["id"] == "nebula-moodboard" and body["lookup"] == NOTE
    assert "lookup" not in http.get("/api/nodes/nebula-moodboard").json()


# -- MCP describe_node ----------------------------------------------------------

@pytest.mark.parametrize("asked", ["moodboard", "Moodboard"])
def test_describe_node_takes_the_display_name(nebula, asked):
    result = mcp_server.describe_node(asked)
    assert result["id"] == "nebula-moodboard"
    assert next(iter(result)) == "lookup"
    assert result["lookup"] == f"{asked} is the Moodboard node: nebula-moodboard"


def test_describe_node_by_id_has_no_note(nebula, shadow):
    result = mcp_server.describe_node("nebula-moodboard")
    assert result["id"] == "nebula-moodboard" and "lookup" not in result


def test_describe_node_refuses_a_shared_name(nebula, shared_name):
    with pytest.raises(Exception) as caught:
        mcp_server.describe_node("Moodboard")
    message = str(caught.value)
    assert "No node type Moodboard: 2 node types are named Moodboard: nebula-moodboard, zz-moodboard-twin." in message


def test_describe_node_through_the_mcp_handler(nebula):
    """As a client calls it: the tool's JSON text starts with the note."""
    parts = asyncio.run(mcp_server.mcp.call_tool("describe_node", {"definition_id": "Moodboard"}))
    content = parts[0] if isinstance(parts, tuple) else parts
    body = json.loads(content[0].text)
    assert body["lookup"] == "Moodboard is the Moodboard node: nebula-moodboard"


def test_describe_node_docstring_says_it_takes_a_name():
    doc = mcp_server.describe_node.__doc__ or ""
    assert "display name" in doc and "lookup" in doc


# -- writes stay strict, and say the id -----------------------------------------

def test_edit_canvas_refuses_a_display_name_and_names_the_id(nebula):
    http, _ = nebula
    with pytest.raises(Exception) as caught:
        mcp_server.edit_canvas(note="board", nodes=[{"ref": "+mb", "definitionId": "moodboard"}])
    assert "unknown node definition moodboard" in str(caught.value)
    assert HINT in str(caught.value)
    assert http.get("/api/graph").json()["nodes"] == []


def test_propose_change_refuses_a_display_name_and_names_the_id(nebula):
    with pytest.raises(Exception) as caught:
        mcp_server.propose_change(note="board", nodes=[{"ref": "+mb", "definitionId": "Moodboard"}])
    assert "unknown node definition Moodboard" in str(caught.value)
    assert HINT in str(caught.value)


def test_nebula_apply_refuses_a_display_name_and_names_the_id(cli):
    code, _, err = _run(["apply", "--note", "board", "--add", "+mb=moodboard"])
    assert code == 1
    assert "unknown node definition moodboard" in err and HINT in err
    assert cli.graph.nodes == {}


def test_nebula_create_refuses_a_display_name_and_stores_nothing(cli):
    """Before, `nebula create moodboard` stored a node of type 'moodboard' and then failed its lookup."""
    code, out, err = _run(["create", "moodboard"])
    assert code == 1
    assert HINT in err and "Created node" not in out
    assert cli.graph.nodes == {}


def test_nebula_quick_refuses_a_display_name(cli):
    code, _, err = _run(["quick", "moodboard"])
    assert code == 1
    assert HINT in err


def test_a_write_refusal_with_no_name_match_gives_close_ids_or_nothing(cli):
    _, _, err = _run(["apply", "--note", "x", "--add", "+mb=nebula-moodbord"])
    assert "unknown node definition nebula-moodbord" in err and "nebula-moodboard" in err.split("nebula-moodbord", 1)[1]
    _, _, err = _run(["apply", "--note", "x", "--add", "+mb=xyzzy-quux-nothing"])
    assert "unknown node definition xyzzy-quux-nothing" in err and "did you mean" not in err


def test_a_write_refusal_lists_a_shared_name_first(cli, shared_name):
    _, _, err = _run(["apply", "--note", "x", "--add", "+mb=moodboard"])
    assert "did you mean nebula-moodboard (Moodboard) or zz-moodboard-twin (Moodboard)?" in err


# -- a Style's model is a write too (review, 2026-10-21) ----------------------------
# A Style stores its modelId and Create applies it, so it stays strict like the
# node writes, and its refusal names the exact-name match the same way.

AGENT_HEADERS = {"X-Nebula-Agent": "GM - Design"}


@pytest.mark.parametrize("name,match", [
    ("FLUX.2", "flux-2-pro (FLUX.2)"),
    ("gpt image 2", "gpt-image-2-generate (GPT Image 2)"),
])
def test_a_style_model_named_by_display_name_is_refused_naming_the_id(cli, tmp_path, monkeypatch, name, match):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    refused = cli.http.post("/api/presets", headers=AGENT_HEADERS, json={
        "name": "s", "category": "My Styles", "prompt": "", "params": {}, "modelId": name,
        "refImages": [], "scope": "global"})
    assert refused.status_code == 400
    detail = refused.json()["detail"]
    assert f"unknown node definition {name}: did you mean {match}?" in detail
    assert "find_nodes" in detail
    assert cli.http.get("/api/presets").json() == []  # nothing stored


def test_nebula_style_new_with_a_display_name_names_the_id(cli, tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    code, _, err = _run(["style", "new", "Review style", "--model", "FLUX.2"])
    assert code == 1
    assert "did you mean flux-2-pro (FLUX.2)?" in err


def test_a_style_update_to_a_display_name_names_the_id(cli, tmp_path, monkeypatch):
    from tests.conftest import PERSON

    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    made = cli.http.post("/api/presets", headers=PERSON, json={
        "name": "s", "category": "My Styles", "prompt": "", "params": {}, "modelId": None,
        "refImages": [], "scope": "global"})
    assert made.status_code == 200, made.text
    refused = cli.http.put(f"/api/presets/{made.json()['id']}", headers=AGENT_HEADERS, json={"modelId": "FLUX.2"})
    assert refused.status_code == 400
    assert "did you mean flux-2-pro (FLUX.2)?" in refused.json()["detail"]


def test_a_style_model_near_miss_gets_close_ids(cli, tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_PRESET_ROOT", str(tmp_path / "presets"))
    refused = cli.http.post("/api/presets", headers=AGENT_HEADERS, json={
        "name": "s", "category": "My Styles", "prompt": "", "params": {}, "modelId": "gpt-image-2-generat",
        "refImages": [], "scope": "global"})
    assert refused.status_code == 400
    assert "gpt-image-2-generate" in refused.json()["detail"].split("definition gpt-image-2-generat", 1)[1]


# -- the turn counter still counts what's left -----------------------------------

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "count_agent_turns.py"


@pytest.fixture(scope="module")
def counter():
    spec = importlib.util.spec_from_file_location("count_agent_turns", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.mark.parametrize("tool,command,text", [
    ("Bash", "nebula info moodboard",
     "Exit code 1\nerror: Node moodboard not found: 2 node types are named Moodboard. Did you mean:"),
    ("Bash", "nebula apply --note x --add +mb=moodboard",
     "Exit code 1\nerror: unknown node definition 'moodboard': did you mean nebula-moodboard (Moodboard)?"),
    ("mcp__nebula__describe_node", None,
     "Error executing tool describe_node: No node type Moodboard: 2 node types are named Moodboard: "
     "nebula-moodboard, zz-moodboard-twin."),
    ("mcp__nebula__describe_node", None,
     "Error executing tool describe_node: No node type moodbord. Close matches: nebula-moodboard."),
    ("mcp__nebula__edit_canvas", None,
     "Error executing tool edit_canvas: unknown node definition 'moodboard': did you mean nebula-moodboard (Moodboard)?"),
    ("mcp__nebula__style_create", None,
     "Error executing tool style_create: style.modelId: unknown node definition 'FLUX.2': "
     "did you mean flux-2-pro (FLUX.2)?; find_nodes (`nebula nodes`) lists them"),
])
def test_the_counter_classes_the_refusals_left_as_usage_errors(counter, tool, command, text):
    from tests.test_count_agent_turns import Transcript, _kinds

    t = Transcript().call(command, text, tool=tool, tool_input=None if command else {}, error=True)
    assert _kinds(counter.count(t.lines())) == ["usage-error"]


def test_a_resolved_lookup_is_a_lookup_not_an_error(counter):
    from tests.test_count_agent_turns import Transcript, _kinds

    t = Transcript().call("nebula info moodboard", f"{NOTE}\nMoodboard (nebula-moodboard)\n")
    assert _kinds(counter.count(t.lines())) == ["lookup"]
