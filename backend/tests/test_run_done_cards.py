"""Done cards (Q125 item 3): a finished agent run posts one Update.

Justin, 2026-10-24, merge-oks Q125, item 3: "A finished run posts a card with
a thumbnail and Show on canvas, without the agent having to remember to ...
run_nodes completion posts the card." GM - Design, 2026-10-25, built
verbatim:

- Success: Codex finished “Hero shots”. / Codex finished 3 nodes.
- Partial: Codex finished 2 of 3 nodes. “Upscale” failed. With more than one
  failed: Codex finished 2 of 5 nodes. 3 failed.
- Failure: Codex's run of “Hero shots” failed. / Codex's run of 3 nodes failed.
- One button on all of them: Show on canvas.
- Thumbnail: the last node's first output ... Video: its first frame ... Text
  or audio output: no thumbnail. Partial: the last output that succeeded.
  Failure: no thumbnail.
- A failed run gets a card, plus the Agent log line.
- Runs the person starts: no card.
- Flood guard: a new done card for the same node and the same agent replaces
  the older one.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent
from services.agent_status import AgentStatusBook
from services.run_done_cards import done_text, possessive, thumbnail_for
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, api  # noqa: F401 - fixture


@pytest.fixture
def done(api, monkeypatch):  # noqa: F811 - the imported fixture
    """Runs through the real routes with a fake engine: each node makes
    ``outputs[node]`` (default a text) or fails when it is in ``fail``."""
    from services.output import OUTPUT_ROOT

    main = api.main
    monkeypatch.setattr(main, "agent_status", AgentStatusBook(api.clock))
    monkeypatch.setattr(main, "agent_runs", main.AgentRunBook(api.clock))
    outputs: dict[str, dict] = {}
    fail: set[str] = set()

    async def no_measure(*args, **kwargs):
        return {}

    async def fake_execute_graph(*, nodes, edges, emit, run_id, **kwargs):
        broken: set[str] = set()
        for node_id in main.topological_sort(nodes, edges):
            # As the engine does: a node downstream of a failure never starts.
            if any(edge.target == node_id and edge.source in broken for edge in edges):
                broken.add(node_id)
                continue
            await emit(ExecutingEvent(node_id=node_id, run_id=run_id))
            if node_id in fail:
                broken.add(node_id)
                await emit(ErrorEvent(node_id=node_id, error="it broke", run_id=run_id))
            else:
                made = outputs.get(node_id) or {"text": {"type": "Text", "value": "made"}}
                await emit(ExecutedEvent(node_id=node_id, outputs=made, run_id=run_id))

    monkeypatch.setattr(main, "_require_spend_approval", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "_measure_run_inputs", no_measure)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "execute_graph", fake_execute_graph)
    folder = OUTPUT_ROOT / "done-cards"
    folder.mkdir(parents=True, exist_ok=True)
    api.outputs = outputs
    api.fail = fail
    api.folder = folder
    return api


def _image(api, name: str) -> dict:
    path = api.folder / f"{name}.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    return {"image": {"type": "Image", "value": str(path)}}


def _cards(api) -> list[dict]:
    notes = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    return [note for note in notes if note["about"] == "run"]


def _chain(api, labels=("Prompt", "Hero shots", "Upscale")) -> list[str]:
    ids = [api.graph.add_node("text-input" if index == 0 else "combine-text", {}) for index in range(len(labels))]
    for index, label in enumerate(labels):
        api.graph.set_label(ids[index], label)
    for source, target in zip(ids, ids[1:]):
        api.graph.connect(source, "text", target, "text1")
    return ids


def _run(api, headers=CLAUDE, target: str | None = None) -> dict:
    response = api.client.post("/api/graph/run", headers=headers, json={"targetNodeId": target} if target else {})
    assert response.status_code == 200, response.text
    return response.json()


# -- the copy (GM, verbatim) ---------------------------------------------------------------

def test_the_copy():
    one = {"n1": "Hero shots"}
    three = {"n1": "Prompt", "n2": "Hero shots", "n3": "Upscale"}
    assert done_text("Codex", one, ["n1"], succeeded=["n1"], failed=[]) == ("Codex finished “Hero shots”.", "success")
    assert done_text("Codex", three, list(three), succeeded=list(three), failed=[]) == (
        "Codex finished 3 nodes.", "success")
    assert done_text("Codex", three, list(three), succeeded=["n1", "n2"], failed=["n3"]) == (
        "Codex finished 2 of 3 nodes. “Upscale” failed.", "partial")
    five = [f"n{i}" for i in range(1, 6)]
    assert done_text("Codex", {}, five, succeeded=["n1", "n2"], failed=["n3", "n4", "n5"]) == (
        "Codex finished 2 of 5 nodes. 3 failed.", "partial")
    assert done_text("Codex", one, ["n1"], succeeded=[], failed=["n1"]) == (
        "Codex's run of “Hero shots” failed.", "failure")
    assert done_text("Codex", three, list(three), succeeded=[], failed=["n2"]) == (
        "Codex's run of 3 nodes failed.", "failure")


def test_the_possessive_always_adds_apostrophe_s():
    assert possessive("Codex") == "Codex's"
    assert possessive("Claude Code") == "Claude Code's"
    assert possessive("Jules") == "Jules's"


# -- one card per run, from the routes -------------------------------------------------------

def test_a_successful_one_node_run_posts_one_card(done):
    (node,) = _chain(done, labels=("Hero shots",))
    done.outputs[node] = _image(done, "hero")
    result = _run(done, target=node)
    assert result["status"] == "finished"
    (card,) = _cards(done)
    assert card["text"] == "Claude Code finished “Hero shots”."
    assert card["source"] == "nebula" and card["author"]["kind"] == "agent"
    assert card["author"]["name"] == "Claude Code" and card["author"]["id"] == "ext:claude-code"
    assert card["author"]["verified"] is False
    assert card["refs"] == [node]  # Show on canvas flies to it
    assert card.get("actions", []) == []
    assert card["run"]["id"] == result["runId"] and card["run"]["lastNodeId"] == node
    assert card["run"]["outcome"] == "success" and card["run"]["nodeIds"] == [node]
    thumb = card["run"]["thumbnail"]
    assert thumb["kind"] == "image" and thumb["url"] == "/api/outputs/done-cards/hero.png"
    assert thumb["nodeId"] == node
    # Unread, like any Update, and announced on the socket.
    listing = done.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()
    assert listing["unread"] >= 1
    added = [m for m in done.sent if m.get("type") == "agentNotes" and m.get("op") == "added"]
    assert added and added[-1]["note"]["about"] == "run"


def test_a_successful_run_of_several_nodes(done):
    ids = _chain(done)
    done.outputs[ids[-1]] = _image(done, "up")
    _run(done)
    (card,) = _cards(done)
    assert card["text"] == "Claude Code finished 3 nodes."
    assert card["run"]["lastNodeId"] == ids[-1] and card["refs"] == [ids[-1]]
    assert card["run"]["nodeIds"] == ids
    assert card["run"]["thumbnail"]["url"].endswith("/up.png")


def test_a_partial_run_names_the_one_that_failed_and_shows_the_last_output_that_succeeded(done):
    ids = _chain(done)
    done.outputs[ids[1]] = _image(done, "mid")
    done.fail.add(ids[2])
    result = _run(done)
    assert result["status"] == "failed"
    (card,) = _cards(done)
    assert card["text"] == "Claude Code finished 2 of 3 nodes. “Upscale” failed."
    assert card["run"]["outcome"] == "partial"
    assert card["run"]["thumbnail"]["url"].endswith("/mid.png")
    assert card["run"]["thumbnail"]["nodeId"] == ids[1]
    assert card["refs"] == [ids[2]]  # the last node; it shows its own error


def test_a_partial_run_with_several_failures_counts_them(done):
    names = ("A", "B", "C", "D", "E")
    ids = [done.graph.add_node("text-input", {}) for _ in names]
    for node_id, name in zip(ids, names):
        done.graph.set_label(node_id, name)
    done.fail.update(ids[2:])
    _run(done)
    (card,) = _cards(done)
    assert card["text"] == "Claude Code finished 2 of 5 nodes. 3 failed."


def test_a_failed_run_gets_a_card_with_no_thumbnail_and_an_agent_log_line(done):
    (node,) = _chain(done, labels=("Hero shots",))
    done.fail.add(node)
    _run(done, headers=CODEX, target=node)
    (card,) = _cards(done)
    assert card["text"] == "Codex's run of “Hero shots” failed."
    assert card["run"]["outcome"] == "failure"
    assert card["run"].get("thumbnail") is None
    lines = [m for m in done.sent if m.get("type") == "agentPresence" and m.get("say") == card["text"]]
    assert lines and lines[-1]["agent"]["name"] == "Codex" and lines[-1].get("target") is None


def test_a_failed_run_of_several_nodes(done):
    ids = _chain(done)
    done.fail.add(ids[0])
    _run(done, headers=CODEX)
    (card,) = _cards(done)
    assert card["text"] == "Codex's run of 3 nodes failed."


def test_runs_the_person_starts_post_no_card(done):
    (node,) = _chain(done, labels=("Hero shots",))
    nodes, edges = done.graph.to_execute_format()
    assert done.client.post("/api/execute", headers=PERSON, json={"nodes": nodes, "edges": edges}).status_code == 200
    assert done.client.post("/api/execute-node", headers=PERSON,
                            json={"nodes": nodes, "edges": edges, "targetNodeId": node}).status_code == 200
    # Nor does an unnamed caller (the CLI without NEBULA_AGENT_NAME).
    _run(done, headers={})
    assert _cards(done) == []


def test_an_agents_canvas_run_posts_a_card_too(done):
    (node,) = _chain(done, labels=("Hero shots",))
    nodes, edges = done.graph.to_execute_format()
    response = done.client.post("/api/execute-node", headers=CLAUDE,
                                json={"nodes": nodes, "edges": edges, "targetNodeId": node})
    assert response.status_code == 200, response.text
    assert [card["text"] for card in _cards(done)] == ["Claude Code finished “Hero shots”."]


def test_a_new_card_for_the_same_node_and_agent_replaces_the_older_one(done):
    (node,) = _chain(done, labels=("Hero shots",))
    for _ in range(3):
        _run(done, target=node)
    cards = _cards(done)
    assert len(cards) == 1
    removed = [m for m in done.sent if m.get("type") == "agentNotes" and m.get("op") == "added" and m.get("removed")]
    assert removed  # the canvas drops the older ones
    # Another agent's card on the same node is its own.
    _run(done, headers=CODEX, target=node)
    assert sorted(card["author"]["name"] for card in _cards(done)) == ["Claude Code", "Codex"]
    # Another node of the same agent's is its own too.
    other = done.graph.add_node("text-input", {})
    _run(done, target=other)
    assert len(_cards(done)) == 3


def test_the_card_is_an_update_the_agent_can_read(done):
    (node,) = _chain(done, labels=("Hero shots",))
    _run(done, target=node)
    import mcp_server  # noqa: F401 - list_notes reads GET /api/canvas/agent-notes
    listed = done.client.get("/api/canvas/agent-notes", headers=CODEX).json()["notes"]
    assert any(note["about"] == "run" and note["run"]["lastNodeId"] == node for note in listed)


def test_no_file_is_copied_for_a_thumbnail(done):
    (node,) = _chain(done, labels=("Hero shots",))
    done.outputs[node] = _image(done, "kept")
    before = sorted(str(path) for path in Path(done.folder).parent.rglob("*") if path.is_file())
    _run(done, target=node)
    after = sorted(str(path) for path in Path(done.folder).parent.rglob("*") if path.is_file())
    assert after == before


# -- which output makes the thumbnail -------------------------------------------------------------

def test_thumbnail_by_output_type(done):
    from services.output import OUTPUT_ROOT

    def url_for(value):
        return done.main._output_url_from_ref(value)

    image = _image(done, "pic")["image"]["value"]
    video = done.folder / "clip.mp4"
    video.write_bytes(b"0" * 16)
    assert thumbnail_for({"image": {"type": "Image", "value": image}}, url_for)["kind"] == "image"
    assert thumbnail_for({"video": {"type": "Video", "value": str(video)}}, url_for) == {
        "kind": "video", "url": "/api/outputs/done-cards/clip.mp4"}
    # Only the first output counts: text or audio first means no thumbnail.
    assert thumbnail_for({"text": {"type": "Text", "value": "hi"},
                          "image": {"type": "Image", "value": image}}, url_for) is None
    assert thumbnail_for({"audio": {"type": "Audio", "value": str(video)}}, url_for) is None
    # A list takes its first item.
    assert thumbnail_for({"image": {"type": "Image", "value": [image, image]}}, url_for)["kind"] == "image"
    # Never a provider's (maybe signed) URL, nor a file outside the output folder.
    assert thumbnail_for({"image": {"type": "Image", "value": "https://cdn.example/x.png?sig=abc"}}, url_for) is None
    outside = Path(OUTPUT_ROOT).parent / "elsewhere.png"
    assert thumbnail_for({"image": {"type": "Image", "value": str(outside)}}, url_for) is None
    assert thumbnail_for({}, url_for) is None


# -- the run pill's model name (GM - Design, 2026-10-25) ---------------------------------------------------

def test_a_node_name_in_the_run_pill_is_quoted_and_a_model_name_is_not(done):
    """GM: "A node name in the run pill is quoted: Running “Text Input” · 0:00
    (the type-name fallback is a node name). Provider model names stay
    unquoted: Running FLUX.2 [pro] · 0:41." """
    from models.graph import GraphNode

    main = done.main
    node_registry = main.node_registry
    assert main._run_model_name(GraphNode(id="n1", definitionId="text-input", params={})) == "“Text Input”"
    # A node whose model is an enum option keeps the provider's own spelling, unquoted.
    for definition in node_registry.get_all().values():
        spec = next((p for p in definition.get("params") or [] if isinstance(p, dict) and p.get("key") == "model"
                     and p.get("type") == "enum" and any(isinstance(o, dict) and o.get("label")
                                                         for o in p.get("options") or [])), None)
        if spec is None:
            continue
        option = next(o for o in spec["options"] if isinstance(o, dict) and o.get("label"))
        name = main._run_model_name(GraphNode(id="n2", definitionId=definition["id"], params={"model": option["value"]}))
        assert name == str(option["label"])[:80]
        assert not name.startswith("“")
        break
    else:
        pytest.skip("no node with an enum model option")
    # The mark on the canvas carries it.
    ids = _chain(done, labels=("Prompt",))
    _run(done, target=ids[0])
    started = [m for m in done.sent if m.get("type") == "agentRun" and m.get("change") == "started"]
    assert started and started[0]["model"] == "“Text Input”"
