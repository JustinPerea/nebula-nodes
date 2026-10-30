"""PR #198 fix round 8, H2 (review 7; GM r9 decision 2, r11): conditional
Cinema scene writes (services/scene_keys.py). A scene write built on a scene
that changed since is refused with 409 ``scene_changed``, the scene Nebula
has now, its ``sceneKey`` and who changed it, so nobody's edit replaces
another's unasked. The rule holds both ways: the canvas sends the key its
edits started from (``ifSceneKey``); an agent's write is checked against the
scene it last read, or its own ``ifSceneKey``."""
from __future__ import annotations

import pytest

from services import scene_keys
from tests.test_round19_fence import AGENT, _canvas, _tab, api  # noqa: F401 - fixture


@pytest.fixture(autouse=True)
def _fresh_keys():
    scene_keys.forget()
    yield
    scene_keys.forget()


def _scene(*prompts: str) -> dict:
    return {"shots": [{"id": f"s{i + 1}", "prompt": p} for i, p in enumerate(prompts)]}


def _cinema(api) -> str:  # noqa: F811
    return api.graph.add_node("cinema-scene", {"scene": _scene("a quiet street", "a busy street")}, position={"x": 0, "y": 0})


def _key(api, node) -> str:  # noqa: F811
    return api.client.get("/api/graph/export").json()["sceneKeys"][node]


def _put(api, node, headers, scene, if_key=None):  # noqa: F811
    body = {"params": {"scene": scene}}
    if if_key is not None:
        body["ifSceneKey"] = if_key
    return api.client.put(f"/api/graph/node/{node}", headers=headers, json=body)


def _prompts(api, node):  # noqa: F811
    return [shot["prompt"] for shot in api.graph.nodes[node]["params"]["scene"]["shots"]]


def test_the_key_names_the_authoring_not_the_runtime():
    one = {"shots": [{"id": "s1", "prompt": "a", "output": {"status": "done", "imageUrl": "/x.png"}}]}
    two = {"shots": [{"id": "s1", "prompt": "a", "variations": 2}]}
    assert scene_keys.scene_key(one) == scene_keys.scene_key({"shots": [{"id": "s1", "prompt": "a"}]})
    assert scene_keys.scene_key(one) != scene_keys.scene_key({"shots": [{"id": "s1", "prompt": "b"}]})
    # variations is a runtime field too
    assert scene_keys.scene_key(two) == scene_keys.scene_key({"shots": [{"id": "s1", "prompt": "a"}]})


def test_the_export_and_the_answer_carry_the_key(api):  # noqa: F811
    node = _cinema(api)
    key = _key(api, node)
    assert isinstance(key, str) and key
    saved = _put(api, node, _tab(api, _canvas(api)), _scene("mine", "a busy street"), key)
    assert saved.status_code == 200, saved.text
    assert saved.json()["sceneKey"] == _key(api, node) != key


def test_a_tab_write_on_a_scene_that_changed_since_is_refused_with_the_scene(api):  # noqa: F811
    node = _cinema(api)
    key = _key(api, node)
    codex = _put(api, node, AGENT, _scene("a quiet street", "codex's busy street"))
    assert codex.status_code == 200, codex.text
    refused = _put(api, node, _tab(api, _canvas(api)), _scene("mine", "a busy street"), key)
    assert refused.status_code == 409
    body = refused.json()
    assert body["code"] == "scene_changed"
    assert [shot["prompt"] for shot in body["scene"]["shots"]] == ["a quiet street", "codex's busy street"]
    assert body["sceneKey"] == _key(api, node)
    assert body["changedBy"] == {"kind": "agent", "name": "Claude"}
    # Nothing was saved: Codex's change stands.
    assert _prompts(api, node) == ["a quiet street", "codex's busy street"]
    # Sent again on top of what Nebula has, with its key: taken.
    again = _put(api, node, _tab(api, _canvas(api)), _scene("mine", "codex's busy street"), body["sceneKey"])
    assert again.status_code == 200, again.text
    assert _prompts(api, node) == ["mine", "codex's busy street"]


def test_a_write_with_no_key_and_no_read_is_the_last_writer(api):  # noqa: F811
    node = _cinema(api)
    assert _put(api, node, _tab(api, _canvas(api)), _scene("one", "two")).status_code == 200
    assert _put(api, node, AGENT, _scene("codex", "two")).status_code == 200
    assert _prompts(api, node) == ["codex", "two"]


def test_an_agent_that_read_the_scene_before_the_person_typed_is_refused(api):  # noqa: F811
    """The rule is symmetric: an agent's older copy never goes back over the
    person's typing."""
    node = _cinema(api)
    assert api.client.get("/api/canvas/snapshot", headers=AGENT).status_code == 200
    typed = _put(api, node, _tab(api, _canvas(api)), _scene("the person typed this", "a busy street"), _key(api, node))
    assert typed.status_code == 200, typed.text
    refused = _put(api, node, AGENT, _scene("a quiet street", "codex's busy street"))
    assert refused.status_code == 409
    assert refused.json()["code"] == "scene_changed"
    assert refused.json()["changedBy"] == {"kind": "person", "name": "You"}
    assert _prompts(api, node) == ["the person typed this", "a busy street"]
    # Read again (the export), then write on top: taken.
    assert api.client.get("/api/graph/export", headers=AGENT).status_code == 200
    taken = _put(api, node, AGENT, _scene("the person typed this", "codex's busy street"))
    assert taken.status_code == 200, taken.text
    assert _prompts(api, node) == ["the person typed this", "codex's busy street"]


def test_an_agents_own_write_counts_as_its_read(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/graph", headers=AGENT).status_code == 200
    assert _put(api, node, AGENT, _scene("first", "a busy street")).status_code == 200
    assert _put(api, node, AGENT, _scene("second", "a busy street")).status_code == 200
    assert _prompts(api, node) == ["second", "a busy street"]


def test_an_agents_explicit_key_wins_over_its_read(api):  # noqa: F811
    node = _cinema(api)
    stale = _key(api, node)
    assert _put(api, node, _tab(api, _canvas(api)), _scene("typed", "a busy street"), stale).status_code == 200
    refused = _put(api, node, AGENT, _scene("codex", "a busy street"), stale)
    assert refused.status_code == 409 and refused.json()["code"] == "scene_changed"
    assert _put(api, node, AGENT, _scene("codex", "a busy street"), refused.json()["sceneKey"]).status_code == 200


def test_a_change_to_the_runtime_alone_is_no_change(api):  # noqa: F811
    node = _cinema(api)
    key = _key(api, node)
    scene = api.graph.nodes[node]["params"]["scene"]
    scene["shots"][0]["output"] = {"status": "done", "imageUrl": "/api/outputs/x.png"}
    taken = _put(api, node, _tab(api, _canvas(api)), _scene("mine", "a busy street"), key)
    assert taken.status_code == 200, taken.text


def test_other_params_are_never_held_to_a_scene_key(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/canvas/snapshot", headers=AGENT).status_code == 200
    assert _put(api, node, _tab(api, _canvas(api)), _scene("typed", "a busy street"), _key(api, node)).status_code == 200
    other = api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"label": "x"}})
    assert other.status_code != 409 or other.json().get("code") != "scene_changed"


def test_reads_are_kept_per_canvas():
    """A node id another canvas (or another graph) reuses never matches a read
    of the old one."""
    class Graph:  # any object: the token is per object, never reused
        pass

    one, two = Graph(), Graph()
    assert scene_keys.graph_token(one) != scene_keys.graph_token(two)
    assert scene_keys.graph_token(one) == scene_keys.graph_token(one)
    scene_keys.note_read("g1:p:1", "Codex", {"n1": "k"})
    assert scene_keys.last_read("g1:p:1", "Codex", "n1") == "k"
    assert scene_keys.last_read("g2:p:1", "Codex", "n1") is None
    assert scene_keys.last_read("g1:p:2", "Codex", "n1") is None


def test_a_canvas_without_scenes_answers_as_before(api):  # noqa: F811
    assert "sceneKeys" not in api.client.get("/api/graph/export").json()
    assert "sceneKeys" not in api.client.get("/api/graph", headers=AGENT).json()
