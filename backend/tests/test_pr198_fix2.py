"""PR #198 fix round 2 (review 2 and GM's round-2 rulings, gm-pr198-r2.md).

- M1: a shot an Undo brings back keeps its output only when the shot is
  `done` or `error`; it never overwrites an existing `shot_<id>` port, and
  when that port holds a newer result the shot takes it. A shot that is
  still rendering can't be removed (GM: "block it"): the backend refuses the
  write with a line an agent can act on.
- M2: a Cinema scene missing `base`, `aspectRatio` or `version` is filled
  with the defaults on every write; only what can't be normalized is refused.
- L4: one money formatter for spend refusals and `nebula spend`.
- N4: an empty PUT says nothing ("Updated" is gone for good).
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

import pytest

import main as main_module
from cli.commands import spend as spend_command
from services import agent_spend, money
from services.cli_graph import CLIGraph
from tests.conftest import PERSON
from tests.test_agent_presence import _presence_events, api  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Codex"}
DEFAULT_BASE = {"model": "seedream-4-5"}
MONEY = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "money" / "cases.json").read_text())


def _restore(client, node, shots, headers=PERSON):
    return client.post("/api/graph/restore", headers=headers, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": {"shots": shots}}}],
        "remove": [], "wire": [], "unwire": []})


def _shots(graph, node):
    return {shot["id"]: shot for shot in graph.nodes[node]["params"]["scene"]["shots"]}


# -- M1: a shot an Undo brings back ------------------------------------------------


def test_a_returning_shot_that_was_rendering_comes_back_idle_not_stuck(api, person):  # noqa: F811
    """The review's probe: the person removed s2 while it rendered (the canvas
    held its optimistic 'running'), the run's merge found no s2 and wrote only
    the port, and the person undid the delete."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    response = _restore(client, node, [{"id": "s1", "prompt": "a"},
                                       {"id": "s2", "prompt": "b", "output": {"status": "running"}}])
    assert response.status_code == 200, response.text
    assert _shots(graph, node)["s2"]["output"] == {"status": "idle"}


def test_a_returning_shot_running_over_an_old_image_never_brings_back_running(api, person):  # noqa: F811
    """Caught re-rendering over an image it had: it comes back as it was
    before that render started (the image is real and finished), never
    "running". The render itself, if it landed, left a newer port (above)."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    response = _restore(client, node, [{"id": "s1", "prompt": "a"}, {
        "id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/old-s2.png", "status": "running"}}])
    assert response.status_code == 200, response.text
    assert _shots(graph, node)["s2"]["output"] == {"imageUrl": "/api/outputs/old-s2.png", "status": "done"}
    assert graph.nodes[node]["outputs"]["shot_s2"]["value"] == "/api/outputs/old-s2.png"


def test_a_returning_shot_adopts_the_newer_image_on_its_port(api, person):  # noqa: F811
    """The run landed after the shot was removed: its port holds the newest
    paid image. The shot that comes back takes it; the port is never
    overwritten with the older image the undo carried."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    graph.nodes[node]["outputs"] = {"shot_s2": {"type": "Image", "value": "/api/outputs/new-s2.png"}}
    for status in ("done", "running", "error"):
        graph.nodes[node]["params"]["scene"]["shots"] = [{"id": "s1", "prompt": "a"}]
        graph.nodes[node]["outputs"] = {"shot_s2": {"type": "Image", "value": "/api/outputs/new-s2.png"}}
        response = _restore(client, node, [{"id": "s1", "prompt": "a"}, {
            "id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/old-s2.png", "status": status},
            "variations": [{"url": "/api/outputs/old-s2.png", "seed": 1}], "selectedVariation": 0}])
        assert response.status_code == 200, response.text
        s2 = _shots(graph, node)["s2"]
        assert graph.nodes[node]["outputs"]["shot_s2"]["value"] == "/api/outputs/new-s2.png", status
        assert s2["output"] == {"imageUrl": "/api/outputs/new-s2.png", "status": "done"}, status
        # The old variation isn't what the shot shows now.
        assert "selectedVariation" not in s2, status


def test_a_returning_done_shot_without_a_port_still_brings_its_image_back(api, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    done = {"imageUrl": "/api/outputs/s2.png", "status": "done"}
    response = _restore(client, node, [{"id": "s1", "prompt": "a"}, {"id": "s2", "prompt": "b", "output": done}])
    assert response.status_code == 200, response.text
    assert _shots(graph, node)["s2"]["output"] == done
    assert graph.nodes[node]["outputs"]["shot_s2"]["value"] == "/api/outputs/s2.png"


def test_after_a_reload_a_returning_shot_is_not_generating(api, person, tmp_path):  # noqa: F811
    """What a reload reads: the saved graph. No shot is saved as running."""
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    _restore(client, node, [{"id": "s1", "prompt": "a"}, {
        "id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/old.png", "status": "running"}}])
    path = tmp_path / "state.json"
    graph.save(path)
    reloaded = CLIGraph()
    reloaded.load(path)
    statuses = [shot.get("output", {}).get("status") for shot in reloaded.nodes[node]["params"]["scene"]["shots"]]
    assert "running" not in statuses


def test_a_saved_scene_with_a_running_shot_loads_settled(tmp_path):
    """A file saved before this fix (or by another app) with a shot left
    'running': nothing renders after a load, so it can't be generating."""
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [{"id": "n1", "definitionId": "cinema-scene", "params": {"scene": {
        "version": 1, "base": DEFAULT_BASE, "aspectRatio": "16:9", "shots": [
            {"id": "s1", "prompt": "a", "output": {"status": "running"}},
            {"id": "s2", "prompt": "b", "output": {"imageUrl": "/api/outputs/x.png", "status": "running"}}]}}}],
        "edges": [], "counter": 1}))
    graph = CLIGraph()
    graph.load(path)
    shots = graph.nodes["n1"]["params"]["scene"]["shots"]
    assert shots[0]["output"] == {"status": "idle"}
    assert shots[1]["output"] == {"imageUrl": "/api/outputs/x.png", "status": "done"}


# -- GM: a shot that is still rendering can't be removed ------------------------------


@pytest.fixture
def rendering(monkeypatch):
    """Runs this test says are active (the registry's own record needs a task)."""
    active: set[str] = set()
    monkeypatch.setattr(main_module, "_run_is_active", lambda run_id: run_id in active)
    main_module._cinema_renders.clear()
    yield active
    main_module._cinema_renders.clear()


def test_removing_a_shot_that_is_rendering_is_refused_with_what_to_do(api, rendering):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}, {"id": "s2", "prompt": "b"}]}})
    graph.set_label(node, "Opening")
    main_module._note_cinema_render("cinema-shot-1", node, "s2")
    rendering.add("cinema-shot-1")
    response = client.put(f"/api/graph/node/{node}", headers=AGENT,
                          json={"params": {"scene": {"version": 1, "base": DEFAULT_BASE, "aspectRatio": "16:9",
                                                     "shots": [{"id": "s1", "prompt": "a"}]}}})
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "Shot 2 (s2)" in detail and "“Opening”" in detail and "still rendering" in detail
    assert "cinema-shot-1" in detail and "cancel_run" in detail
    assert set(_shots(graph, node)) == {"s1", "s2"}
    # Another shot can still change; and once the run ends the shot can go.
    edited = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": {
        "version": 1, "base": DEFAULT_BASE, "aspectRatio": "16:9",
        "shots": [{"id": "s1", "prompt": "edited"}, {"id": "s2", "prompt": "b"}]}}})
    assert edited.status_code == 200, edited.text
    rendering.discard("cinema-shot-1")
    gone = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": {
        "version": 1, "base": DEFAULT_BASE, "aspectRatio": "16:9", "shots": [{"id": "s1", "prompt": "edited"}]}}})
    assert gone.status_code == 200, gone.text


def test_a_whole_scene_run_blocks_removing_any_of_its_shots(api, rendering, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}, {"id": "s2", "prompt": "b"}]}})
    main_module._note_cinema_render("run-graph", node, None)
    rendering.add("run-graph")
    # The person's own undo (a restore) is refused too: nothing orphans a paid run.
    response = _restore(client, node, [{"id": "s2", "prompt": "b"}])
    assert response.status_code == 409, response.text
    # The person reads GM's line (fix round 3, M2); agents keep "Shot 1 (s1)" and the run.
    assert response.json()["detail"] == (
        "Couldn't undo. It would remove \u201cShot 1\u201d, which is still running. Stop the run first.")


# -- M2: a Cinema scene missing a field --------------------------------------------


BARE = {"shots": [{"id": "s1", "prompt": "x"}]}


def _cinema_nodes(graph):
    return [node for node in graph.nodes.values() if node.get("definitionId") == "cinema-scene"]


def _assert_normalized(scene):
    assert scene["base"] == DEFAULT_BASE
    assert scene["aspectRatio"] == "16:9"
    assert scene["version"] == 1
    assert scene["shots"][0]["id"] == "s1" and scene["shots"][0]["prompt"] == "x"


@pytest.mark.parametrize("scene", [BARE, {**BARE, "base": None}, {**BARE, "base": {}}, {**BARE, "aspectRatio": ""},
                                   {**BARE, "base": {"model": ""}}])
def test_create_node_fills_a_scenes_defaults(api, scene):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/node", headers=AGENT, json={"definitionId": "cinema-scene", "params": {"scene": scene}})
    assert response.status_code == 200, response.text
    _assert_normalized(_cinema_nodes(graph)[-1]["params"]["scene"])


def test_edit_canvas_fills_a_new_scenes_defaults(api):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/apply", headers=AGENT, json={"nodes": [
        {"ref": "+c", "definitionId": "cinema-scene", "params": {"scene": BARE}}]})
    assert response.status_code == 200, response.text
    _assert_normalized(_cinema_nodes(graph)[-1]["params"]["scene"])


def test_import_fills_a_scenes_defaults(api):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/import", headers=AGENT, json={"nodes": [
        {"id": "a", "definitionId": "cinema-scene", "params": {"scene": BARE}}], "edges": []})
    assert response.status_code == 200, response.text
    _assert_normalized(_cinema_nodes(graph)[-1]["params"]["scene"])


def test_put_and_restore_fill_a_scenes_defaults(api, person):  # noqa: F811
    client, graph, _sent = api
    node = graph.add_node("cinema-scene", {"scene": {"version": 1, "base": DEFAULT_BASE, "aspectRatio": "1:1",
                                                     "shots": [{"id": "s1", "prompt": "x"}]}})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"scene": BARE}})
    assert response.status_code == 200, response.text
    _assert_normalized(graph.nodes[node]["params"]["scene"])
    response = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": {"shots": [{"id": "s1", "prompt": "x"}]}}}],
        "remove": [], "wire": [], "unwire": []})
    assert response.status_code == 200, response.text
    _assert_normalized(graph.nodes[node]["params"]["scene"])
    # A node an undo brings back whole.
    graph.remove_node(node)
    response = client.post("/api/graph/restore", headers=PERSON, json={"action": "undo", "nodes": [
        {"id": node, "definitionId": "cinema-scene", "params": {"scene": BARE}, "position": {"x": 0, "y": 0}}],
        "remove": [], "wire": [], "unwire": []})
    assert response.status_code == 200, response.text
    _assert_normalized(graph.nodes[node]["params"]["scene"])


def test_a_saved_scene_missing_its_base_loads_with_the_defaults(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"nodes": [{"id": "n1", "definitionId": "cinema-scene", "params": {"scene": BARE}}],
                                "edges": [], "counter": 1}))
    graph = CLIGraph()
    graph.load(path)
    _assert_normalized(graph.nodes["n1"]["params"]["scene"])


def test_an_agent_created_running_shot_starts_idle(api):  # noqa: F811
    client, graph, _sent = api
    response = client.post("/api/graph/node", headers=AGENT, json={"definitionId": "cinema-scene", "params": {"scene": {
        **BARE, "shots": [{"id": "s1", "prompt": "x", "output": {"status": "running"}}]}}})
    assert response.status_code == 200, response.text
    assert _cinema_nodes(graph)[-1]["params"]["scene"]["shots"][0]["output"] == {"status": "idle"}


@pytest.mark.parametrize("scene,named", [
    ("a scene", "scene must be an object"),
    ({"shots": "s1"}, "scene.shots must be a list"),
    ({"shots": [{"prompt": "x"}]}, "scene.shots[0].id"),
    ({"shots": [{"id": "s1"}, {"id": "s1"}]}, "unique"),
    ({**BARE, "base": "seedream-4-5"}, "scene.base must be an object"),
    ({**BARE, "aspectRatio": 16}, "scene.aspectRatio must be text"),
    ({"shots": [{"id": "s1", "prompt": ["x"]}]}, "scene.shots[0].prompt must be text"),
])
def test_what_cant_be_normalized_is_refused_with_the_field_named(api, scene, named):  # noqa: F811
    client, graph, _sent = api
    before = len(graph.nodes)
    response = client.post("/api/graph/node", headers=AGENT, json={"definitionId": "cinema-scene", "params": {"scene": scene}})
    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert named in detail
    assert "cinema-scene" in detail
    assert len(graph.nodes) == before


# -- L4: one money formatter -------------------------------------------------------


@pytest.mark.parametrize("case", MONEY["spent"], ids=[str(case["amount"]) for case in MONEY["spent"]])
def test_what_was_spent_matches_the_shared_table(case):
    """Settings and `nebula spend`: to the cent (frontend formatSpentUsd reads the same table)."""
    assert money.usd_spent(case["amount"]) == case["text"]
    assert spend_command._usd(case["amount"]) == case["text"]


@pytest.mark.parametrize("case", MONEY["amount"], ids=[str(case["amount"]) for case in MONEY["amount"]])
def test_an_amount_matches_the_shared_table(case):
    """Spend refusals and every chip's figures (frontend formatUsd reads the same table)."""
    assert money.usd_amount(case["amount"]) == case["text"]
    assert agent_spend._usd(case["amount"]) == case["text"]


def test_the_spend_formatter_never_lies_about_nothing():
    """Property: "$0.00" only for nothing; never "$0.000", never "$-…"; to the
    cent; a non-zero amount under half a cent is "<$0.01"."""
    rng = random.Random(198)
    samples = [rng.uniform(-5, 5) for _ in range(4000)] + [rng.uniform(0, 0.02) for _ in range(4000)] + [
        0.0, -0.0, 1e-12, -1e-12, 0.004999999, 0.005, 9.995, 10.005, 1234.5, float("nan"), float("inf")]
    for amount in samples:
        text = money.usd_spent(amount)
        assert "-" not in text and "$0.000" not in text and "nan" not in text.lower() and "inf" not in text.lower(), amount
        if text == "$0.00":
            assert not (math.isfinite(amount) and amount > 0), amount
        elif text == "<$0.01":
            assert 0 < amount < 0.005, amount
        else:
            assert text.startswith("$") and len(text.rsplit(".", 1)[1]) == 2, (amount, text)
            assert abs(float(text[1:].replace(",", "")) - amount) <= 0.005 + 1e-9, (amount, text)


def test_an_amount_never_lies_about_nothing():
    """Property: "$0" only for nothing; never "$0.000" or "$-…"; never two
    texts for the same rounded value at a branch edge ("$0.1" vs "$0.10")."""
    rng = random.Random(1982)
    samples = [10 ** rng.uniform(-6, 4) for _ in range(6000)] + [rng.uniform(-1, 1) for _ in range(500)] + [
        0.0995, 0.09999, 9.996, 9.9949, 0.1, 10.0, float("nan"), float("-inf")]
    for amount in samples:
        text = money.usd_amount(amount)
        assert "-" not in text and text.rstrip("0") != "$0.", (amount, text)
        assert "nan" not in text.lower() and "inf" not in text.lower(), amount
        if text == "$0":
            assert not (math.isfinite(amount) and amount > 0), amount
            continue
        value = float(text[1:].replace(",", ""))
        assert value > 0, (amount, text)
        assert abs(value - amount) / amount <= 0.05 + 1e-9, (amount, text)
        whole, _, decimals = text[1:].partition(".")
        if value >= 10:
            assert decimals == "", (amount, text)
        elif value >= 0.1:
            assert len(decimals) == 2, (amount, text)
        else:
            assert len(decimals.lstrip("0")) <= 2 and not decimals.endswith("0"), (amount, text)


def test_a_spend_refusal_never_says_three_decimals():
    assert agent_spend._usd(0.0004) == "$0.0004"  # was "$0.000"


# -- N4: an empty PUT says nothing ----------------------------------------------------


def test_an_empty_put_says_nothing_and_logs_nothing(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("text-input", {})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {}})
    assert response.status_code == 200, response.text
    events = _presence_events(sent)
    assert all("Updated" not in (event.get("say") or "") + (event.get("log") or "") for event in events)
    assert all(not event.get("log") and not event.get("say") for event in events)
