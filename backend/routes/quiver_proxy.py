"""Proxy for QuiverAI's GET /v1/models.

The frontend hits /api/quiver/models on Quiver node drop to populate
the dynamic `model` enum. Matches the OpenRouter / Replicate / FAL
proxy pattern in this directory — same 5-minute cache via model_cache.

When QUIVER_API_KEY is not configured we return 400, and the frontend
falls back to its hardcoded model list (arrow-1, arrow-1.1, arrow-1.1-max)
so node drops keep working offline.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from services.model_cache import model_cache
from services.quiver_client import (
    QuiverAuthError,
    QuiverClient,
    QuiverError,
    QuiverInsufficientCreditsError,
    QuiverRateLimitError,
    QuiverServerError,
)
from services.settings import load_settings

router = APIRouter(prefix="/api/quiver", tags=["quiver"])

CACHE_KEY = "quiver:models"
CACHE_TTL = 300.0  # 5 minutes — matches the other provider proxies


@router.get("/models")
async def get_models() -> dict[str, Any]:
    """Return the QuiverAI model catalog (id, name, capabilities, pricing).

    Slim payload — frontend only needs id, name, supported_operations,
    pricing_credits, and a few capability flags. The full /v1/models
    response carries fields (context_length, max_output_length) the
    Nebula UI doesn't surface today; trimming them keeps the wire
    payload small and the cached entry tight.
    """
    cached = model_cache.get(CACHE_KEY)
    if cached is not None:
        return cached

    settings = load_settings()
    api_key = settings.get("apiKeys", {}).get("QUIVER_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="QUIVER_API_KEY not configured")

    try:
        client = QuiverClient(api_key)
        models = await client.list_models()
    except QuiverAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    except QuiverInsufficientCreditsError as exc:
        # /v1/models doesn't burn credits in practice, but be defensive —
        # any 402 surfaces as 402 to the frontend rather than a generic 500.
        raise HTTPException(status_code=402, detail=str(exc))
    except QuiverRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    except QuiverServerError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except QuiverError as exc:
        raise HTTPException(status_code=exc.status_code or 500, detail=str(exc))

    models_slim: list[dict[str, Any]] = []
    for m in models:
        models_slim.append({
            "id": m.id,
            "name": m.name or m.id,
            "description": m.description,
            "input_modalities": m.input_modalities,
            "output_modalities": m.output_modalities,
            "supported_operations": m.supported_operations,
            "pricing_credits": m.pricing_credits,
        })

    result = {"models": models_slim, "count": len(models_slim)}
    model_cache.set(CACHE_KEY, result, ttl=CACHE_TTL)
    return result
