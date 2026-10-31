"""An agent's first turn in one call: GET /api/agent/start, MCP `start_here`
and `nebula context` (plan v2.7, PR26, §5.10.1).

GM's headless run on 2026-10-20 spent 8 of its 16 turns finding its way
(docs/agent-runs/2026-10-20-cli-headless.md). The start call gives a first
turn the canvas, pins, proposals, every board, the node types that run here
with prices and the spend limits at once, each part inside its own budget.
"""
from __future__ import annotations

import asyncio
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.selection_context import SelectionContextStore
from tests.conftest import PERSON

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
# Part budgets in tokens, counted as characters / 4 (plan §5.10.1).
BUDGETS = {"canvas": 2500, "pins": 400, "proposals": 300, "boards": 800, "nodes": 2500, "spend": 150, "next": 300}
TOTAL_CHARS = 28_000
PARTS = ["canvas", "pins", "proposals", "boards", "nodes", "spend", "next"]


def _size(value) -> int:
    return len(json.dumps(value, ensure_ascii=False))


class _Krea:
    def status(self):
        return {"status": "disconnected"}


@pytest.fixture
def start(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        active = make_project("Good Machines")
        other = make_project("Client work")
        gone = make_project("Old pitch")
        for project in (active, other, gone):
            catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = active["id"]
        store.commit(catalog)
    boards = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(boards))

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module, "_krea_connector", lambda: _Krea())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.main = main_module
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.store = store
    ctx.boards = boards
    ctx.active, ctx.other, ctx.gone = active["id"], other["id"], gone["id"]
    ctx.tmp = tmp_path
    return ctx


def _board(ctx, scope: str, board_id: str, name: str, *, updated: str = "2026-10-20T10:00:00+00:00",
           images: int = 3, analyzed: bool = True, direction: str = "", **extra) -> Path:
    folder = ctx.boards / scope
    folder.mkdir(parents=True, exist_ok=True)
    board = {
        "id": board_id, "name": name, "version": 1, "mode": "look", "strength": 0.7,
        "notes": "", "direction": direction, "avoid": [], "projectId": None if scope == "_global" else scope,
        "images": [{"id": f"{board_id}-{i}", "url": f"/api/outputs/{board_id}-{i}.png", "weight": 1.0,
                    "notes": "", "excluded": False} for i in range(images)],
        "analysis": {"colors": [{"hex": "#123456"}]} if analyzed else None,
        "createdAt": updated, "updatedAt": updated,
        **extra,
    }
    path = folder / f"{board_id}.json"
    path.write_text(json.dumps(board))
    return path


def _get(ctx, via: str | None = None, headers=CLAUDE) -> dict:
    # The CLI says so on every request (X-Nebula-Surface), the one signal
    # (services/agent_words; review 10 of PR #203, NIT-4).
    if via == "cli":
        headers = {**(headers or {}), "X-Nebula-Surface": "cli"}
    response = ctx.client.get("/api/agent/start", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_start_here_returns_canvas_pins_proposals_boards_nodes_spend(start):
    ctx = start
    prompt = ctx.graph.add_node("text-input", {"value": "a quiet lake at dawn"}, position={"x": 0, "y": 0})
    image = ctx.graph.add_node("nano-banana", {"aspect_ratio": "16:9"}, position={"x": 450, "y": 0})
    ctx.graph.connect(prompt, "text", image, "prompt")
    ctx.client.post("/api/canvas/selection", json={"nodeIds": [image]})
    pin = ctx.client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer light", "nodeId": image})
    assert pin.status_code == 201, pin.text
    done = ctx.client.post("/api/canvas/pins", headers=PERSON, json={"text": "older ask", "nodeId": prompt}).json()
    ctx.client.post(f"/api/canvas/pins/{done['pin']['id']}/resolve",
                    headers={"X-Nebula-Agent": "Codex"}, json={"reply": "SECRET-REPLY-HISTORY"})
    proposed = ctx.client.post("/api/canvas/proposals", headers={"X-Nebula-Agent": "Codex"}, json={
        "note": "Upscale the take", "nodes": [{"ref": "+up", "definitionId": "preview"}],
        "edges": [{"source": image, "sourceHandle": "image", "target": "+up", "targetHandle": "input"}]})
    assert proposed.status_code == 201, proposed.text
    ctx.client.post("/api/canvas/cursor", headers={"X-Nebula-Agent": "Codex"},
                    json={"target": {"nodeId": prompt}, "say": "looking"})
    _board(ctx, ctx.active, "mbcurrent01", "Good Machines", direction="quiet coastal mornings, ochre and peach")
    _board(ctx, "_global", "mbglobal001", "House style", analyzed=False, images=5)
    _board(ctx, ctx.other, "mbother0001", "Client board")
    trash = ctx.boards / ".trash"
    trash.mkdir(parents=True)
    (trash / "mbtrashed01.json").write_text(json.dumps({"id": "mbtrashed01", "name": "Deleted board"}))

    answer = _get(ctx)

    assert list(answer) == PARTS
    canvas = answer["canvas"]
    assert canvas["project"] == {"id": ctx.active, "name": "Good Machines"}
    assert canvas["view"]["stale"] is True
    assert canvas["selection"] == [image]
    assert canvas["nodeCount"] == 2 and not canvas.get("truncated")
    first, second = canvas["nodes"]
    assert first["id"] == image  # selected first
    assert first["definitionId"] == "nano-banana" and first["inputsFrom"] == [f"{prompt}.text→prompt"]
    assert second["params"] == {"value": "a quiet lake at dawn"} and second["state"] == "unknown"
    # Other agents' cursors, never the caller's own.
    assert [agent["name"] for agent in canvas["agents"]] == ["Codex"]

    pins = answer["pins"]
    assert pins["openCount"] == 1
    assert pins["open"] == [{"id": pin.json()["pin"]["id"], "text": "warmer light", "anchor": {"nodeId": image}}]

    proposals = answer["proposals"]
    assert proposals["count"] == 1
    assert proposals["open"][0]["note"] == "Upscale the take" and proposals["open"][0]["agent"] == "Codex"

    boards = answer["boards"]
    assert boards["count"] == 3  # the board in Recently deleted is left out
    assert [(row["id"], row["where"]) for row in boards["rows"]] == [
        ("mbcurrent01", "current"), ("mbglobal001", "global"), ("mbother0001", "Client work")]
    current = boards["rows"][0]
    assert current == {"id": "mbcurrent01", "name": "Good Machines", "where": "current", "images": 3,
                       "analyzed": True, "direction": "quiet coastal mornings, ochre and peach"}
    assert boards["rows"][1]["analyzed"] is False and boards["rows"][1]["images"] == 5

    nodes = answer["nodes"]
    assert nodes["byCategory"]["utility"]["text-input"] == "free"
    assert nodes["byCategory"]["moodboard"]["nebula-moodboard"] == "free"
    assert nodes["ready"] >= 3 and "prices" in nodes

    spend = answer["spend"]
    assert spend["budget"] == "shared" and "perRunUsd" in spend and "usedUsd" in spend
    assert "kreaPlanRuns" in spend

    nxt = answer["next"]
    assert nxt["events"]["journal"] == ctx.main.canvas_events.journal_id
    assert isinstance(nxt["events"]["cursor"], int)
    assert "describe_node" in nxt["describe"] and "propose_change" in nxt["propose"]
    assert "resolve_pin" in nxt["pins"]

    text = json.dumps(answer)
    assert "SECRET-REPLY-HISTORY" not in text and "older ask" not in text


def test_no_private_note_image_note_or_board_note_goes_in(start):
    ctx = start
    _board(ctx, ctx.active, "mbprivate01", "Private test", notes="SECRET-BOARD-NOTE", images=0)
    path = ctx.boards / ctx.active / "mbprivate01.json"
    board = json.loads(path.read_text())
    board["images"] = [{"id": "img1", "url": "/api/outputs/a.png", "weight": 1, "notes": "SECRET-IMAGE-NOTE",
                        "privateNote": "SECRET-PRIVATE-NOTE", "excluded": False}]
    board["briefOverride"] = {"text": "SECRET-OVERRIDE", "by": "person"}
    path.write_text(json.dumps(board))

    text = json.dumps(_get(ctx))

    assert "Private test" in text
    for secret in ("SECRET-BOARD-NOTE", "SECRET-IMAGE-NOTE", "SECRET-PRIVATE-NOTE", "SECRET-OVERRIDE"):
        assert secret not in text


def test_boards_list_every_project_but_not_a_trashed_project_or_the_trash(start):
    ctx = start
    with ctx.store.transaction() as catalog:
        from services.project_store import move_to_trash

        move_to_trash(catalog, ctx.gone)
        ctx.store.commit(catalog)
    _board(ctx, ctx.gone, "mbgone00001", "From a deleted project")
    _board(ctx, ctx.other, "mbolder0001", "Older", updated="2026-10-01T10:00:00+00:00")
    _board(ctx, ctx.other, "mbnewer0001", "Newer", updated="2026-10-19T10:00:00+00:00")
    _board(ctx, "_global", "mbglobal002", "Global, older", updated="2026-09-01T10:00:00+00:00")
    (ctx.boards / ".notes").mkdir()
    (ctx.boards / ".notes" / "mbnewer0001.json").write_text(json.dumps({"id": "x", "name": "a side file"}))

    rows = _get(ctx)["boards"]["rows"]

    # Global before other projects; inside a group, the newest edit first.
    assert [row["id"] for row in rows] == ["mbglobal002", "mbnewer0001", "mbolder0001"]
    assert "a side file" not in json.dumps(rows)


def test_moodboard_store_summaries_read_names_and_counts(start):
    from services.moodboard_store import MoodboardStore

    ctx = start
    _board(ctx, ctx.other, "mbsumm00001", "Summary", images=4, direction="x" * 300, notes="hidden")
    rows = MoodboardStore().summaries()
    assert rows == [{"id": "mbsumm00001", "name": "Summary", "projectId": ctx.other, "images": 4,
                     "analyzed": True, "direction": "x" * 300, "updatedAt": "2026-10-20T10:00:00+00:00"}]


def _big_canvas(ctx, nodes: int = 300, boards: int = 200) -> None:
    long_text = "a very long prompt about a quiet lake at dawn, mist over the water, " * 8
    ids = []
    for index in range(nodes):
        if index % 3 == 0:
            ids.append(ctx.graph.add_node("text-input", {"value": f"{index} {long_text}"},
                                          position={"x": index * 10, "y": 0}))
        else:
            ids.append(ctx.graph.add_node("nano-banana", {
                "aspect_ratio": "16:9", "imageSize": "2K", "temperature": 0.7, "seed": index,
                "numberOfImages": 2, "outputFormat": "png", "personGeneration": "allow_all",
                "safetyLevel": "block_none", "thinking": "high"}, position={"x": index * 10, "y": 300}))
        if index % 3 == 1:
            ctx.graph.connect(ids[index - 1], "text", ids[index], "prompt")
    ctx.client.post("/api/canvas/selection", json={"nodeIds": ids[200:205]})
    ctx.main.agent_presence.report_view({
        "viewport": {"x": 0, "y": 0, "zoom": 1}, "screen": {"width": 1440, "height": 900},
        "nodes": [{"id": node_id, "x": i * 10, "y": 0 if i % 3 == 0 else 300, "width": 300, "height": 200}
                  for i, node_id in enumerate(ids)]})
    for index in range(30):
        ctx.client.post("/api/canvas/pins", headers=PERSON, json={
            "text": f"pin {index} " + "make the lake heavier and the light warmer " * 6, "nodeId": ids[index]})
    for agent in ("Codex", "Claude Code", "Hermes", "Cursor"):
        for index in range(3):
            made = ctx.client.post("/api/canvas/proposals", headers={"X-Nebula-Agent": agent}, json={
                "note": (f"{agent} {index} " + "upscale the hero take and warm it " * 5)[:160],
                "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": "x"}}]})
            assert made.status_code == 201, made.text
    projects = [ctx.active, "_global", ctx.other]
    for index in range(boards):
        _board(ctx, projects[index % 3], f"mbbig{index:06d}",
               f"Board {index} " + "with a long descriptive name for the moodboard " * 3,
               updated=f"2026-10-{(index % 28) + 1:02d}T10:00:00+00:00",
               direction="quiet coastal mornings, ochre and peach, painterly brushwork " * 4)


def test_start_here_stays_under_budget_with_300_nodes_and_200_boards(start, monkeypatch):
    ctx = start
    from services import node_readiness

    # Every definition ready to run here, the largest node list there is.
    monkeypatch.setattr(node_readiness, "node_access", lambda *args, **kwargs: "key")
    _big_canvas(ctx)

    for via in ("mcp", "cli"):
        answer = _get(ctx, via=via)
        assert _size(answer) < TOTAL_CHARS, _size(answer)
        for part, tokens in BUDGETS.items():
            assert _size(answer[part]) <= tokens * 4, (part, _size(answer[part]))

    canvas = answer["canvas"]
    assert canvas["nodeCount"] == 300 and canvas["truncated"] is True
    assert canvas["nodes"][0]["id"] in canvas["selection"]
    full = canvas["nodes"]
    assert 0 < len(full) <= 60
    assert all(len(full_node.get("params") or {}) <= 8 for full_node in full)
    assert all(len(json.dumps(value, ensure_ascii=False).strip('"')) <= 60
               for node in full for value in (node.get("params") or {}).values())
    assert canvas["others"] and len(full) + len(canvas["others"]) < 300


def test_truncated_parts_say_where_the_rest_is(start, monkeypatch):
    ctx = start
    from services import node_readiness

    monkeypatch.setattr(node_readiness, "node_access", lambda *args, **kwargs: "key")
    _big_canvas(ctx)

    mcp = _get(ctx)
    assert mcp["canvas"]["more"] == "look_at_canvas gives every node"
    assert mcp["pins"]["openCount"] == 30 and len(mcp["pins"]["open"]) <= 10
    assert "look_at_canvas" in mcp["pins"]["more"]
    assert mcp["proposals"]["count"] == 12 and len(mcp["proposals"]["open"]) <= 5
    assert mcp["boards"]["count"] == 200 and len(mcp["boards"]["rows"]) <= 30
    assert mcp["boards"]["more"] == 'moodboard_list(project_id="<project-id>") lists a project\'s boards and Global\'s'
    assert mcp["boards"]["read"] == 'moodboard_get(board="<id or exact name>") gives one in full'
    assert all(len(row.get("direction") or "") <= 80 for row in mcp["boards"]["rows"])
    # Current project first, then Global.
    ranks = [{"current": 0, "global": 1}.get(row["where"], 2) for row in mcp["boards"]["rows"]]
    assert ranks == sorted(ranks) and ranks[0] == 0
    assert mcp["nodes"]["truncated"] is True and mcp["nodes"]["more"] == "find_nodes(category=…) gives the rest"
    assert sum(mcp["nodes"]["rest"].values()) + sum(len(ids) for ids in mcp["nodes"]["byCategory"].values()) \
        == mcp["nodes"]["ready"]

    cli = _get(ctx, via="cli")
    assert cli["canvas"]["more"] == "`nebula look` gives every node"
    assert cli["boards"]["more"] == \
        "`nebula moodboard list --project <project-id>` lists a project's boards and Global's"
    assert cli["boards"]["read"] == "`nebula moodboard show <id>` gives one in full"
    assert cli["nodes"]["more"] == "`nebula nodes --category <category>` lists the rest with prices"
    assert "nebula info" in cli["next"]["describe"]


def test_spend_shows_what_the_budget_it_runs_against_has_used(start, monkeypatch):
    """Every outside agent (no Nebula chat token) shares one 24-hour budget, and an app with a token
    and a personal agent count inside it too: the shared part reports that budget's use, not only the
    caller's own line, or an agent plans a run the limit will refuse."""
    from services import agent_spend

    ctx = start
    ledger = agent_spend.SpendLedger(None)
    monkeypatch.setattr(ctx.main, "agent_spend_ledger", ledger)
    monkeypatch.setattr(ctx.main, "load_settings", lambda: {
        "runCostConfirmUsd": 1.0, "agentSpend": {"sessionUsd": 5.0, "outsideDailyUsd": 3.0, "kreaPlanRuns": 4}})
    ledger.record(agent_spend.OUTSIDE_SHARED, "Codex", {"gpt-image-2-generate": 1.25}, {"krea-2-generate": 1})
    ledger.record(f"{agent_spend.PERSONAL_AGENT_PREFIX}hermes", "Hermes", {"nano-banana": 0.5})

    spend = _get(ctx)["spend"]  # Claude Code, an outside agent with no token: the shared budget

    assert spend["budget"] == "shared" and spend["limitUsd"] == 3.0
    assert spend["usedUsd"] == pytest.approx(1.75)
    assert spend["kreaPlanRuns"] == {"used": 1, "limit": 4}


def test_spend_for_an_app_gives_its_own_line_and_the_shared_budget():
    from cli.formatter import format_start
    from services import agent_start

    status = {"limited": True, "budget": "app", "window": "24h",
              "limits": {"perRunUsd": 1.0, "sessionUsd": 5.0, "outsideDailyUsd": 3.0, "appDailyUsd": 2.0,
                         "kreaPlanRuns": 4, "models": {}},
              "spent": {"totalUsd": 0.5, "models": {}, "kreaPlanRuns": 0},
              "outsideSpent": {"totalUsd": 2.5, "models": {}, "kreaPlanRuns": 3}}
    part = agent_start.spend_part(status)
    assert part["limitUsd"] == 2.0 and part["usedUsd"] == 0.5
    assert part["sharedLimitUsd"] == 3.0 and part["sharedUsedUsd"] == 2.5
    assert part["kreaPlanRuns"] == {"used": 3, "limit": 4}
    assert _size(part) <= BUDGETS["spend"] * 4
    text = format_start({"spend": part})
    assert "every outside agent together $2.50 of $3.00" in text

    chat = agent_start.spend_part({**status, "budget": "chat", "outsideSpent": None})
    assert chat["limitUsd"] == 5.0 and chat["usedUsd"] == 0.5 and "sharedUsedUsd" not in chat


def test_the_surface_header_is_the_one_signal(start):
    """The hints follow X-Nebula-Surface wherever it is sent (review 10 of
    PR #203, NIT-4): a `via` query beside it names nothing, and a surface
    Nebula doesn't know reads MCP words. An older CLI's `?via=cli` with no
    header at all reads as the CLI (review 11, LOW-1; test_idol_round12)."""
    assert "`nebula " not in json.dumps(_get(start)) and "`nebula " in json.dumps(_get(start, via="cli"))
    for headers, params in (({**CLAUDE, "X-Nebula-Surface": "telnet"}, None),
                            ({**CLAUDE, "X-Nebula-Surface": "mcp"}, {"via": "cli"})):
        response = start.client.get("/api/agent/start", params=params, headers=headers)
        assert response.status_code == 200
        assert "`nebula " not in response.text and "describe_node" in response.text


def test_start_here_over_mcp_returns_the_route_as_compact_text(start, monkeypatch):
    import mcp_server
    from nebula_api import NebulaAPI

    ctx = start
    ctx.graph.add_node("text-input", {"value": "a lake"})
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=ctx.client))
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")

    content = asyncio.run(mcp_server.mcp.call_tool("start_here", {}))
    blocks = content[0] if isinstance(content, tuple) else content
    assert len(blocks) == 1 and blocks[0].type == "text"
    answer = json.loads(blocks[0].text)
    assert answer == _get(ctx)
    # No second, structured copy of the answer for the client to show.
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    assert tools["start_here"].outputSchema is None
    assert tools["start_here"].annotations.readOnlyHint is True


def test_nebula_context_json_equals_the_route(start, monkeypatch):
    from cli.client import NebulaClient
    from cli.commands import context as context_cmd

    ctx = start
    ctx.graph.add_node("text-input", {"value": "a lake"})
    _board(ctx, ctx.active, "mbcontext01", "Good Machines")
    client = NebulaClient("http://testserver")
    client._client = ctx.client

    out = io.StringIO()
    with redirect_stdout(out):
        context_cmd.run(client, as_json=True)
    assert json.loads(out.getvalue()) == _get(ctx, via="cli", headers=None)

    out = io.StringIO()
    with redirect_stdout(out):
        context_cmd.run(client)
    text = out.getvalue()
    assert "Good Machines" in text and "text-input" in text and "mbcontext01" in text
    assert "nebula info" in text


MCP_TOOL_NAMES = ("start_here", "look_at_canvas", "find_nodes", "describe_node", "propose_change", "moodboard_get",
                  "wait_for_canvas_change", "resolve_pin", "get_spend_limits", "edit_canvas")


def test_the_cli_answer_names_no_mcp_tool(start, monkeypatch):
    """`nebula context` is read by agents with only a shell: every hint and note names a `nebula` command."""
    ctx = start
    from services import node_readiness

    monkeypatch.setattr(node_readiness, "node_access", lambda *args, **kwargs: "key")
    _big_canvas(ctx)
    text = json.dumps(_get(ctx, via="cli"), ensure_ascii=False)
    assert [name for name in MCP_TOOL_NAMES if name in text] == []
    # The same notes over MCP name the tools.
    mcp = json.dumps(_get(ctx), ensure_ascii=False)
    assert "describe_node" in mcp and "find_nodes" in mcp


def test_every_command_the_cli_answer_names_parses(start, monkeypatch):
    """The hints are commands an agent will copy; each must parse with the real `nebula` parser."""
    import re
    import shlex

    from cli.__main__ import build_parser

    ctx = start
    from services import node_readiness

    monkeypatch.setattr(node_readiness, "node_access", lambda *args, **kwargs: "key")
    _big_canvas(ctx)
    text = json.dumps(_get(ctx, via="cli"), ensure_ascii=False)
    commands = sorted(set(re.findall(r"`(nebula [^`]+)`", text)))
    assert len(commands) >= 6, commands
    filled = {"<id>": "nano-banana", "<pin-id>": "pin_1", "<cursor>": "12", "<journal>": "j1", "<category>": "image",
              "<board>": "mb1", "<node-id>": "n2", '"..."': '"x"', "+ref=<id>": "+g=nano-banana", " ... ": " "}
    for command in commands:
        argv = command
        for placeholder, value in filled.items():
            argv = argv.replace(placeholder, value)
        words = shlex.split(argv)[1:]
        if len(words) == 1 and words[0] in ("info", "propose"):
            continue  # the command named in a sentence, its arguments given beside it
        build_parser().parse_args(words)
