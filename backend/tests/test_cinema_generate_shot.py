"""Tests for the per-shot regeneration entrypoint (POST /api/cinema/generate-shot).

Covers the request-validation guards (return before any async work) and the
critical merge logic `_merge_shot_result`, which must update ONLY the target
shot's output + port while leaving every sibling shot and port intact (the D2
"single-shot state merge" concern from the proposal).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def client():
    from main import app
    return TestClient(app)


def _cinema_node(shots):
    return {
        "id": "n1",
        "definitionId": "cinema-scene",
        "params": {"scene": {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9", "shots": shots}},
        "outputs": {},
    }


# ---------- request-validation guards ----------


class TestGenerateShotGuards:
    def test_missing_node_is_404(self, client):
        resp = client.post(
            "/api/cinema/generate-shot",
            json={"nodes": [], "edges": [], "nodeId": "nope", "shotId": "a"},
        )
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    def test_non_cinema_node_is_400(self, client):
        node = {"id": "n1", "definitionId": "text-input", "params": {}, "outputs": {}}
        resp = client.post(
            "/api/cinema/generate-shot",
            json={"nodes": [node], "edges": [], "nodeId": "n1", "shotId": "a"},
        )
        assert resp.status_code == 400
        assert "cinema-scene" in resp.json()["detail"]

    def test_node_without_scene_is_400(self, client):
        node = {"id": "n1", "definitionId": "cinema-scene", "params": {}, "outputs": {}}
        resp = client.post(
            "/api/cinema/generate-shot",
            json={"nodes": [node], "edges": [], "nodeId": "n1", "shotId": "a"},
        )
        assert resp.status_code == 400
        assert "scene" in resp.json()["detail"].lower()

    def test_missing_shot_is_404(self, client):
        node = _cinema_node([{"id": "a", "prompt": "x"}])
        resp = client.post(
            "/api/cinema/generate-shot",
            json={"nodes": [node], "edges": [], "nodeId": "n1", "shotId": "zzz"},
        )
        assert resp.status_code == 404
        assert "zzz" in resp.json()["detail"]


# ---------- merge logic (no-clobber) ----------


class TestMergeShotResult:
    def _seed_cli_node(self):
        from main import cli_graph

        cli_graph.nodes["n1"] = {
            "params": {
                "scene": {
                    "shots": [
                        {"id": "a", "prompt": "pa", "output": {"imageUrl": "URL_A", "status": "done"}},
                        {"id": "b", "prompt": "pb", "output": {"imageUrl": "URL_B_old", "status": "done"}},
                        {"id": "c", "prompt": "pc", "output": {"imageUrl": "URL_C", "status": "done"}},
                    ]
                }
            },
            "outputs": {
                "shot_a": {"type": "Image", "value": "URL_A"},
                "shot_b": {"type": "Image", "value": "URL_B_old"},
                "shot_c": {"type": "Image", "value": "URL_C"},
            },
        }
        return cli_graph

    def test_merge_updates_only_target_shot_and_port(self):
        from main import _merge_shot_result, cli_graph
        from models.graph import GraphNode

        self._seed_cli_node()

        # The executed single-shot node carries the regenerated output for shot b.
        executed = GraphNode(
            id="n1",
            definitionId="cinema-scene",
            params={"scene": {"shots": [{"id": "b", "prompt": "pb", "output": {"imageUrl": "URL_B_new", "status": "done"}}]}},
        )
        # The full (all-shots) scene from the request — the merge target.
        fresh_scene = {
            "shots": [
                {"id": "a", "prompt": "pa", "output": {"imageUrl": "URL_A", "status": "done"}},
                {"id": "b", "prompt": "pb", "output": {"imageUrl": "URL_B_old", "status": "done"}},
                {"id": "c", "prompt": "pc", "output": {"imageUrl": "URL_C", "status": "done"}},
            ]
        }
        captured = {"shot_b": {"type": "Image", "value": "URL_B_new"}}

        returned = _merge_shot_result("n1", "b", fresh_scene, executed, captured)

        # Returned the new output.
        assert returned == {"imageUrl": "URL_B_new", "status": "done"}

        node = cli_graph.nodes["n1"]
        shots = {s["id"]: s for s in node["params"]["scene"]["shots"]}
        # All three shots survive; only b changed.
        assert set(shots) == {"a", "b", "c"}
        assert shots["a"]["output"]["imageUrl"] == "URL_A"
        assert shots["b"]["output"]["imageUrl"] == "URL_B_new"
        assert shots["c"]["output"]["imageUrl"] == "URL_C"
        # Ports: a/c preserved, b updated — NOT clobbered down to a single port.
        assert node["outputs"]["shot_a"]["value"] == "URL_A"
        assert node["outputs"]["shot_b"]["value"] == "URL_B_new"
        assert node["outputs"]["shot_c"]["value"] == "URL_C"

        cli_graph.nodes.pop("n1", None)

    def test_merge_is_noop_when_node_absent_from_cli_graph(self):
        from main import _merge_shot_result, cli_graph
        from models.graph import GraphNode

        cli_graph.nodes.pop("ghost", None)
        executed = GraphNode(
            id="ghost",
            definitionId="cinema-scene",
            params={"scene": {"shots": [{"id": "b", "output": {"imageUrl": "NEW", "status": "done"}}]}},
        )
        fresh_scene = {"shots": [{"id": "b", "output": {"imageUrl": "OLD", "status": "done"}}]}
        # Should not raise; returns the new output even when there's nothing to persist.
        returned = _merge_shot_result("ghost", "b", fresh_scene, executed, {})
        assert returned == {"imageUrl": "NEW", "status": "done"}
        assert "ghost" not in cli_graph.nodes
