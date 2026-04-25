"""Proxy the Nous Portal model list so the frontend can populate the
Inspector dropdown without bundling Nous's auth into the React app.

Mirrors `routes/openrouter_proxy.py`: 5-minute cache, slimmed payload
(id / name / modalities / context length). Auth comes from
`~/.hermes/auth.json` via `services/nous_auth.py` — when it's missing
or stale we surface the underlying message verbatim so the user knows
to re-run `hermes auth`.
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
    cached = model_cache.get(CACHE_KEY)
    if cached is not None:
        return cached

    try:
        cred = load_nous_credential()
    except NousNotAuthenticatedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    url = f"{cred.base_url.rstrip('/')}/models"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={"Authorization": f"Bearer {cred.access_token}"},
        )
        if resp.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail="Nous Portal token rejected — run `hermes auth` to refresh.",
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
    model_cache.set(CACHE_KEY, result, ttl=CACHE_TTL)
    return result
