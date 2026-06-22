"""Tests for the per-shot regeneration entrypoint (POST /api/cinema/generate-shot).

Covers the request-validation guards (return before any async work) and the
critical merge logic `_merge_shot_result`, which must update ONLY the target
shot's output + port while leaving every sibling shot and port intact (the D2
"single-shot state merge" concern from the proposal).
"""
from __future__ import annotations

import asyncio
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

    def test_variations_count_is_bounded(self, client):
        # An out-of-range variations count is rejected by the model (422) before
        # any generation runs — a raw POST can't queue an unbounded base-model run.
        node = _cinema_node([{"id": "a", "prompt": "x"}])
        for bad in (0, 5, 1000):
            resp = client.post(
                "/api/cinema/generate-shot",
                json={"nodes": [node], "edges": [], "nodeId": "n1", "shotId": "a", "variations": bad},
            )
            assert resp.status_code == 422, f"variations={bad} should be rejected"


# ---------- merge logic (no-clobber) ----------


class TestMergeShotResult:
    def _seed_cli_node(self):
        from main import cli_graph, _shot_merge_locks

        # Each asyncio.run() below spins a fresh event loop; drop cached locks so a
        # Lock created in a prior loop is never awaited from a new one.
        _shot_merge_locks.clear()
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

        # The seeded cli_graph node IS the live scene the merge patches.
        self._seed_cli_node()

        # The executed single-shot node carries the regenerated output for shot b.
        executed = GraphNode(
            id="n1",
            definitionId="cinema-scene",
            params={"scene": {"shots": [{"id": "b", "prompt": "pb", "output": {"imageUrl": "URL_B_new", "status": "done"}}]}},
        )
        captured = {"shot_b": {"type": "Image", "value": "URL_B_new"}}

        returned = asyncio.run(_merge_shot_result("n1", "b", executed, captured))

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

    def test_merge_preserves_concurrent_sibling_edits(self):
        """A sibling shot edited on the canvas DURING a slow generation must
        survive the merge — the merge reads the live scene, not a request
        snapshot. Regression for the verifier's CRITICAL #1."""
        from main import _merge_shot_result, cli_graph
        from models.graph import GraphNode

        self._seed_cli_node()
        # Simulate the editor persisting an edit to a SIBLING shot (a) mid-generation.
        cli_graph.nodes["n1"]["params"]["scene"]["shots"][0]["prompt"] = "pa_EDITED"

        executed = GraphNode(
            id="n1",
            definitionId="cinema-scene",
            params={"scene": {"shots": [{"id": "b", "output": {"imageUrl": "URL_B_new", "status": "done"}}]}},
        )
        asyncio.run(_merge_shot_result("n1", "b", executed, {"shot_b": {"type": "Image", "value": "URL_B_new"}}))

        shots = {s["id"]: s for s in cli_graph.nodes["n1"]["params"]["scene"]["shots"]}
        # The concurrent sibling edit is preserved (NOT reverted to a snapshot).
        assert shots["a"]["prompt"] == "pa_EDITED"
        assert shots["b"]["output"]["imageUrl"] == "URL_B_new"
        cli_graph.nodes.pop("n1", None)

    def test_terminal_error_preserves_live_scene_and_last_good_port(self):
        """A failed background pass must replace the optimistic running state
        without erasing the last good image or any concurrent sibling edit."""
        from main import _merge_shot_result, cli_graph

        self._seed_cli_node()
        cli_graph.nodes["n1"]["params"]["scene"]["shots"][0]["prompt"] = "pa_EDITED"

        returned = asyncio.run(
            _merge_shot_result(
                "n1",
                "b",
                None,
                {},
                terminal_error="Reference input failed",
            )
        )

        node = cli_graph.nodes["n1"]
        shots = {s["id"]: s for s in node["params"]["scene"]["shots"]}
        assert returned == {
            "imageUrl": "URL_B_old",
            "status": "error",
            "error": "Reference input failed",
        }
        assert shots["a"]["prompt"] == "pa_EDITED"
        assert shots["b"]["output"] == returned
        assert shots["c"]["output"]["imageUrl"] == "URL_C"
        assert node["outputs"] == {
            "shot_a": {"type": "Image", "value": "URL_A"},
            "shot_b": {"type": "Image", "value": "URL_B_old"},
            "shot_c": {"type": "Image", "value": "URL_C"},
        }
        cli_graph.nodes.pop("n1", None)

    @pytest.mark.asyncio
    async def test_background_error_event_persists_terminal_shot_error(
        self, monkeypatch
    ):
        """execute_graph returns normally after upstream ErrorEvent. Absence of
        the target ExecutedEvent must still reconcile the shot and broadcast."""
        from main import _run_single_shot_task, cli_graph
        from models.events import ErrorEvent
        from models.graph import GraphNode

        self._seed_cli_node()
        cli_graph.nodes["n1"]["params"]["scene"]["shots"][2]["prompt"] = "pc_EDITED"
        emitted = []
        broadcasts = []

        async def fake_execute_graph(**kwargs):
            await kwargs["emit"](
                ErrorEvent(
                    node_id="upstream",
                    error="raw upstream failure",
                    friendly="Reference input failed",
                )
            )

        async def fake_emit_and_sync(event):
            emitted.append(event)

        async def fake_broadcast():
            broadcasts.append(True)

        monkeypatch.setattr("main.execute_graph", fake_execute_graph)
        monkeypatch.setattr("main._emit_and_sync", fake_emit_and_sync)
        monkeypatch.setattr("main._broadcast_graph_sync", fake_broadcast)

        target = GraphNode(
            id="n1",
            definitionId="cinema-scene",
            params={
                "scene": {
                    "shots": [
                        {"id": "b", "output": {"imageUrl": "STALE", "status": "done"}}
                    ]
                }
            },
        )
        await _run_single_shot_task(
            node_id="n1",
            shot_id="b",
            sub_nodes=[target],
            sub_edges=[],
            api_keys={},
        )

        node = cli_graph.nodes["n1"]
        shots = {s["id"]: s for s in node["params"]["scene"]["shots"]}
        assert shots["b"]["output"] == {
            "imageUrl": "URL_B_old",
            "status": "error",
            "error": "Reference input failed",
        }
        assert shots["c"]["prompt"] == "pc_EDITED"
        assert node["outputs"]["shot_b"]["value"] == "URL_B_old"
        assert len(emitted) == 1
        assert broadcasts == [True]
        cli_graph.nodes.pop("n1", None)

    @pytest.mark.asyncio
    async def test_background_exception_persists_terminal_shot_error(
        self, monkeypatch
    ):
        from main import _run_single_shot_task, cli_graph
        from models.graph import GraphNode

        self._seed_cli_node()
        broadcasts = []

        async def fake_execute_graph(**_kwargs):
            raise RuntimeError("executor exploded")

        async def fake_broadcast():
            broadcasts.append(True)

        monkeypatch.setattr("main.execute_graph", fake_execute_graph)
        monkeypatch.setattr("main._broadcast_graph_sync", fake_broadcast)

        target = GraphNode(
            id="n1",
            definitionId="cinema-scene",
            params={"scene": {"shots": [{"id": "b"}]}},
        )
        await _run_single_shot_task(
            node_id="n1",
            shot_id="b",
            sub_nodes=[target],
            sub_edges=[],
            api_keys={},
        )

        shot_b = next(
            shot
            for shot in cli_graph.nodes["n1"]["params"]["scene"]["shots"]
            if shot["id"] == "b"
        )
        assert shot_b["output"] == {
            "imageUrl": "URL_B_old",
            "status": "error",
            "error": "Shot generation failed: executor exploded",
        }
        assert cli_graph.nodes["n1"]["outputs"]["shot_b"]["value"] == "URL_B_old"
        assert broadcasts == [True]
        cli_graph.nodes.pop("n1", None)

    def test_concurrent_merges_on_same_node_keep_both_ports(self):
        """Two single-shot generates completing close together must each keep
        their port — i.e. the merge MERGES into the existing ports dict rather
        than REPLACING it. (This guards the merge-not-replace property; it does
        NOT prove the per-node lock serializes, because the merge critical
        section has no `await` and is already atomic under asyncio's cooperative
        scheduler. The lock is defensive — it matters only if an `await` is ever
        added inside the critical section, e.g. async persistence.)"""
        from main import _merge_shot_result, cli_graph
        from models.graph import GraphNode

        self._seed_cli_node()

        exec_b = GraphNode(id="n1", definitionId="cinema-scene",
                           params={"scene": {"shots": [{"id": "b", "output": {"imageUrl": "URL_B_new", "status": "done"}}]}})
        exec_c = GraphNode(id="n1", definitionId="cinema-scene",
                           params={"scene": {"shots": [{"id": "c", "output": {"imageUrl": "URL_C_new", "status": "done"}}]}})

        async def _both():
            await asyncio.gather(
                _merge_shot_result("n1", "b", exec_b, {"shot_b": {"type": "Image", "value": "URL_B_new"}}),
                _merge_shot_result("n1", "c", exec_c, {"shot_c": {"type": "Image", "value": "URL_C_new"}}),
            )

        asyncio.run(_both())

        node = cli_graph.nodes["n1"]
        # Both regenerated ports survive (the per-node lock serialized the merges).
        assert node["outputs"]["shot_a"]["value"] == "URL_A"
        assert node["outputs"]["shot_b"]["value"] == "URL_B_new"
        assert node["outputs"]["shot_c"]["value"] == "URL_C_new"
        shots = {s["id"]: s for s in node["params"]["scene"]["shots"]}
        assert shots["b"]["output"]["imageUrl"] == "URL_B_new"
        assert shots["c"]["output"]["imageUrl"] == "URL_C_new"
        cli_graph.nodes.pop("n1", None)

    def test_merge_is_noop_when_node_absent_from_cli_graph(self):
        from main import _merge_shot_result, cli_graph, _shot_merge_locks
        from models.graph import GraphNode

        _shot_merge_locks.clear()
        cli_graph.nodes.pop("ghost", None)
        executed = GraphNode(
            id="ghost",
            definitionId="cinema-scene",
            params={"scene": {"shots": [{"id": "b", "output": {"imageUrl": "NEW", "status": "done"}}]}},
        )
        # Should not raise; returns the new output even when there's nothing to persist.
        returned = asyncio.run(_merge_shot_result("ghost", "b", executed, {}))
        assert returned == {"imageUrl": "NEW", "status": "done"}
        assert "ghost" not in cli_graph.nodes


class TestMergeShotVariations:
    def _seed_cli_node(self):
        from main import cli_graph, _shot_merge_locks

        _shot_merge_locks.clear()
        cli_graph.nodes["n1"] = {
            "params": {
                "scene": {
                    "shots": [
                        {"id": "a", "prompt": "pa", "output": {"imageUrl": "URL_A", "status": "done"}},
                        {"id": "b", "prompt": "pb", "output": {"imageUrl": "URL_B_old", "status": "done"}},
                    ]
                }
            },
            "outputs": {
                "shot_a": {"type": "Image", "value": "URL_A"},
                "shot_b": {"type": "Image", "value": "URL_B_old"},
            },
        }
        return cli_graph

    def test_variations_stored_and_first_promoted_canonical(self):
        from main import _merge_shot_variations, cli_graph

        self._seed_cli_node()
        variations = [
            {"url": "URL_B_v0", "seed": 10},
            {"url": "URL_B_v1", "seed": 11},
            {"url": "URL_B_v2", "seed": 12},
        ]
        returned = asyncio.run(_merge_shot_variations("n1", "b", variations))

        # Canonical = first variation.
        assert returned == {"imageUrl": "URL_B_v0", "status": "done"}
        node = cli_graph.nodes["n1"]
        shots = {s["id"]: s for s in node["params"]["scene"]["shots"]}
        assert shots["b"]["variations"] == variations
        assert shots["b"]["selectedVariation"] == 0
        assert shots["b"]["output"]["imageUrl"] == "URL_B_v0"
        # Sibling shot 'a' untouched (no variations, original output/port).
        assert "variations" not in shots["a"]
        assert shots["a"]["output"]["imageUrl"] == "URL_A"
        assert node["outputs"]["shot_a"]["value"] == "URL_A"
        # Canonical port = first variation.
        assert node["outputs"]["shot_b"]["value"] == "URL_B_v0"
        cli_graph.nodes.pop("n1", None)

    def test_empty_variations_is_noop(self):
        from main import _merge_shot_variations, cli_graph

        self._seed_cli_node()
        returned = asyncio.run(_merge_shot_variations("n1", "b", []))
        assert returned is None
        # Shot b unchanged.
        shots = {s["id"]: s for s in cli_graph.nodes["n1"]["params"]["scene"]["shots"]}
        assert "variations" not in shots["b"]
        assert shots["b"]["output"]["imageUrl"] == "URL_B_old"
        cli_graph.nodes.pop("n1", None)
