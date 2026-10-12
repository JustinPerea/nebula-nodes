from __future__ import annotations

import base64
import json
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from services import google_vertex
from services.google_vertex import (
    TOKEN_URL,
    VertexCredentialsError,
    access_token,
    parse_service_account,
    signed_assertion,
)


def _key_json(**overrides) -> str:
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    ).decode()
    data = {
        "type": "service_account", "project_id": "proj-1", "private_key_id": "kid-1",
        "private_key": pem, "client_email": "veo@proj-1.iam.gserviceaccount.com",
        "token_uri": "https://evil.example/token",
    }
    data.update(overrides)
    return json.dumps(data)


def _b64decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def test_parse_rejects_non_service_account_keys():
    with pytest.raises(VertexCredentialsError):
        parse_service_account("not json")
    with pytest.raises(VertexCredentialsError, match="service_account"):
        parse_service_account(json.dumps({"type": "authorized_user"}))
    with pytest.raises(VertexCredentialsError, match="project_id"):
        parse_service_account(_key_json(project_id=""))


def test_signed_assertion_is_a_valid_rs256_jwt():
    raw = _key_json()
    account = parse_service_account(raw)
    jwt = signed_assertion(account, now=1_000)
    header, claims, signature = jwt.split(".")
    assert json.loads(_b64decode(header)) == {"alg": "RS256", "typ": "JWT", "kid": "kid-1"}
    assert json.loads(_b64decode(claims)) == {
        "iss": "veo@proj-1.iam.gserviceaccount.com",
        "scope": "https://www.googleapis.com/auth/cloud-platform",
        "aud": TOKEN_URL, "iat": 1_000, "exp": 4_600,
    }
    public = serialization.load_pem_private_key(account["private_key"].encode(), None).public_key()
    public.verify(_b64decode(signature), f"{header}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256())


class _TokenClient:
    calls: list[tuple[str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, data=None):
        _TokenClient.calls.append((url, data))

        class _R:
            status_code = 200

            def json(self):
                return {"access_token": "ya29.token", "expires_in": 3599}
        return _R()


@pytest.mark.asyncio
async def test_access_token_uses_fixed_endpoint_and_caches():
    google_vertex._tokens.clear()
    _TokenClient.calls = []
    raw = _key_json()
    with patch("services.google_vertex.httpx.AsyncClient", return_value=_TokenClient()):
        assert await access_token(raw) == ("ya29.token", "proj-1")
        assert await access_token(raw) == ("ya29.token", "proj-1")
    assert len(_TokenClient.calls) == 1, "the second call is served from cache"
    url, data = _TokenClient.calls[0]
    assert url == TOKEN_URL, "token_uri from the key file is ignored"
    assert data["grant_type"] == "urn:ietf:params:oauth:grant-type:jwt-bearer"
    google_vertex._tokens.clear()
