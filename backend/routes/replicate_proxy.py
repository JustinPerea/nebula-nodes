from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from services.settings import load_settings
from services.model_cache import model_cache

router = APIRouter(prefix="/api/replicate", tags=["replicate"])

REPLICATE_API_BASE = "https://api.replicate.com/v1"
CACHE_TTL = 3600.0  # 1 hour — schemas don't change often


@router.get("/schema/{owner}/{name}")
async def get_model_schema(owner: str, name: str) -> dict[str, Any]:
    """Fetch a Replicate model's latest version schema. Caches for 1 hour."""
    cache_key = f"replicate:schema:{owner}/{name}"
    cached = model_cache.get(cache_key)
    if cached is not None:
        return cached

    settings = load_settings()
    api_key = settings.get("apiKeys", {}).get("REPLICATE_API_TOKEN", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="REPLICATE_API_TOKEN not configured")

    headers = {"Authorization": f"Token {api_key}"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1: Get model info to find latest_version
        model_resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}",
            headers=headers,
        )
        if model_resp.status_code != 200:
            raise HTTPException(status_code=model_resp.status_code, detail=model_resp.text)

        model_data = model_resp.json()
        latest_version = model_data.get("latest_version", {})
        version_id = latest_version.get("id")

        if not version_id:
            raise HTTPException(status_code=404, detail=f"No version found for {owner}/{name}")

        # Step 2: Get version with full OpenAPI schema
        version_resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}/versions/{version_id}",
            headers=headers,
        )
        if version_resp.status_code != 200:
            raise HTTPException(status_code=version_resp.status_code, detail=version_resp.text)

        version_data = version_resp.json()
        openapi_schema = version_data.get("openapi_schema", {})

    # Extract input and output schemas from OpenAPI
    input_schema = (
        openapi_schema
        .get("components", {})
        .get("schemas", {})
        .get("Input", {})
    )
    output_schema = (
        openapi_schema
        .get("components", {})
        .get("schemas", {})
        .get("Output", {})
    )

    result = {
        "version_id": version_id,
        "model_id": f"{owner}/{name}",
        "input_schema": input_schema,
        "output_schema": output_schema,
        "description": model_data.get("description", ""),
    }

    model_cache.set(cache_key, result, ttl=CACHE_TTL)
    return result
