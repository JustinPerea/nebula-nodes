"""PR #198 fix round 2, M2: a proposal that adds a Cinema scene without
`base` (MCP propose_change) is filled with the defaults when the person
accepts it, so the scene opens in Cinema."""
from __future__ import annotations

from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, KEY, _key, _propose, api  # noqa: F401 - fixture


def test_an_accepted_proposal_adds_a_scene_with_its_defaults(api):  # noqa: F811
    response = _propose(api, {"note": "add a scene", "nodes": [
        {"ref": "+c", "definitionId": "cinema-scene", "params": {"scene": {"shots": [{"id": "s1", "prompt": "x"}]}}}]})
    assert response.status_code == 201, response.text
    proposal_id = response.json()["proposal"]["id"]
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                               headers={**PERSON, KEY: _key(api, proposal_id)}, json={})
    assert accepted.status_code == 200, accepted.text
    scene = next(node for node in api.graph.nodes.values() if node["definitionId"] == "cinema-scene")["params"]["scene"]
    assert scene["base"] == {"model": "seedream-4-5"}
    assert scene["aspectRatio"] == "16:9" and scene["version"] == 1


def test_a_proposal_with_a_scene_that_cant_be_normalized_is_refused(api):  # noqa: F811
    response = _propose(api, {"note": "add a scene", "nodes": [
        {"ref": "+c", "definitionId": "cinema-scene", "params": {"scene": {"shots": "s1"}}}]})
    assert response.status_code == 400, response.text
    assert "scene.shots must be a list" in response.json()["detail"]
