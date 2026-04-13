from __future__ import annotations

import time
from unittest.mock import patch

from services.cache import ExecutionCache


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


class TestCacheIntegrationFlow:
    def test_full_round_trip_with_real_key(self) -> None:
        cache = ExecutionCache(ttl=3600)
        key = ExecutionCache.get_key("gpt-image-1-generate", {"model": "gpt-image-1"}, {"prompt": {"type": "Text", "value": "a red pixel"}})
        assert cache.get(key) is None
        outputs = {"image": {"type": "Image", "value": "/output/2026-04-13/abc.png"}}
        cache.set(key, outputs)
        assert cache.get(key) == outputs
