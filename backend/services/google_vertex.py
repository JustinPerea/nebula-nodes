"""Vertex AI access from a Google Cloud service-account key.

Veo on Vertex needs an OAuth bearer token: express-mode API keys don't cover
Veo. The person pastes the service account's JSON key in Settings
(``GOOGLE_VERTEX_CREDENTIALS``); the project comes from the key and calls go
to ``us-central1``. Tokens come from Google's standard JWT-bearer exchange
(https://developers.google.com/identity/protocols/oauth2/service-account),
signed here with ``cryptography`` so no Google SDK is needed, and are cached
until shortly before they expire.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from execution.person_line import with_api_status, with_person_line

VERTEX_REGION = "us-central1"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_REFRESH_MARGIN_SECONDS = 300

_tokens: dict[str, tuple[str, float]] = {}
_lock = asyncio.Lock()


class VertexCredentialsError(ValueError):
    """The pasted key isn't a usable service-account key."""


def parse_service_account(raw: str) -> dict[str, str]:
    """client_email, private_key, project_id (and private_key_id) from the JSON key."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise with_person_line(VertexCredentialsError(
            "GOOGLE_VERTEX_CREDENTIALS is not valid JSON (paste the full service-account key file)"
        ),
            "Your Vertex AI service account key in Settings isn't a service account key file. Paste the whole key file again.") from None
    if not isinstance(data, dict) or data.get("type") != "service_account":
        raise with_person_line(VertexCredentialsError(
            "GOOGLE_VERTEX_CREDENTIALS must be a service-account JSON key (\"type\": \"service_account\")"
        ),
            "Your Vertex AI service account key in Settings isn't a service account key file. Paste the whole key file again.")
    missing = [k for k in ("client_email", "private_key", "project_id") if not isinstance(data.get(k), str) or not data[k]]
    if missing:
        raise with_person_line(
            VertexCredentialsError(f"The service-account key is missing {', '.join(missing)}"),
            "Your Vertex AI service account key is missing parts of the key file. Paste the whole key file again in Settings.")
    return {
        "client_email": data["client_email"],
        "private_key": data["private_key"],
        "project_id": data["project_id"],
        "private_key_id": str(data.get("private_key_id") or ""),
    }


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def signed_assertion(account: dict[str, str], now: float | None = None) -> str:
    """The RS256 JWT exchanged for an access token."""
    issued = int(now if now is not None else time.time())
    header: dict[str, Any] = {"alg": "RS256", "typ": "JWT"}
    if account.get("private_key_id"):
        header["kid"] = account["private_key_id"]
    claims = {
        "iss": account["client_email"],
        "scope": SCOPE,
        "aud": TOKEN_URL,
        "iat": issued,
        "exp": issued + 3600,
    }
    signing_input = f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}." \
        f"{_b64url(json.dumps(claims, separators=(',', ':')).encode())}"
    try:
        key = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
    except (ValueError, TypeError):
        raise with_person_line(
            VertexCredentialsError("The service-account private_key can't be read"),
            "The private key in your Vertex AI service account key can't be read. Paste the whole key file again in Settings.") from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise with_person_line(
            VertexCredentialsError("The service-account private_key must be an RSA key"),
            "The private key in your Vertex AI service account key can't be read. Paste the whole key file again in Settings.")
    signature = key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{_b64url(signature)}"


async def access_token(raw: str) -> tuple[str, str]:
    """(bearer token, project id) for the pasted key, from cache when still fresh.

    The token endpoint is fixed, not read from the key, so a key file can't
    send the signed assertion anywhere else."""
    account = parse_service_account(raw)
    cache_key = hashlib.sha256(raw.encode()).hexdigest()
    async with _lock:
        cached = _tokens.get(cache_key)
        if cached and cached[1] - _REFRESH_MARGIN_SECONDS > time.time():
            return cached[0], account["project_id"]
        assertion = signed_assertion(account)
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(TOKEN_URL, data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            })
        if resp.status_code != 200:
            raise with_api_status(RuntimeError(
                f"Google refused the Vertex service-account key ({resp.status_code}): {resp.text[:300]}"
            ), resp.status_code)
        body = resp.json()
        token = body.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("Google's token response had no access_token")
        expires_in = body.get("expires_in")
        lifetime = float(expires_in) if isinstance(expires_in, (int, float)) else 3600.0
        _tokens[cache_key] = (token, time.time() + lifetime)
        return token, account["project_id"]


def model_url(project_id: str, model: str, method: str) -> str:
    return (
        f"https://{VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/{project_id}"
        f"/locations/{VERTEX_REGION}/publishers/google/models/{model}:{method}"
    )
