"""Nebula says connected, never wired (GM - Design, 2026-10-25), beyond the
cursor bubbles (test_connected_copy.py): the canvas record (`nebula watch`,
`nebula history`), edit and undo summaries, refusals, the CLI, the MCP tool
docs agents read, the docs and the node descriptions.

Second pass (GM - Design's ruling on the leftovers): the verb is "connect"
everywhere ("Can't connect", "Connect it:", "Connect the audio track ..."), an
unwired required input is "a required input with nothing connected", and the
noun is "connection(s)" ("Connections" in project size, CONNECTIONS: in
`nebula look`, Deleted “X” and its connections). The reason codes and the
`unwire` / `--unwire` names stay until the next breaking API change.

The ratchet at the bottom reads every string literal in the backend's code
and every docstring in mcp_server.py (agents read the MCP tools' docs), with
`backtick spans` and the --wire / --unwire flags taken out first, and fails on
"wire", "wires", "wired", "wiring" or "unwired", apart from the field keys,
reason codes, part names and pricing tokens listed in ALLOWED (code
identifiers, which GM said to leave alone). Other docstrings are for people
reading the code.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

from services import canvas_undo, moodboard_adapters
from services.chat_session import NEBULA_MCP_PRIMER
from tests.conftest import PERSON
from tests.test_canvas_proposals import CODEX, api  # noqa: F401 - fixture

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
WIRED = re.compile(r"\b(wired|wiring|unwired)\b", re.IGNORECASE)


def _edge(source: str, target: str) -> dict:
    return {"source": source, "sourceHandle": "text", "target": target, "targetHandle": "prompt"}


def _pair(api) -> tuple[str, str]:
    return (api.graph.add_node("text-input", {"value": "a cat"}),
            api.graph.add_node("gpt-image-2-5-generate", {}))


def test_the_canvas_record_says_connected_and_disconnected(api):  # noqa: F811
    text, image = _pair(api)
    assert api.client.post("/api/graph/connect", headers=CODEX, json=_edge(text, image)).status_code == 200
    assert api.client.request("DELETE", "/api/graph/edge", headers=CODEX, json=_edge(text, image)).status_code == 200
    summaries = {e["kind"]: e["summary"] for e in api.journal.read(after=0, limit=100)["events"]
                 if e["kind"] in ("edge.added", "edge.removed")}
    assert summaries == {"edge.added": f"connected {text}.text → {image}.prompt",
                         "edge.removed": f"disconnected {text}.text → {image}.prompt"}


def test_an_edit_summary_says_connected_and_disconnected(api, monkeypatch):  # noqa: F811
    lines: list[str] = []
    monkeypatch.setattr(api.main, "publish_action", lines.append)
    text, image = _pair(api)
    api.graph.connect(text, "text", image, "prompt")
    other = api.graph.add_node("text-input", {"value": "a dog"})
    body = {"unwire": [_edge(text, image)], "edges": [_edge(other, image)]}
    response = api.client.post("/api/graph/apply", headers=CODEX, json=body)
    assert response.status_code == 200, response.text
    assert response.json()["summary"] == "connected 1, disconnected 1"
    assert lines[-1] == "Codex edited the canvas: connected 1, disconnected 1"


def test_an_edit_that_removes_and_connects_one_node_is_refused_in_connected_words(api):  # noqa: F811
    text, image = _pair(api)
    response = api.client.post("/api/graph/apply", headers=CODEX,
                               json={"remove": [text], "edges": [_edge(text, image)]})
    assert response.status_code == 400
    assert "can't also be connected, changed, renamed or moved" in response.text


def test_the_undo_reply_says_connected_back_and_disconnected():
    verbs = dict(canvas_undo.UNDONE_VERBS)
    assert verbs["wired"] == "connected back" and verbs["unwired"] == "disconnected"


def test_a_restore_line_in_the_agent_log_says_connected(api, monkeypatch):  # noqa: F811
    lines: list[str] = []
    monkeypatch.setattr(api.main, "publish_action", lines.append)
    text, image = _pair(api)
    response = api.client.post("/api/graph/restore", headers=PERSON, json={
        "action": "redo", "nodes": [], "remove": [], "wire": [_edge(text, image)], "unwire": []})
    assert response.status_code == 200, response.text
    assert lines[-1].endswith("0 changed, 1 connected, 0 disconnected")


def test_the_moodboard_note_and_the_in_app_agent_prompt_say_connected():
    assert moodboard_adapters.NO_ENTRY_NOTE == (
        "This node has no moodboard adapter entry, so a connected board goes as text only.")
    assert "add a new node connected to the SAME input nodes" in " ".join(NEBULA_MCP_PRIMER.split())


def test_a_size_refusal_says_connect_never_wire():
    from tests.test_price_from_input_size import _decide_why

    for reason in ("wires", "unwired", "pending"):
        refusal = _decide_why(reason)
        assert not re.search(r"\b[Ww]ire(d)?\b", refusal), refusal
    assert "more than one input is connected to its image port" in _decide_why("wires")
    assert "Connect an Image Input (or Video Input) holding the file to it" in _decide_why("unwired")


def test_the_cli_says_connected():
    from cli.formatter import _moodboard_lines

    [line, detail] = _moodboard_lines({"line": "Board images go", "channel": "images", "needsWired": ["images"]})
    assert "needs images connected" in detail


def test_the_cli_brief_of_a_board_at_strength_0_says_connected(monkeypatch, capsys):
    from cli.commands import moodboard

    monkeypatch.setattr(moodboard.boards, "brief", lambda board: {
        "brief": {"styleBrief": "Soft dusk light."}, "briefOverride": None})
    moodboard._print_brief({"id": "b1", "strength": 0})
    printed = capsys.readouterr().out
    assert ("  Brief (generated), not sent: board strength is 0, so no node it's connected to gets the board:\n"
            "    Soft dusk light.\n") == printed


def test_the_mcp_tool_docs_say_connected():
    import mcp_server

    assert "what a connected Nebula\n    moodboard does there" in mcp_server.describe_node.__doc__
    doc = " ".join(mcp_server.moodboard_get.__doc__.split())
    assert "the board is off and no node it's connected to gets any of it" in doc


JEV_DESCRIPTIONS = {
    "jev-decide": "Also a gate: whatever is connected to “Through” comes out of “On Pass” or “On Fail”",
    "jev-box": "no crop, and the nodes connected to “Crop”, “Mask” or “Annotated” are skipped.",
}


@pytest.mark.parametrize("node_id", sorted(JEV_DESCRIPTIONS))
def test_the_jev_node_descriptions_say_connected(node_id):
    definitions = json.loads((BACKEND / "data" / "node_definitions.json").read_text())
    description = definitions[node_id]["description"]
    assert JEV_DESCRIPTIONS[node_id] in description and not WIRED.search(description)


DOC_PHRASES = {
    "docs/MCP-SETUP.md": [
        "what a connected Nebula", "Creating, connecting, setting, running, removing and disconnecting nodes",
        "| connected / disconnected |", "# Applied: added 3, connected 2, renamed 1, moved 1, removed 1, disconnected 1.",
        "for every node it's connected to", "connected to a Preview's `input`",
        "the cursor's words (\"Added “Moodboard”\", \"Running “Krea 2”\", \"Connecting “Prompt” to “Krea 2”\"",
    ],
    "skills/nebula/SKILL.md": ["what a connected board does there", "every node it's connected to"],
}


@pytest.mark.parametrize("path", sorted(DOC_PHRASES))
def test_the_docs_agents_read_say_connected(path):
    text = " ".join((REPO / path).read_text().split())
    for phrase in DOC_PHRASES[path]:
        assert phrase in text, phrase


# -- the ratchet -----------------------------------------------------------------------------

# Field keys (`wired` / `unwired` in an edit's or undo's reply, `wire` /
# `wires` in a restore body, an undo's state and a proposal's counts, the
# `wire[i]` path in a refusal), reason codes (`reason` in a skipped part),
# part names (`part`: "wire", "wires in"), the project-size row kind, the
# pricing and route tokens, and a Krea schema key: identifiers, not words a
# person or agent reads as prose.
ALLOWED = {
    "wire", "wires", "wired", "unwired", "wire[", "wires in", "wired since", "can't be wired now",
    "(wired ", "(wired)", "(wired ports)", "x-krea-wire-type",
}


# Prose the ratchet doesn't read: `backtick spans` (field names such as
# `wired`, `unwire`) and the CLI's --wire / --unwire flags.
_NOT_PROSE = re.compile(r"`[^`]*`|--(?:un)?wire\b")
WIRE_WORDS = re.compile(r"\b(wire|wires|wired|wiring|unwired)\b", re.IGNORECASE)


def _docstrings(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                ids.add(id(body[0].value))
    return ids


def _wired_literals() -> list[str]:
    found: list[str] = []
    for path in sorted(BACKEND.rglob("*.py")):
        rel = path.relative_to(BACKEND)
        if rel.parts[0] in {".venv", "tests"} or "__pycache__" in rel.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        # Agents read every docstring in mcp_server.py: the tools' docs.
        skip = set() if rel.as_posix() == "mcp_server.py" else _docstrings(tree)
        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip
                    and node.value not in ALLOWED
                    and WIRE_WORDS.search(_NOT_PROSE.sub("", node.value))):
                found.append(f"{rel}:{node.lineno}: {node.value[:100]!r}")
    return found


def test_no_string_in_the_backend_says_wire_or_wired():
    assert _wired_literals() == []


def test_the_ratchet_reads_mcp_docstrings_and_skips_backticks_and_flags():
    """The scope itself: an MCP tool's docstring counts, a field name in
    backticks and the --wire flag don't."""
    assert WIRE_WORDS.search(_NOT_PROSE.sub("", "Returns `wired, unwired` and --wire a b")) is None
    assert WIRE_WORDS.search(_NOT_PROSE.sub("", "an unwired required input")) is not None
    assert WIRE_WORDS.search(_NOT_PROSE.sub("", "deletes nodes or wires")) is not None


# -- second pass: GM - Design's ruling on the leftovers --------------------------------------

def _texts(rel: str) -> str:
    """Every string in a backend file as a person or agent reads it: an
    f-string's fields become {}, whitespace runs one space."""
    tree = ast.parse((BACKEND / rel).read_text(encoding="utf-8"))
    parts: list[str] = []
    inner: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = ""
            for value in node.values:
                inner.add(id(value))
                text += value.value if isinstance(value, ast.Constant) else "{}"
            parts.append(text)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in inner:
            parts.append(node.value)
    return "\n".join(" ".join(part.split()) for part in parts)


VERB_AND_NOUN_PINS = {
    "main.py": [
        "Can't connect {}.{}: {}, so Nebula can't tell which ports {} has.",
        "doesn't have the ports these connections use", "; these connections use others",
        ". Disconnect them in the same edit (`unwire`), or pick a model that takes them.",
        "There's no connection {}.{} → {}.{}; ", "look_at_canvas lists the current connections.",
        "nodes and {} connections ", " is no longer on the canvas, so its connection can't be put back.",
        "the connection {}.{} → {}.{} can't come back: {}", "`images` (Image, several connections)",
    ],
    "cli/commands/upload.py": ["Connect it: nebula connect {}:{} <node>:<port>"],
    "cli/commands/graph.py": ["Deleted {} ({}) and its connections", "error: no connection {} → {} (`nebula graph` lists them)"],
    "cli/__main__.py": ["Delete nodes and their connections", "Remove a connection",
                        "Read a saved project without opening it: nodes, connections, cover, run history",
                        "Read the canvas as data: what's on screen, states, connections, agent cursors",
                        "A connection, e.g. --wire n4:image +up:image (repeatable)",
                        "Delete a node and its connections (repeatable)",
                        "Remove a connection, e.g. --unwire n1:text n2:prompt (repeatable)"],
    "execution/maker_routes_elevenlabs.py": ["Connect the audio track to Audio, or clear the ElevenLabs voice_id"],
    "handlers/veo.py": ["Connect the upstream Veo node's 'Source URI' output to 'Extend Video'",
                        "Connect the upstream node's 'Video' output (the saved clip) to 'Extend Video' instead."],
    "handlers/krea_workspace.py": ["Connect media or text to save to Krea Files"],
    "handlers/krea_export.py": ["Connect a Krea 3D job or enter its job ID"],
    "execution/route_clients.py": ["Choose another provider for it, or connect an image from a public URL."],
    "services/chat_session.py": ["connect the SAME source image to both", "remove_from_canvas deletes nodes or connections."],
    "services/agent_start.py": ["prices, before you connect it.", "adds and connects in one call",
                                'connect "moodboard" to its "moodboard" input instead.',
                                "before you connect or set it.", "adds and connects in one step",
                                "connect +mb:moodboard to its moodboard input instead."],
    "services/canvas_undo.py": ["puts {} connection{} back", "the connection {} can't come back: {} is gone"],
    "services/canvas_edits.py": ["unwire must be a list of connections",
                                 "an edit needs at least one node, connection, param change, rename, move, removal or unwire"],
    "services/canvas_proposals.py": ["{} is a connection {}, not {}",
                                     "a proposal needs at least one node, connection, param change or run"],
    "services/port_contracts.py": ["A connection into this node no longer matches its inputs.",
                                   "Remove that connection, then connect a matching output.",
                                   "one connection", "up to {} connections"],
    "services/project_size.py": ["Connections"],
}


@pytest.mark.parametrize("rel", sorted(VERB_AND_NOUN_PINS))
def test_the_backend_says_connect_and_connection(rel):
    text = _texts(rel)
    for phrase in VERB_AND_NOUN_PINS[rel]:
        assert phrase in text, f"{rel}: {phrase}"


def test_the_mcp_docs_say_connect_and_connection():
    import mcp_server

    run = " ".join(mcp_server.run_nodes.__doc__.split())
    assert "(a missing key, a required input with nothing connected)" in run
    assert "so connect an Image Input holding the file to it" in run
    edit = " ".join(mcp_server.edit_canvas.__doc__.split())
    assert "`edges`: connections [{" in edit and "disconnect them in the same call (`unwire`)" in edit
    remove = " ".join(mcp_server.remove_from_canvas.__doc__.split())
    assert remove.startswith("Delete nodes (with their connections) and/or single connections, all or nothing.")
    assert '"Run history", "Connections", "Create draft"' in " ".join(mcp_server.project_size.__doc__.split())
    assert "remove_from_canvas deletes nodes or connections." in mcp_server.INSTRUCTIONS


def test_project_size_names_the_connections_row():
    from services import project_size

    assert project_size.ROW_NAMES["wires"] == "Connections"


def test_nebula_look_and_project_show_list_connections():
    from cli.formatter import format_project, format_snapshot

    edge = {"source": "n1", "sourceHandle": "text", "target": "n2", "targetHandle": "prompt"}
    look = format_snapshot({"nodes": [], "edges": [edge]})
    shown = format_project({"id": "p1", "name": "Lake", "nodes": [], "edges": [edge]})
    for text in (look, shown):
        assert "CONNECTIONS:\n  n1.text → n2.prompt" in text and "WIRES" not in text


class _DeletingClient:
    def __init__(self, label):
        self.label = label

    def delete_node(self, node_id):
        return {"status": "deleted", "id": node_id, "label": self.label}


@pytest.mark.parametrize(("label", "shown"), [("Hero shot", "“Hero shot”"), ("“Hero”", "“Hero”")])
def test_nebula_delete_names_the_node_in_quotes(capsys, label, shown):
    from cli.commands.graph import run_delete

    run_delete(_DeletingClient(label), ["n3"])
    assert capsys.readouterr().out == f"Deleted {shown} (n3) and its connections\n"


def test_the_delete_route_returns_the_node_name_with_the_type_name_fallback(api):  # noqa: F811
    named = api.graph.add_node("text-input", {"value": "a cat"})
    api.client.put(f"/api/graph/node/{named}/label", headers=PERSON, json={"label": "Hero"})
    plain = api.graph.add_node("text-input", {"value": "a dog"})
    labels = [api.client.delete(f"/api/graph/node/{node}", headers=PERSON).json()["label"] for node in (named, plain)]
    assert labels == ["Hero", api.main.node_registry.get_all()["text-input"]["displayName"]]


@pytest.mark.parametrize("name", ["Hero", "“Hero”", '"Hero"', " “Hero” ", "“Hero\""])
def test_a_quoted_name_is_not_quoted_twice(name):
    import main

    assert main._quoted(name) == "“Hero”"


def test_a_name_that_is_only_quotes_keeps_them():
    import main

    assert main._quoted('""') == "“\"\"”"


# -- the size refusal: more than one input on the measured port ------------------------------

def test_more_than_one_input_names_them_and_says_disconnect_all_but_one():
    from tests.test_price_from_input_size import PRICING, REGISTRY, UP
    from services import agent_spend

    refusal = agent_spend.decide(
        UP, [("a", "up", "image"), ("b", "up", "image")], settings={"apiKeys": {"FAL_KEY": "set"}},
        pricing=PRICING, definitions=REGISTRY, spent=agent_spend.Spent(), how_to_ask="ASK.", sizes=None,
        size_reasons={"up": "wires"},
        size_inputs={"up": ("image", [("Hero", "a", "image"), ("“Back plate”", "b", "image")])}).refusal
    assert ("more than one input is connected to its image port, so Nebula can't tell which file it sends; "
            "so it can't check this run against the spending limits set in Nebula Settings. "
            "Connected to it now: “Hero” (a:image) and “Back plate” (b:image). "
            "Disconnect all but one, or propose it.") in refusal


def test_several_nodes_each_list_their_inputs():
    from tests.test_price_from_input_size import PRICING, REGISTRY
    from services import agent_spend

    items = [{"id": "up", "definitionId": "seedvr2-upscale", "params": {}},
             {"id": "up2", "definitionId": "seedvr2-upscale", "params": {}}]
    refusal = agent_spend.decide(
        items, [], settings={"apiKeys": {"FAL_KEY": "set"}}, pricing=PRICING, definitions=REGISTRY,
        spent=agent_spend.Spent(), how_to_ask="ASK.", sizes=None, size_reasons={"up": "wires", "up2": "wires"},
        size_inputs={"up": ("image", [("A", "a", "image"), ("B", "b", "image")]),
                     "up2": ("image", [("C", "c", "image"), ("D", "d", None), ("E", "e", "image")])}).refusal
    assert ("Connected to up now: “A” (a:image) and “B” (b:image); to up2: “C” (c:image), “D” (d) and "
            "“E” (e:image). Disconnect all but one, or propose it.") in refusal


def test_run_input_sizes_records_what_is_connected_to_the_measured_port(tmp_path):
    from tests.test_price_from_input_size import PRICING, REGISTRY
    from services import input_sizes

    items = [{"id": "up", "definitionId": "seedvr2-upscale", "params": {}}]
    edges = [("a", "image", "up", "image"), ("b", "image", "up", "image")]
    reasons: dict[str, str] = {}
    connected: dict = {}
    input_sizes.run_input_sizes(items, edges, PRICING, REGISTRY, reasons=reasons, connected=connected)
    assert reasons == {"up": "wires"} and connected == {"up": ("image", [("a", "image"), ("b", "image")])}


def test_an_agent_run_with_two_inputs_on_the_sized_port_names_them(api, monkeypatch):  # noqa: F811
    from unittest.mock import AsyncMock

    from services import agent_spend

    monkeypatch.setattr(api.main, "execute_graph", AsyncMock())
    monkeypatch.setattr(api.main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(api.main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    settings = api.client.put("/api/settings", headers=PERSON, json={
        "apiKeys": {"FAL_KEY": "placeholder-not-a-key"}, "runCostConfirmUsd": 1,
        "agentSpend": {"sessionUsd": None, "models": {"seedvr2-upscale": {"perRunUsd": 1}}}})
    assert settings.status_code == 200, settings.text
    hero = api.graph.add_node("image-input", {})
    api.client.put(f"/api/graph/node/{hero}/label", headers=PERSON, json={"label": "Hero"})
    plate = api.graph.add_node("image-input", {})
    up = api.graph.add_node("seedvr2-upscale", {})
    api.graph.connect(hero, "image", up, "image")
    api.graph.connect(plate, "image", up, "image")
    response = api.client.post("/api/graph/run", headers=CODEX, json={"targetNodeId": up})
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert (f"Connected to it now: “Hero” ({hero}:image) and “Image Input” ({plate}:image). "
            "Disconnect all but one, or propose it.") in detail


# -- third pass: GM - Design's words for the leftovers, and the review's findings ----------

def test_arrange_says_each_step_of_connecting_the_nodes():
    from services.canvas_edits import ArrangeRequest

    doc = " ".join((REPO / "docs/MCP-SETUP.md").read_text().split())
    assert "each step of connecting the nodes is a column, 120 px apart" in doc
    assert "each step of connecting the nodes" in " ".join((ArrangeRequest.__doc__ or "").split())
    assert "the wiring" not in doc and not WIRED.search(ArrangeRequest.__doc__ or "")


def test_nebula_proposal_says_connects_in_a_column_that_lines_up():
    from cli.formatter import format_proposal

    view = {
        "id": "p_1", "status": "open", "agent": {"name": "Codex"}, "note": "Upscale", "expiresAt": 1_000_000 + 900_000,
        "nodes": [{"ref": "+up", "name": "Topaz Upscale", "cost": {"label": "paid · fal"}, "position": {"x": 1, "y": 2}}],
        "edges": [{"source": "n4", "sourceHandle": "image", "target": "+up", "targetHandle": "image"}],
        "params": [{"nodeId": "n4", "changes": {"prompt": {}}}],
        "run": [],
        "cost": {"notReady": [{"ref": "+up", "name": "Topaz Upscale", "missing": "a fal key"}]},
    }
    rows = format_proposal(view, now_ms=1_000_000).splitlines()[1:]
    assert rows == [
        "  adds     +up  Topaz Upscale  [paid · fal]  @(1,2)",
        "  connects n4.image → +up.image",
        "  sets     n4: prompt",
        "  runs     nothing until the person chooses",
        "  can't    +up  Topaz Upscale: a fal key",
    ]
    # Every value starts in the same column, one space after the widest verb.
    assert {len(row) - len(row[2:].split(" ", 1)[1].lstrip(" ")) for row in rows} == {11}


def _sources(count: int) -> list[tuple[str, str, str]]:
    return [(f"S{index}", f"s{index}", "image") for index in range(count)]


def _size_refusal(size_inputs):
    from tests.test_price_from_input_size import PRICING, REGISTRY
    from services import agent_spend

    items = [{"id": node_id, "definitionId": "seedvr2-upscale", "params": {}} for node_id in size_inputs]
    return agent_spend.decide(
        items, [], settings={"apiKeys": {"FAL_KEY": "set"}}, pricing=PRICING, definitions=REGISTRY,
        spent=agent_spend.Spent(), how_to_ask="ASK.", sizes=None, size_reasons={node_id: "wires" for node_id in size_inputs},
        size_inputs=size_inputs)


def test_a_hundred_inputs_list_the_first_five_and_how_many_more():
    refusal = _size_refusal({"up": ("image", _sources(100))}).refusal
    assert ("Connected to it now: “S0” (s0:image), “S1” (s1:image), “S2” (s2:image), “S3” (s3:image), "
            "“S4” (s4:image) and 95 more. Disconnect all but one, or propose it.") in refusal
    assert "S5" not in refusal and len(refusal) < 1000


def test_five_inputs_are_all_listed():
    refusal = _size_refusal({"up": ("image", _sources(5))}).refusal
    assert "“S3” (s3:image) and “S4” (s4:image). Disconnect" in refusal and " more." not in refusal


def test_many_nodes_list_the_first_five_groups_and_how_many_more():
    refusal = _size_refusal({f"up{index}": ("image", _sources(2)) for index in range(8)}).refusal
    group = "“S0” (s0:image) and “S1” (s1:image)"
    assert (f"Connected to up0 now: {group}; to up1: {group}; to up2: {group}; to up3: {group}; "
            f"to up4: {group}; and 3 more nodes. Disconnect all but one, or propose it.") in refusal
    assert "up5" not in refusal.split("Connected to", 1)[1]


@pytest.mark.parametrize("count", [2, 6, 100])
def test_the_cap_changes_the_message_only(count):
    """The guard decides the same with or without the names: refuses, charges
    and holds alike (the change is to the refusal's text only)."""
    named = _size_refusal({"up": ("image", _sources(count))})
    bare = _size_refusal({"up": ("image", [])})
    assert named.refusal and bare.refusal
    assert (named.charge, named.plan_charge, dict(named.per_node), dict(named.plan_per_node)) == (
        bare.charge, bare.plan_charge, dict(bare.per_node), dict(bare.plan_per_node))


def test_an_execute_run_names_its_inputs_from_its_own_nodes(api, monkeypatch):  # noqa: F811
    """/api/execute prices the request's nodes, so the names come from them:
    the canvas label only when the canvas node is the same definition, else
    the run node's type name. A canvas node with that id but another
    definition never lends its label."""
    from unittest.mock import AsyncMock

    from services import agent_spend

    monkeypatch.setattr(api.main, "execute_graph", AsyncMock())
    monkeypatch.setattr(api.main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(api.main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    settings = api.client.put("/api/settings", headers=PERSON, json={
        "apiKeys": {"FAL_KEY": "placeholder-not-a-key"}, "runCostConfirmUsd": 1,
        "agentSpend": {"sessionUsd": None, "models": {"seedvr2-upscale": {"perRunUsd": 1}}}})
    assert settings.status_code == 200, settings.text
    hero = api.graph.add_node("image-input", {})
    api.client.put(f"/api/graph/node/{hero}/label", headers=PERSON, json={"label": "Hero"})
    other = api.graph.add_node("text-input", {"value": "x"})
    api.client.put(f"/api/graph/node/{other}/label", headers=PERSON, json={"label": "Wrong"})
    nodes = [{"id": hero, "definitionId": "image-input", "params": {}},
             {"id": other, "definitionId": "image-input", "params": {}},
             {"id": "fresh", "definitionId": "image-input", "params": {}},
             {"id": "up", "definitionId": "seedvr2-upscale", "params": {}}]
    edges = [{"id": f"e{index}", "source": source, "sourceHandle": "image", "target": "up", "targetHandle": "image"}
             for index, source in enumerate((hero, other, "fresh"))]
    response = api.client.post("/api/execute", headers=CODEX, json={"nodes": nodes, "edges": edges})
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert (f"Connected to it now: “Hero” ({hero}:image), “Image Input” ({other}:image) and "
            "“Image Input” (fresh:image).") in detail
    assert "Wrong" not in detail


def test_a_run_source_name_never_raises(monkeypatch):
    import main

    def broken():
        raise RuntimeError("registry down")

    from models.graph import GraphNode

    monkeypatch.setattr(main.node_registry, "get_all", broken)
    run = {"zz": GraphNode(id="zz", definitionId="image-input")}
    assert main._run_node_name("zz", run) == "zz"
    assert main._run_node_name("gone", run) == "gone"


@pytest.mark.parametrize(("name", "shown"), [
    ('12"', "“12\"”"),
    ('"A" and "B"', "“\"A\" and \"B\"”"),
    ("“Hero", "““Hero”"),
    ('Hero"', "“Hero\"”"),
    ("“A” and “B”", "““A” and “B””"),
    ('""Hero""', "“\"\"Hero\"\"”"),
])
def test_an_unpaired_quote_is_never_stripped(name, shown):
    from services.node_names import quoted

    assert quoted(name) == shown


@pytest.mark.parametrize("name", ['"', "“", "“”"])
def test_a_name_that_is_only_quotes_or_one_quote_keeps_them(name):
    from services.node_names import quoted

    assert quoted(name) == f"“{name}”"


@pytest.mark.parametrize(("ref", "label", "shown"), [
    ("n3", "Hero", "Deleted “Hero” (n3) and its connections"),
    ("n4", "Hero", "Deleted “Hero” (n4) and its connections"),
])
def test_nebula_delete_keeps_the_id(capsys, ref, label, shown):
    from cli.commands.graph import run_delete

    run_delete(_DeletingClient(label), [ref])
    assert capsys.readouterr().out == shown + "\n"


# -- the docs agents read: the same ratchet over their prose (review 3, finding 6) -------------

# Prose the docs ratchet doesn't read: fenced code, `backtick spans`, the
# --wire / --unwire flags, and the one line that names the old word to say
# it is gone.
_DOC_NOT_PROSE = re.compile(r"```.*?```|`[^`]*`|--(?:un)?wire\b|\"connected\" for \"wired\"", re.DOTALL)
AGENT_DOCS = ("docs/MCP-SETUP.md", "skills/nebula/SKILL.md")


def _doc_wire_words(text: str) -> list[str]:
    prose = _DOC_NOT_PROSE.sub("", text)
    return [prose[max(0, m.start() - 40):m.end() + 20].replace("\n", " ") for m in WIRE_WORDS.finditer(prose)]


@pytest.mark.parametrize("path", AGENT_DOCS)
def test_no_prose_in_the_docs_agents_read_says_wire_or_wired(path):
    assert _doc_wire_words((REPO / path).read_text()) == []


def test_the_docs_ratchet_skips_code_and_flags_but_reads_prose():
    assert _doc_wire_words("```\nnebula apply --wire a b\n```\nUse `wired` and --unwire.") == []
    assert _doc_wire_words("the person edits one (a wire\n  to or from it)") != []
