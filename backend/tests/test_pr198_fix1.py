"""PR #198 fix round 1 (review 1 and GM's rulings, gm-pr198-r1.md).

- GM item 7 / review L2: a universal node's provider setting is named by
  the Inspector's label, the key in sentence case ("Set “Guidance scale”").
  A setting with no label at all leaves the bubble empty, and the Agent log
  still gets a line: "Changed a setting on “<node>”" / "Changed <N> settings
  on “<node>”". No agent action is ever left out of the log.
- N1: a Stop recorded between admission and the World Labs claim refuses
  with the same words as every other reused-id refusal.
- N2: a bubble that fails never turns a saved PUT into a 500.
- M1, the backend half: a restore that leaves out a shot's media keeps the
  media the scene has now (a run's output), and puts back the rest.
- GM item 6: what was spent is never "$0.00" when it isn't nothing.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

import main as main_module
from cli.commands import spend as spend_command
from services import universal_ports
from services.agent_presence import AgentIdentity, AgentPresence
from services.execution_runs import ExecutionRunRegistry
from services.provider_start_guard import ProviderStartCancelledError
from tests.test_agent_presence import _presence_events, api  # noqa: F401 - fixture

AGENT = {"X-Nebula-Agent": "Codex"}


def _last(sent: list[dict]) -> dict:
    return _presence_events(sent)[-1]


# -- GM item 7: universal node settings ------------------------------------------


def test_a_replicate_setting_is_named_by_its_inspector_label_in_sentence_case(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("replicate-universal", {"model_id": "owner/model"})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"guidance_scale": 3}})
    assert response.status_code == 200, response.text
    event = _last(sent)
    assert event["say"] == "Set “Guidance scale”"
    assert event.get("log", event["say"]) == "Set “Guidance scale”"


def test_the_picker_labels_a_replicate_models_settings_in_sentence_case():
    ports, params = universal_ports.replicate_inputs({"input_schema": {"properties": {
        "guidance_scale": {"type": "number"},
        "num_inference_steps": {"type": "integer"},
        "input_image": {"type": "string", "format": "uri"},
    }}})
    assert [param["label"] for param in params] == ["Guidance scale", "Num inference steps"]
    assert universal_ports.setting_label("guidance_scale") == "Guidance scale"
    # Ports keep the Title Case every other port label uses.
    assert [port["label"] for port in ports] == ["Input Image"]


def test_a_setting_with_no_label_leaves_the_bubble_empty_and_the_log_says_what_changed(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("fal-universal", {})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"guidance_scale": 3}})
    assert response.status_code == 200, response.text
    event = _last(sent)
    assert event["say"] == ""
    assert event["log"] == "Changed a setting on “FAL”"
    assert "guidance" not in event["log"]


def test_several_settings_with_no_label_are_counted_on_the_node(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("fal-universal", {})
    graph.set_label(node, "Hero still")
    response = client.put(f"/api/graph/node/{node}", headers=AGENT,
                          json={"params": {"guidance_scale": 3, "num_steps": 20, "strength": 0.5}})
    assert response.status_code == 200, response.text
    event = _last(sent)
    assert event["say"] == ""
    assert event["log"] == "Changed 3 settings on “Hero still”"


def test_a_labeled_field_beside_unlabeled_ones_is_the_bubble_and_the_log(api):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("fal-universal", {})
    response = client.put(f"/api/graph/node/{node}", headers=AGENT,
                          json={"params": {"endpoint_id": "fal-ai/flux/dev", "guidance_scale": 3}})
    assert response.status_code == 200, response.text
    event = _last(sent)
    assert event["say"] == "Set “Endpoint”"
    assert event.get("log", event["say"]) == "Set “Endpoint”"


def test_an_action_said_with_no_words_is_still_logged_in_its_own_words(api, monkeypatch):  # noqa: F811
    """Any canvas action that names what it did (`did`) has a log line, even
    when its caller said nothing: the Agent log never leaves one out. Its
    words are the Agents panel's ("Changed “Text Input”")."""
    client, graph, sent = api
    node = graph.add_node("text-input", {"value": "a"})
    monkeypatch.setattr(main_module, "_set_params_bubble", lambda *_args: ("", ""))
    assert client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b"}}).status_code == 200
    event = _last(sent)
    assert event["say"] == ""
    assert event["log"] == "Changed “Text Input”"


def test_a_bare_cursor_move_has_nothing_to_log():
    presence = AgentPresence(clock=lambda: 100.0)
    identity = AgentIdentity(id="cx", name="Codex", color="#336699", verified=True)
    assert "log" not in presence.point(identity, target={"x": 1.0, "y": 2.0}, action="move")
    logged = presence.point(identity, target={"nodeId": "n1"}, action="click", say="", log="Changed a setting on “A”")
    assert logged["log"] == "Changed a setting on “A”"


# -- N1: the World Labs claim's Stop ----------------------------------------------


STOP_RECORDED = "run {id} was stopped, so this id can’t start again. Start a new run with a new id."


def test_a_stop_that_lands_at_the_world_labs_claim_says_what_every_reused_id_says(monkeypatch):
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_fresh_paid_worldlabs_claims", lambda _nodes: [("worldlabs-world", "n1")])

    def stopped(**_kwargs):
        raise ProviderStartCancelledError("run wl-run was cancelled before it started")

    monkeypatch.setattr(main_module.provider_start_guard, "claim", stopped)
    with pytest.raises(HTTPException) as refused:
        main_module._claim_fresh_paid_worldlabs_starts(run_id="wl-run", nodes=[])
    assert refused.value.status_code == 409
    assert refused.value.detail == STOP_RECORDED.format(id="wl-run")


# -- N2: a failed bubble never fails the saved PUT ---------------------------------


def test_a_bubble_that_raises_leaves_the_saved_put_a_200(api, monkeypatch):  # noqa: F811
    client, graph, sent = api
    node = graph.add_node("text-input", {"value": "a"})

    def broken(*_args, **_kwargs):
        raise RuntimeError("bubble broke")

    monkeypatch.setattr(main_module, "_set_params_bubble", broken)
    response = client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": "b"}})
    assert response.status_code == 200, response.text
    assert graph.nodes[node]["params"]["value"] == "b"
    # The person's own PUT computes no bubble at all.
    person = client.put(f"/api/graph/node/{node}", json={"params": {"value": "c"}})
    assert person.status_code == 200, person.text


# -- M1, the backend half: a restore keeps a run's shot media -----------------------


def test_a_restore_that_leaves_out_a_shots_media_keeps_the_media_the_scene_has(api):  # noqa: F811
    client, graph, sent = api
    paid = {"imageUrl": "/api/outputs/paid-s2.png", "status": "done"}
    node = graph.add_node("cinema-scene", {"scene": {"shots": [
        {"id": "s1", "prompt": "b"}, {"id": "s2", "prompt": "other", "output": paid}]}})
    for shots in (
        # The body before the fix: s2 without its image.
        [{"id": "s1", "prompt": "a"}, {"id": "s2", "prompt": "other"}],
        # The body the canvas sends now: s2 with it.
        [{"id": "s1", "prompt": "a"}, {"id": "s2", "prompt": "other", "output": paid}],
    ):
        response = client.post("/api/graph/restore", json={"action": "undo", "nodes": [
            {"id": node, "definitionId": "cinema-scene", "params": {"scene": {"shots": shots}}}],
            "remove": [], "wire": [], "unwire": []})
        assert response.status_code == 200, response.text
        stored = {shot["id"]: shot for shot in graph.nodes[node]["params"]["scene"]["shots"]}
        assert stored["s1"]["prompt"] == "a"
        assert stored["s2"]["output"] == paid


# -- GM item 6: what was spent ------------------------------------------------------


def test_the_cli_never_says_a_non_zero_spend_is_zero():
    assert spend_command._usd(0) == "$0.00"
    assert spend_command._usd(0.003) == "<$0.01"
    assert spend_command._usd(0.006) == "$0.01"
    assert spend_command._usd(None) == "no limit"


def test_undo_of_a_shot_delete_brings_the_shot_back_with_its_image_for_the_person(api, person):  # noqa: F811
    """A proposal that deleted a rendered shot, undone: the shot comes back
    with the image a run made, on the backend as on the canvas, port and all.
    Only the person's restore (or the server's own inverse) is trusted with
    media; anyone else's returning shot starts idle, as before."""
    from tests.conftest import PERSON

    client, graph, sent = api
    paid = {"imageUrl": "/api/outputs/paid-s3.png", "status": "done"}
    node = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    body = {"action": "undo", "nodes": [{"id": node, "definitionId": "cinema-scene", "params": {"scene": {"shots": [
        {"id": "s1", "prompt": "a"}, {"id": "s3", "prompt": "rendered", "output": paid}]}}}],
        "remove": [], "wire": [], "unwire": []}
    response = client.post("/api/graph/restore", headers=PERSON, json=body)
    assert response.status_code == 200, response.text
    shots = {shot["id"]: shot for shot in graph.nodes[node]["params"]["scene"]["shots"]}
    assert shots["s3"]["output"] == paid
    assert graph.nodes[node]["outputs"]["shot_s3"]["value"] == paid["imageUrl"]

    other = graph.add_node("cinema-scene", {"scene": {"shots": [{"id": "s1", "prompt": "a"}]}})
    body["nodes"][0]["id"] = other
    response = client.post("/api/graph/restore", headers=AGENT, json=body)
    assert response.status_code == 200, response.text
    shots = {shot["id"]: shot for shot in graph.nodes[other]["params"]["scene"]["shots"]}
    assert shots["s3"]["output"] == {"status": "idle"}
