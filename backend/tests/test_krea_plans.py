"""Krea plans and trial links for the Settings card: fixed tools, safe links only."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

import routes.krea_connector as routes
import services.krea_connector as service
from services.krea_plans import sanitize_plans, trial_link

LIVE = {  # trimmed from a live show_plans answer (2026-10-09)
    "plans": [{"id": "creator_pro", "name": "Pro", "prominent": False, "units": 20000,
               "examples": ["257 Nano Banana 2 generations"],
               "features": [{"text": "Krea Agent", "included": True, "isNew": True},
                            {"text": "App Builder", "included": True, "isNew": False}],
               "price": 35, "annual_price": 21, "annual_discount_pct": 40,
               "checkout_url": "https://www.krea.ai/pricing?plan=creator_pro&period=monthly",
               "annual_checkout_url": "https://www.krea.ai/pricing?plan=creator_pro&period=yearly"}],
    "trial": None, "annual_savings_pct": 40, "manage_url": "https://www.krea.ai/pricing",
}


def test_plans_keep_card_fields_and_krea_links():
    plans = sanitize_plans(LIVE)
    assert plans["plans"][0] == {
        "id": "creator_pro", "name": "Pro", "prominent": False, "units": 20000, "price": 35, "annualPrice": 21,
        "examples": ["257 Nano Banana 2 generations"],
        "features": [{"text": "Krea Agent", "included": True, "isNew": True},
                     {"text": "App Builder", "included": True, "isNew": False}],
        "checkoutUrl": "https://www.krea.ai/pricing?plan=creator_pro&period=monthly",
        "annualCheckoutUrl": "https://www.krea.ai/pricing?plan=creator_pro&period=yearly"}
    assert plans["trialAvailable"] is False
    assert plans["manageUrl"] == "https://www.krea.ai/pricing"


@pytest.mark.parametrize("link", [
    "http://www.krea.ai/pricing", "https://krea.ai.evil.test/pricing", "https://user:pw@www.krea.ai/pricing",
    "https://www.krea.ai:8443/pricing", "javascript:alert(1)", "https://checkout.stripe.com/pay",
])
def test_plan_links_off_krea_are_dropped(link):
    plan = {**LIVE["plans"][0], "checkout_url": link}
    assert sanitize_plans({**LIVE, "plans": [plan], "manage_url": link})["plans"][0]["checkoutUrl"] is None


def test_trial_link_allows_only_stripe_checkout_or_krea():
    assert trial_link({"checkout_url": "https://checkout.stripe.com/c/pay/cs_fixture"}).startswith("https://checkout.stripe.com/")
    assert trial_link("https://www.krea.ai/pricing?trial=1") == "https://www.krea.ai/pricing?trial=1"
    for answer in ({"url": "https://stripe.evil.test/pay"}, {"checkout_url": "http://checkout.stripe.com/x"}, {}, None):
        with pytest.raises(ValueError):
            trial_link(answer)


@pytest.mark.asyncio
async def test_connector_billing_calls_only_plan_and_trial_tools(tmp_path):
    connector = service.KreaConnector(tmp_path / "krea")
    for name in ("generate_image", "create_api_token", "list_files"):
        with pytest.raises(service.ConnectorError, match="plan and trial"):
            await connector.call_billing(name)


@pytest.mark.asyncio
async def test_plan_and_trial_routes(monkeypatch):
    calls = []

    class Connector:
        async def call_billing(self, name):
            calls.append(name)
            if name == "show_plans":
                return LIVE
            return {"checkout_url": "https://checkout.stripe.com/c/pay/cs_fixture"}

    monkeypatch.setattr(routes, "get_connector", Connector)
    app = FastAPI()
    app.include_router(routes.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://nebula.test",
                                 headers={"Origin": "http://127.0.0.1:5173"}) as client:
        assert (await client.get("/api/krea/plans")).json()["plans"][0]["name"] == "Pro"
        assert calls == ["show_plans"]  # loading plans never starts a trial
        assert (await client.post("/api/krea/trial")).json() == {"url": "https://checkout.stripe.com/c/pay/cs_fixture"}
        assert (await client.get("/api/krea/trial")).status_code == 405
    assert calls == ["show_plans", "start_free_trial"]


@pytest.mark.asyncio
async def test_plan_routes_refuse_remote_origins(monkeypatch):
    monkeypatch.setattr(routes, "get_connector", lambda: pytest.fail("connector must not be reached"))
    app = FastAPI()
    app.include_router(routes.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://nebula.test",
                                 headers={"Origin": "https://evil.test"}) as client:
        assert (await client.post("/api/krea/trial")).status_code == 403
        assert (await client.get("/api/krea/plans")).status_code == 403
