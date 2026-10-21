"""The MCP tools for covers and proposals outside the graph (U16, Q60 a):
`list_project_covers`, `set_project_cover`, `propose_asset_change`, and
`get_proposal` / `withdraw_proposal` on an asset proposal. Each goes through
the HTTP route the Projects screen and Moodboard Studio use."""
from __future__ import annotations

import pytest

import mcp_server
from nebula_api import NebulaAPI
from services import krea_agent_mcp
from tests.conftest import stored_image_urls
from tests.test_asset_proposals import A, B, C, _key, _pin, _saved, api  # noqa: F401 - the fixture


@pytest.fixture
def tools(api, monkeypatch):  # noqa: F811 - the imported fixture
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=api.client))
    return api


def _registered(name: str):
    return next(tool for tool in mcp_server.mcp._tool_manager.list_tools() if tool.name == name)


def test_the_tools_are_registered_listed_and_annotated():
    for name in ("list_project_covers", "set_project_cover", "propose_asset_change"):
        assert name in krea_agent_mcp.NEBULA_MCP_TOOLS
    assert _registered("list_project_covers").annotations.readOnlyHint is True
    cover = _registered("set_project_cover").annotations
    assert cover.readOnlyHint is False and cover.destructiveHint is False and cover.openWorldHint is False
    propose = _registered("propose_asset_change").annotations
    assert propose.readOnlyHint is False and propose.destructiveHint is False


def test_an_agent_reads_and_sets_a_cover_and_can_put_it_back(tools):
    listed = mcp_server.list_project_covers(tools.dusk)
    assert [image["url"] for image in listed["images"]] == [C, B, A]
    assert listed["pinnedBy"] is None

    set_ = mcp_server.set_project_cover(tools.dusk, A)
    assert set_["project"]["cover"] == {"source": "pinned", "images": [A]}
    assert set_["previous"] == {"cover": None}
    assert _saved(tools)["coverBy"] == {"kind": "agent", "name": "Claude Code"}
    back = mcp_server.set_project_cover(tools.dusk, set_["previous"]["cover"] or "")
    assert back["project"]["cover"]["source"] == "output"
    assert "coverPin" not in _saved(tools)


def test_the_persons_pin_points_the_agent_at_a_proposal(tools):
    _pin(tools, A, tools.person)
    with pytest.raises(Exception) as refused:
        mcp_server.set_project_cover(tools.dusk, B)
    assert "propose_asset_change" in str(refused.value)

    made = mcp_server.propose_asset_change("project", tools.dusk, {"cover": B}, "The new grade reads better")
    view = made["proposal"]
    assert view["status"] == "open" and view["kind"] == "project"
    assert "acceptKey" not in str(made)
    assert mcp_server.get_proposal(view["id"])["proposal"]["status"] == "open"

    accepted = tools.client.post(f"/api/asset-proposals/{view['id']}/accept",
                                 headers={**tools.person, "X-Nebula-Proposal-Key": _key(tools, view["id"])})
    assert accepted.status_code == 200, accepted.text
    decided = mcp_server.get_proposal(view["id"], wait_seconds=1)["proposal"]
    assert decided["status"] == "accepted" and decided["applied"] == {"cover": B}


def test_an_agent_withdraws_an_asset_proposal(tools):
    _pin(tools, A, tools.person)
    view = mcp_server.propose_asset_change("project", tools.dusk, {"cover": ""}, "Back to the newest image")["proposal"]
    assert view["change"]["cover"]["to"] is None
    assert mcp_server.withdraw_proposal(view["id"])["proposal"]["status"] == "withdrawn"


def test_a_board_is_named_by_id_or_name(tools):
    made = tools.client.post("/api/moodboards", json={"name": "Dusk board",
                                                      "images": [{"url": stored_image_urls(1, name="dusk")[0]}],
                                                      "projectId": tools.active}, headers=tools.person).json()
    by_name = mcp_server.propose_asset_change("moodboard", "dusk board", {"sendNotes": True}, "Your notes say dusk")
    assert by_name["proposal"]["target"]["id"] == made["id"]
    mcp_server.withdraw_proposal(by_name["proposal"]["id"])
    by_id = mcp_server.propose_asset_change("moodboard", made["id"], {"send_notes": True}, "Your notes say dusk")
    assert by_id["proposal"]["change"] == {"sendNotes": {"from": False, "to": True}}
