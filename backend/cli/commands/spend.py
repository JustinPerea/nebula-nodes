from __future__ import annotations

from typing import Any

from ..client import NebulaClient


def _usd(value: Any) -> str:
    return f"${value:.2f}" if isinstance(value, (int, float)) else "no limit"


def run(client: NebulaClient) -> None:
    view = client.get_spend()
    if not view.get("limited"):
        print("Your runs aren't limited (spending limits apply to agents).")
        return
    limits = view.get("limits") or {}
    spent = view.get("spent") or {}
    print("Spending limits (set by the person in Settings > Preferences):")
    print(f"  Per run:      {_usd(limits.get('perRunUsd'))}")
    session = limits.get("sessionUsd")
    used = spent.get("totalUsd", 0)
    print(f"  This session: {_usd(session)}" + (f", {_usd(used)} used" if session is not None else f" ({_usd(used)} used)"))
    for model, cap in sorted((limits.get("models") or {}).items()):
        model_used = (spent.get("models") or {}).get(model, 0)
        parts = []
        if cap.get("perRunUsd") is not None:
            parts.append(f"{_usd(cap['perRunUsd'])} per run")
        if cap.get("sessionUsd") is not None:
            parts.append(f"{_usd(cap['sessionUsd'])} per session, {_usd(model_used)} used")
        print(f"  {model}: {', '.join(parts)}")
    print("\nAmounts are upper estimates at list prices. Nodes without a published price always need")
    print("a proposal. Over a limit: `nebula propose --run <node>` and the person decides.")
