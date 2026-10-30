"""PR #204 round 4: who sees a shared asset Update's ``asks`` and ``firstSince``.

The person's tabs (connected as the person, or held: a tab that says it is one with
X-Nebula-Tab, or ``?tab=1`` on its socket, and carries no agent marker) and the agent that
made the asks see them. Every other reader, an unnamed and unmarked CLI included, gets the
Update as it was before the fields existed. Nothing about the person gate changes."""
from __future__ import annotations

import asyncio
import json

from tests.conftest import FORGED_ORIGIN, PERSON
from tests.test_canvas_proposals import CODEX
from tests.test_presence_followups_3_round3 import _two_asks
from tests.test_undo_restores_deletes import CLAUDE, api, canvas  # noqa: F401 - fixtures

TAB = {"X-Nebula-Tab": "tab-cccccccccccccccc"}
SHARE = ("asks", "firstSince")


def _ref(notes: list[dict]) -> dict:
    (note,) = [n for n in notes if n.get("about") == "proposal" and not n.get("resolvedAt")]
    return note["proposal"]


def _http(canvas, headers) -> dict:
    response = canvas.client.get("/api/canvas/agent-notes", headers=headers)
    assert response.status_code == 200, response.text
    return _ref(response.json()["notes"])


def _sees(ref: dict) -> bool:
    return all(key in ref for key in SHARE)


def _hides(ref: dict) -> bool:
    return not any(key in ref for key in SHARE)


def test_http_the_persons_tabs_and_the_author_see_the_share_others_dont(canvas, monkeypatch):
    _two_asks(canvas, monkeypatch)  # Claude Code's two asks under one Update
    assert _http(canvas, PERSON)["asks"] == 2                      # the person's tab
    assert _http(canvas, {**FORGED_ORIGIN, **TAB})["asks"] == 2   # a held tab
    assert _http(canvas, CLAUDE)["asks"] == 2                      # the agent that asked
    assert _http(canvas, {**TAB, **CLAUDE})["asks"] == 2           # still that agent
    assert _hides(_http(canvas, CODEX))                            # another agent
    assert _hides(_http(canvas, {**TAB, **CODEX}))                 # a tab claim never beats a marker
    assert _hides(_http(canvas, {**PERSON, **CODEX}))              # nor does a token with one
    assert _hides(_http(canvas, {}))                               # unnamed, unmarked (a bare CLI)
    assert _hides(_http(canvas, FORGED_ORIGIN))                    # a browser that doesn't say it's a tab
    # What the others get is the Update as on main: the rest of the ref is untouched.
    full, bare = _http(canvas, PERSON), _http(canvas, CODEX)
    assert {k: v for k, v in full.items() if k not in SHARE} == bare


def test_mcp_the_author_sees_the_share_another_agent_doesnt(canvas, monkeypatch):
    import mcp_server
    from nebula_api import NebulaAPI

    _two_asks(canvas, monkeypatch)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=canvas.client))
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    assert _ref(mcp_server.list_notes()["notes"])["asks"] == 2
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    assert _hides(_ref(mcp_server.list_notes()["notes"]))


def test_cli_named_as_the_author_sees_the_share_unnamed_or_another_doesnt(canvas, monkeypatch):
    from cli.client import NebulaClient

    _two_asks(canvas, monkeypatch)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_SESSION", raising=False)
    cli = NebulaClient("http://testserver")
    cli._client = canvas.client
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    assert _ref(cli.list_notes()["notes"])["asks"] == 2
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    assert _hides(_ref(cli.list_notes()["notes"]))
    monkeypatch.delenv("NEBULA_AGENT_NAME")
    assert _hides(_ref(cli.list_notes()["notes"]))


def _socket_sync(canvas, path: str, headers: dict) -> dict:
    with canvas.client.websocket_connect(path, headers=headers) as ws:
        for _ in range(6):
            message = ws.receive_json()
            if message.get("type") == "agentNotes" and message.get("op") == "sync":
                return _ref(message["notes"])
    raise AssertionError("no Updates sync on connect")


def test_a_sockets_first_sync_follows_the_same_rule(canvas, monkeypatch):
    _two_asks(canvas, monkeypatch)
    assert _socket_sync(canvas, "/ws?tab=1", FORGED_ORIGIN)["asks"] == 2   # a held tab
    assert _socket_sync(canvas, "/ws", CLAUDE)["asks"] == 2                # the agent that asked
    assert _hides(_socket_sync(canvas, "/ws", CODEX))                      # another agent
    assert _hides(_socket_sync(canvas, "/ws?tab=1", CODEX))                # claim plus marker
    assert _hides(_socket_sync(canvas, "/ws", FORGED_ORIGIN))              # no claim


class _Socket:
    def __init__(self) -> None:
        self.got: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.got.append(json.loads(text))


def test_a_broadcast_gives_each_socket_its_readers_form():
    import main

    manager = main.ConnectionManager()
    person, held, author, other, bare = (_Socket() for _ in range(5))
    manager.active_connections.extend([person, held, author, other, bare])
    manager.browser_connections.add(person)
    manager.share_views[held] = {"sees_share": True, "agent_id": None}
    manager.share_views[author] = {"sees_share": False, "agent_id": "ext:claude-code"}
    manager.share_views[other] = {"sees_share": False, "agent_id": "ext:codex"}
    note = {"id": "an_1", "about": "proposal",
            "author": {"kind": "agent", "id": "ext:claude-code", "name": "Claude Code", "color": "#E8825A"},
            "proposal": {"id": "pa_1", "kind": "project", "targetId": "p", "asks": 2, "firstSince": 5}}
    asyncio.run(manager.broadcast_raw({"type": "agentNotes", "surface": "canvas", "op": "changed", "note": note}))
    seen = {name: sock.got[-1]["note"]["proposal"]
            for name, sock in (("person", person), ("held", held), ("author", author), ("other", other), ("bare", bare))}
    assert seen["person"]["asks"] == seen["held"]["asks"] == seen["author"]["asks"] == 2
    assert _hides(seen["other"]) and _hides(seen["bare"])
    # Any other message goes out as it did.
    asyncio.run(manager.broadcast_raw({"type": "graphSync", "asks": 2}))
    assert all(sock.got[-1] == {"type": "graphSync", "asks": 2} for sock in (person, held, author, other, bare))


def test_the_tab_claim_is_no_agent_marker_and_never_the_person():
    from services.person_gate import AGENT_MARKER_HEADERS, has_agent_marker, is_person

    assert "x-nebula-tab" not in AGENT_MARKER_HEADERS
    assert not has_agent_marker(TAB)
    assert not is_person({**FORGED_ORIGIN, **TAB})
