"""Tests for backend/routes/quiver_proxy.py.

The proxy is a thin layer in front of QuiverClient.list_models() that
adds 5-minute caching and slims the wire payload for the frontend. Tests
cover the happy path, the offline-fallback contract (400 when key is
absent so the frontend uses its hardcoded model list), error mapping
from QuiverError subclasses to HTTP status codes, and the cache
behavior."""

from __future__ import annotations

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from main import app
from services.model_cache import model_cache


CACHE_KEY = "quiver:models"


@pytest.fixture(autouse=True)
def reset_cache():
    """Reset the in-memory model cache between tests. Each test patches
    routes.quiver_proxy.load_settings directly, so no real settings file
    is ever read."""
    model_cache.clear()
    yield
    model_cache.clear()


@pytest.fixture
def client():
    return TestClient(app)


def _set_quiver_key(monkeypatch, key: str = "qvr-test") -> None:
    """Patch load_settings as seen from the proxy module."""
    monkeypatch.setattr(
        "routes.quiver_proxy.load_settings",
        lambda: {"apiKeys": {"QUIVER_API_KEY": key}},
    )


def _no_quiver_key(monkeypatch) -> None:
    monkeypatch.setattr(
        "routes.quiver_proxy.load_settings",
        lambda: {"apiKeys": {}},
    )


def test_returns_400_when_key_not_configured(client, monkeypatch) -> None:
    _no_quiver_key(monkeypatch)
    resp = client.get("/api/quiver/models")
    assert resp.status_code == 400
    assert "QUIVER_API_KEY" in resp.json()["detail"]


@respx.mock
def test_returns_slim_model_list(client, monkeypatch) -> None:
    _set_quiver_key(monkeypatch)
    respx.get("https://api.quiver.ai/v1/models").mock(
        return_value=Response(200, json={
            "object": "list",
            "data": [
                {
                    "id": "arrow-1.1",
                    "name": "Arrow 1.1",
                    "description": "Default Arrow model",
                    "owned_by": "quiver",
                    "context_length": 131072,
                    "max_output_length": 131072,
                    "input_modalities": ["text", "image"],
                    "output_modalities": ["svg"],
                    "supported_operations": ["svg_generate", "svg_vectorize"],
                    "supported_sampling_parameters": ["temperature"],
                    "pricing_credits": {"svg_generate": 20, "svg_vectorize": 15},
                },
                {
                    "id": "arrow-1.1-max",
                    "name": "Arrow 1.1 Max",
                    "supported_operations": ["svg_generate", "svg_vectorize"],
                    "pricing_credits": {"svg_generate": 25, "svg_vectorize": 20},
                },
            ],
        })
    )
    resp = client.get("/api/quiver/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert body["models"][0]["id"] == "arrow-1.1"
    assert body["models"][0]["pricing_credits"] == {"svg_generate": 20, "svg_vectorize": 15}
    assert "context_length" not in body["models"][0]  # trimmed
    # Slim payload only carries fields the frontend uses
    expected_keys = {"id", "name", "description", "input_modalities", "output_modalities",
                     "supported_operations", "pricing_credits"}
    assert set(body["models"][0].keys()) == expected_keys


@respx.mock
def test_caches_between_calls(client, monkeypatch) -> None:
    _set_quiver_key(monkeypatch)
    route = respx.get("https://api.quiver.ai/v1/models").mock(
        return_value=Response(200, json={"object": "list", "data": [{"id": "arrow-1.1"}]})
    )
    r1 = client.get("/api/quiver/models")
    r2 = client.get("/api/quiver/models")
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json() == r2.json()
    assert route.call_count == 1  # second hit served from cache


@respx.mock
def test_bubbles_401_from_quiver(client, monkeypatch) -> None:
    _set_quiver_key(monkeypatch, key="qvr-bad")
    respx.get("https://api.quiver.ai/v1/models").mock(
        return_value=Response(401, json={"error": "bad key"})
    )
    resp = client.get("/api/quiver/models")
    assert resp.status_code == 401


@respx.mock
def test_bubbles_429_as_429(client, monkeypatch) -> None:
    _set_quiver_key(monkeypatch)
    # Two 429s so the client's single retry is exhausted -> QuiverRateLimitError -> 429
    respx.get("https://api.quiver.ai/v1/models").mock(
        side_effect=[
            Response(429, headers={"Retry-After": "0"}, text="rate limited"),
            Response(429, headers={"Retry-After": "0"}, text="rate limited again"),
        ]
    )
    resp = client.get("/api/quiver/models")
    # GET endpoints in QuiverClient don't run the retry loop, so a single 429
    # bubbles immediately. Either way the surface is 429.
    assert resp.status_code == 429


@respx.mock
def test_bubbles_5xx_as_502(client, monkeypatch) -> None:
    _set_quiver_key(monkeypatch)
    respx.get("https://api.quiver.ai/v1/models").mock(
        return_value=Response(503, text="upstream down")
    )
    resp = client.get("/api/quiver/models")
    assert resp.status_code == 502  # we surface Quiver 5xx as bad-gateway
