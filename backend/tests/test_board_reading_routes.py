"""Read the board through the API, the proposal flow, the CLI and MCP
(services/board_reading.py, main.py "Read the board").

agy is FAKE (tests/test_board_reading.py's install_fake) and Google is an
httpx MockTransport through ``main._board_reading_transport``: nothing here
runs the person's agy or calls a paid API.
"""
from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import mcp_server
import moodboard_client as boards
from cli.__main__ import build_parser
from cli.client import NebulaClient
from cli.commands import moodboard as moodboard_cmd
from nebula_api import NebulaAPI
from services import agent_spend, board_reading as br
from tests.conftest import PERSON
from tests.test_board_reading import calls, install_fake, make_image

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
SETTINGS: dict = {}


class Google:
    def __init__(self) -> None:
        self.bodies: list[dict] = []
        self.status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        if self.status != 200:
            return httpx.Response(self.status, content=b'{"error": {"message": "API key not valid."}}')
        names = [p["text"].removeprefix("images/") for p in self.bodies[-1]["contents"][0]["parts"][1:]
                 if "text" in p]
        text = f"Key route reading. **Bold** cites `{names[0]}`."
        payload = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]}
        return httpx.Response(200, content=b"data: " + json.dumps(payload).encode() + b"\r\n\r\n")


@pytest.fixture(autouse=True)
def _never_the_real_agy(monkeypatch):
    """No test may find the person's own agy: every lookup Nebula makes
    (agent_binaries.resolve, PATH and the login shell) refuses it, so only a
    test's FAKE, passed in or patched over find_agy, ever runs."""
    from services import agent_binaries

    real = agent_binaries.resolve

    def resolve(command, **kwargs):
        if str(command).rsplit("/", 1)[-1] == "agy":
            return None
        return real(command, **kwargs)

    monkeypatch.setattr(agent_binaries, "resolve", resolve)
    monkeypatch.setattr(br, "find_agy", lambda: None)


@pytest.fixture
def agy_dir(tmp_path):
    return tmp_path / "agy-bin"


@pytest.fixture
def google(monkeypatch):
    import main

    fake = Google()
    monkeypatch.setattr(main, "_board_reading_transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def client(tmp_path, monkeypatch, person, google, agy_dir):
    import main

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setattr(main, "_STATE_DIR", tmp_path / "state")
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)
    sent: list[dict] = []

    async def keep(data):
        sent.append(data)

    monkeypatch.setattr(main.manager, "broadcast_raw", keep)
    monkeypatch.setattr(main.manager, "broadcast_browser", keep)
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    SETTINGS.clear()
    SETTINGS.update({"apiKeys": {"GOOGLE_API_KEY": "g-test"}})
    monkeypatch.setattr(main, "load_settings", lambda: json.loads(json.dumps(SETTINGS)))
    install_fake(agy_dir)
    monkeypatch.setattr(br, "find_agy", lambda: agy_dir / "agy")
    br.forget_status()
    br.runs.clear()
    with TestClient(main.app) as test_client:
        test_client.sent = sent  # type: ignore[attr-defined]
        yield test_client
    br.runs.clear()
    br.forget_status()


def no_agy(monkeypatch):
    monkeypatch.setattr(br, "find_agy", lambda: None)
    br.forget_status()


def _board(client, count=3) -> dict:
    images = [{"url": make_image((40 * n % 255, 90, 150))[0]} for n in range(count)]
    response = client.post("/api/moodboards", json={"name": "Desert light", "images": images}, headers=PERSON)
    assert response.status_code == 200, response.text
    return response.json()


def _wait(client, board_id, *, headers=PERSON, timeout=20.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        data = client.get(f"/api/moodboards/{board_id}/reading", headers=headers).json()
        if data["run"] and data["run"]["status"] != "running":
            return data
        assert time.monotonic() < deadline, data
        time.sleep(0.1)


def test_the_person_reads_on_antigravity_and_the_reading_is_saved(client, agy_dir, google):
    board = _board(client)
    before = client.get(f"/api/moodboards/{board['id']}/reading", headers=PERSON).json()
    assert before["reading"] is None and before["route"]["route"] == "antigravity"
    assert before["route"]["count"] == 3 and before["route"]["antigravity"] == {"installed": True, "signedIn": True}
    started = client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    assert started.status_code == 200 and started.json()["status"] == "running"
    data = _wait(client, board["id"])
    assert data["run"]["status"] == "done" and google.bodies == []
    reading = data["reading"]
    first = board["images"][0]["id"]
    assert reading["route"] == "antigravity" and reading["by"] == {"kind": "person"}
    # The fake cites the first two file names in name order.
    named = sorted(board["images"], key=lambda img: f"tile-{img['id']}.png")[:2]
    assert reading["cited"] == [img["id"] for img in named]
    numbers = {img["id"]: n + 1 for n, img in enumerate(board["images"])}
    assert f"(#{numbers[named[0]['id']]})" in data["markdown"] and "`tile-notsent.png`" in data["markdown"]
    assert data["tiles"][0] == {"number": 1, "imageId": first, "file": f"tile-{first}.png", "onBoard": True,
                                "numberWhenRead": 1, "cited": first in reading["cited"]}
    assert data["stale"]["stale"] is False
    saved = client.get(f"/api/moodboards/{board['id']}", headers=PERSON).json()
    assert saved["boardReading"]["id"] == reading["id"] and "boardReadingPrevious" not in saved
    assert saved["version"] == board["version"] + 1
    # Every socket heard it, with the run's outcome.
    assert any(m.get("type") == "boardReadingRun" and m["run"]["status"] == "done" for m in client.sent)
    assert any(m.get("type") == "storedAssetChanged" and m.get("id") == board["id"] for m in client.sent)
    # agy never saw a Nebula variable.
    run_call = [c for c in calls(agy_dir) if "--sandbox" in c["argv"]][-1]
    assert not any(name.startswith("NEBULA") or "KEY" in name or "TOKEN" in name for name in run_call["env"])


def test_staleness_follows_the_image_set(client):
    board = _board(client, 2)
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    _wait(client, board["id"])
    images = board["images"] + [{"url": make_image((1, 2, 3))[0]}]
    client.put(f"/api/moodboards/{board['id']}", json={"notes": "warmer"}, headers=PERSON)
    assert client.get(f"/api/moodboards/{board['id']}/reading").json()["stale"]["stale"] is False
    client.put(f"/api/moodboards/{board['id']}", json={"images": images}, headers=PERSON)
    stale = client.get(f"/api/moodboards/{board['id']}/reading").json()["stale"]
    assert stale["stale"] is True and len(stale["added"]) == 1


def test_a_second_read_keeps_the_first_for_undo(client):
    board = _board(client, 2)
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    first = _wait(client, board["id"])["reading"]
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    second = _wait(client, board["id"])
    assert second["reading"]["id"] != first["id"] and second["hasPrevious"] is True
    stale_undo = client.post(f"/api/moodboards/{board['id']}/reading/undo", json={"readingId": first["id"]})
    assert stale_undo.status_code == 409
    undone = client.post(f"/api/moodboards/{board['id']}/reading/undo", json={"readingId": second["reading"]["id"]},
                         headers=PERSON)
    assert undone.status_code == 200 and undone.json()["reading"]["id"] == first["id"]
    # Undo again brings the newer one back.
    again = client.post(f"/api/moodboards/{board['id']}/reading/undo", json={"readingId": first["id"]},
                        headers=PERSON)
    assert again.json()["reading"]["id"] == second["reading"]["id"]


def test_a_reading_is_never_set_through_put_or_create(client):
    board = _board(client, 1)
    response = client.put(f"/api/moodboards/{board['id']}", json={"boardReading": {"markdown": "x"}},
                          headers=PERSON)
    assert response.status_code == 422
    response = client.post("/api/moodboards", json={"name": "x", "images": [], "boardReadingPrevious": {}},
                           headers=PERSON)
    assert response.status_code == 422


def test_the_key_route_runs_for_the_person_when_antigravity_is_signed_out(client, agy_dir, google):
    (agy_dir / "status").write_text("signed_out")
    board = _board(client, 2)
    state = client.get(f"/api/moodboards/{board['id']}/reading").json()["route"]
    assert state["route"] == "gemini_key" and state["antigravity"] == {"installed": True, "signedIn": False}
    assert 0 < state["estimate"]["low"] < state["estimate"]["high"]
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    data = _wait(client, board["id"])
    assert data["run"]["status"] == "done" and data["reading"]["route"] == "gemini_key"
    assert data["reading"]["cost"]["high"] == pytest.approx(state["estimate"]["high"])
    assert len(google.bodies) == 1 and "#1" in data["markdown"]


@pytest.mark.parametrize("behavior, cause", [("plan_limit", "plan_limit"), ("signed_out", "signed_out"),
                                             ("write", "write_attempt"), ("garbage", "other")])
def test_a_failed_read_leaves_the_earlier_reading(client, agy_dir, behavior, cause):
    board = _board(client, 2)
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    first = _wait(client, board["id"])["reading"]
    (agy_dir / "behavior").write_text(behavior)
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    data = _wait(client, board["id"])
    assert data["run"]["status"] == "failed" and data["run"]["cause"] == cause
    assert data["reading"]["id"] == first["id"]


def test_stop_keeps_the_earlier_reading(client, agy_dir, tmp_path):
    board = _board(client, 2)
    (agy_dir / "behavior").write_text("timeout")
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    assert client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON).status_code == 409
    time.sleep(0.5)
    # Only the person, or the agent that started it, may stop it.
    assert client.post(f"/api/moodboards/{board['id']}/reading/stop", headers=CLAUDE).status_code == 403
    stopped = client.post(f"/api/moodboards/{board['id']}/reading/stop", headers=PERSON)
    assert stopped.json()["status"] == "stopped"
    data = client.get(f"/api/moodboards/{board['id']}/reading").json()
    assert data["run"]["status"] == "stopped" and data["reading"] is None
    # The sandbox folder went with agy.
    root = tmp_path / "state" / "tmp" / "board-reading"
    assert [p for p in root.iterdir() if p.name.startswith("read-")] == []


def test_locks_say_what_to_do(client, monkeypatch):
    no_agy(monkeypatch)
    SETTINGS["apiKeys"] = {}
    board = _board(client, 1)
    response = client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=PERSON)
    assert response.status_code == 422
    assert response.json()["detail"] == ("You can read the board after you install Antigravity and sign in, or add "
                                         "a Gemini API key in Settings.")
    empty = client.put(f"/api/moodboards/{board['id']}", json={"images": []}, headers=PERSON).json()
    response = client.post(f"/api/moodboards/{empty['id']}/reading", json={}, headers=PERSON)
    assert response.json()["detail"] == "You can read the board after you add images."


def test_an_agent_reads_on_the_subscription(client):
    board = _board(client, 2)
    started = client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=CLAUDE)
    assert started.status_code == 200 and started.json()["status"] == "running"
    data = _wait(client, board["id"], headers=CLAUDE)
    assert data["reading"]["by"]["kind"] == "agent" and data["reading"]["by"]["name"] == "Claude Code"
    # An unnamed caller that isn't the person can't read.
    assert client.post(f"/api/moodboards/{board['id']}/reading", json={}).status_code == 400


def _accept(client, proposal_id):
    import main

    key = main.asset_proposals.get(proposal_id).accept_key
    return client.post(f"/api/asset-proposals/{proposal_id}/accept",
                       headers={**PERSON, "X-Nebula-Proposal-Key": key})


def test_an_agent_on_the_key_route_proposes_and_accept_runs_it(client, monkeypatch, google):
    no_agy(monkeypatch)
    board = _board(client, 2)
    response = client.post(f"/api/moodboards/{board['id']}/reading", json={"note": "Read it for the brief"},
                           headers=CLAUDE)
    assert response.status_code == 202, response.text
    proposal = response.json()["proposal"]
    assert proposal["kind"] == "moodboard" and proposal["change"]["read"]["images"] == 2
    assert proposal["change"]["read"]["cost"]["high"] > 0 and proposal["note"] == "Read it for the brief"
    assert proposal["summary"] == "read “Desert light” with Gemini 4 Argon"
    assert google.bodies == []
    accepted = _accept(client, proposal["id"])
    assert accepted.status_code == 200, accepted.text
    data = _wait(client, board["id"])
    assert data["reading"]["route"] == "gemini_key" and data["reading"]["by"] == {
        "kind": "person", "acceptedFrom": "Claude Code"}
    assert len(google.bodies) == 1


def test_an_agent_naming_the_key_route_proposes_the_switch(client, google):
    board = _board(client, 2)
    response = client.post(f"/api/moodboards/{board['id']}/reading", json={"route": "gemini_key"}, headers=CLAUDE)
    assert response.status_code == 202 and response.json()["status"] == "proposed"
    assert google.bodies == [] and br.runs.running(board["id"]) is None


def test_the_read_proposal_s_update_says_so(client, monkeypatch):
    from services import asset_proposals as ap

    no_agy(monkeypatch)
    board = _board(client, 1)
    proposal = client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=CLAUDE).json()["proposal"]
    record = ap.asset_proposals.get(proposal["id"])
    assert ap.update_text(record) == "Claude Code wants to read “Desert light” with Gemini 4 Argon."
    assert ap.update_detail(record)["read"] is True
    reject = client.post(f"/api/asset-proposals/{proposal['id']}/reject",
                         headers={**PERSON, "X-Nebula-Proposal-Key": record.accept_key})
    assert reject.status_code == 200 and ap.outcome_line(record) == "You said no"


def test_a_read_proposal_can_t_be_made_without_a_key(client, monkeypatch):
    no_agy(monkeypatch)
    board = _board(client, 1)
    SETTINGS["apiKeys"] = {}
    response = client.post("/api/asset-proposals", json={"kind": "moodboard", "id": board["id"],
                                                          "change": {"read": True}, "note": "n"}, headers=CLAUDE)
    assert response.status_code == 409


def test_an_agent_failure_reaches_the_agent_log(client, agy_dir):
    board = _board(client, 1)
    (agy_dir / "behavior").write_text("plan_limit")
    client.post(f"/api/moodboards/{board['id']}/reading", json={}, headers=CLAUDE)
    _wait(client, board["id"], headers=CLAUDE)
    says = [m.get("say") for m in client.sent if m.get("say")]
    assert "Reading the board" in says
    assert "Couldn't read the board because the Antigravity plan has reached its limit for now." in says


# -- the CLI and MCP ------------------------------------------------------------------------------------

@pytest.fixture
def cli(client, monkeypatch):
    nebula = NebulaClient("http://testserver")
    nebula._client = client
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    return nebula


def test_mcp_reads_the_board_and_returns_numbered_markdown(cli, client):
    board = _board(client, 2)
    result = mcp_server.moodboard_read_board(board["id"])
    assert result["status"] == "done" and "#1" in result["markdown"] and "tile-" not in result["markdown"].replace(
        "tile-notsent", "")
    assert result["tiles"][0]["imageId"] == board["images"][0]["id"] and result["stale"] is False
    assert result["writtenBy"].startswith("Gemini")
    again = mcp_server.moodboard_reading(board["id"])
    assert again["markdown"] == result["markdown"] and again["route"] == "antigravity"
    text = json.dumps(again)
    assert "/tmp" not in text and "read-" not in text and "calls.jsonl" not in text


def test_mcp_on_the_key_route_proposes(cli, client, monkeypatch, google):
    no_agy(monkeypatch)
    board = _board(client, 2)
    result = mcp_server.moodboard_read_board(board["id"], note="For the brief")
    assert result["status"] == "proposed" and result["proposal"]["change"]["read"]["images"] == 2
    assert google.bodies == []


def test_mcp_says_why_a_read_failed(cli, client, agy_dir):
    board = _board(client, 1)
    (agy_dir / "behavior").write_text("signed_out")
    with pytest.raises(RuntimeError, match="Antigravity signed out during the read"):
        mcp_server.moodboard_read_board(board["id"])


def test_cli_read_and_reading(cli, client, capsys, monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Terminal")
    board = _board(client, 2)
    moodboard_cmd.run(cli, build_parser().parse_args(["moodboard", "read", board["id"]]))
    out = capsys.readouterr().out
    assert "Gemini 4 Argon's reading of Desert light" in out and "#1" in out and "Antigravity" in out
    moodboard_cmd.run(cli, build_parser().parse_args(["moodboard", "reading", board["id"], "--json"]))
    data = json.loads(capsys.readouterr().out)
    assert data["board"]["id"] == board["id"] and data["tiles"]


def test_client_read_waits_and_reports_running_past_its_wait(client, agy_dir):
    board = _board(client, 1)
    (agy_dir / "behavior").write_text("timeout")
    api = NebulaAPI("http://testserver", client=client)
    clock = iter([0.0, 0.0, 1000.0])
    result = boards.read_board(api, board["id"], headers=CLAUDE, sleep=lambda s: None, clock=lambda: next(clock))
    assert result["status"] == "running"
    client.post(f"/api/moodboards/{board['id']}/reading/stop", headers=PERSON)
