"""Round 14 of PR #114: the person's canvas is read-only while Nebula is offline.

GM (2026-10-27): "Nebula is offline. Editing is paused until it reconnects."
The tab blocks every edit while it can't reach the backend, not queues it,
"because a restarted backend refuses replayed writes". An agent sees the same
outage as Nebula never answering its connect (nebula_api's "Nebula isn't
running at …"). Its tool error now also says the canvas is read-only meanwhile,
that nothing either side edits is saved or queued, and to re-read the canvas
(start_here) once Nebula is back rather than assume its plan landed. A request
Nebula took and then dropped (a restart mid-request), a timeout and a real
refusal don't say it: Nebula was there.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError

import nebula_api
from nebula_api import NebulaAPIError

MCP_NOTE = ("While Nebula is offline the person's canvas is read-only: nothing you or they edit is saved or "
            "queued. Once it's back, call start_here to re-read the canvas before assuming your plan landed.")
CLI_NOTE = ("While Nebula is offline the person's canvas is read-only: nothing you or they edit is saved or "
            "queued. Once it's back, run `nebula graph` to re-read the canvas before assuming your plan landed.")
DOWN = "http://127.0.0.1:1"


@pytest.fixture
def unreachable(monkeypatch):
    import mcp_server

    monkeypatch.delenv("NEBULA_URL_FILE", raising=False)
    monkeypatch.setattr(mcp_server, "_base_url", DOWN)
    return mcp_server


class _Failing:
    """A NebulaAPI whose every request fails with `error`."""

    def __init__(self, error: BaseException) -> None:
        self.error = error
        self.base_url = DOWN

    def request(self, *_args, **_kwargs):
        raise self.error

    send = request


def _raised(cause: BaseException, **kwargs) -> NebulaAPIError:
    try:
        try:
            raise cause
        except BaseException as inner:
            raise NebulaAPIError(**kwargs) from inner
    except NebulaAPIError as exc:
        return exc


def _tool_error(mcp_server, name: str, arguments: dict) -> str:
    with pytest.raises(ToolError) as refused:
        asyncio.run(mcp_server.mcp.call_tool(name, arguments))
    return str(refused.value)


def test_the_notes_are_the_shared_strings():
    assert nebula_api.offline_read_only("call start_here") == MCP_NOTE
    assert nebula_api.offline_read_only("run `nebula graph`") == CLI_NOTE


def test_an_unreachable_nebula_says_the_canvas_is_read_only(unreachable):
    text = _tool_error(unreachable, "list_projects", {})
    assert f"Nebula isn't running at {DOWN}. Start Nebula, then retry. {MCP_NOTE}" in text


def test_a_write_tool_says_it_too(unreachable):
    text = _tool_error(unreachable, "edit_canvas", {"nodes": [{"ref": "+a", "definitionId": "text-input"}]})
    assert text.endswith(f"Nebula isn't running at {DOWN}. Start Nebula, then retry. {MCP_NOTE}")


def test_a_wrapped_connect_error_says_it_too(unreachable, tmp_path):
    """load_graph_file wraps the restore's error in its own (file name first)."""
    bundle = tmp_path / "glass.nebula"
    bundle.write_text('{"version": 3, "nodes": [], "edges": []}', encoding="utf-8")
    assert _tool_error(unreachable, "load_graph_file", {"path": str(bundle)}).endswith(MCP_NOTE)


def test_a_url_file_with_nothing_behind_it_says_it_too(monkeypatch, tmp_path):
    import mcp_server

    monkeypatch.setattr(mcp_server, "_base_url", None)
    monkeypatch.setenv("NEBULA_URL_FILE", str(tmp_path / "backend-url"))
    text = _tool_error(mcp_server, "list_projects", {})
    assert "isn't running" in text and text.endswith(MCP_NOTE)


def test_a_steps_plan_that_stops_on_an_unreachable_nebula_says_it(unreachable):
    stopped = unreachable.edit_canvas(steps=[{"nodes": [{"ref": "+a", "definitionId": "text-input"}]}])
    assert stopped["status"] == "stopped"
    assert stopped["error"] == f"cannot connect to Nebula backend at {DOWN}. {MCP_NOTE}"


@pytest.mark.parametrize("error", [
    # Nebula took the request, then went away (a restart): it was there.
    _raised(httpx.RemoteProtocolError("closed"), detail="POST /api/graph/apply failed: closed", kind="connect"),
    _raised(httpx.ReadTimeout("slow"), detail="Nebula didn't answer GET /api/projects in time.", kind="timeout"),
    NebulaAPIError("Cannot replace the graph while a run is active.", status=409),
], ids=["dropped-mid-request", "timeout", "refusal"])
def test_nebula_that_was_there_doesnt_say_read_only(monkeypatch, error):
    import mcp_server

    monkeypatch.setattr(mcp_server, "_api", lambda: _Failing(error))
    text = _tool_error(mcp_server, "list_projects", {})
    assert error.detail in text
    assert "read-only" not in text


def test_the_note_names_only_real_tools():
    import re

    import mcp_server

    tools = {tool.name for tool in asyncio.run(mcp_server.mcp.list_tools())}
    named = set(re.findall(r"\b([a-z]+(?:_[a-z]+)+)\b", MCP_NOTE))
    assert named and named <= tools


def test_the_cli_says_it_for_an_unreachable_nebula(capsys):
    from cli.client import NebulaClient

    with pytest.raises(SystemExit):
        NebulaClient(DOWN).get_spend()
    err = capsys.readouterr().err
    assert err.strip() == f"error: cannot connect to Nebula backend at {DOWN} — is the server running? {CLI_NOTE}"


def test_the_cli_doesnt_say_it_for_a_dropped_request(capsys, monkeypatch):
    from cli.client import NebulaClient

    client = NebulaClient(DOWN)
    dropped = _raised(httpx.RemoteProtocolError("closed"), detail="GET /api/agent/spend failed: closed",
                      kind="connect")
    monkeypatch.setattr(type(client), "api", property(lambda self: _Failing(dropped)))
    with pytest.raises(SystemExit):
        client.get_spend()
    assert "read-only" not in capsys.readouterr().err


def test_nebula_apply_stops_with_the_cli_note():
    import apply_steps

    never = _raised(httpx.ConnectError("refused"), detail="Nebula isn't running at x.", kind="connect")
    dropped = _raised(httpx.ReadError("reset"), detail="POST failed", kind="connect")
    assert apply_steps.stop_reason(never, DOWN, reread="run `nebula graph`") == (
        f"cannot connect to Nebula backend at {DOWN}. {CLI_NOTE}")
    assert apply_steps.stop_reason(dropped, DOWN, reread="run `nebula graph`") == (
        f"cannot connect to Nebula backend at {DOWN}")
    assert apply_steps.stop_reason(never, DOWN) == f"cannot connect to Nebula backend at {DOWN}"
