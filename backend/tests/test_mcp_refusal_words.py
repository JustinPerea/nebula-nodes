"""PR #212 round 6: a refusal is worded for its reader where it is written
(agent_spend.propose_hint, main._quick_propose_hint, handlers/speridlabs_idol.agent_call_stop),
never rewritten on its way out. The refusals an MCP caller can get (a spend
refusal from decide, a stopped Idol call, a quick run's) reach the caller through
mcp_server's two call sites exactly as they were written, name `propose_change
(run: ...)`, and never a `nebula` command.

(The `propose_hint_for_mcp` rewrite that sat at those two sites was proved to
change none of these texts, then deleted: the same corpus read identically with
and without it.)"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mcp_server  # noqa: E402
import main  # noqa: E402
from handlers import speridlabs_idol  # noqa: E402
from models.graph import GraphNode  # noqa: E402
from nebula_api import NebulaAPIError  # noqa: E402
from services import agent_spend  # noqa: E402
from tests.test_daily_total import DEFINITIONS, _decide  # noqa: E402


def _corpus() -> dict[str, str]:
    ask = agent_spend.propose_hint(["n1"], "mcp")
    spend = _decide(0.4, 4.8)                                    # passes the total: waits
    unpriced = _decide(0.4, 0.0, items=[{"id": "n2", "definitionId": "unpriced", "params": {}}])
    per_run = _decide(1.5, 0.0, settings={"runCostConfirmUsd": 1})
    refused = agent_spend.decide(
        [{"id": "n1", "definitionId": "paid", "params": {}}], [], settings={"runCostConfirmUsd": None},
        pricing={"nodes": {"paid": {"currency": "usd", "rows": [{"match": {}, "price": 9.0}]}}},
        definitions=DEFINITIONS, how_to_ask=ask,
        budgets=agent_spend.session_budgets("outside:shared", agent_spend.Spent(),
                                            agent_spend.caps_from_settings({"runCostConfirmUsd": None}),
                                            outside_spent=agent_spend.Spent(), daily_spent=agent_spend.Spent(4.8)))
    stop = speridlabs_idol.agent_call_stop(GraphNode(id="n7", definitionId="speridlabs-idol", params={}))
    quick = f"{speridlabs_idol.agent_stop_text('Idol')} {main._quick_propose_hint('speridlabs-idol', 'mcp')}"
    return {
        "decide: wait refusal": spend.refusal,
        "decide: unpriced": unpriced.refusal,
        "decide: per-run limit": per_run.refusal,
        "decide: how_to_ask text": refused.refusal or ask,
        "idol stop": str(stop),
        "idol stop (ask from the origin)": f"{speridlabs_idol.agent_stop_text('Idol')} {agent_spend.propose_hint(['n7'], 'mcp')}",
        "quick run": quick,
        "the hint alone": ask,
    }


def _through_sites(monkeypatch, text: str) -> dict[str, object]:
    """What each call site hands the tool's caller for a refusal reading `text`."""
    from mcp.server.fastmcp import FastMCP
    from mcp.server.fastmcp.exceptions import ToolError

    async def refuse(self, name, arguments):
        raise ToolError(text)

    monkeypatch.setattr(FastMCP, "call_tool", refuse)
    try:
        asyncio.run(mcp_server.mcp.call_tool("start_here", {}))
        site1 = None
    except ToolError as exc:
        site1 = str(exc)

    class Api:
        def request(self, *args, **kwargs):
            raise NebulaAPIError(text, status=403, kind="http", headers={"x": "y"}, payload={"detail": text})

    monkeypatch.setattr(mcp_server, "_api", lambda: Api())
    try:
        mcp_server._canvas_call("POST", "/api/graph/run", None)
        site2 = None
    except NebulaAPIError as exc:
        site2 = (exc.detail, str(exc), exc.status, exc.kind, exc.headers, exc.payload)
    return {"site1": site1, "site2": site2}


def test_an_mcp_caller_gets_each_refusal_as_written_with_propose_change_and_no_nebula_command(monkeypatch):
    corpus = _corpus()
    assert len(corpus) >= 8 and all(corpus.values())
    for name, text in corpus.items():
        assert "`nebula" not in text and "nebula propose" not in text, name
        through = _through_sites(monkeypatch, text)
        assert through["site1"] == text, name
        assert through["site2"][0] == text and through["site2"][1] == text, name
    for name in ("the hint alone", "idol stop (ask from the origin)", "quick run"):
        assert "propose_change (run: " in corpus[name], name
    assert "propose_change (run: n1)" in corpus["the hint alone"]
    assert "propose_change (run: <node id>)" in corpus["quick run"]
    assert "propose_change (run: n7)" in corpus["idol stop"]


def test_the_helper_that_rewrote_cli_words_is_gone():
    assert not hasattr(agent_spend, "propose_hint_for_mcp") and not hasattr(agent_spend, "_PROPOSE_MCP")
    assert not hasattr(mcp_server, "_worded_for_this_surface")
