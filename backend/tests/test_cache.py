from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

import pytest

from execution.engine import execute_graph
from models import GraphNode
from models.events import ErrorEvent, ExecutedEvent
from models.graph import GraphEdge
from models.spatial import dump_spatial_value, parse_spatial_value
from services.cache import ExecutionCache
from services.output import (
    OUTPUT_ROOT,
    get_run_dir,
    portable_output_ref,
    read_manifest,
    resolve_output_ref,
)


class TestGetKey:
    @pytest.mark.parametrize("kind", ["camera-pose", "camera-path", "spatial-context", "sensor-rig"])
    def test_spatial_authors_include_node_identity(self, kind: str) -> None:
        assert ExecutionCache.get_key(kind, {}, {}, node_id="a") != ExecutionCache.get_key(kind, {}, {}, node_id="b")

    def test_deterministic_for_same_inputs(self) -> None:
        key1 = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1", "size": "1024x1024"}, {"prompt": {"type": "Text", "value": "a red pixel"}})
        key2 = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1", "size": "1024x1024"}, {"prompt": {"type": "Text", "value": "a red pixel"}})
        assert key1 == key2
        assert len(key1) == 64

    def test_different_params_produce_different_keys(self) -> None:
        inputs = {"prompt": {"type": "Text", "value": "hello"}}
        key1 = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1", "size": "1024x1024"}, inputs)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1", "size": "1536x1024"}, inputs)
        assert key1 != key2

    def test_different_inputs_produce_different_keys(self) -> None:
        params = {"model": "gpt-image-1"}
        key1 = ExecutionCache.get_key("gpt-image-1-generate", params, {"prompt": {"type": "Text", "value": "cat"}})
        key2 = ExecutionCache.get_key("gpt-image-1-generate", params, {"prompt": {"type": "Text", "value": "dog"}})
        assert key1 != key2

    def test_different_node_types_produce_different_keys(self) -> None:
        params = {"model": "x"}
        inputs = {"text": {"type": "Text", "value": "hello"}}
        key1 = ExecutionCache.get_key("claude-chat", params, inputs)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", params, inputs)
        assert key1 != key2

    def test_dict_key_order_does_not_affect_key(self) -> None:
        inputs = {"prompt": {"type": "Text", "value": "test"}}
        key1 = ExecutionCache.get_key("gpt-image-1-generate", {"size": "1024x1024", "model": "gpt-image-1"}, inputs)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1", "size": "1024x1024"}, inputs)
        assert key1 == key2


class TestCacheGetSet:
    def test_miss_returns_none(self) -> None:
        cache = ExecutionCache(ttl=3600)
        assert cache.get("nonexistent") is None

    def test_hit_returns_stored_outputs(self) -> None:
        cache = ExecutionCache(ttl=3600)
        outputs = {"image": {"type": "Image", "value": "/output/test.png"}}
        cache.set("abc123", outputs)
        assert cache.get("abc123") == outputs

    def test_expired_entry_returns_none(self) -> None:
        cache = ExecutionCache(ttl=1)
        outputs = {"text": {"type": "Text", "value": "hello"}}
        cache.set("key1", outputs)
        original_time = time.monotonic()
        with patch("services.cache.time.monotonic", return_value=original_time + 2):
            assert cache.get("key1") is None
        assert cache.size == 0

    def test_not_expired_entry_returns_value(self) -> None:
        cache = ExecutionCache(ttl=3600)
        outputs = {"text": {"type": "Text", "value": "hello"}}
        cache.set("key1", outputs)
        original_time = time.monotonic()
        with patch("services.cache.time.monotonic", return_value=original_time + 100):
            assert cache.get("key1") == outputs

    def test_clear_removes_all_entries(self) -> None:
        cache = ExecutionCache(ttl=3600)
        cache.set("a", {"x": 1})
        cache.set("b", {"y": 2})
        assert cache.size == 2
        cache.clear()
        assert cache.size == 0

    def test_overwrite_existing_key(self) -> None:
        cache = ExecutionCache(ttl=3600)
        cache.set("key1", {"v": 1})
        cache.set("key1", {"v": 2})
        assert cache.get("key1") == {"v": 2}
        assert cache.size == 1

    def test_missing_absolute_output_artifact_invalidates_entry(self) -> None:
        cache = ExecutionCache(ttl=3600)
        missing = OUTPUT_ROOT / "archived-run" / "gone.png"
        cache.set("missing-file", {"image": {"type": "Image", "value": str(missing)}})

        assert cache.get("missing-file") is None
        assert cache.size == 0

    def test_missing_served_output_artifact_invalidates_nested_entry(self) -> None:
        cache = ExecutionCache(ttl=3600)
        cache.set("missing-url", {
            "images": {
                "type": "Array",
                "value": ["https://example.test/remote.png", "/api/outputs/old-run/gone.png"],
            }
        })

        assert cache.get("missing-url") is None

    def test_existing_output_artifact_and_remote_values_remain_valid(self) -> None:
        cache = ExecutionCache(ttl=3600)
        run_dir = OUTPUT_ROOT / "cache-existing"
        run_dir.mkdir(parents=True, exist_ok=True)
        image = run_dir / "image.png"
        image.write_bytes(b"png")
        outputs = {
            "image": {"type": "Image", "value": "/api/outputs/cache-existing/image.png"},
            "remote": {"type": "Image", "value": "https://example.test/image.png"},
        }
        cache.set("existing", outputs)

        assert cache.get("existing") == outputs

    def test_external_absolute_value_is_not_owned_or_invalidated(self) -> None:
        cache = ExecutionCache(ttl=3600)
        outputs = {"text": {"type": "Text", "value": "/outside/not-nebula-owned"}}
        cache.set("external", outputs)

        assert cache.get("external") == outputs


class TestCacheIntegrationFlow:
    @pytest.mark.asyncio
    async def test_identical_pose_nodes_retain_identity_across_cached_runs(self) -> None:
        from handlers.spatial import handle_camera_pose

        cache = ExecutionCache()
        for _ in range(2):
            events = []

            async def emit(event) -> None:
                events.append(event)

            await execute_graph(
                nodes=[GraphNode(id=node_id, definitionId="camera-pose", params={}, outputs={}) for node_id in ("a", "b")],
                edges=[], api_keys={}, handler_registry={"camera-pose": handle_camera_pose},
                emit=emit, cache=cache,
            )
            assert not any(isinstance(event, ErrorEvent) for event in events)
            completed = [event for event in events if isinstance(event, ExecutedEvent)]
            assert len(completed) == 2
            for event in completed:
                assert event.outputs["pose"]["value"]["id"] == event.node_id

    def test_full_round_trip_with_real_key(self) -> None:
        cache = ExecutionCache(ttl=3600)
        key = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1"}, {"prompt": {"type": "Text", "value": "a red pixel"}})
        assert cache.get(key) is None
        outputs = {"image": {"type": "Image", "value": "/output/2026-04-13/abc.png"}}
        cache.set(key, outputs)
        assert cache.get(key) == outputs

    @pytest.mark.asyncio
    async def test_deleted_cached_artifact_reexecutes_handler(self) -> None:
        cache = ExecutionCache(ttl=3600)
        calls = 0
        output_paths = []

        async def handler(node, _inputs, _keys):
            nonlocal calls
            calls += 1
            path = get_run_dir() / f"{node.id}-{calls}.png"
            path.write_bytes(b"png")
            output_paths.append(path)
            return {"image": {"type": "Image", "value": str(path)}}

        async def run() -> list[object]:
            events: list[object] = []

            async def emit(event) -> None:
                events.append(event)

            await execute_graph(
                nodes=[GraphNode(id="n1", definitionId="cache-file-node", params={}, outputs={})],
                edges=[],
                api_keys={},
                handler_registry={"cache-file-node": handler},
                emit=emit,
                cache=cache,
            )
            return events

        await run()
        output_paths[0].unlink()
        second_events = await run()

        assert calls == 2
        executed = [event for event in second_events if isinstance(event, ExecutedEvent)]
        assert executed[0].outputs["image"]["value"] == str(output_paths[1])
        assert output_paths[1].is_file()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "definition_id",
        ["worldlabs-environment", "worldlabs-world-export"],
    )
    async def test_worldlabs_operations_bypass_output_cache(
        self, definition_id: str, monkeypatch
    ) -> None:
        cache = ExecutionCache(ttl=3600)
        calls = 0

        async def handler(_node, _inputs, _keys):
            nonlocal calls
            calls += 1
            return {"result": {"type": "Text", "value": f"operation-{calls}"}}

        # Replace the canonical implementation at its source so the identity
        # gate remains exercised while this test performs no provider work.
        handler_name = (
            "handle_worldlabs_environment"
            if definition_id == "worldlabs-environment"
            else "handle_worldlabs_export"
        )
        monkeypatch.setattr(f"handlers.worldlabs.{handler_name}", handler)

        async def emit(_event) -> None:
            return None

        node = GraphNode(id="world-1", definitionId=definition_id, params={}, outputs={})
        for _ in range(2):
            await execute_graph(
                nodes=[node],
                edges=[],
                api_keys={},
                handler_registry={definition_id: handler},
                emit=emit,
                cache=cache,
            )

        assert calls == 2
        assert cache.size == 0

    @pytest.mark.asyncio
    async def test_cached_world_is_rebound_into_new_run_and_manifest(self) -> None:
        cache = ExecutionCache(ttl=3600)
        calls = 0

        async def handler(_node, _inputs, _keys):
            nonlocal calls
            calls += 1
            run_dir = get_run_dir()
            splat = run_dir / "world-100k.spz"
            panorama = run_dir / "world-panorama.png"
            collider = run_dir / "world-collider.glb"
            splat.write_bytes(b"spz")
            panorama.write_bytes(b"png")
            collider.write_bytes(b"glb")
            return {
                "world": {
                    "type": "World",
                    "value": {
                        "schemaVersion": 1,
                        "provider": "worldlabs",
                        "worldId": "world-cache",
                        "assets": {
                            "splats": {"100k": str(splat)},
                            "panorama": str(panorama),
                            "colliderMesh": str(collider),
                        },
                    },
                },
                "panorama": {"type": "Image", "value": str(panorama)},
            }

        async def run() -> dict:
            events: list[object] = []

            async def emit(event) -> None:
                events.append(event)

            await execute_graph(
                nodes=[
                    GraphNode(
                        id="world-node",
                        definitionId="cache-world-node",
                        params={},
                        outputs={},
                    )
                ],
                edges=[],
                api_keys={},
                handler_registry={"cache-world-node": handler},
                emit=emit,
                cache=cache,
            )
            executed = [event for event in events if isinstance(event, ExecutedEvent)]
            assert len(executed) == 1
            return executed[0].outputs

        first = await run()
        second = await run()

        assert calls == 1
        first_world = first["world"]["value"]
        second_world = second["world"]["value"]
        first_paths = {
            Path(resolve_output_ref(first_world["assets"]["splats"]["100k"])),
            Path(resolve_output_ref(first_world["assets"]["panorama"])),
            Path(resolve_output_ref(first_world["assets"]["colliderMesh"])),
        }
        second_paths = {
            Path(resolve_output_ref(second_world["assets"]["splats"]["100k"])),
            Path(resolve_output_ref(second_world["assets"]["panorama"])),
            Path(resolve_output_ref(second_world["assets"]["colliderMesh"])),
        }
        assert first_paths.isdisjoint(second_paths)
        assert len({path.parent for path in second_paths}) == 1
        second_run_dir = next(iter(second_paths)).parent
        assert all(path.is_file() for path in second_paths)
        assert portable_output_ref(second["panorama"]["value"]) == second_world["assets"]["panorama"]

        manifest = read_manifest(second_run_dir)
        assert {record["output_path"] for record in manifest["outputs"]} == {
            path.name for path in second_paths
        }

        # The latest cache no longer depends on the first run's directory.
        for path in first_paths:
            path.unlink()
        key = ExecutionCache.get_key("cache-world-node", {}, {})
        cached = cache.get(key)
        assert cached is not None
        assert cached["world"]["value"]["assets"]["panorama"] == portable_output_ref(second["panorama"]["value"])

    @pytest.mark.asyncio
    async def test_cached_spatial_context_stays_portable_for_downstream_validation(
        self,
    ) -> None:
        cache = ExecutionCache(ttl=3600)
        context_calls = 0
        validation_calls = 0

        async def context_handler(_node, _inputs, _keys):
            nonlocal context_calls
            context_calls += 1
            image = get_run_dir() / "reference.png"
            image.write_bytes(b"fixture")
            coordinate_system = {
                "schemaVersion": 1,
                "kind": "coordinate-system",
                "id": "world",
                "handedness": "right",
                "upAxis": "y",
                "forwardAxis": "-z",
                "unit": "meters",
                "metersPerUnit": 1.0,
                "originMeters": [0.0, 0.0, 0.0],
            }
            pose = {
                "schemaVersion": 1,
                "kind": "camera-pose",
                "id": "pose",
                "coordinateSystem": coordinate_system,
                "position": [0.0, 0.0, 0.0],
                "orientation": [0.0, 0.0, 0.0, 1.0],
                "timestampSeconds": 0.0,
            }
            return {
                "context": {
                    "type": "SpatialContext",
                    "value": {
                        "schemaVersion": 1,
                        "kind": "spatial-context",
                        "id": "context",
                        "coordinateSystem": coordinate_system,
                        "anchors": [
                            {
                                "id": "anchor",
                                "role": "reference",
                                "pose": pose,
                                "asset": {
                                    "id": "asset",
                                    "uri": portable_output_ref(str(image)),
                                    "mediaType": "image/png",
                                },
                            }
                        ],
                    },
                }
            }

        async def validator_handler(_node, inputs, _keys):
            nonlocal validation_calls
            validation_calls += 1
            parsed = parse_spatial_value("SpatialContext", inputs["input"].value)
            return {
                "value": {
                    "type": "SpatialContext",
                    "value": dump_spatial_value(parsed),
                }
            }

        async def run() -> dict:
            events: list[object] = []

            async def emit(event) -> None:
                events.append(event)

            await execute_graph(
                nodes=[
                    GraphNode(
                        id="context",
                        definitionId="cache-spatial-context",
                        params={},
                    ),
                    GraphNode(
                        id="validate",
                        definitionId="cache-spatial-validator",
                        params={},
                    ),
                ],
                edges=[
                    GraphEdge(
                        id="edge",
                        source="context",
                        sourceHandle="context",
                        target="validate",
                        targetHandle="input",
                    )
                ],
                api_keys={},
                handler_registry={
                    "cache-spatial-context": context_handler,
                    "cache-spatial-validator": validator_handler,
                },
                emit=emit,
                cache=cache,
            )
            assert not [event for event in events if isinstance(event, ErrorEvent)]
            executed = [event for event in events if isinstance(event, ExecutedEvent)]
            return next(event.outputs for event in executed if event.node_id == "context")

        first = await run()
        second = await run()

        assert context_calls == 1
        assert validation_calls == 2
        first_uri = first["context"]["value"]["anchors"][0]["asset"]["uri"]
        second_uri = second["context"]["value"]["anchors"][0]["asset"]["uri"]
        assert first_uri.startswith("/api/outputs/")
        assert second_uri.startswith("/api/outputs/")
        assert first_uri != second_uri
        assert Path(resolve_output_ref(second_uri)).is_file()
