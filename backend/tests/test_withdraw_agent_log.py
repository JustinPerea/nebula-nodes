"""GM, PR #202 r2: an agent's withdrawal of an asset proposal reaches the
Agent log on every route (HTTP, MCP, CLI), mirroring the ask's own line:
"Asks to X (decide …)" → "Withdrew its request to X", with the same X from
the same helper, under the agent's name, as the ask line."""
from __future__ import annotations

import io

import pytest

import mcp_server
from cli.commands import proposals as proposals_cmd
from nebula_api import NebulaAPI
from tests.test_asset_proposals import A, C, CLAUDE, _pin, _propose, api  # noqa: F401 - the fixture
from tests.test_commons_proposals import CLAUDE as COMMONS_CLAUDE, _propose as _propose_commons, cx  # noqa: F401


def _log_lines(sent: list[dict]) -> list[tuple[str, str]]:
    """The Agent log rows these events make: (agent, words), as agentActionEntry reads them."""
    return [((event.get("agent") or {}).get("name", ""), event.get("log") or event.get("say") or "")
            for event in sent if event.get("type") == "agentPresence" and (event.get("log") or event.get("say"))]


def _ask_and_withdrawal(sent: list[dict]) -> tuple[tuple[str, str], tuple[str, str]]:
    lines = _log_lines(sent)
    (ask,) = [line for line in lines if line[1].startswith("Asks to ")]
    (withdrew,) = [line for line in lines if line[1].startswith("Withdrew its request to ")]
    return ask, withdrew


def _mirrors(ask: tuple[str, str], withdrew: tuple[str, str]) -> None:
    what = ask[1].removeprefix("Asks to ").rsplit(" (decide ", 1)[0]
    assert withdrew == (ask[0], f"Withdrew its request to {what}")
    assert withdrew[0] == "Claude Code"


@pytest.fixture(autouse=True)
def _commons_on(monkeypatch):
    # conftest opts test_commons_* files in by name; this one covers the Commons too.
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")


@pytest.fixture
def tools(api, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=api.client))
    return api


def test_http_a_withdrawal_mirrors_the_ask_line(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    assert api.client.delete(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).status_code == 200
    ask, withdrew = _ask_and_withdrawal(api.sent)
    _mirrors(ask, withdrew)
    assert withdrew[1] == 'Withdrew its request to make another image the cover of “Dusk”'


def test_mcp_a_withdrawal_mirrors_the_ask_line(tools):
    _pin(tools, A, tools.person)
    view = mcp_server.propose_asset_change("project", tools.dusk, {"cover": ""}, "Back to the newest image")["proposal"]
    assert mcp_server.withdraw_proposal(view["id"])["proposal"]["status"] == "withdrawn"
    ask, withdrew = _ask_and_withdrawal(tools.sent)
    _mirrors(ask, withdrew)
    assert withdrew[1] == 'Withdrew its request to set the cover of “Dusk” back to automatic'


def test_cli_a_withdrawal_mirrors_the_ask_line(api, monkeypatch):
    from cli.client import NebulaClient

    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    client = NebulaClient("http://testserver")
    client._client = api.client
    out = io.StringIO()
    args = type("Args", (), {"id_or_action": "withdraw", "proposal_id": view["id"], "agent_name": "Claude Code",
                             "json": False})()
    assert proposals_cmd.run_proposal(client, args, out=out) == 0
    assert f"Withdrew {view['id']}." in out.getvalue()
    _mirrors(*_ask_and_withdrawal(api.sent))


def test_a_commons_withdrawal_mirrors_its_ask_line(cx, canvas_project):
    made = _propose_commons(cx, {"edits": [
        {"correction": {"field_path": "type_style.value", "value": "serif"}},
        {"correction": {"field_path": "axes.quiet_loud", "value": -0.4}},
        {"correction": {"field_path": "summary", "op": "set", "value": "A quiet grid poster"}},
    ]}).json()["proposal"]
    assert cx.client.delete(f"/api/canvas/proposals/{made['id']}", headers=COMMONS_CLAUDE).status_code == 200
    ask, withdrew = _ask_and_withdrawal(cx.sent)
    _mirrors(ask, withdrew)
    assert withdrew[1] == "Withdrew its request to make 3 changes to an image in the Commons"


def test_a_refused_withdrawal_logs_nothing(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    other = api.client.delete(f"/api/canvas/proposals/{view['id']}", headers={"X-Nebula-Agent": "Codex"})
    assert other.status_code == 403
    assert not [line for line in _log_lines(api.sent) if line[1].startswith("Withdrew")]
