from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from services.settings import load_settings
from services.model_cache import model_cache

router = APIRouter(prefix="/api/openrouter", tags=["openrouter"])

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
CACHE_KEY = "openrouter:models"
CACHE_TTL = 300.0  # 5 minutes


@router.get("/models")
async def get_models() -> dict[str, Any]:
    """Proxy the OpenRouter model list. Caches for 5 minutes."""
    cached = model_cache.get(CACHE_KEY)
    if cached is not None:
        return cached

    settings = load_settings()
    api_key = settings.get("apiKeys", {}).get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="OPENROUTER_API_KEY not configured")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            OPENROUTER_MODELS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data = resp.json()

    # Slim down the payload — frontend only needs id, name, and modality info
    models_raw = data.get("data", [])
    models_slim: list[dict[str, Any]] = []
    for m in models_raw:
        arch = m.get("architecture", {})
        models_slim.append({
            "id": m.get("id", ""),
            "name": m.get("name", m.get("id", "")),
            "input_modalities": arch.get("input_modalities", ["text"]),
            "output_modalities": arch.get("output_modalities", ["text"]),
            "context_length": m.get("context_length", 0),
            "pricing": m.get("pricing", {}),
        })

    result = {"models": models_slim, "count": len(models_slim)}
    model_cache.set(CACHE_KEY, result, ttl=CACHE_TTL)
    return result
