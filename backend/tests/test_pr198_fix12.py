"""PR #198 fix round 12 (review 11; GM r19, r20).

- GM r20 answer 3: a save of a scene node someone deleted is answered 404
  ``node_gone`` with ``deletedBy`` (who deleted it, as ``changedBy`` names a
  writer; null when Nebula didn't see the delete), so the person's canvas
  names them once and stops saving it.
- Review 11, L-1 item 8: a restore (the canvas's undo or redo, an agent's
  undo) authors the scenes it puts back or sets, so a refusal after it names
  the restoring actor, never the writer from before it.
- Review 11, L-4: the health answer and the socket's hello say when the
  process started (``bootStartedAt``).
- GM r19 answer 1: ids take no quotes in refusal details and CLI output.
"""
from __future__ import annotations

import pytest

from services import cli_graph as cli_graph_module, scene_keys
from tests.test_canvas_undo import _apply
from tests.test_pr198_fix9 import CODEX, _cinema, _export, _person_types, _put, _scene
from tests.test_round19_fence import _canvas, _tab, api  # noqa: F401 - fixture


@pytest.fixture(autouse=True)
def _fresh_keys():
    scene_keys.forget()
    yield
    scene_keys.forget()


def _gone(response) -> dict:
    assert response.status_code == 404, response.text
    body = response.json()
    assert body["code"] == "node_gone"
    return body


def test_codex_deleted_the_scene_a_save_after_names_codex(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.delete(f"/api/graph/node/{node}", headers=CODEX).status_code == 200
    body = _gone(_put(api, node, _tab(api, _canvas(api)), _scene("typed after", "b")))
    assert body["deletedBy"] == {"kind": "agent", "name": "Codex"}
    # The person reads GM's line (approved round 3), never the id.
    assert body["detail"] == "That node isn't on the canvas anymore."


def test_the_persons_own_delete_in_another_window(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.delete(f"/api/graph/node/{node}", headers=_tab(api, _canvas(api))).status_code == 200
    body = _gone(_put(api, node, _tab(api, _canvas(api)), _scene("typed after", "b")))
    assert body["deletedBy"]["kind"] == "person"


def test_an_agent_edit_that_removes_the_scene_is_recorded_too(api):  # noqa: F811
    node = _cinema(api)
    _apply(api, {"remove": [node]}, headers=CODEX)
    body = _gone(_put(api, node, _tab(api, _canvas(api)), _scene("typed after", "b")))
    assert body["deletedBy"] == {"kind": "agent", "name": "Codex"}


def test_a_delete_nebula_never_saw_says_nobody(api):  # noqa: F811
    body = _gone(_put(api, "n99", CODEX, _scene("a", "b")))
    assert body["deletedBy"] is None
    # GM r19 answer 1: the id bare, for the agent to copy.
    assert body["detail"].startswith("Node n99 not found")
    assert "'n99'" not in body["detail"]


def test_a_restore_authors_the_scene_so_a_refusal_after_names_the_restorer(api):  # noqa: F811
    node = _cinema(api)
    # Codex reads, then writes the scene: Codex is its writer, and has read it.
    api.client.get("/api/graph/export", headers=CODEX)
    assert _put(api, node, CODEX, _scene("codex wrote", "a busy street")).status_code == 200
    # The person's Cmd+Z puts the scene back (the canvas's restore).
    restored = api.client.post("/api/graph/restore", headers=_tab(api, _canvas(api)), json={
        "action": "undo", "nodes": [{"id": node, "definitionId": "cinema-scene",
                                     "params": {"scene": _scene("a quiet street", "a busy street")}}]})
    assert restored.status_code == 200, restored.text
    # Codex's write built on its own older copy is refused, and names the person.
    refused = _put(api, node, CODEX, _scene("codex again", "a busy street"))
    assert refused.status_code == 409 and refused.json()["code"] == "scene_changed"
    assert refused.json()["changedBy"]["kind"] == "person"


def test_a_restore_that_leaves_the_scene_as_it_was_records_no_writer(api):  # noqa: F811
    node = _cinema(api)
    _person_types(api, node)
    before = scene_keys.writer(api.main._scene_scope(), node)
    scene = api.main.cli_graph.nodes[node]["params"]["scene"]
    restored = api.client.post("/api/graph/restore", headers=CODEX, json={
        "action": "undo", "nodes": [{"id": node, "definitionId": "cinema-scene", "params": {"scene": scene}}]})
    assert restored.status_code == 200, restored.text
    assert scene_keys.writer(api.main._scene_scope(), node) == before


def test_health_says_when_the_process_started(api):  # noqa: F811
    body = api.client.get("/api/health").json()
    assert body["bootStartedAt"] == api.main.BACKEND_BOOT_STARTED_AT
    assert isinstance(body["bootStartedAt"], int) and body["bootStartedAt"] > 1_700_000_000_000_000


def test_ids_take_no_quotes(api):  # noqa: F811
    # GM r19 answer 1: `run run_ab12 …`, `Node n9 …`: bare.
    assert api.main.RUN_ID_RAN.format(id="run_ab12").startswith("run run_ab12 already ran")
    assert api.client.delete("/api/graph/node/n9", headers=CODEX).json()["detail"].startswith("Node n9 not found")
    graph = cli_graph_module.CLIGraph()
    with pytest.raises(ValueError, match=r"^Node n9 not found$"):
        graph.remove_node("n9")


def test_no_quoted_id_in_the_backends_details():
    """A scan of the backend's f-strings: an id interpolated in straight
    quotes (``'{node_id}'``) is gone from refusal details, run errors and CLI
    output. A call shown as code (``get_run('{rid}')``) keeps its quotes:
    they are the call's syntax (in backticks since round 13)."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    quoted = re.compile(r"(?<![A-Za-z_(])'\{([^{}]*(?:_id|Id|\bid|\brid)\b[^{}]*)\}'")
    found = []
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        if rel.startswith(("tests/", ".venv/")) or "/site-packages/" in rel:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if quoted.search(line):
                found.append(f"{rel}:{number}: {line.strip()}")
    # Review 12 N-5 (round 13): the engine's run errors too; nothing allowed.
    assert found == []
