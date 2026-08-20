"""Credential-aware cache regressions for the Nous model-list proxy.

All upstream HTTP is intercepted. These tests never read real Hermes files or
call Nous Portal.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from main import app
from services.model_cache import model_cache
from services.nous_auth import (
    NousCredential,
    NousCredentialExpiredError,
    NousCredentialInvalidError,
)


MODELS_URL = "https://inference.example/v1/models"


@pytest.fixture(autouse=True)
def reset_model_cache():
    model_cache.clear()
    yield
    model_cache.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _credential(token: str, *, expiry_year: int = 2999) -> NousCredential:
    return NousCredential(
        access_token=token,
        base_url="https://inference.example/v1",
        expires_at=datetime(expiry_year, 1, 1, tzinfo=timezone.utc),
    )


@respx.mock
def test_same_credential_reuses_cached_models(client, monkeypatch) -> None:
    loads = {"count": 0}

    def load() -> NousCredential:
        loads["count"] += 1
        return _credential("stable-token")

    monkeypatch.setattr("routes.nous_proxy.load_nous_credential", load)
    route = respx.get(MODELS_URL).mock(
        return_value=Response(200, json={"data": [{"id": "hermes-stable"}]})
    )

    first = client.get("/api/nous/models")
    second = client.get("/api/nous/models")

    assert first.status_code == 200
    assert second.json() == first.json()
    assert route.call_count == 1
    # Auth is intentionally re-read before every cache lookup so external
    # Hermes rotation/expiry cannot be hidden by the model TTL.
    assert loads["count"] == 2


@respx.mock
def test_rotated_credential_does_not_reuse_previous_model_cache(
    client,
    monkeypatch,
) -> None:
    credentials = iter([_credential("token-one"), _credential("token-two")])
    monkeypatch.setattr(
        "routes.nous_proxy.load_nous_credential",
        lambda: next(credentials),
    )
    route = respx.get(MODELS_URL).mock(
        side_effect=[
            Response(200, json={"data": [{"id": "model-before-rotation"}]}),
            Response(200, json={"data": [{"id": "model-after-rotation"}]}),
        ]
    )

    first = client.get("/api/nous/models")
    second = client.get("/api/nous/models")

    assert first.json()["models"][0]["id"] == "model-before-rotation"
    assert second.json()["models"][0]["id"] == "model-after-rotation"
    assert route.call_count == 2
    assert route.calls[0].request.headers["Authorization"] == "Bearer token-one"
    assert route.calls[1].request.headers["Authorization"] == "Bearer token-two"


@respx.mock
def test_expired_credential_blocks_previously_cached_models(
    client,
    monkeypatch,
) -> None:
    expired = NousCredentialExpiredError("Nous Portal credential expired")
    load_results = iter([_credential("soon-expired-token"), expired])

    def load() -> NousCredential:
        value = next(load_results)
        if isinstance(value, Exception):
            raise value
        return value

    monkeypatch.setattr("routes.nous_proxy.load_nous_credential", load)
    route = respx.get(MODELS_URL).mock(
        return_value=Response(200, json={"data": [{"id": "cached-model"}]})
    )

    first = client.get("/api/nous/models")
    second = client.get("/api/nous/models")

    assert first.status_code == 200
    assert second.status_code == 401
    assert "expired" in second.json()["detail"]
    assert route.call_count == 1


@respx.mock
def test_rejected_token_uses_daedalus_refresh_instruction(
    client,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "routes.nous_proxy.load_nous_credential",
        lambda: _credential("rejected-token"),
    )
    respx.get(MODELS_URL).mock(return_value=Response(401, text="rejected"))

    response = client.get("/api/nous/models")

    assert response.status_code == 401
    assert "hermes-daedalus model" in response.json()["detail"]


@respx.mock(assert_all_called=False)
def test_locally_rejected_credential_never_reaches_upstream(
    client,
    monkeypatch,
) -> None:
    def reject() -> NousCredential:
        raise NousCredentialInvalidError(
            "Persisted inference base URL is not the canonical Nous host"
        )

    monkeypatch.setattr(
        "routes.nous_proxy.load_nous_credential",
        reject,
    )
    upstream = respx.get("https://attacker.example/v1/models").mock(
        return_value=Response(200, json={"data": []})
    )

    response = client.get("/api/nous/models")

    assert response.status_code == 401
    assert "canonical Nous host" in response.json()["detail"]
    assert upstream.call_count == 0
