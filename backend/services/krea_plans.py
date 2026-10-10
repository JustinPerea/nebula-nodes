"""Krea plan and trial details for the Settings connection card.

Krea's `show_plans` and `start_free_trial` MCP tools answer with links the
user opens in a browser. Only the fields the card shows pass through, and a
link survives only when it points at Krea's pricing pages or Stripe checkout.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

BILLING_TOOLS = frozenset({"show_plans", "start_free_trial"})
_PLAN_LINK_HOSTS = {"www.krea.ai", "krea.ai"}
_TRIAL_LINK_HOSTS = _PLAN_LINK_HOSTS | {"checkout.stripe.com"}


def safe_link(value: Any, hosts: set[str]) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in hosts or parsed.username or parsed.password or port not in (None, 443):
        return None
    return value


def _number(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _text(value: Any, limit: int = 200) -> str | None:
    return value[:limit] if isinstance(value, str) and value.strip() else None


def sanitize_plans(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("plans"), list):
        raise ValueError("Krea returned no plan list")
    plans = []
    for plan in payload["plans"][:10]:
        if not isinstance(plan, dict) or not _text(plan.get("name")):
            continue
        features = [{"text": _text(item.get("text")), "included": bool(item.get("included")), "isNew": bool(item.get("isNew"))}
                    for item in plan.get("features") or [] if isinstance(item, dict) and _text(item.get("text"))]
        plans.append({
            "id": _text(plan.get("id"), 64),
            "name": _text(plan.get("name"), 64),
            "prominent": bool(plan.get("prominent")),
            "units": _number(plan.get("units")),
            "price": _number(plan.get("price")),
            "annualPrice": _number(plan.get("annual_price")),
            "examples": [text for text in (_text(item) for item in plan.get("examples") or []) if text][:4],
            "features": features[:30],
            "checkoutUrl": safe_link(plan.get("checkout_url"), _PLAN_LINK_HOSTS),
            "annualCheckoutUrl": safe_link(plan.get("annual_checkout_url"), _PLAN_LINK_HOSTS),
        })
    trial = payload.get("trial")
    return {
        "plans": plans,
        # Krea sends a trial object only to eligible free accounts; its exact
        # fields are not documented, so the card only needs to know it exists.
        "trialAvailable": isinstance(trial, dict) and bool(trial),
        "annualSavingsPct": _number(payload.get("annual_savings_pct")),
        "manageUrl": safe_link(payload.get("manage_url"), _PLAN_LINK_HOSTS),
    }


def trial_link(payload: Any) -> str:
    candidates = [payload] if isinstance(payload, str) else [
        payload.get(key) for key in ("checkout_url", "checkoutUrl", "url")] if isinstance(payload, dict) else []
    link = next((link for link in (safe_link(value, _TRIAL_LINK_HOSTS) for value in candidates) if link), None)
    if link is None:
        raise ValueError("Krea returned no trial checkout link")
    return link
