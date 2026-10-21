"""The CLI commands added for agents: long runs, result/cancel, delete,
disconnect, rename, move, projects, spend, and what `nebula context` counts."""
from __future__ import annotations

import asyncio
import threading

import pytest
from fastapi.testclient import TestClient

from cli.client import NebulaClient
from cli.commands import execute, graph, projects, spend
from cli.formatter import format_start, node_access
from models.events import ExecutedEvent


@pytest.fixture
def cli(monkeypatch):
    import main

    release = threading.Event()

    async def slow_execute_graph(*, nodes, emit, run_id, **kwargs):
        await emit(ExecutedEvent(node_id=nodes[0].id, outputs={"text": {"type": "Text", "value": "made"}}, run_id=run_id))
        while not release.is_set():
            await asyncio.sleep(0.01)

    monkeypatch.setattr(main, "execute_graph", slow_execute_graph)
    with TestClient(main.app) as http:
        http.delete("/api/graph?force=true")
        client = NebulaClient()
        client._client = http
        yield client, release
        release.set()
        http.delete("/api/graph?force=true")


def _text_node(client: NebulaClient) -> str:
    return client.create_node("text-input", {"value": "hi"})["id"]


def test_run_returns_still_running_then_result_collects_it(cli, capsys):
    client, release = cli
    node = _text_node(client)
    assert execute.run_node(client, node, wait=0.05) == execute.EXIT_RUNNING
    printed = capsys.readouterr().out
    assert "Still running" in printed and "nebula result " in printed and "nebula cancel " in printed
    run_id = printed.split("(run ")[1].split(")")[0]
    release.set()
    assert execute.run_result(client, run_id, wait=5) == 0
    assert f"{node}: made" in capsys.readouterr().out


def test_cancel_stops_the_run(cli, capsys):
    client, _ = cli
    node = _text_node(client)
    execute.run_node(client, node, wait=0.05)
    run_id = capsys.readouterr().out.split("(run ")[1].split(")")[0]
    assert execute.run_cancel(client, run_id) == 0
    assert "Stopping run" in capsys.readouterr().out
    assert execute.run_result(client, run_id, wait=5) == execute.EXIT_CANCELLED
    assert f"{node}: made" in capsys.readouterr().out


def test_graph_edits(cli, capsys):
    client, _ = cli
    first, second = _text_node(client), client.create_node("preview", {})["id"]
    port = client.get_node("preview")["inputPorts"][0]["id"]
    client.connect(first, "text", second, port)

    graph.run_disconnect(client, f"{first}:text", f"{second}:{port}")
    assert client.get_graph()["edges"] == []
    with pytest.raises(SystemExit):
        graph.run_disconnect(client, f"{first}:text", f"{second}:{port}")

    graph.run_rename(client, first, "Hero prompt")
    graph.run_move(client, [f"{first}=400,120"])
    saved = next(node for node in client.get_graph()["nodes"] if node["id"] == first)
    assert saved["position"] == {"x": 400.0, "y": 120.0}
    assert "Hero prompt" in capsys.readouterr().out

    graph.run_delete(client, [first, second])
    assert client.get_graph()["nodes"] == []
    with pytest.raises(SystemExit):
        graph.run_move(client, ["n1=left"])


def test_projects_open_refuses_an_unknown_project(cli, capsys):
    client, _ = cli
    projects.run_list(client)
    with pytest.raises(SystemExit):
        projects.run_open(client, "no-such-project")


def test_project_new_opens_a_fresh_project_and_names_the_way_back(cli, capsys, monkeypatch):
    client, _ = cli
    projects.run_new(client, "First")
    first_id = client.list_projects()["activeProjectId"]
    _text_node(client)
    capsys.readouterr()
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    projects.run_new(client, "  Agent sketches ")
    printed = capsys.readouterr().out
    listing = client.list_projects()
    opened = next(p for p in listing["projects"] if p["id"] == listing["activeProjectId"])
    assert opened["name"] == "Agent sketches" and opened["createdBy"]["name"] == "Claude Code"
    assert client.get_graph()["nodes"] == []
    assert "Made and opened Agent sketches" in printed
    assert f"nebula project open {first_id}" in printed and "First is saved" in printed
    with pytest.raises(SystemExit):
        projects.run_new(client, "   ")


def test_clear_refuses_a_canvas_with_nodes_unless_forced(cli, capsys, monkeypatch):
    client, _ = cli
    _text_node(client)
    with pytest.raises(SystemExit) as refused:
        graph.run_clear(client)
    assert refused.value.code == 1
    message = capsys.readouterr().err
    assert "has 1 node" in message and 'nebula project new "<name>"' in message and "--force" in message
    assert len(client.get_graph()["nodes"]) == 1
    # Agents may clear with --force (D3, 2026-10-18): the canvas makes it one
    # undo step, and the CLI says so.
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    graph.run_clear(client, force=True)
    assert client.get_graph()["nodes"] == []
    out = capsys.readouterr().out
    assert "Canvas cleared (1 node removed)" in out and "undo" in out


def test_the_backend_refuses_a_clear_without_force_even_when_the_cli_check_is_skipped(cli, capsys):
    """The 409 is the backend's, not only the CLI's: a node added after the
    CLI looked (or a client that never looks) still needs force."""
    client, _ = cli
    _text_node(client)
    with pytest.raises(SystemExit):
        client.clear_graph()
    err = capsys.readouterr().err
    assert "nebula project new" in err and "--force" in err
    assert len(client.get_graph()["nodes"]) == 1
    client.clear_graph(force=True)
    assert client.get_graph()["nodes"] == []


def test_spend_shows_the_limits_an_agent_works_under(cli, capsys):
    client, _ = cli
    spend.run(client)
    out = capsys.readouterr().out
    # The CLI here has no chat token, so it shares the outside agents' 24-hour budget.
    assert "Per run:" in out and "All agents outside Nebula chats, last 24 hours" in out
    assert "This session:" not in out and "Krea plan runs:" in out


DEFINITIONS = [
    {"id": "text-input", "category": "utility", "apiProvider": "utility", "envKeyName": []},
    {"id": "gpt-image-1-generate", "category": "image-gen", "apiProvider": "openai", "envKeyName": "OPENAI_API_KEY"},
    {"id": "veo-3", "category": "video-gen", "apiProvider": "fal", "envKeyName": "FAL_KEY",
     "directKeyName": ["GOOGLE_VERTEX", "GEMINI_API_KEY"]},
    {"id": "krea-files", "category": "utility", "apiProvider": "krea", "envKeyName": [],
     "params": [{"key": "_kreaAuth", "options": [{"value": "mcp"}]}]},
    {"id": "krea-2-generate", "category": "image-gen", "apiProvider": "krea", "envKeyName": "KREA_API_TOKEN",
     "params": [{"key": "_kreaAuth", "options": [{"value": "api-token"}, {"value": "mcp"}]}]},
    {"id": "nous-portal-universal", "category": "universal", "apiProvider": "nous", "envKeyName": []},
]


@pytest.mark.parametrize("keys, krea, expected", [
    (set(), False, {"text-input": "free", "nous-portal-universal": "nous"}),
    ({"GEMINI_API_KEY"}, False, {"text-input": "free", "veo-3": "key", "nous-portal-universal": "nous"}),
    (set(), True, {"text-input": "free", "krea-files": "krea", "krea-2-generate": "krea", "nous-portal-universal": "nous"}),
    ({"KREA_API_TOKEN", "OPENAI_API_KEY"}, False,
     {"text-input": "free", "gpt-image-1-generate": "key", "krea-2-generate": "key", "nous-portal-universal": "nous"}),
])
def test_node_access_matches_the_canvas(keys, krea, expected):
    found = {n["id"]: node_access(n, keys, krea) for n in DEFINITIONS}
    assert {k: v for k, v in found.items() if v} == expected


def _start_notes(api_keys: dict, krea: bool = False, via: str = "mcp") -> list[str]:
    """The node notes `nebula context` and start_here print (main._start_node_notes)."""
    import main

    context = {"settings": {"apiKeys": api_keys}, "keys": {key for key, value in api_keys.items() if value},
               "krea": krea, "pricing": main.model_pricing.load_pricing().get("nodes") or {},
               "definitions": main.node_registry.get_all()}
    rows = [main._agent_node_row(definition, context) for definition in context["definitions"].values()]
    return main._start_node_notes(rows, context, via)


def test_context_notes_say_what_local_provider_nodes_need():
    """`nebula context` moved onto GET /api/agent/start (plan v2.7, PR26); its
    notes say what the old context legend said."""
    nothing = " ".join(_start_notes({}))
    assert "qc-frame-review" in nothing and "free at the defaults" in nothing
    assert "mode=vision-llm" in nothing and "no list price" in nothing
    assert "mode=jev needs TYPESAFE_API_KEY and is priced per run" in nothing
    assert "cinema-scene" not in nothing  # its base models all need a key, so it isn't ready

    google = " ".join(_start_notes({"GOOGLE_API_KEY": "g"}))
    assert "cinema-scene: default seedream-4-5 needs BYTEPLUS_API_KEY or FAL_KEY; set scene.base.model to nano-banana" in google
    assert "cinema-scene: default" not in " ".join(_start_notes({"FAL_KEY": "f"}))


def test_context_notes_name_krea_plan_billing_and_routes_in_the_callers_words():
    mcp = " ".join(_start_notes({"BFL_API_KEY": "b"}, krea=True))
    assert "_kreaAuth" in mcp and "propose_change" in mcp and "_provider" in mcp and "describe_node" in mcp
    cli = " ".join(_start_notes({"BFL_API_KEY": "b"}, krea=True, via="cli"))
    assert "`nebula propose`" in cli and "`nebula info <id>`" in cli and "propose_change" not in cli


def test_format_start_prints_every_part():
    text = format_start({
        "canvas": {"project": {"id": "p1", "name": "Good Machines"}, "view": {"stale": False}, "selection": ["n2"],
                   "agents": [{"name": "Codex", "target": {"nodeId": "n1"}}], "nodeCount": 3,
                   "nodes": [{"id": "n2", "name": "Hero", "definitionId": "nano-banana", "state": "complete",
                              "inputsFrom": ["n1.text→prompt"], "params": {"aspect_ratio": "16:9"}}],
                   "others": {"n3": "Preview"}, "truncated": True, "more": "`nebula look` gives every node"},
        "pins": {"openCount": 1, "open": [{"id": "pin_1", "text": "warmer", "anchor": {"nodeId": "n2"}}]},
        "proposals": {"count": 0, "open": []},
        "boards": {"count": 1, "rows": [{"id": "mb1", "name": "Dusk", "where": "current", "images": 4,
                                         "analyzed": True, "direction": "quiet"}]},
        "nodes": {"ready": 2, "total": 300, "byCategory": {"utility": {"text-input": "free"},
                                                           "image-gen": {"nano-banana": [0.039, 0.039]}},
                  "runsWith": {"krea": ["krea-3"]}, "notes": ["a note"], "krea": "not signed in"},
        "spend": {"budget": "shared", "perRunUsd": 1.0, "limitUsd": 10, "usedUsd": 0.23, "window": "24h",
                  "kreaPlanRuns": {"used": 0, "limit": 10}},
        "next": {"events": {"cursor": 4, "journal": "j1"}, "describe": "`nebula info <id>`: ...",
                 "propose": "`nebula propose` ...", "pins": "`nebula pin resolve` ..."},
    })
    for expected in ("CANVAS: Good Machines (p1), 3 nodes, open in the browser", "selected: n2",
                     "Codex's cursor is at n1", "n2  Hero (nano-banana) [complete] <- n1.text→prompt",
                     'aspect_ratio="16:9"', "also: n3 Preview", "PINS (1 open)", 'pin_1 on n2: "warmer"',
                     "mb1  Dusk [current] 4 images, analyzed — quiet", "Utility: text-input free",
                     "Image: nano-banana $0.039", "runs with krea: krea-3", "a note",
                     "SPEND: $1.00 per run; shared budget $0.23 of $10 used in the last 24h; Krea plan runs 0 of 10",
                     "Events cursor 4 (journal j1)."):
        assert expected in text, expected
