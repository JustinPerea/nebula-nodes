"""PR26b: what the PR26 first-turn measurement asked for (15 `claude -p`
runs, docs/agent-runs/2026-10-20-pr26-first-turn-measurement.md).

- CLI agents read `nebula apply --help` and `nebula info nebula-moodboard`
  after `nebula context`, because it named `apply` but not its flags, nor
  the Moodboard node's param and port. The start answer now gives the exact
  calls, for both ways in.
- MCP agents guessed argument names (`moodboard_get(id=...)`,
  `describe_node(id=...)`, `edit_canvas` nodes with `type`, edges with
  `from`/`to`) and got pydantic's raw errors. Every tool now answers a wrong
  argument with one line naming its real ones, and refuses names it
  doesn't take instead of ignoring them.
- `point_at(say=...)` and `nebula point --say` with no target were usage
  errors; they now narrate where the agent's cursor already is.
"""
from __future__ import annotations

import asyncio
import io
import json
import re
from contextlib import redirect_stderr, redirect_stdout

import pytest
from mcp.server.fastmcp.exceptions import ToolError

import mcp_server
from services import agent_start
from services.canvas_edits import parse_edit
from services.canvas_proposals import ProposalError, parse_spec
from tests.test_agent_presence import _presence_events, api  # noqa: F401 - fixture
from tests.test_agent_start import CLAUDE, _board, _get, start  # noqa: F401 - fixture


def _tools() -> dict:
    return {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}


# -- A. the start answer gives the exact calls ------------------------------------

def _hint_text(answer: dict) -> str:
    return json.dumps({"next": answer["next"], "use": answer["boards"].get("use")}, ensure_ascii=False)


def test_every_call_in_the_mcp_hints_names_arguments_the_tool_takes(start):
    _board(start, start.active, "mbhint01", "Good Machines")
    text = json.loads(_hint_text(_get(start)))
    flat = " ".join(str(value) for value in text["next"].values() if isinstance(value, str)) + " " + text["use"]
    tools = _tools()
    calls = re.findall(r"\b([a-z]+(?:_[a-z]+)+)\(([^()]*)\)", flat)
    named = {name for name, _ in calls}
    assert {"describe_node", "edit_canvas", "propose_change", "point_at", "resolve_pin",
            "wait_for_canvas_change", "run_nodes", "get_proposal"} <= named, named
    for name, args in calls:
        properties = tools[name].inputSchema["properties"]
        for arg in re.findall(r"(?:^|[(,]\s*)([a-z_]+)=", args):
            assert arg in properties, (name, arg)
    # The old hint said describe_node(id), which the tool doesn't take.
    assert "describe_node(id)" not in flat


def test_the_build_hint_is_a_plan_edit_canvas_and_propose_change_take(start):
    """The hint's nodes and edges, with its placeholder filled, pass the backend's own shape check."""
    hint = _get(start)["next"]["build"]
    nodes = json.loads(re.search(r"nodes=(\[.*?\]), edges=", hint).group(1).replace("<id>", "nano-banana"))
    edges = json.loads(re.search(r"edges=(\[.*?\])", hint).group(1))
    spec = parse_edit({"nodes": nodes, "edges": edges, "arrange": True})
    assert [node.definition_id for node in spec.additions.nodes] == ["text-input", "nano-banana"]
    assert parse_spec({"note": "x", "nodes": nodes, "edges": edges, "run": ["+g"]}).run == ("+g",)
    # And the ports and param it names are the real ones.
    defs = start.main.node_registry.get_all()
    assert "value" in {param["key"] for param in defs["text-input"]["params"]}
    assert edges[0]["sourceHandle"] in {port["id"] for port in defs["text-input"]["outputPorts"]}
    assert edges[0]["targetHandle"] in {port["id"] for port in defs["nano-banana"]["inputPorts"]}
    assert "propose_change" in _get(start)["next"]["propose"] and "same" in _get(start)["next"]["propose"]


def test_the_boards_part_says_how_to_put_a_board_on_the_canvas(start):
    _board(start, start.active, "mbhint02", "Good Machines")
    defs = start.main.node_registry.get_all()
    board_node = defs["nebula-moodboard"]
    assert "moodboard" in {param["key"] for param in board_node["params"]}
    assert "moodboard" in {port["id"] for port in board_node["outputPorts"]}
    assert "input" in {port["id"] for port in defs["preview"]["inputPorts"]}

    mcp = _get(start)["boards"]["use"]
    for word in ('"definitionId": "nebula-moodboard"', '"moodboard": "<board id>"', '"sourceHandle": "moodboard"',
                 '"definitionId": "preview"', '"targetHandle": "input"'):
        assert word in mcp, word
    cli = _get(start, via="cli")["boards"]["use"]
    for word in ("--add +mb=nebula-moodboard", "--param +mb.moodboard=<board>", "--add +pv=preview",
                 "--wire +mb:moodboard +pv:input"):
        assert word in cli, word
    # No boards, no line about them.
    empty = agent_start.boards_part([], active_project_id=None, project_names={}, via="mcp")
    assert "use" not in empty


def test_the_boards_hint_fits_with_its_rows_in_the_boards_budget(start):
    rows = [{"id": f"mb{i:04d}", "name": f"Board {i}", "projectId": None, "images": 3, "analyzed": True,
             "direction": "quiet coastal mornings, ochre and peach " * 4, "updatedAt": f"2026-10-{i % 28 + 1:02d}"}
            for i in range(200)]
    for via in agent_start.VIAS:
        part = agent_start.boards_part(rows, active_project_id=None, project_names={}, via=via)
        assert part["use"] and part["truncated"] is True
        assert agent_start.size(part) <= agent_start.BUDGETS["boards"] * agent_start.CHARS_PER_TOKEN


def test_next_is_one_line_per_hint_inside_its_budget_and_the_total_still_fits():
    for via in agent_start.VIAS:
        part = agent_start.next_part({"cursor": 123456, "journal": "abcdef012345"}, via=via)
        assert set(part) == {"events", "describe", "build", "propose", "point", "pins"}, set(part)
        assert all("\n" not in value for value in part.values() if isinstance(value, str))
        assert agent_start.size(part) <= agent_start.BUDGETS["next"] * agent_start.CHARS_PER_TOKEN, \
            (via, agent_start.size(part))
    # Every part at its budget, plus the answer's own keys, stays under the total.
    keys = agent_start.size({name: None for name in agent_start.BUDGETS}) - 4 * len(agent_start.BUDGETS)
    assert sum(agent_start.BUDGETS.values()) * agent_start.CHARS_PER_TOKEN + keys \
        < agent_start.TOTAL_TOKENS * agent_start.CHARS_PER_TOKEN


def test_nebula_context_prints_the_first_build_without_apply_help_or_info(start):
    """board -> Preview, then a paid node through propose: the flags, the
    Moodboard node's param and port, and the point line are all printed."""
    from cli.client import NebulaClient
    from cli.commands import context as context_cmd

    _board(start, start.active, "mbcontext02", "Good Machines")
    client = NebulaClient("http://testserver")
    client._client = start.client
    out = io.StringIO()
    with redirect_stdout(out):
        context_cmd.run(client)
    text = out.getvalue()
    for word in ("nebula apply --note", "--add +p=text-input", "--param +p.value=", "--wire +p:text +g:prompt",
                 "--add +mb=nebula-moodboard", "--param +mb.moodboard=<board>", "--wire +mb:moodboard +pv:input",
                 "--run +g", "--set nX.key=value", 'nebula point --say "..."', "nebula point n2 --say"):
        assert word in text, word
    # Under BOARDS, right after the boards.
    boards = text[text.index("BOARDS"):text.index("NODES THAT RUN HERE")]
    assert "nebula-moodboard" in boards


# -- B. one-line argument errors on MCP ---------------------------------------------

def _refused(name: str, arguments: dict, monkeypatch) -> str:
    sent: list = []
    monkeypatch.setattr(mcp_server, "_canvas_call", lambda *args, **kwargs: sent.append(args) or {})
    with pytest.raises(ToolError) as caught:
        asyncio.run(mcp_server.mcp.call_tool(name, arguments))
    assert sent == [], "nothing is sent for a call with wrong arguments"
    message = str(caught.value)
    assert "\n" not in message and "validation error" not in message and "pydantic" not in message, message
    return message


def test_a_guessed_argument_name_gets_one_line_naming_the_real_one(monkeypatch):
    assert _refused("moodboard_get", {"id": "95660c6f4e7d"}, monkeypatch) == \
        "moodboard_get takes board (required), not id. Call moodboard_get(board=...)."
    message = _refused("describe_node", {"id": "nebula-moodboard"}, monkeypatch)
    assert message.startswith("describe_node takes definition_id (required), not id")
    assert "describe_node(definition_id=...)" in message


def test_a_missing_argument_names_what_it_needs(monkeypatch):
    message = _refused("resolve_pin", {"pin_id": "pin_1"}, monkeypatch)
    assert message == "resolve_pin needs reply: it takes pin_id (required), reply (required). " \
                      "Call resolve_pin(pin_id=..., reply=...)."


def test_an_unknown_argument_is_refused_even_beside_the_required_ones(monkeypatch):
    # E1 and E2 sent run_nodes(node_ids=...): it ran the whole canvas, node_ids ignored.
    message = _refused("run_nodes", {"node_ids": '["n2"]'}, monkeypatch)
    assert message.startswith("run_nodes takes node_id, wait_seconds")
    assert "not node_ids (did you mean node_id?)" in message
    assert _refused("describe_node", {"definition_id": "preview", "verbose": True}, monkeypatch).startswith(
        "describe_node takes definition_id (required), not verbose")


def test_a_wrong_type_names_the_argument_and_its_type(monkeypatch):
    message = _refused("point_at", {"x": "left", "y": 0}, monkeypatch)
    assert message.startswith('point_at: x must be a number, not "left". It takes node_id, port, x, y, say')
    assert _refused("edit_canvas", {"nodes": {"ref": "+a"}}, monkeypatch).startswith(
        "edit_canvas: nodes must be a list")


def test_a_long_signature_is_cut_but_keeps_the_close_name(monkeypatch):
    message = _refused("moodboard_update", {"board": "b1", "cover_image": 3}, monkeypatch)
    assert "not cover_image (did you mean cover?)" in message and "more" in message
    assert len(message) < 300, len(message)


def test_every_tool_gets_the_check(monkeypatch):
    for name, tool in _tools().items():
        message = _refused(name, {"zz_not_an_argument": 1}, monkeypatch)
        assert message.startswith(f"{name} takes"), message
        assert "not zz_not_an_argument" in message


def test_the_agent_sees_the_line_as_the_tool_result(monkeypatch):
    """Through the MCP server's own request handler, as a client calls it."""
    from mcp import types

    handler = mcp_server.mcp._mcp_server.request_handlers[types.CallToolRequest]
    request = types.CallToolRequest(method="tools/call", params=types.CallToolRequestParams(
        name="moodboard_get", arguments={"id": "abc"}))
    result = asyncio.run(handler(request)).root
    assert result.isError is True
    assert result.content[0].text == "moodboard_get takes board (required), not id. Call moodboard_get(board=...)."


def test_right_arguments_still_reach_the_tool(monkeypatch):
    sent: list = []
    monkeypatch.setattr(mcp_server, "_canvas_call", lambda method, path, ctx, **kwargs: sent.append(path) or {"ok": 1})
    asyncio.run(mcp_server.mcp.call_tool("describe_node", {"definition_id": "preview"}))
    # Claude Desktop sends lists as JSON text; FastMCP parses them, and so does the check.
    asyncio.run(mcp_server.mcp.call_tool("remove_from_canvas", {"node_ids": '["n2"]'}))
    assert sent[0] == "/api/agent/nodes/preview" and len(sent) == 2


# -- B. node and edge shape errors (edit_canvas, propose_change, nebula apply/propose)

def _shape_error(body: dict, *, proposal: bool = False) -> str:
    with pytest.raises(ProposalError) as caught:
        if proposal:
            parse_spec({"note": "x", **body})
        else:
            parse_edit(body)
    message = str(caught.value.detail if hasattr(caught.value, "detail") else caught.value)
    assert "\n" not in message, message
    return message


@pytest.mark.parametrize("key", ["type", "definition", "kind", "definition_id", "nodeType"])
@pytest.mark.parametrize("proposal", [False, True])
def test_a_node_typed_under_another_key_names_definition_id(key, proposal):
    message = _shape_error({"nodes": [{"ref": "+mb", key: "nebula-moodboard"}]}, proposal=proposal)
    assert message.startswith("nodes[0].definitionId must be a node definition id")
    assert f"not {key}" in message and '"definitionId": "nebula-moodboard"' in message


@pytest.mark.parametrize("edge,named", [
    ({"from": "+mb.moodboard", "to": "+pv.input"}, "from/to"),
    ({"source": "+mb", "sourcePort": "moodboard", "target": "+pv", "targetPort": "input"}, "sourcePort/targetPort"),
])
@pytest.mark.parametrize("proposal", [False, True])
def test_a_wire_in_another_shape_names_the_four_fields(edge, named, proposal):
    nodes = [{"ref": "+mb", "definitionId": "nebula-moodboard"}, {"ref": "+pv", "definitionId": "preview"}]
    message = _shape_error({"nodes": nodes, "edges": [edge]}, proposal=proposal)
    assert message.startswith("edges[0] ")
    assert "{source, sourceHandle, target, targetHandle}" in message and f"not {named}" in message
    assert '"source": "+mb", "sourceHandle": "moodboard"' in message


@pytest.mark.parametrize("proposal", [False, True])
def test_a_node_placed_with_x_and_y_is_told_to_use_position(proposal):
    # E1 and E2 sent "x": 0 on their nodes; it was dropped without a word.
    message = _shape_error({"nodes": [{"ref": "+pv", "definitionId": "preview", "x": 0, "y": 40}]},
                           proposal=proposal)
    assert message.startswith("nodes[0] ") and 'position {"x": 0, "y": 40}' in message, message


@pytest.mark.parametrize("key", ["name", "label", "title"])
@pytest.mark.parametrize("proposal", [False, True])
def test_a_node_named_inline_is_told_to_use_rename(key, proposal):
    message = _shape_error({"nodes": [{"ref": "+g", "definitionId": "preview", key: "Lake hero"}]},
                           proposal=proposal)
    assert message.startswith("nodes[0] ") and 'rename={"+g": "Lake hero"}' in message, message


@pytest.mark.parametrize("proposal", [False, True])
def test_any_other_unknown_node_field_is_refused_with_the_node_shape(proposal):
    message = _shape_error({"nodes": [{"ref": "+g", "definitionId": "preview", "colour": "red"}]},
                           proposal=proposal)
    assert "unknown field 'colour'" in message and "{ref, definitionId, params, position}" in message, message


def test_the_node_field_refusals_are_counted_as_usage_errors():
    from tests.test_count_agent_turns import _load

    counter = _load()
    for node in ({"x": 0, "y": 0}, {"name": "Hero"}, {"colour": "red"}):
        with pytest.raises(ProposalError) as caught:
            parse_edit({"nodes": [{"ref": "+g", "definitionId": "preview", **node}]})
        call = counter.Call("mcp__nebula__edit_canvas", "")
        counter.classify(call, {}, f"Error executing tool edit_canvas: {caught.value.detail}", True)
        assert call.kind == "usage-error", caught.value.detail


def test_an_unwire_in_another_shape_names_the_four_fields():
    message = _shape_error({"unwire": [{"from": "n1.text", "to": "n2.prompt"}]})
    assert message.startswith("unwire[0] ") and "{source, sourceHandle, target, targetHandle}" in message


def test_a_bad_wire_end_keeps_its_own_error():
    nodes = [{"ref": "+mb", "definitionId": "nebula-moodboard"}]
    message = _shape_error({"nodes": nodes, "edges": [
        {"source": "+zz", "sourceHandle": "moodboard", "target": "n4", "targetHandle": "x"}]})
    assert "is not one of this proposal's new nodes" in message


# -- C. narrate without a target -----------------------------------------------------

AGENT = {"X-Nebula-Agent": "Claude Code"}


def test_say_alone_with_no_cursor_and_no_view_goes_to_the_origin(api):  # noqa: F811
    client, graph, sent = api
    response = client.post("/api/canvas/cursor", json={"say": "Reading your board"}, headers=AGENT)
    assert response.status_code == 200, response.text
    assert response.json()["target"] == {"x": 0.0, "y": 0.0} and response.json()["placed"] == "origin"
    (event,) = _presence_events(sent)
    assert event["target"] == {"x": 0.0, "y": 0.0} and event["say"] == "Reading your board"


def test_say_alone_with_no_cursor_goes_to_the_middle_of_the_persons_view(api):  # noqa: F811
    client, graph, sent = api
    client.post("/api/canvas/view", json={"viewport": {"x": -100, "y": -50, "zoom": 2},
                                           "screen": {"width": 1000, "height": 600}, "nodes": []})
    response = client.post("/api/canvas/cursor", json={"say": "Starting"}, headers=AGENT).json()
    # Visible area: x 50..550, y 25..325 in flow coordinates.
    assert response["target"] == {"x": 300.0, "y": 175.0} and response["placed"] == "view"


def test_say_alone_stays_at_the_agents_cursor(api):  # noqa: F811
    client, graph, sent = api
    node_id = graph.add_node("text-input", {"value": "hi"})
    client.post("/api/canvas/view", json={"viewport": {"x": 0, "y": 0, "zoom": 1},
                                           "screen": {"width": 800, "height": 600}, "nodes": []})
    client.post("/api/canvas/cursor", json={"target": {"nodeId": node_id, "handle": "text"}}, headers=AGENT)
    response = client.post("/api/canvas/cursor", json={"say": "Wiring it next"}, headers=AGENT).json()
    assert response["target"] == {"nodeId": node_id, "handle": "text"} and response["placed"] == "cursor"
    first, second = _presence_events(sent)
    assert second["target"] == first["target"] and second["say"] == "Wiring it next"
    (cursor,) = client.get("/api/canvas/snapshot").json()["agents"]
    assert cursor["target"] == {"nodeId": node_id, "handle": "text"} and cursor["say"] == "Wiring it next"


def test_no_target_and_nothing_to_say_is_one_actionable_line(api):  # noqa: F811
    client, graph, sent = api
    for body in ({}, {"say": "   "}, {"from": {"x": 1, "y": 2}, "say": "drag"}):
        response = client.post("/api/canvas/cursor", json=body, headers=AGENT)
        assert response.status_code == 422, body
        assert "target" in response.json()["detail"]
    assert _presence_events(sent) == []


def test_mcp_point_at_say_alone_sends_no_target(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(mcp_server, "_canvas_call",
                        lambda method, path, ctx, **kwargs: calls.append(kwargs["json"]) or {"placed": "cursor"})
    mcp_server.point_at(say="Reading your board")
    assert calls == [{"say": "Reading your board", "action": "move"}]
    with pytest.raises(ValueError, match="say"):
        mcp_server.point_at()
    assert "without node_id" in mcp_server.point_at.__doc__ or "With only `say`" in mcp_server.point_at.__doc__


def test_cli_point_say_alone_sends_no_target(monkeypatch):
    from cli.__main__ import build_parser
    from cli.commands import canvas

    args = build_parser().parse_args(["point", "--say", "Reading your board"])
    assert args.target is None

    class Client:
        body = None

        def point_cursor(self, body, agent_name=None):
            Client.body = body
            return {"agent": {"name": "Claude Code"}, "target": {"x": 0, "y": 0}, "say": body["say"],
                    "placed": "cursor"}

    out = io.StringIO()
    with redirect_stdout(out):
        canvas.run_point(Client(), None, say="Reading your board")
    assert Client.body == {"say": "Reading your board", "action": "move"}
    assert out.getvalue().strip() == "Claude Code (where its cursor is): Reading your board"


def test_cli_point_with_neither_is_one_actionable_usage_line(monkeypatch):
    import sys

    from cli import __main__ as cli_main

    monkeypatch.setattr(sys, "argv", ["nebula", "point"])
    err = io.StringIO()
    with redirect_stderr(err), pytest.raises(SystemExit) as stopped:
        cli_main.main()
    assert stopped.value.code == 2
    last = err.getvalue().strip().splitlines()[-1]
    assert last.startswith("nebula point: error: ") and "--say" in last and "target" in last


# -- Adversarial review ------------------------------------------------------------

def test_the_board_read_call_is_given_with_one_small_board(start):
    """With a board or two nothing is cut, and the answer still says how to
    read one, with the argument named as moodboard_get takes it."""
    _board(start, start.active, "mbread01", "Good Machines")
    part = _get(start)["boards"]
    assert "truncated" not in part
    assert 'moodboard_get(board="' in part["read"], part
    # start_here sends the answer as JSON text, where the quote is escaped.
    assert 'moodboard_get(board=\\"' in json.dumps(_get(start), ensure_ascii=False)
    assert "`nebula moodboard show <id>`" in _get(start, via="cli")["boards"]["read"]

    from cli.client import NebulaClient
    from cli.commands import context as context_cmd

    client = NebulaClient("http://testserver")
    client._client = start.client
    out = io.StringIO()
    with redirect_stdout(out):
        context_cmd.run(client)
    boards = out.getvalue()[out.getvalue().index("BOARDS"):out.getvalue().index("NODES THAT RUN HERE")]
    assert "nebula moodboard show <id>" in boards
    # No boards, no read line either.
    assert "read" not in agent_start.boards_part([], active_project_id=None, project_names={}, via="mcp")


def test_a_wire_with_no_ports_names_the_ports_of_its_ends(start):
    """{source, target} with no handles: the line names the ports each end
    has, as a wrong port name's error does, for new refs and canvas nodes."""
    preview = start.graph.add_node("preview", {}, position={"x": 0, "y": 0})
    nodes = [{"ref": "+mb", "definitionId": "nebula-moodboard", "params": {"moodboard": "mbx"}}]
    for path in ("/api/graph/apply", "/api/canvas/proposals"):
        body = {"note": "x", "nodes": nodes, "edges": [{"source": "+mb", "target": preview}]}
        response = start.client.post(path, headers=CLAUDE, json=body)
        assert response.status_code == 422, (path, response.text)
        detail = response.json()["detail"]
        assert detail.startswith("edges[0].sourceHandle must be a port id"), detail
        assert "Valid outputPorts on +mb (nebula-moodboard): ['moodboard'" in detail, detail
        body["edges"] = [{"source": "+mb", "sourceHandle": "moodboard", "target": preview}]
        detail = start.client.post(path, headers=CLAUDE, json=body).json()["detail"]
        assert detail.startswith("edges[0].targetHandle must be a port id"), detail
        assert f"Valid inputPorts on {preview} (preview): ['input'" in detail, detail
    # Without a graph to ask (the parser alone), the plain line stays.
    assert _shape_error({"nodes": nodes, "edges": [{"source": "+mb", "target": "n9"}]}) == \
        "edges[0].sourceHandle must be a port id"


def test_cli_wire_without_a_port_gets_the_ports_from_the_server(start):
    from cli.plan import build_body

    body = build_body(add=["+mb=nebula-moodboard", "+pv=preview"], param=["+mb.moodboard=mbx"],
                      wire=[["+mb", "+pv:input"]])
    assert body["edges"] == [{"source": "+mb", "target": "+pv", "targetHandle": "input"}]
    detail = start.client.post("/api/graph/apply", headers=CLAUDE, json={"note": "x", **body}).json()["detail"]
    assert "Valid outputPorts on +mb (nebula-moodboard): ['moodboard'" in detail, detail


def test_shape_errors_stay_short_whatever_the_node_or_wire_holds():
    """The hints copy the agent's node or wire back, but never its whole size."""
    huge = "data:image/png;base64," + "A" * 200_000
    for proposal in (False, True):
        message = _shape_error({"nodes": [{"ref": "+g", "type": "nano-banana",
                                           "params": {"prompt": "p", "image": huge}}]}, proposal=proposal)
        assert len(message) < 400, len(message)
        assert '"definitionId": "nano-banana"' in message and '"image"' in message and "AAAA" not in message
        message = _shape_error({"nodes": [{"ref": "+g", "type": "x" * 50_000}]}, proposal=proposal)
        assert len(message) < 400, len(message)
        message = _shape_error({"nodes": [{"ref": "+g", "type": "nano-banana",
                                           "params": {f"key{i}": i for i in range(5_000)}}]}, proposal=proposal)
        assert len(message) < 400, len(message)
        message = _shape_error({"nodes": [{"ref": "+g", "definitionId": "preview"}],
                                "edges": [{"from": "+g." + "p" * 50_000, "to": "n2.input"}]}, proposal=proposal)
        assert len(message) < 400 and "not from/to" in message, len(message)


def test_point_at_with_half_a_point_is_counted_as_a_usage_error():
    """The counter's patterns know both point_at refusals and the node ref one."""
    from tests.test_count_agent_turns import _load

    counter = _load()

    messages = []
    for kwargs in ({"x": 1}, {"y": 2}, {}):
        with pytest.raises(ValueError) as caught:
            mcp_server.point_at(**kwargs)
        messages.append(("point_at", str(caught.value)))
    with pytest.raises(ProposalError) as caught:
        parse_edit({"nodes": [{"type": "nano-banana", "params": {}}]})
    messages.append(("edit_canvas", caught.value.detail))
    for tool, message in messages:
        call = counter.Call(f"mcp__nebula__{tool}", "")
        counter.classify(call, {}, f"Error executing tool {tool}: {message}", True)
        assert call.kind == "usage-error", message
