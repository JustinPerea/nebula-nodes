"""Tests for per-provider API key validation — services.settings.validate_provider_keys
and the GET /api/health/providers endpoint.

Covers validation contract assertions:
- VAL-INFRA-003: endpoint returns per-provider status objects with
  configured (bool), status (not_configured|valid|invalid|error), last_checked.
- VAL-INFRA-004: results are cached with a 5-minute TTL; a second call within
  the TTL makes no new provider API calls and returns identical timestamps.

All HTTP is mocked — no live API calls.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.settings as settings_service  # noqa: E402
from services.nous_auth import NousCredential, NousNotAuthenticatedError  # noqa: E402

# Provider display name -> primary settings.json apiKeys entry.
PROVIDER_KEYS = {
    "FAL": "FAL_KEY",
    "OpenAI": "OPENAI_API_KEY",
    "Google": "GOOGLE_API_KEY",
    "Ideogram": "IDEOGRAM_API_KEY",
    "Runway": "RUNWAY_API_KEY",
    "xAI": "XAI_API_KEY",
    "Replicate": "REPLICATE_API_TOKEN",
    "ElevenLabs": "ELEVENLABS_API_KEY",
    # Nous has no settings.json key — it resolves an OAuth credential from
    # Hermes auth files via services.nous_auth.load_nous_credential().
}

ALL_PROVIDERS = list(PROVIDER_KEYS) + ["Nous"]

ALLOWED_STATUSES = {"not_configured", "valid", "invalid", "error"}


# ---------------------------------------------------------------------------
# Fakes / fixtures
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int):
        self.status_code = status_code


class _FakeAsyncClient:
    """httpx.AsyncClient stand-in: records GET requests, delegates responses."""

    def __init__(self, responder, log, **_kwargs):
        self._responder = responder
        self._log = log

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None, **_kwargs):
        self._log.append({"url": url, "headers": dict(headers or {})})
        return self._responder(url, dict(headers or {}))


def _install_client(monkeypatch, responder) -> list[dict]:
    """Patch the httpx.AsyncClient used by services.settings; return request log."""
    log: list[dict] = []
    monkeypatch.setattr(
        settings_service.httpx,
        "AsyncClient",
        lambda **kwargs: _FakeAsyncClient(responder, log, **kwargs),
    )
    return log


def _set_keys(monkeypatch, keys: dict[str, str]) -> None:
    def fake_get_api_key(names):
        if isinstance(names, str):
            names = [names]
        for name in names:
            if keys.get(name):
                return keys[name]
        return None

    monkeypatch.setattr(settings_service, "get_api_key", fake_get_api_key)


def _deny_nous(monkeypatch) -> None:
    def _raise():
        raise NousNotAuthenticatedError("no credential in test")

    monkeypatch.setattr("services.nous_auth.load_nous_credential", _raise)


def _grant_nous(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.nous_auth.load_nous_credential",
        lambda: NousCredential(
            access_token="nous-test-token",
            base_url="https://inference-api.nousresearch.com/v1",
        ),
    )


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """Fresh cache + no configured keys/credentials for every test."""
    settings_service.clear_provider_validation_cache()
    _set_keys(monkeypatch, {})
    _deny_nous(monkeypatch)
    yield
    settings_service.clear_provider_validation_cache()


# ---------------------------------------------------------------------------
# not_configured
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_all_providers_not_configured_without_keys(monkeypatch):
    log = _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    result = await settings_service.validate_provider_keys()

    assert set(result) == set(ALL_PROVIDERS)
    for name, info in result.items():
        assert info["configured"] is False, name
        assert info["status"] == "not_configured", name
        assert info["last_checked"], name
    # No network traffic when nothing is configured.
    assert log == []


# ---------------------------------------------------------------------------
# valid / invalid / error per provider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", list(PROVIDER_KEYS))
async def test_valid_key_reports_valid(monkeypatch, provider):
    _set_keys(monkeypatch, {PROVIDER_KEYS[provider]: "test-key"})
    _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    result = await settings_service.validate_provider_keys()

    assert result[provider]["configured"] is True
    assert result[provider]["status"] == "valid"
    assert result[provider]["last_checked"]


@pytest.mark.asyncio
async def test_nous_valid_with_credential(monkeypatch):
    _grant_nous(monkeypatch)
    _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    result = await settings_service.validate_provider_keys()

    assert result["Nous"]["configured"] is True
    assert result["Nous"]["status"] == "valid"


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", list(PROVIDER_KEYS))
@pytest.mark.parametrize("status_code", [401, 403])
async def test_rejected_key_reports_invalid(monkeypatch, provider, status_code):
    _set_keys(monkeypatch, {PROVIDER_KEYS[provider]: "bad-key"})
    _install_client(monkeypatch, lambda url, headers: _FakeResponse(status_code))

    result = await settings_service.validate_provider_keys()

    assert result[provider]["configured"] is True
    assert result[provider]["status"] == "invalid"


@pytest.mark.asyncio
async def test_unexpected_status_reports_error(monkeypatch):
    _set_keys(monkeypatch, {"FAL_KEY": "test-key"})
    _install_client(monkeypatch, lambda url, headers: _FakeResponse(500))

    result = await settings_service.validate_provider_keys()

    assert result["FAL"]["configured"] is True
    assert result["FAL"]["status"] == "error"
    assert "500" in result["FAL"]["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc",
    [httpx.ConnectError("boom"), httpx.TimeoutException("slow")],
)
async def test_network_failure_reports_error(monkeypatch, exc):
    _set_keys(monkeypatch, {"OPENAI_API_KEY": "test-key"})

    def responder(url, headers):
        raise exc

    _install_client(monkeypatch, responder)

    result = await settings_service.validate_provider_keys()

    assert result["OpenAI"]["configured"] is True
    assert result["OpenAI"]["status"] == "error"
    assert result["OpenAI"]["detail"]


# ---------------------------------------------------------------------------
# Per-provider request shape (URL + auth header)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_each_provider_uses_its_own_endpoint_and_auth(monkeypatch):
    _set_keys(monkeypatch, {env: f"key-for-{env}" for env in PROVIDER_KEYS.values()})
    _grant_nous(monkeypatch)
    log = _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    await settings_service.validate_provider_keys()

    assert len(log) == len(ALL_PROVIDERS)
    by_url = {req["url"]: req["headers"] for req in log}

    fal = by_url["https://api.fal.ai/v1/models?limit=1"]
    assert fal["Authorization"] == "Key key-for-FAL_KEY"

    openai = by_url["https://api.openai.com/v1/models"]
    assert openai["Authorization"] == "Bearer key-for-OPENAI_API_KEY"

    google_url = next(u for u in by_url if u.startswith("https://generativelanguage.googleapis.com/"))
    assert by_url[google_url]["x-goog-api-key"] == "key-for-GOOGLE_API_KEY"

    ideogram = by_url["https://api.ideogram.ai/models"]
    assert ideogram["Api-Key"] == "key-for-IDEOGRAM_API_KEY"

    runway = by_url["https://api.dev.runwayml.com/v1/organization"]
    assert runway["Authorization"] == "Bearer key-for-RUNWAY_API_KEY"
    assert "X-Runway-Version" in runway

    xai = by_url["https://api.x.ai/v1/models"]
    assert xai["Authorization"] == "Bearer key-for-XAI_API_KEY"

    replicate = by_url["https://api.replicate.com/v1/models"]
    assert replicate["Authorization"] == "Bearer key-for-REPLICATE_API_TOKEN"

    elevenlabs = by_url["https://api.elevenlabs.io/v1/user"]
    assert elevenlabs["xi-api-key"] == "key-for-ELEVENLABS_API_KEY"

    nous = by_url["https://inference-api.nousresearch.com/v1/models"]
    assert nous["Authorization"] == "Bearer nous-test-token"


# ---------------------------------------------------------------------------
# Caching (VAL-INFRA-004)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_second_call_within_ttl_returns_cached_identical_timestamp(monkeypatch):
    _set_keys(monkeypatch, {"FAL_KEY": "test-key"})
    log = _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    first = await settings_service.validate_provider_keys()
    second = await settings_service.validate_provider_keys()

    # Exactly one HTTP request total — the second call was served from cache.
    assert len(log) == 1
    assert second == first
    assert second["FAL"]["last_checked"] == first["FAL"]["last_checked"]


@pytest.mark.asyncio
async def test_cache_expires_after_ttl(monkeypatch):
    _set_keys(monkeypatch, {"FAL_KEY": "test-key"})
    log = _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    clock = {"now": 1_000.0}
    monkeypatch.setattr(settings_service, "_monotonic", lambda: clock["now"])

    await settings_service.validate_provider_keys()
    assert len(log) == 1

    # Within TTL: still cached.
    clock["now"] += settings_service.PROVIDER_CHECK_TTL_SECONDS - 1
    await settings_service.validate_provider_keys()
    assert len(log) == 1

    # Past TTL: re-validates against the provider API.
    clock["now"] += 2
    await settings_service.validate_provider_keys()
    assert len(log) == 2


@pytest.mark.asyncio
async def test_force_refresh_bypasses_cache(monkeypatch):
    _set_keys(monkeypatch, {"FAL_KEY": "test-key"})
    log = _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    await settings_service.validate_provider_keys()
    await settings_service.validate_provider_keys(force_refresh=True)

    assert len(log) == 2


# ---------------------------------------------------------------------------
# Endpoint: GET /api/health/providers (VAL-INFRA-003, VAL-INFRA-004)
# ---------------------------------------------------------------------------


def test_endpoint_returns_per_provider_status_objects(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app

    _set_keys(monkeypatch, {"FAL_KEY": "test-key"})
    _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    client = TestClient(app)
    resp = client.get("/api/health/providers")

    assert resp.status_code == 200
    body = resp.json()
    assert "providers" in body
    providers = body["providers"]

    # Contract minimum: FAL, OpenAI, Google present.
    for name in ("FAL", "OpenAI", "Google"):
        assert name in providers
    # Full roster.
    assert set(providers) == set(ALL_PROVIDERS)

    for name, info in providers.items():
        assert isinstance(info["configured"], bool), name
        assert info["status"] in ALLOWED_STATUSES, name
        assert info["last_checked"], name

    assert providers["FAL"]["status"] == "valid"
    assert providers["OpenAI"]["status"] == "not_configured"


def test_endpoint_caches_results_between_calls(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app

    _set_keys(monkeypatch, {"FAL_KEY": "test-key", "OPENAI_API_KEY": "bad-key"})
    responder_calls = {"n": 0}

    def responder(url, headers):
        responder_calls["n"] += 1
        return _FakeResponse(200 if "fal" in url else 401)

    _install_client(monkeypatch, responder)

    client = TestClient(app)
    first = client.get("/api/health/providers").json()
    second = client.get("/api/health/providers").json()

    # No new provider API calls on the second request; identical payload.
    assert responder_calls["n"] == 2  # FAL + OpenAI, once each
    assert second == first
    for name in ALL_PROVIDERS:
        assert second["providers"][name]["last_checked"] == first["providers"][name]["last_checked"]

    assert first["providers"]["FAL"]["status"] == "valid"
    assert first["providers"]["OpenAI"]["status"] == "invalid"


# ---------------------------------------------------------------------------
# Cache invalidation on settings save (fix-n-03)
# ---------------------------------------------------------------------------


def test_settings_save_clears_provider_validation_cache(monkeypatch):
    """PUT /api/settings must drop the provider-validation cache so the next
    GET /api/health/providers revalidates instead of serving stale status
    for up to the 5-minute TTL after an API key change."""
    from fastapi.testclient import TestClient
    import main as main_module

    _set_keys(monkeypatch, {"FAL_KEY": "test-key"})
    log = _install_client(monkeypatch, lambda url, headers: _FakeResponse(200))

    # Keep the endpoint off the real settings.json.
    monkeypatch.setattr(main_module, "load_settings", lambda: {"apiKeys": {}})
    saved: list[dict] = []
    monkeypatch.setattr(main_module, "save_settings", lambda s: saved.append(s))

    client = TestClient(main_module.app)

    # Populate the cache via the health endpoint (one FAL HTTP call).
    first = client.get("/api/health/providers").json()
    assert first["providers"]["FAL"]["status"] == "valid"
    assert settings_service._provider_check_cache, "cache should be populated"
    assert len(log) == 1

    resp = client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "rotated-key"}})
    assert resp.status_code == 200
    assert resp.json() == {"status": "saved"}
    assert saved, "endpoint should still persist the merged settings"

    # The save dropped the cache...
    assert settings_service._provider_check_cache == {}

    # ...so the next health poll revalidates against the provider API
    # (new HTTP traffic instead of a cached payload).
    second = client.get("/api/health/providers").json()
    assert len(log) == 2
    assert second["providers"]["FAL"]["status"] == "valid"


# ---------------------------------------------------------------------------
# Cache generation / mid-flight clear race (misc-provider-cache-race)
# ---------------------------------------------------------------------------


def test_clear_provider_validation_cache_increments_generation():
    """Each clear bumps the cache generation counter so in-flight validation
    calls can detect that their results became stale mid-flight."""
    before = settings_service._provider_cache_generation
    settings_service.clear_provider_validation_cache()
    assert settings_service._provider_cache_generation == before + 1


@pytest.mark.asyncio
async def test_in_flight_result_not_cached_when_cache_cleared_mid_flight(monkeypatch):
    """Race: a provider validation HTTP call is in flight when a settings save
    clears the cache. The in-flight (pre-save) result must NOT repopulate the
    cache — the next health poll must revalidate against the provider."""
    _set_keys(monkeypatch, {"FAL_KEY": "old-key"})

    request_in_flight = asyncio.Event()
    release_response = asyncio.Event()
    request_count = {"n": 0}

    class _BlockingClient:
        """Fake client whose GET blocks until the test releases it."""

        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, **_kwargs):
            request_count["n"] += 1
            request_in_flight.set()
            await release_response.wait()
            return _FakeResponse(200)

    monkeypatch.setattr(
        settings_service.httpx,
        "AsyncClient",
        lambda **kwargs: _BlockingClient(**kwargs),
    )

    task = asyncio.create_task(settings_service.validate_provider_keys())
    await request_in_flight.wait()  # provider HTTP call is now in flight

    # Mid-flight: a settings save clears the validation cache.
    settings_service.clear_provider_validation_cache()

    release_response.set()
    result = await task

    # The caller still receives the result it computed...
    assert result["FAL"]["status"] == "valid"
    # ...but the stale in-flight result was NOT stored in the cache.
    assert settings_service._provider_check_cache == {}

    # The next health poll revalidates (new HTTP traffic) instead of serving
    # the discarded pre-save result, and repopulates the cache.
    second = await settings_service.validate_provider_keys()
    assert request_count["n"] == 2
    assert second["FAL"]["status"] == "valid"
    assert "FAL" in settings_service._provider_check_cache
