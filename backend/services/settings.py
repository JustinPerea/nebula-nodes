from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx

SETTINGS_PATH = Path(__file__).resolve().parent.parent.parent / "settings.json"

DEFAULT_SETTINGS: dict[str, Any] = {
    "apiKeys": {},
    "routing": {},
    "outputPath": None,
    "executionMode": "manual",
    "batchSizeCap": 25,
    "exportFolder": None,
    "zoomTelemetryEnabled": False,
}


def load_settings() -> dict[str, Any]:
    if SETTINGS_PATH.exists():
        with open(SETTINGS_PATH, "r") as f:
            return json.load(f)
    return dict(DEFAULT_SETTINGS)


def save_settings(settings: dict[str, Any]) -> None:
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def get_api_key(provider_key_name: str | list[str]) -> str | None:
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    if isinstance(provider_key_name, str):
        names = [provider_key_name]
    else:
        names = provider_key_name

    for name in names:
        key = api_keys.get(name)
        if key:
            return key
    return None


# ---------------------------------------------------------------------------
# Per-provider API key validation (GET /api/health/providers)
# ---------------------------------------------------------------------------
#
# get_api_key() only checks non-empty presence — a stale or revoked key still
# reads as "configured", which sends the agent down a generation path that is
# guaranteed to fail. validate_provider_keys() closes that gap: for every
# known provider it confirms a credential exists, then makes one minimal
# authenticated API call and classifies the outcome. Results are cached in
# memory with a 5-minute TTL so repeated health polls don't hammer providers.

PROVIDER_STATUS_NOT_CONFIGURED = "not_configured"
PROVIDER_STATUS_CONFIGURED_UNVERIFIED = "configured_unverified"
PROVIDER_STATUS_VALID = "valid"
PROVIDER_STATUS_INVALID = "invalid"
PROVIDER_STATUS_UNAUTHORIZED = "unauthorized"
PROVIDER_STATUS_INSUFFICIENT_CREDITS = "insufficient_credits"
PROVIDER_STATUS_RATE_LIMITED = "rate_limited"
PROVIDER_STATUS_ERROR = "error"

PROVIDER_CHECK_TTL_SECONDS = 300.0  # 5-minute cache TTL
PROVIDER_CHECK_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class ProviderCheck:
    """How to validate one provider's credential.

    key_names: settings.json apiKeys entries to try, in order. Empty for
    providers whose credential does not live in settings.json (Nous reads an
    OAuth token from Hermes auth files instead).
    """

    key_names: tuple[str, ...]
    url: str
    auth_headers: Callable[[str], dict[str, str]]


PROVIDER_CHECKS: dict[str, ProviderCheck] = {
    "FAL": ProviderCheck(
        ("FAL_KEY",),
        "https://api.fal.ai/v1/models?limit=1",
        lambda key: {"Authorization": f"Key {key}"},
    ),
    "OpenAI": ProviderCheck(
        ("OPENAI_API_KEY",),
        "https://api.openai.com/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Google": ProviderCheck(
        ("GOOGLE_API_KEY",),
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        lambda key: {"x-goog-api-key": key},
    ),
    "Ideogram": ProviderCheck(
        ("IDEOGRAM_API_KEY",),
        "https://api.ideogram.ai/models",
        lambda key: {"Api-Key": key},
    ),
    "Runway": ProviderCheck(
        ("RUNWAY_API_KEY",),
        "https://api.dev.runwayml.com/v1/organization",
        lambda key: {
            "Authorization": f"Bearer {key}",
            "X-Runway-Version": "2024-11-06",
        },
    ),
    "xAI": ProviderCheck(
        ("XAI_API_KEY",),
        "https://api.x.ai/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Replicate": ProviderCheck(
        ("REPLICATE_API_TOKEN",),
        "https://api.replicate.com/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "ElevenLabs": ProviderCheck(
        ("ELEVENLABS_API_KEY",),
        "https://api.elevenlabs.io/v1/user",
        lambda key: {"xi-api-key": key},
    ),
    "Anthropic": ProviderCheck(
        ("ANTHROPIC_API_KEY",),
        "https://api.anthropic.com/v1/models?limit=1",
        lambda key: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    ),
    "OpenRouter": ProviderCheck(
        ("OPENROUTER_API_KEY",),
        "https://openrouter.ai/api/v1/key",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Meshy": ProviderCheck(
        ("MESHY_API_KEY",),
        "https://api.meshy.ai/openapi/v1/balance",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "MiniMax": ProviderCheck(
        ("MINIMAX_API_KEY",),
        "https://api.minimaxi.com/v1/models/MiniMax-M2.7",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "QuiverAI": ProviderCheck(
        ("QUIVER_API_KEY",),
        "https://api.quiver.ai/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Krea": ProviderCheck(
        ("KREA_API_TOKEN",),
        "https://api.krea.ai/styles",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    "Higgsfield": ProviderCheck(
        ("HIGGSFIELD_API_KEY",),
        "",
        lambda key: {"Authorization": f"Key {key}"},
    ),
    "Nous": ProviderCheck(
        (),
        "",  # resolved from the Hermes credential's inference base URL
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
}

# provider name -> (monotonic expiry, result dict)
_provider_check_cache: dict[str, tuple[float, dict[str, Any]]] = {}

# Cache generation counter, bumped by clear_provider_validation_cache().
# validate_provider_keys() snapshots the generation when it starts; if a clear
# lands while its provider HTTP calls are in flight, the snapshot no longer
# matches and the now-stale results are discarded instead of being cached —
# otherwise a settings save could be followed by pre-save results repopulating
# the cache and being served for up to the TTL.
_provider_cache_generation = 0

# Indirection so tests can drive cache expiry with a fake clock.
_monotonic = time.monotonic


def clear_provider_validation_cache() -> None:
    """Drop all cached validation results (used by tests and key updates)."""
    global _provider_cache_generation
    _provider_check_cache.clear()
    _provider_cache_generation += 1


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class _ResolvedCheck:
    url: str
    headers: dict[str, str]


def _resolve_check(name: str, check: ProviderCheck) -> _ResolvedCheck | None:
    """Return the request to make for a provider, or None if unconfigured."""
    if check.key_names:
        key = get_api_key(list(check.key_names))
        if not key:
            return None
        return _ResolvedCheck(url=check.url, headers=check.auth_headers(key))

    if name == "Nous":
        # Imported lazily so the patched module attribute is picked up at call
        # time and settings.py stays importable without Hermes present.
        from services.nous_auth import NousNotAuthenticatedError, load_nous_credential

        try:
            cred = load_nous_credential()
        except NousNotAuthenticatedError:
            return None
        base = cred.base_url.rstrip("/")
        return _ResolvedCheck(
            url=f"{base}/models",
            headers=check.auth_headers(cred.access_token),
        )

    return None


async def _check_one(
    client: httpx.AsyncClient, name: str, check: ProviderCheck
) -> dict[str, Any]:
    """Validate a single provider; never raises."""
    try:
        resolved = _resolve_check(name, check)
    except Exception as exc:  # unexpected credential-store failure
        return {
            "configured": False,
            "status": PROVIDER_STATUS_ERROR,
            "last_checked": _utc_now_iso(),
            "detail": f"credential lookup failed: {type(exc).__name__}: {exc}"[:200],
        }

    if resolved is None:
        return {
            "configured": False,
            "status": PROVIDER_STATUS_NOT_CONFIGURED,
            "last_checked": _utc_now_iso(),
        }

    # Higgsfield documents authenticated generation and per-request polling,
    # but no non-billable account/model probe. Presence is still useful health
    # information; do not submit a generation merely to label the key valid.
    if not resolved.url:
        return {
            "configured": True,
            "status": PROVIDER_STATUS_CONFIGURED_UNVERIFIED,
            "last_checked": _utc_now_iso(),
            "detail": "configured; provider exposes no safe validation probe",
        }

    try:
        resp = await client.get(resolved.url, headers=resolved.headers)
    except Exception as exc:  # timeout, DNS, connection refused, ...
        return {
            "configured": True,
            "status": PROVIDER_STATUS_ERROR,
            "last_checked": _utc_now_iso(),
            "detail": f"{type(exc).__name__}: {exc}"[:200],
        }

    result: dict[str, Any] = {
        "configured": True,
        "last_checked": _utc_now_iso(),
    }
    if 200 <= resp.status_code < 300:
        result["status"] = PROVIDER_STATUS_VALID
    elif resp.status_code == 401:
        result["status"] = PROVIDER_STATUS_INVALID
        result["detail"] = f"authentication rejected (HTTP {resp.status_code})"
    elif resp.status_code == 403:
        result["status"] = PROVIDER_STATUS_UNAUTHORIZED
        result["detail"] = "credential is not authorized for the validation endpoint (HTTP 403)"
    elif resp.status_code == 402:
        result["status"] = PROVIDER_STATUS_INSUFFICIENT_CREDITS
        result["detail"] = "credential accepted but the account has insufficient credits (HTTP 402)"
    elif resp.status_code == 429:
        result["status"] = PROVIDER_STATUS_RATE_LIMITED
        result["detail"] = "validation request was rate limited (HTTP 429)"
    else:
        result["status"] = PROVIDER_STATUS_ERROR
        result["detail"] = f"unexpected response (HTTP {resp.status_code})"
    return result


async def validate_provider_keys(
    *,
    force_refresh: bool = False,
    ttl_seconds: float = PROVIDER_CHECK_TTL_SECONDS,
) -> dict[str, dict[str, Any]]:
    """Validate every known provider's API key, cached with a TTL.

    Returns {provider: {"configured": bool, "status": str, "last_checked": str}}
    where status distinguishes not configured, configured but safely
    unverified, valid, invalid, unauthorized, insufficient-credit,
    rate-limited, and provider/network errors. Within the
    TTL the cached dict is returned unchanged (identical last_checked); expired
    or forced entries are re-checked with one minimal API call per provider.

    If clear_provider_validation_cache() runs while this call's provider
    requests are in flight (e.g. a concurrent settings save), the freshly
    computed results are still returned to the caller but are NOT written to
    the cache — they predate the clear and would otherwise repopulate it with
    stale status.
    """
    now = _monotonic()
    generation = _provider_cache_generation
    results: dict[str, dict[str, Any]] = {}
    pending: list[str] = []

    for name in PROVIDER_CHECKS:
        if not force_refresh:
            cached = _provider_check_cache.get(name)
            if cached is not None and cached[0] > now:
                results[name] = cached[1]
                continue
        pending.append(name)

    if pending:
        async with httpx.AsyncClient(timeout=PROVIDER_CHECK_TIMEOUT_SECONDS) as client:
            checked = await asyncio.gather(
                *(_check_one(client, name, PROVIDER_CHECKS[name]) for name in pending)
            )
        cache_current = _provider_cache_generation == generation
        for name, result in zip(pending, checked):
            if cache_current:
                _provider_check_cache[name] = (now + ttl_seconds, result)
            results[name] = result

    return results
