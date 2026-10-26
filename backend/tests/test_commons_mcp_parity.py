"""Commons for agents, now (Justin's Q63 b, 2026-10-20; audit U13).

Read tools for what agents could reach only over raw HTTP: the collections
(`commons_add` needs one's id), status, borrowings, a borrowing's fidelity
check and the concentration summary; `membership_id` on `commons_comment`; and
curation through `propose_asset_change(kind="commons")`. Each goes through
the route the Commons UI uses, and each has a `nebula commons` twin.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import mcp_server
from commons.skill import COMMONS_CLI_SKILL, COMMONS_SKILL
from nebula_api import NebulaAPI
from services import krea_agent_mcp
from tests.test_commons_proposals import _opened, cx  # noqa: F401 - the fixture

REPO = Path(__file__).resolve().parents[2]
READS = ("commons_collections", "commons_status", "commons_borrowings", "commons_concentration")


@pytest.fixture
def tools(cx, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=cx.client))
    return cx


def _registered(name: str):
    return next(tool for tool in mcp_server.mcp._tool_manager.list_tools() if tool.name == name)


def test_the_tools_are_registered_listed_annotated_and_documented():
    setup = (REPO / "docs" / "MCP-SETUP.md").read_text()
    for name in (*READS, "commons_fidelity"):
        assert name in krea_agent_mcp.NEBULA_MCP_TOOLS
        assert f"`{name}`" in setup, name
        assert name in COMMONS_SKILL, name
    for name in READS:
        annotations = _registered(name).annotations
        assert annotations.readOnlyHint is True and annotations.openWorldHint is False
    fidelity = _registered("commons_fidelity").annotations
    # It saves the check's result on the borrowing: not read-only, but safe to repeat.
    assert fidelity.readOnlyHint is False and fidelity.destructiveHint is False and fidelity.idempotentHint is True
    assert "membership_id" in _registered("commons_comment").parameters["properties"]
    assert "brand" in _registered("propose_asset_change").parameters["properties"]
    assert 'kind="commons"' in COMMONS_SKILL
    assert "Evaluation" in COMMONS_SKILL or "evaluation" in COMMONS_SKILL


def test_collections_are_listed_in_the_agents_scope(tools):
    names = [c["name"] for c in mcp_server.commons_collections()["collections"]]
    assert names == ["<untrusted-commons-text>Open refs</untrusted-commons-text>"]
    acme = mcp_server.commons_collections(brand="acme")["collections"]
    assert len(acme) == 2 and all(c["id"].startswith("col_") for c in acme)


def test_status_borrowings_fidelity_and_concentration(tools):
    status = mcp_server.commons_status()
    assert set(status["queue"]) >= {"queued", "ready"}
    assert status["queue"]["ready"] == 1

    from commons.effective import effective

    hex_ = effective(tools.store, tools.poster)["fields"]["palette"][0]["hex"]
    borrowed = mcp_server.commons_borrow(tools.poster, "palette", hex_, {"kind": "external", "ref": "deck-1"},
                                         "its main colour")
    rows = mcp_server.commons_borrowings(asset=tools.poster)["borrowings"]
    assert [row["id"] for row in rows] == [borrowed["id"]]
    assert mcp_server.commons_borrowings(asset=tools.acme_only) == {"borrowings": []}
    checked = mcp_server.commons_fidelity(borrowed["id"])
    assert checked["status"] == "unverifiable"  # an external output has no pixels here
    with pytest.raises(Exception) as missing:
        mcp_server.commons_fidelity("bor_missing")
    assert "404" in str(missing.value)
    summary = mcp_server.commons_concentration()
    assert summary["total"] == 1 and summary["by_asset"] == {tools.poster: 1.0}


def test_a_comment_goes_into_the_named_membership(tools):
    comment = mcp_server.commons_comment(tools.inbox, "Keep this one for the grid", membership_id=tools.inbox_membership)
    assert comment["membership"] == tools.inbox_membership
    with pytest.raises(Exception) as other:
        mcp_server.commons_comment(tools.inbox, "x", membership_id=tools.poster_membership)
    assert "404" in str(other.value)


def test_an_agent_proposes_curation_and_reads_the_decision(tools):
    made = mcp_server.propose_asset_change(
        "commons", tools.poster, {"correction": {"field_path": "summary", "value": "A quiet grid"}},
        "Reads quieter to me")
    view = made["proposal"]
    assert view["kind"] == "commons" and view["status"] == "open"
    assert "acceptKey" not in str(made)
    in_brand = mcp_server.propose_asset_change(
        "commons", tools.acme_only, {"membership": {"id": tools.store.memberships_for_asset(tools.acme_only)[0]["id"],
                                                    "role": "attract"}}, "On brand", brand="acme")
    assert in_brand["proposal"]["target"]["id"] == tools.acme_only
    accepted = tools.client.post(f"/api/asset-proposals/{view['id']}/accept",
                                 headers={**tools.person, "X-Nebula-Proposal-Key": _opened(tools, view["id"])["acceptKey"]})
    assert accepted.status_code == 200, accepted.text
    decided = mcp_server.get_proposal(view["id"], wait_seconds=1)["proposal"]
    assert decided["status"] == "accepted" and decided["applied"]["edits"]
    assert mcp_server.withdraw_proposal(in_brand["proposal"]["id"])["proposal"]["status"] == "withdrawn"


# -- the CLI twins ---------------------------------------------------------------------

def test_the_cli_has_a_twin_for_each_tool():
    from cli.__main__ import build_parser

    parse = build_parser().parse_args
    assert parse(["commons", "collections", "--brand", "acme"]).brand == "acme"
    args = parse(["commons", "borrowings", "--asset", "ast_1", "--brand", "acme"])
    assert (args.commons_cmd, args.asset, args.brand) == ("borrowings", "ast_1", "acme")
    assert parse(["commons", "fidelity", "bor_1"]).borrowing_id == "bor_1"
    assert parse(["commons", "concentration", "--brand", "acme"]).commons_cmd == "concentration"
    assert parse(["commons", "comment", "ast_1", "x", "--membership", "mem_1"]).membership == "mem_1"
    propose = parse(["commons", "propose", "ast_1", "--edit", '{"correction": {"field_path": "summary", "value": "x"}}',
                     "--note", "why", "--brand", "acme"])
    assert propose.edit and propose.note == "why"
    assert "nebula commons propose" in COMMONS_CLI_SKILL and "nebula commons collections" in COMMONS_CLI_SKILL


class _FakeClient:
    def __init__(self):
        self.calls: list[tuple] = []

    def commons_enabled(self):
        return True

    def commons(self, method, path, **kwargs):
        self.calls.append(("commons", method, path, kwargs))
        return {"ok": True}

    def _request(self, method, path, **kwargs):
        self.calls.append(("api", method, path, kwargs))
        return {"proposal": {"id": "pa_1"}}


@pytest.mark.parametrize("argv, expected", [
    (["commons", "collections", "--brand", "acme"], ("commons", "GET", "/collections", {"params": {"brand": "acme"}})),
    (["commons", "borrowings", "--asset", "ast_1"], ("commons", "GET", "/borrowings", {"params": {"asset": "ast_1"}})),
    (["commons", "fidelity", "bor_1"], ("commons", "POST", "/borrowings/bor_1/fidelity", {"params": {}})),
    (["commons", "concentration"], ("commons", "GET", "/concentration", {"params": {}})),
    (["commons", "comment", "ast_1", "hi", "--membership", "mem_1"],
     ("commons", "POST", "/comments", {"json": {"asset_id": "ast_1", "text": "hi", "region_id": None,
                                                "membership_id": "mem_1", "brand": None}})),
    (["commons", "propose", "ast_1", "--edit", '{"correction": {"field_path": "summary", "value": "x"}}',
      "--edit", '{"membership": {"id": "mem_1", "role": "avoid"}}', "--note", "why"],
     ("api", "POST", "/api/asset-proposals", {"json": {
         "kind": "commons", "id": "ast_1", "note": "why",
         "change": {"edits": [{"correction": {"field_path": "summary", "value": "x"}},
                              {"membership": {"id": "mem_1", "role": "avoid"}}]}}})),
])
def test_the_cli_twins_call_the_same_routes(argv, expected, capsys):
    from cli.__main__ import build_parser
    from cli.commands import commons

    client = _FakeClient()
    commons.run(client, build_parser().parse_args(argv))
    assert client.calls == [expected]


def test_an_empty_listing_still_answers_the_client(tools):
    """What an MCP client gets: one JSON object, even when nothing is listed
    (a bare list came back as one text block per row, and none at all for an
    empty one, so the agent saw an empty answer)."""
    import asyncio
    import json

    def answer(name, args):
        result = asyncio.run(mcp_server.mcp.call_tool(name, args))
        blocks = result[0] if isinstance(result, tuple) else result
        texts = [block.text for block in blocks if getattr(block, "type", "") == "text"]
        assert len(texts) == 1, (name, texts)
        return json.loads(texts[0])

    assert answer("commons_borrowings", {"asset": tools.acme_only}) == {"borrowings": []}
    listed = answer("commons_collections", {"brand": "acme"})
    assert [c["id"].startswith("col_") for c in listed["collections"]] == [True, True]


def test_status_explains_both_pauses_as_state_not_ui_copy():
    """sf (GM - Design shortened the Commons toolbar's worker status). Agents
    keep the structured state, never the person's status line: the tool says
    what each field means and what resumes each pause, so an agent can explain
    it the way the tooltip does."""
    doc = mcp_server.commons_status.__doc__ or ""
    for word in ("evaluation_waiting", "evaluation_assisted", "held", "paused_load", "cap_reached",
                 "budget_exhausted", "sealed", "closes the agent review", "Inbox"):
        assert word in doc, word
    setup = (REPO / "docs" / "MCP-SETUP.md").read_text()
    assert "`evaluation_assisted`" in setup


def test_status_does_not_promise_a_stopped_worker_resumes():
    """Review of sf: a pause only lifts. A stopped worker (the default at
    launch) stays stopped after the labels are sealed, so the tool tells
    agents that analysis resumes only if `worker.running`."""
    doc = " ".join((mcp_server.commons_status.__doc__ or "").split())
    assert "it resumes once" not in doc
    assert "the hold lifts once" in doc
    assert "worker.running" in doc
    setup = " ".join((REPO / "docs" / "MCP-SETUP.md").read_text().split())
    assert "what resumes it" not in setup
    assert "`worker.running`" in setup
