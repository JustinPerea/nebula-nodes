"""Idol without a Hugging Face token, by run plan (GM, PR #203 r8 items 1-2).

Round 7: Idol is keyless (the first live call ran with no token), so no
run is refused for the missing token any more. A canvas run still skips an
agent's placeholder Idol and runs the rest (the backend validates after
_skip_placeholders, as the canvas reads lib/runScope nodesThatRun), and a
real Idol in it runs.
"""
from __future__ import annotations

from execution import engine
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _apply, _execute_body, pend  # noqa: F401 - fixture

IDOL_LINE = "You can run Idol after you add your Hugging Face token in Settings."  # the keyed line, gone


def _no_keys(pend, monkeypatch) -> None:
    """No keys saved, and the engine's real preflight (the pend fixture stubs
    it out): the check under test."""
    main = pend.main
    real = main.load_settings
    monkeypatch.setattr(main, "load_settings", lambda *a, **k: {**real(*a, **k), "apiKeys": {}})
    monkeypatch.setattr(main, "validate_graph", engine.validate_graph)


def _agent_idol(pend) -> dict[str, str]:
    """An image into Idol, both the agent's placeholders."""
    body = {
        "note": "a splat of the still",
        "nodes": [{"ref": "+img", "definitionId": "image-input", "params": {"filePath": "/x.png"}},
                  {"ref": "+idol", "definitionId": "speridlabs-idol"}],
        "edges": [{"source": "+img", "sourceHandle": "image", "target": "+idol", "targetHandle": "image"}],
        "pending": True,
    }
    response = _apply(pend, body)
    assert response.status_code == 200, response.text
    return response.json()["idMap"]


def _errors(pend) -> list[dict]:
    return [error for message in pend.sent if message.get("type") == "validationError"
            for error in message.get("errors") or []]


def test_a_canvas_run_skips_a_placeholder_idol_and_runs_the_rest(pend, monkeypatch):
    _no_keys(pend, monkeypatch)
    ids = _agent_idol(pend)
    text = pend.graph.add_node("text-input", {"value": "the person's"})
    response = pend.client.post("/api/execute", headers=PERSON, json={**_execute_body(pend), "runId": "r1"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "started"
    assert ids["+idol"] in body["skipped"]
    assert pend.ran == [[text]]
    assert not any(IDOL_LINE in str(error.get("message")) for error in _errors(pend))


def test_a_canvas_run_with_a_real_idol_runs_without_a_token(pend, monkeypatch):
    _no_keys(pend, monkeypatch)
    image = pend.graph.add_node("image-input", {"filePath": "/x.png"})
    idol = pend.graph.add_node("speridlabs-idol", {})
    pend.graph.connect(image, "image", idol, "image")
    text = pend.graph.add_node("text-input", {"value": "the person's"})
    response = pend.client.post("/api/execute", headers=PERSON, json={**_execute_body(pend), "runId": "r2"})
    assert response.status_code == 200, response.text
    assert response.json().get("status") == "started"
    assert [error for error in _errors(pend) if error.get("nodeId") == idol] == []
    assert sorted(pend.ran[0]) == sorted([image, idol, text])
