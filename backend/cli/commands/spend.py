from __future__ import annotations

from typing import Any

from services import money

from ..client import NebulaClient


def _usd(value: Any) -> str:
    """To the cent, as Settings shows it (services/money.py usd_spent, the
    one formatter; review 2, L4). A non-zero amount that would round to
    "$0.00" is "<$0.01": "$0" only ever means nothing (GM, PR #198 r1)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "no limit"
    return money.usd_spent(value)


def run(client: NebulaClient) -> None:
    view = client.get_spend()
    if not view.get("limited"):
        print("Your runs aren't limited (spending limits apply to agents).")
        return
    limits = view.get("limits") or {}
    spent = view.get("spent") or {}
    budget = view.get("budget")
    print("Spending limits (set by the person in Settings > Preferences):")
    daily = view.get("dailyTotal") or {}
    if daily:
        # The umbrella every agent, script and unlinked tab shares, exact.
        daily_cap = daily.get("limitUsd")
        line = f"  Daily total, everything that isn't the person, last 24 hours: {_usd(daily_cap)}"
        line += (f", {_usd(daily.get('usedUsd', 0))} used, {_usd(daily.get('leftUsd', 0))} left"
                 if daily_cap is not None else f" ({_usd(daily.get('usedUsd', 0))} used)")
        print(line)
    print(f"  Per run:      {_usd(limits.get('perRunUsd'))}")
    used = spent.get("totalUsd", 0)
    plan_cap = limits.get("kreaPlanRuns")
    if budget == "chat":
        session = limits.get("sessionUsd")
        print(f"  This session: {_usd(session)}" + (f", {_usd(used)} used" if session is not None else f" ({_usd(used)} used)"))
        plan_used = spent.get("kreaPlanRuns", 0)
        period = "per session"
    else:
        # Outside Nebula's chats: one shared budget over the last 24 hours,
        # and an app's own daily limit inside it when the person gave it a token.
        outside = view.get("outsideSpent") or spent
        shared_cap = limits.get("outsideDailyUsd")
        shared_used = outside.get("totalUsd", 0)
        if budget == "app":
            app_cap = limits.get("appDailyUsd")
            print(f"  {view.get('agent', 'This app')}, last 24 hours: {_usd(app_cap)}"
                  + (f", {_usd(used)} used" if app_cap is not None else f" ({_usd(used)} used)"))
        print(f"  All agents outside Nebula chats, last 24 hours: {_usd(shared_cap)}"
              + (f", {_usd(shared_used)} used" if shared_cap is not None else f" ({_usd(shared_used)} used)"))
        plan_used = outside.get("kreaPlanRuns", 0)
        period = "per 24 hours, shared"
    print(f"  Krea plan runs: {plan_cap if plan_cap is not None else 'no limit'} {period}, {plan_used} used")
    # Per-model budgets count the session, or every outside agent together.
    model_spent = (spent if budget == "chat" else view.get("outsideSpent") or spent).get("models") or {}
    for model, cap in sorted((limits.get("models") or {}).items()):
        model_used = model_spent.get(model, 0)
        parts = []
        if cap.get("perRunUsd") is not None:
            parts.append(f"{_usd(cap['perRunUsd'])} per run")
        if cap.get("sessionUsd") is not None:
            parts.append(f"{_usd(cap['sessionUsd'])} {'per session' if budget == 'chat' else 'per 24 hours'}, "
                         f"{_usd(model_used)} used")
        print(f"  {model}: {', '.join(parts)}")
    print("\nAmounts are upper estimates at list prices. Nodes without a published price always need")
    print("a proposal. Over a limit: `nebula propose --run <node>` and the person decides. A run that")
    print("would pass the daily total is sent as a proposal for you and waits for the person's OK.")
