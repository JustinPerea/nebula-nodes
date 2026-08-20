"""Proxy the Nous Portal model list so the frontend can populate the
Inspector dropdown without bundling Nous's auth into the React app.

Mirrors `routes/openrouter_proxy.py`: 5-minute cache, slimmed payload
(id / name / modalities / context length). Auth comes from Hermes profile
files via `services/nous_auth.py`. Cache entries are bound to a non-secret
credential identity so an external Hermes expiry or rotation cannot reuse a
model list fetched under the previous credential.
"""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from services.model_cache import model_cache
from services.nous_auth import NousNotAuthenticatedError, load_nous_credential

router = APIRouter(prefix="/api/nous", tags=["nous"])

CACHE_KEY = "nous:models"
CACHE_TTL = 300.0  # 5 minutes — matches the OpenRouter proxy


@router.get("/models")
async def get_models() -> dict[str, Any]:
    try:
        cred = load_nous_credential()
    except NousNotAuthenticatedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    # Resolve auth before consulting the cache. load_nous_credential() rejects
    # locally expired credentials, while cache_identity changes when Hermes
    # rotates the token, base URL, or expiry metadata. The raw token is never
    # included in the cache key.
    cached = model_cache.get(CACHE_KEY)
    if (
        isinstance(cached, tuple)
        and len(cached) == 2
        and cached[0] == cred.cache_identity
    ):
        return cached[1]

    url = f"{cred.base_url.rstrip('/')}/models"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={"Authorization": f"Bearer {cred.access_token}"},
        )
        if resp.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail=(
                    "Nous Portal token rejected — run `hermes-daedalus model` "
                    "and select Nous Portal to refresh."
                ),
            )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data = resp.json()
    raw = data.get("data") or data.get("models") or []

    slim: list[dict[str, Any]] = []
    for m in raw:
        arch = m.get("architecture") or {}
        slim.append({
            "id": m.get("id", ""),
            "name": m.get("name", m.get("id", "")),
            "input_modalities": arch.get("input_modalities", ["text"]),
            "output_modalities": arch.get("output_modalities", ["text"]),
            "context_length": m.get("context_length", 0),
            "pricing": m.get("pricing", {}),
        })

    result = {"models": slim, "count": len(slim)}
    # Keep one bounded cache entry. Storing the identity beside the payload
    # avoids both stale cross-credential reuse and one abandoned key per
    # external Hermes rotation.
    model_cache.set(CACHE_KEY, (cred.cache_identity, result), ttl=CACHE_TTL)
    return result
