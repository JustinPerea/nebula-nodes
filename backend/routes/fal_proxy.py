from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/fal", tags=["fal"])


@router.get("/health")
async def fal_health() -> dict[str, str]:
    """Simple health check. FAL doesn't have a public schema endpoint
    like Replicate — endpoint params are hardcoded per node config."""
    return {"status": "ok", "provider": "fal"}
