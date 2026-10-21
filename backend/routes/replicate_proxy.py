from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from services.settings import load_settings
from services.model_cache import model_cache

router = APIRouter(prefix="/api/replicate", tags=["replicate"])

REPLICATE_API_BASE = "https://api.replicate.com/v1"
CACHE_TTL = 3600.0  # 1 hour — schemas don't change often
# How much of the model's example output is kept with its schema: enough to
# read a file's type (services/universal_ports.replicate_output), never a whole
# inline file or a long text.
_EXAMPLE_ITEMS = 8
_EXAMPLE_URL_CHARS = 2048
_EXAMPLE_TEXT_CHARS = 200


def _example_output(value: Any, depth: int = 0) -> Any:
    """The model's `default_example.output`, cut down to what says its type:
    a URL (its extension), a data: URI's header, a short slice of text; the
    first few items of a list or keys of an object."""
    if isinstance(value, str):
        if value.startswith("data:"):
            return value.partition(",")[0][:120] + ","
        if value.startswith(("http://", "https://")):
            return value[:_EXAMPLE_URL_CHARS]
        return value[:_EXAMPLE_TEXT_CHARS]
    if depth >= 2:
        return None
    if isinstance(value, list):
        return [_example_output(item, depth + 1) for item in value[:_EXAMPLE_ITEMS]]
    if isinstance(value, dict):
        return {str(key)[:64]: _example_output(item, depth + 1)
                for key, item in list(value.items())[:_EXAMPLE_ITEMS]}
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return None


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
        # What the model's own example run returned, from the model data read
        # above (no extra call): it types a file output whose schema is a
        # plain `uri` (services/universal_ports.replicate_output).
        "default_example_output": _example_output(
            (model_data.get("default_example") or {}).get("output")
            if isinstance(model_data.get("default_example"), dict) else None),
    }

    model_cache.set(cache_key, result, ttl=CACHE_TTL)
    return result
