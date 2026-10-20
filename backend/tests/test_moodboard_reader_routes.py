"""POST /api/moodboards/{id}/read/estimate and /read?dryRun=1, the spend gate,
and the CLI and MCP surfaces (PR4; contract 07 section 1.13).

Google is mocked (tests/test_moodboard_reader.py's FakeGoogle) through
``main._moodboard_reader_transport``; no test calls a paid API.
"""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import mcp_server
import moodboard_client as boards
from cli.__main__ import build_parser
from cli.client import NebulaClient
from cli.commands import moodboard as moodboard_cmd
from nebula_api import NebulaAPI
from services import agent_spend
from services.output import OUTPUT_ROOT
from tests.conftest import PERSON
from tests.test_moodboard_reader import FakeGoogle, labels_of, phase_of, reading, sse


class RouteGoogle(FakeGoogle):
    """Real JPEGs reach the route's requests, so answers go by label alone."""

    def readings_for(self, body):
        return [reading(label, "Dither" if label != "B" else "Glass") for label in labels_of(body)]


SETTINGS: dict = {}


@pytest.fixture
def google(monkeypatch):
    import main

    fake = RouteGoogle()
    monkeypatch.setattr(main, "_moodboard_reader_transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def client(tmp_path, monkeypatch, person, google):
    import main

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)

    async def ignore(data):
        return None

    monkeypatch.setattr(main.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main.manager, "broadcast_browser", ignore)
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    SETTINGS.clear()
    SETTINGS.update({"apiKeys": {"GOOGLE_API_KEY": "g-test"}, "runCostConfirmUsd": 50.0,
                     "agentSpend": {"sessionUsd": None, "models": {}}})
    monkeypatch.setattr(main, "load_settings", lambda: json.loads(json.dumps(SETTINGS)))
    return TestClient(main.app)


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "moodboard-reader-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 48), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _board(client, count=3, **body) -> dict:
    images = [{"url": _url((40 * n % 255, 90, 150))} for n in range(count)]
    response = client.post("/api/moodboards", json={"name": f"Read {uuid4().hex[:6]}", "images": images, **body})
    assert response.status_code == 200, response.text
    return response.json()


def _spent(key: str = agent_spend.OUTSIDE_SHARED) -> float:
    import main

    return main.agent_spend_ledger.spent(key).total


def test_the_estimate_route(client):
    board = _board(client, 7)
    response = client.post(f"/api/moodboards/{board['id']}/read/estimate", json={"model": "gemini-4-argon"})
    assert response.status_code == 200, response.text
    est = response.json()
    assert (est["count"], est["batches"], est["available"]) == (7, 2, True)
    assert 0 < est["low"] < est["high"] and est["unconfirmed"] is False and est["sources"]
    assert est["reader"]["name"] == "Gemini 4 Argon"

    SETTINGS["apiKeys"] = {}
    assert client.post(f"/api/moodboards/{board['id']}/read/estimate",
                       json={"model": "gemini-4-argon"}).json()["available"] is False


@pytest.mark.parametrize("body, detail", [
    ({"model": "gpt-vision"}, "No reader called 'gpt-vision'"),
    ({"model": "gemini-4-argon", "imageIds": ["nope"]}, "No image nope"),
    ({"model": "gemini-4-argon", "thinkingLevel": "minimal"}, "thinking level"),
])
def test_bad_requests_are_refused(client, body, detail):
    board = _board(client, 1)
    for path in ("read/estimate", "read?dryRun=1"):
        response = client.post(f"/api/moodboards/{board['id']}/{path}", json=body)
        assert response.status_code == 422 and detail in response.json()["detail"]


def test_a_read_that_is_not_a_dry_run_is_refused(client, google):
    board = _board(client, 1)
    response = client.post(f"/api/moodboards/{board['id']}/read", json={"model": "gemini-4-argon"})
    assert response.status_code == 422 and "dryRun=1" in response.json()["detail"]
    assert google.bodies == []


def test_a_dry_run_reads_saves_nothing_and_gives_back_unstarted_requests(client, google):
    board = _board(client, 3)
    before = client.get(f"/api/moodboards/{board['id']}").json()
    est = client.post(f"/api/moodboards/{board['id']}/read/estimate", json={"model": "gemini-4-argon"}).json()

    response = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["dryRun"] is True and result["applied"] is False
    assert result["summary"]["sorted"] == 3 and result["estimate"]["high"] == pytest.approx(est["high"])
    assert result["requestedBy"]["kind"] != "person" and result["reader"]["kind"] == "reader"
    assert [phase_of(body) for body in google.bodies] == ["read", "sort"]
    # Nothing was saved: same version, same update time, no readings.
    after = client.get(f"/api/moodboards/{board['id']}").json()
    assert (after["version"], after["updatedAt"], after.get("readings")) == (
        before["version"], before["updatedAt"], before.get("readings"))
    # The agent was counted for what started (no retries ran), not the whole hold.
    started = est["shares"]["batch:1"] + est["shares"]["sort"]
    assert _spent() == pytest.approx(started, abs=1e-5)


def test_an_agent_is_refused_when_a_usd_limit_is_set_and_the_read_is_unpriced(client, google, monkeypatch):
    from services import moodboard_reader as reader

    unpriced = reader.load_models()
    unpriced["models"]["gemini-4-argon"]["prices"] = None
    monkeypatch.setattr(reader, "load_models", lambda path=None: unpriced)
    board = _board(client, 2)

    response = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"})
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert "no list price" in detail and "Settings > Agent spending" in detail and "--estimate" in detail
    assert google.bodies == [] and _spent() == 0


def test_an_agent_over_the_per_run_limit_is_refused(client, google):
    board = _board(client, 6)
    SETTINGS["runCostConfirmUsd"] = 0.01
    response = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"})
    assert response.status_code == 403 and "per-run limit" in response.json()["detail"]
    assert google.bodies == []
    # The Gemini chat node's own limit replaces the general one (Q11).
    SETTINGS["agentSpend"] = {"sessionUsd": None, "models": {"gemini-chat": {"perRunUsd": 20.0, "sessionUsd": None}}}
    assert client.post(f"/api/moodboards/{board['id']}/read?dryRun=1",
                       json={"model": "gemini-4-argon"}).status_code == 200


def test_the_hold_is_given_back_when_the_key_is_missing(client, google):
    board = _board(client, 2)
    SETTINGS["apiKeys"] = {}
    response = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"})
    assert response.status_code == 400 and "GOOGLE_API_KEY" in response.json()["detail"]
    assert google.bodies == [] and _spent() == 0


def test_the_person_passes_and_is_not_counted(client, google):
    board = _board(client, 2)
    SETTINGS["runCostConfirmUsd"] = 0.01
    response = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"},
                           headers=PERSON)
    assert response.status_code == 200, response.text
    assert response.json()["requestedBy"]["kind"] == "person" and _spent() == 0


def test_a_retry_keeps_its_share_and_only_unstarted_requests_come_back(client, google):
    board = _board(client, 3)
    est = client.post(f"/api/moodboards/{board['id']}/read/estimate", json={"model": "gemini-4-argon"}).json()
    google.script[1] = lambda body: (200, sse(json.dumps({"readings": [reading("A")]})[:-2], finish="MAX_TOKENS"))
    result = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"}).json()
    assert result["sent"] == ["batch:1", "retry:1", "sort"]
    shares = est["shares"]
    assert _spent() == pytest.approx(shares["batch:1"] + shares["retry:1"] + shares["sort"], abs=1e-5)


def test_only_some_images_are_read(client, google):
    board = _board(client, 5)
    ids = [board["images"][2]["id"], board["images"][4]["id"]]
    result = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1",
                         json={"model": "gemini-4-argon", "imageIds": ids}).json()
    assert [r["number"] for r in result["results"]] == [3, 5]
    assert labels_of(google.bodies[0]) == ["A", "B"]


def test_stream_answers_ndjson_lines_then_the_result(client):
    board = _board(client, 2)
    with client.stream("POST", f"/api/moodboards/{board['id']}/read?dryRun=1&stream=1",
                       json={"model": "gemini-4-argon"}) as response:
        assert response.status_code == 200 and response.headers["content-type"].startswith("application/x-ndjson")
        rows = [json.loads(line) for line in response.iter_lines() if line]
    traces = [row for row in rows if row["type"] == "moodboardReadTrace"]
    assert rows[-1]["type"] == "moodboardReadResult" and "trace" not in rows[-1]
    assert [row["seq"] for row in traces] == list(range(1, len(traces) + 1))
    assert traces[0]["kind"] == "batch" and traces[-1]["kind"] == "done"
    assert rows[-1]["summary"]["sorted"] == 2


# -- the CLI and MCP -------------------------------------------------------------------------

@pytest.fixture
def cli(client, monkeypatch):
    nebula = NebulaClient("http://testserver")
    nebula._client = client
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=client))
    return nebula


def _cli(nebula, argv, capsys) -> str:
    moodboard_cmd.run(nebula, build_parser().parse_args(argv))
    return capsys.readouterr().out


def test_cli_dry_run_prints_the_trace_lines(cli, client, capsys):
    board = _board(client, 3)
    out = _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--dry-run"], capsys)
    assert "Gemini 4 Argon" in out and "$" in out
    assert "Reading #1–#3" in out
    assert "#1  dither study → Dither (0.82)" in out and "#2  glass study → Glass (0.82)" in out
    assert "#2 → Glass (new look)" in out
    assert "Dry run: would sort 3 into 2 looks (2 new) · nothing moved" in out


def test_cli_only_reads_the_named_images(cli, client, capsys, google):
    board = _board(client, 6)
    out = _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--dry-run",
                     "--only", "3,5"], capsys)
    assert "Reading #3, #5" in out and labels_of(google.bodies[0]) == ["A", "B"]


def test_cli_json_prints_one_line_per_trace_line(cli, client, capsys):
    board = _board(client, 2)
    out = _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--dry-run", "--json"],
               capsys)
    rows = [json.loads(line) for line in out.splitlines() if line.strip()]
    assert rows[0]["type"] == "moodboardReadTrace" and rows[-1]["type"] == "moodboardReadResult"


def test_cli_estimate_reads_nothing(cli, client, capsys, google):
    board = _board(client, 7)
    out = _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--estimate"], capsys)
    assert "7 references in 2 batches" in out and "$" in out and google.bodies == []


def test_cli_quiet_prints_the_summary_only(cli, client, capsys):
    board = _board(client, 2)
    out = _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--dry-run", "--quiet"],
               capsys)
    assert "Reading #1" not in out and "Dry run: would sort 2" in out
    # Only the done and spent lines: no estimate block first.
    assert out.splitlines()[0].startswith("Dry run: would sort 2") and "Priced at" not in out
    assert out.splitlines()[1].startswith("Spent about $") and len(out.splitlines()) == 2


def test_cli_says_when_a_request_has_no_token_count(cli, client, capsys, google):
    google.script = {1: lambda body: (503, [])}  # no usageMetadata for that request; the retry answers
    board = _board(client, 2)
    out = _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--dry-run"], capsys)
    assert "in 3 requests. Nothing was saved." in out
    assert ("1 request stopped without a token count, so it isn't in this figure; Google may still bill it, "
            "so read it as a minimum.") in out


def test_cli_without_dry_run_is_refused_before_anything_is_sent(cli, client, capsys, google):
    board = _board(client, 2)
    with pytest.raises(SystemExit):
        _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon"], capsys)
    assert "--dry-run" in capsys.readouterr().err and google.bodies == []


def test_cli_read_flags_need_read_with(cli, client, capsys):
    board = _board(client, 1)
    with pytest.raises(SystemExit):
        _cli(cli, ["moodboard", "analyze", board["id"], "--dry-run", "--only", "1"], capsys)
    assert "--read-with" in capsys.readouterr().err


def test_cli_refusal_is_printed(cli, client, capsys, google):
    board = _board(client, 6)
    SETTINGS["runCostConfirmUsd"] = 0.01
    with pytest.raises(SystemExit):
        _cli(cli, ["moodboard", "analyze", board["id"], "--read-with", "gemini-4-argon", "--dry-run"], capsys)
    assert "per-run limit" in capsys.readouterr().err and google.bodies == []


def test_mcp_moodboard_analyze_reads_with_a_model(cli, client):
    board = _board(client, 3)
    result = mcp_server.moodboard_analyze(board["id"], read_with="gemini-4-argon", dry_run=True)
    assert result["summary"]["sorted"] == 3 and result["dryRun"] is True
    assert result["results"][0] == {"number": 1, "id": board["images"][0]["id"], "look": "Dither", "fit": 0.82,
                                    "reason": "dither study", "status": "sorted", "newLook": True}
    assert all(line["kind"] != "thought" for line in result["lines"]) and len(result["lines"]) <= 20
    assert "readings" not in result and "trace" not in result


def test_mcp_estimate_only_and_refusals(cli, client, google):
    board = _board(client, 2)
    est = mcp_server.moodboard_analyze(board["id"], read_with="gemini-4-argon", estimate_only=True)
    assert est["count"] == 2 and google.bodies == []
    with pytest.raises(RuntimeError, match="dry_run"):
        mcp_server.moodboard_analyze(board["id"], read_with="gemini-4-argon")
    with pytest.raises(RuntimeError, match="read_with"):
        mcp_server.moodboard_analyze(board["id"], dry_run=True, only=["1"])


def test_mcp_only_takes_numbers_as_the_docs_show(cli, client, google):
    board = _board(client, 6)
    # Through FastMCP's own argument validation, as an agent's call arrives.
    est = asyncio.run(mcp_server.mcp._tool_manager.call_tool(
        "moodboard_analyze", {"board": board["id"], "read_with": "gemini-4-argon", "estimate_only": True,
                              "only": [3, 5]}))
    assert est["count"] == 2 and google.bodies == []
