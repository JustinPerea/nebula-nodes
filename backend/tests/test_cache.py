from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from execution.engine import execute_graph
from models import GraphNode
from models.events import ExecutedEvent
from services.cache import ExecutionCache
from services.output import OUTPUT_ROOT, get_run_dir


class TestGetKey:
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
