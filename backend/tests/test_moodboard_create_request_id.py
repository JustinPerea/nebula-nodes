"""A board create sent again makes one board (PR #210 round 6e).

Moodboard Studio gives each unsaved board a request id. When a create
reached Nebula but its answer was lost on the way back, the Studio sends the
same create again; the same ``requestId`` returns the board the first send
made (same id, same version) instead of a second one. The record is a file
beside the boards, so it holds across a restart. Agents' create (MCP, CLI)
takes the same optional id; without one, every create makes a board.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import mcp_server
import moodboard_client as boards
from cli.__main__ import build_parser
from cli.client import NebulaClient
from cli.commands import moodboard as moodboard_cmd
from nebula_api import NebulaAPI
from services import moodboard_store
from services.moodboard_store import MoodboardStore
from tests.conftest import stored_image_urls

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def told(tmp_path, monkeypatch):
    """The board root is this test's; returns what was broadcast and said."""
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    calls: dict[str, list] = {"broadcast": [], "said": []}

    async def ignore(data, **_):
        return None

    async def broadcast(kind, board, *_, **__):
        calls["broadcast"].append(board["id"] if isinstance(board, dict) else board)

    async def say(line):
        calls["said"].append(line)

    monkeypatch.setattr(main_module.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    monkeypatch.setattr(main_module, "_broadcast_stored_asset", broadcast)
    monkeypatch.setattr(main_module, "_say_agent_action", say)
    return calls


@pytest.fixture
def http(told):
    import main as main_module

    return TestClient(main_module.app)


def _boards_on_disk(tmp_path: Path) -> list[str]:
    return sorted(path.stem for path in (tmp_path / "moodboards" / "_global").glob("*.json"))


def _post(http, request_id: str | None, name: str = "Dusk", urls: list[str] | None = None):
    body = {"name": name, "images": [{"url": url} for url in (urls or [])]}
    if request_id is not None:
        body["requestId"] = request_id
    return http.post("/api/moodboards", json=body)


def test_a_create_whose_answer_was_lost_sent_again_makes_one_board(http, told, tmp_path):
    urls = stored_image_urls(2, name="lost")
    first = _post(http, "draft-0001-aaaa", urls=urls)
    assert first.status_code == 200, first.text
    # The answer never reached the Studio; it sends the same create again.
    again = _post(http, "draft-0001-aaaa", urls=urls)
    assert again.status_code == 200, again.text

    assert again.json()["id"] == first.json()["id"]
    assert again.json()["version"] == first.json()["version"] == 1
    # The client learns the board is the earlier send's.
    assert again.json()["repeated"] is True and "repeated" not in first.json()
    assert [image["url"] for image in again.json()["images"]] == urls
    assert _boards_on_disk(tmp_path) == [first.json()["id"]]
    assert [row["id"] for row in http.get("/api/moodboards").json()] == [first.json()["id"]]
    # Nobody is told twice: the repeat changed nothing.
    assert told["broadcast"] == [first.json()["id"]]
    assert len(told["said"]) == 1
    # The id is the client's, kept beside the boards, never on the board.
    assert "requestId" not in again.json() and "createRequestId" not in again.json()


def test_a_repeat_returns_the_board_as_it_is_now(http, tmp_path):
    first = _post(http, "draft-0002-aaaa", urls=stored_image_urls(1, name="now")).json()
    renamed = http.put(f"/api/moodboards/{first['id']}", json={"name": "Dusk, warmer"})
    assert renamed.status_code == 200, renamed.text

    again = _post(http, "draft-0002-aaaa", urls=stored_image_urls(1, name="now")).json()

    assert again["id"] == first["id"]
    assert again["name"] == "Dusk, warmer" and again["version"] == renamed.json()["version"]
    assert _boards_on_disk(tmp_path) == [first["id"]]


def test_two_drafts_make_two_boards(http, told, tmp_path):
    one = _post(http, "draft-0003-aaaa", name="Dusk").json()
    two = _post(http, "draft-0003-bbbb", name="Dusk").json()

    assert one["id"] != two["id"]
    assert _boards_on_disk(tmp_path) == sorted([one["id"], two["id"]])
    assert told["broadcast"] == [one["id"], two["id"]]


def test_without_a_request_id_every_create_makes_a_board(http, tmp_path):
    one = _post(http, None).json()
    two = _post(http, None).json()

    assert one["id"] != two["id"]
    assert len(_boards_on_disk(tmp_path)) == 2
    assert not (tmp_path / "moodboards" / ".creates").exists()


@pytest.mark.parametrize("request_id", ["short", "has space here", "a/b/../c-d-e", "x" * 129, 12345678, True,
                                        # R1: empty is refused, never a plain create; R2: 7 is one short;
                                        # R3: a trailing newline ($ would match before it).
                                        "", "abcdefg", "abcdefgh\n"])
def test_a_request_id_that_is_not_a_plain_token_is_refused(http, tmp_path, request_id):
    response = http.post("/api/moodboards", json={"name": "Dusk", "requestId": request_id})

    assert response.status_code == 422
    assert "requestId" in response.json()["detail"]
    assert _boards_on_disk(tmp_path) == []


def test_a_repeat_after_the_board_was_deleted_makes_a_new_one(http, tmp_path):
    first = _post(http, "draft-0004-aaaa").json()
    assert http.delete(f"/api/moodboards/{first['id']}").status_code == 200

    again = _post(http, "draft-0004-aaaa").json()

    assert again["id"] != first["id"]
    assert _boards_on_disk(tmp_path) == [again["id"]]
    # The record now names the live board, so a third send returns it.
    assert _post(http, "draft-0004-aaaa").json()["id"] == again["id"]


def _create_in_a_new_process(tmp_path: Path, request_id: str) -> dict:
    """``create_once`` in its own Python: nothing this process holds in
    memory reaches it, as after a backend restart. Every Nebula folder it
    could touch is this test's."""
    env = {
        **os.environ,
        "HOME": str(tmp_path / "home"),
        "NEBULA_MOODBOARD_ROOT": str(tmp_path / "moodboards"),
        "NEBULA_SETTINGS_PATH": str(tmp_path / "settings.json"),
        "NEBULA_STATE_DIR": str(tmp_path / "state"),
        "NEBULA_OUTPUT_ROOT": str(tmp_path / "outputs"),
    }
    script = (
        "import json, sys\n"
        "from services.moodboard_store import MoodboardStore\n"
        "board, made = MoodboardStore().create_once(name='Dusk', requestId=sys.argv[1], by='person')\n"
        "print(json.dumps({'id': board['id'], 'version': board['version'], 'made': made}))\n"
    )
    done = subprocess.run([sys.executable, "-c", script, request_id], cwd=BACKEND, env=env,
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_the_request_id_holds_across_a_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    before = _create_in_a_new_process(tmp_path, "draft-0005-aaaa")
    after = _create_in_a_new_process(tmp_path, "draft-0005-aaaa")
    other = _create_in_a_new_process(tmp_path, "draft-0005-bbbb")

    assert before["made"] is True and after["made"] is False and other["made"] is True
    assert after["id"] == before["id"] and after["version"] == before["version"]
    assert other["id"] != before["id"]
    assert _boards_on_disk(tmp_path) == sorted([before["id"], other["id"]])
    # And this process, which made neither, finds it too.
    board, made = MoodboardStore().create_once(name="Dusk", requestId="draft-0005-aaaa")
    assert made is False and board["id"] == before["id"]


def test_two_sends_of_one_create_racing_each_other_make_one_board(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    make = MoodboardStore._create

    def slow(self, *args, **kwargs):
        # Long enough that, without the lock, both sends find no record.
        time.sleep(0.15)
        return make(self, *args, **kwargs)

    monkeypatch.setattr(MoodboardStore, "_create", slow)
    results: list[tuple[str, bool]] = []
    gate = threading.Barrier(2)

    def send():
        gate.wait()
        board, made = MoodboardStore().create_once(name="Dusk", requestId="draft-0006-aaaa")
        results.append((board["id"], made))

    threads = [threading.Thread(target=send) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert len({board_id for board_id, _ in results}) == 1
    assert sorted(made for _, made in results) == [False, True]
    assert len(_boards_on_disk(tmp_path)) == 1


def test_the_record_is_a_side_file_the_scans_skip(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board, _ = MoodboardStore().create_once(name="Dusk", requestId="draft-0007-aaaa")
    root = tmp_path / "moodboards"

    record = json.loads((root / ".creates" / "draft-0007-aaaa.json").read_text())
    assert record["id"] == board["id"]
    assert root / ".creates" not in moodboard_store.board_scopes(root)
    assert [row["id"] for row in MoodboardStore().list("global")] == [board["id"]]
    # Not on the board: a GET-then-PUT round trip never carries it.
    assert "createRequestId" not in json.loads((root / "_global" / f"{board['id']}.json").read_text())


def test_a_record_naming_no_board_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    folder = tmp_path / "moodboards" / ".creates"
    folder.mkdir(parents=True)
    (folder / "draft-0008-aaaa.json").write_text(json.dumps({"id": "../../etc"}))
    (folder / "draft-0008-bbbb.json").write_text("not json")

    one, made_one = MoodboardStore().create_once(name="Dusk", requestId="draft-0008-aaaa")
    two, made_two = MoodboardStore().create_once(name="Dusk", requestId="draft-0008-bbbb")

    assert made_one and made_two and one["id"] != two["id"]


# -- agents: the client, MCP and the CLI ----------------------------------------------

@pytest.fixture
def api(told, monkeypatch):
    import main as main_module

    test_http = TestClient(main_module.app)
    client = NebulaClient("http://testserver")
    client._client = test_http
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=test_http))
    return client


def test_the_client_sends_the_id_only_when_given_one():
    sent: list[dict] = []

    class Api:
        def request(self, method, path, json=None, headers=None):
            sent.append(json)
            return {"id": "b1", "images": []}

    boards.create_board(Api(), "Dusk", [], project="none")
    boards.create_board(Api(), "Dusk", [], project="none", request_id="agent-run-0001")

    # An older Nebula refuses fields it doesn't know, so a create without an
    # id sends exactly what it always did.
    assert "requestId" not in sent[0]
    assert sent[1]["requestId"] == "agent-run-0001"


def test_mcp_create_sent_again_with_its_id_makes_one_board(api, tmp_path):
    first = asyncio.run(mcp_server.moodboard_create("Agent board", [], request_id="agent-run-0002"))
    again = asyncio.run(mcp_server.moodboard_create("Agent board", [], request_id="agent-run-0002"))
    plain = asyncio.run(mcp_server.moodboard_create("Agent board", []))

    assert again["id"] == first["id"] and plain["id"] != first["id"]
    assert _boards_on_disk(tmp_path) == sorted([first["id"], plain["id"]])


def test_cli_new_with_a_request_id_run_twice_makes_one_board(api, tmp_path, capsys):
    made = []
    moodboard_cmd.run(api, build_parser().parse_args(["moodboard", "new", "CLI board", "--request-id", "cli-run-0003"]))
    made.append(re.search(r"Made CLI board \((\w+)\)", capsys.readouterr().out).group(1))
    moodboard_cmd.run(api, build_parser().parse_args(["moodboard", "new", "CLI board", "--request-id", "cli-run-0003"]))
    made.append(re.search(r"already made by an earlier call with this request id\. Its id is (\w+),",
                          capsys.readouterr().out).group(1))
    moodboard_cmd.run(api, build_parser().parse_args(["moodboard", "new", "CLI board"]))
    plain = re.search(r"Made CLI board \((\w+)\)", capsys.readouterr().out).group(1)

    assert made[0] == made[1] != plain
    assert _boards_on_disk(tmp_path) == sorted([made[0], plain])


def test_cli_help_says_what_the_request_id_does():
    parser = build_parser()
    action = next(a for a in parser._actions if a.__class__.__name__ == "_SubParsersAction")
    new = action.choices["moodboard"]._actions[-1].choices["new"]
    option = next(a for a in new._actions if "--request-id" in a.option_strings)
    assert "same id" in option.help and option.default is None
    assert "new id for each board" in option.help and "another project is refused" in option.help


# -- round 6g: attempts, the write order, scope, expiry and purge ----------------------

def _record(tmp_path: Path, request_id: str) -> dict:
    return json.loads((tmp_path / "moodboards" / ".creates" / f"{request_id}.json").read_text())


def _write_record(tmp_path: Path, request_id: str, data) -> None:
    folder = tmp_path / "moodboards" / ".creates"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{request_id}.json").write_text(json.dumps(data))


def test_the_record_says_which_attempt_made_the_board_and_at_which_version(http, tmp_path):
    first = http.post("/api/moodboards", json={"name": "Dusk", "requestId": "draft-6g01-aaaa", "attempt": 1})
    assert first.status_code == 200, first.text
    board = first.json()
    record = _record(tmp_path, "draft-6g01-aaaa")
    assert {key: record[key] for key in ("id", "attempt", "version", "projectId", "state")} == {
        "id": board["id"], "attempt": 1, "version": 1, "projectId": None, "state": "made"}
    assert abs(record["at"] - time.time()) < 60
    assert "madeAttempt" not in board and "madeVersion" not in board

    renamed = http.put(f"/api/moodboards/{board['id']}", json={"name": "Rivers"}).json()
    again = http.post("/api/moodboards", json={"name": "Dusk", "requestId": "draft-6g01-aaaa", "attempt": 3})

    assert again.status_code == 200, again.text
    body = again.json()
    assert body["repeated"] is True and body["id"] == board["id"]
    # Which attempt made it, and at which version: not this send's.
    assert body["madeAttempt"] == 1 and body["madeVersion"] == 1
    assert body["version"] == renamed["version"] and body["name"] == "Rivers"
    # The repeat leaves the record as the making attempt wrote it.
    assert _record(tmp_path, "draft-6g01-aaaa")["attempt"] == 1


def test_an_agent_repeat_has_no_attempt(http):
    first = _post(http, "agent-6g02-aaaa").json()
    again = _post(http, "agent-6g02-aaaa").json()
    assert again["id"] == first["id"] and again["madeAttempt"] is None and again["madeVersion"] == 1


@pytest.mark.parametrize("attempt", [0, 1_000_001, -1, True, False, 1.5, 2.0, "2", [1], {"n": 1}])
def test_a_bad_attempt_is_refused_by_name(http, tmp_path, attempt):
    response = http.post("/api/moodboards", json={"name": "Dusk", "requestId": "draft-6g03-aaaa", "attempt": attempt})

    assert response.status_code == 422
    assert response.json()["detail"] == "attempt must be a whole number from 1 to 1000000"
    assert _boards_on_disk(tmp_path) == []
    assert not (tmp_path / "moodboards" / ".creates" / "draft-6g03-aaaa.json").exists()


@pytest.mark.parametrize("attempt", [1, 1_000_000])
def test_the_attempt_bounds_are_taken(http, attempt):
    response = http.post("/api/moodboards", json={"name": "Dusk", "requestId": f"draft-6g04-{attempt}", "attempt": attempt})
    assert response.status_code == 200, response.text


def test_an_attempt_without_a_request_id_is_refused(http, tmp_path):
    response = http.post("/api/moodboards", json={"name": "Dusk", "attempt": 1})

    assert response.status_code == 422
    assert "attempt" in response.json()["detail"] and "requestId" in response.json()["detail"]
    assert _boards_on_disk(tmp_path) == []


def test_an_eight_character_id_is_the_shortest_taken(http):
    assert _post(http, "abcdefgh").status_code == 200
    assert _post(http, "x" * 128).status_code == 200


def test_the_record_is_written_pending_before_the_board(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    make = MoodboardStore._create
    seen: list[dict] = []

    def watch(self, *args, **kwargs):
        # When the board is about to be written, its record already names it.
        seen.append(_record(tmp_path, "draft-6g05-aaaa"))
        return make(self, *args, **kwargs)

    monkeypatch.setattr(MoodboardStore, "_create", watch)
    board, made = MoodboardStore().create_once(name="Dusk", requestId="draft-6g05-aaaa", attempt=2)

    assert made is True
    assert seen[0]["state"] == "pending" and seen[0]["id"] == board["id"] and seen[0]["attempt"] == 2
    assert _record(tmp_path, "draft-6g05-aaaa")["state"] == "made"


def test_a_failed_record_write_makes_no_board(tmp_path, monkeypatch):
    """P2 of review 9: the record goes first, so a write that fails leaves
    nothing behind, and the resend makes the one board."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    real = moodboard_store._write_record
    calls = {"n": 0}

    def flaky(path, record):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("disk full")
        return real(path, record)

    monkeypatch.setattr(moodboard_store, "_write_record", flaky)
    with pytest.raises(OSError):
        MoodboardStore().create_once(name="Dusk", requestId="flaky-6g06-aaaa")
    assert _boards_on_disk(tmp_path) == []

    board, made = MoodboardStore().create_once(name="Dusk", requestId="flaky-6g06-aaaa")
    assert made is True and _boards_on_disk(tmp_path) == [board["id"]]


def test_a_crash_before_the_record_is_finalized_still_finds_the_board(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    # Step 4 never runs (a crash right after the board was written).
    monkeypatch.setattr(moodboard_store, "_finalize_record", lambda path, record: None)
    board, made = MoodboardStore().create_once(name="Dusk", requestId="crash-6g07-aaaa", attempt=1)
    assert made is True and _record(tmp_path, "crash-6g07-aaaa")["state"] == "pending"
    monkeypatch.undo()
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))

    again, made_again = MoodboardStore().create_once(name="Dusk", requestId="crash-6g07-aaaa", attempt=2)

    assert made_again is False and again["id"] == board["id"]
    assert _boards_on_disk(tmp_path) == [board["id"]]
    record = _record(tmp_path, "crash-6g07-aaaa")
    assert record["state"] == "made" and record["attempt"] == 1


def test_a_failed_finalize_still_answers_the_board_it_made(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    real = moodboard_store._write_record

    def no_second_write(path, record):
        if record.get("state") == "made":
            raise OSError("disk full")
        return real(path, record)

    monkeypatch.setattr(moodboard_store, "_write_record", no_second_write)
    board, made = MoodboardStore().create_once(name="Dusk", requestId="final-6g08-aaaa")

    assert made is True and _record(tmp_path, "final-6g08-aaaa")["state"] == "pending"
    again, made_again = MoodboardStore().create_once(name="Dusk", requestId="final-6g08-aaaa")
    assert made_again is False and again["id"] == board["id"]


def test_a_failed_board_write_leaves_no_record(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    real = moodboard_store._write_json

    def no_board(path, data):
        if path.parent.name == "_global":
            raise OSError("disk full")
        return real(path, data)

    monkeypatch.setattr(moodboard_store, "_write_json", no_board)
    with pytest.raises(OSError):
        MoodboardStore().create_once(name="Dusk", requestId="board-6g09-aaaa")
    assert not (tmp_path / "moodboards" / ".creates" / "board-6g09-aaaa.json").exists()
    monkeypatch.setattr(moodboard_store, "_write_json", real)

    board, made = MoodboardStore().create_once(name="Dusk", requestId="board-6g09-aaaa")
    assert made is True and _boards_on_disk(tmp_path) == [board["id"]]


def test_a_refused_create_leaves_no_record(http, tmp_path):
    response = http.post("/api/moodboards", json={"name": "  ", "requestId": "empty-6g10-aaaa"})
    assert response.status_code == 422
    assert not (tmp_path / "moodboards" / ".creates" / "empty-6g10-aaaa.json").exists()


def test_a_pending_record_naming_no_board_is_overwritten(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    _write_record(tmp_path, "left-6g11-aaaa", {"id": "aaaaaaaaaaaa", "attempt": 1, "version": 1,
                                               "projectId": None, "state": "pending", "at": time.time()})

    board, made = MoodboardStore().create_once(name="Dusk", requestId="left-6g11-aaaa", attempt=2)

    assert made is True and board["id"] != "aaaaaaaaaaaa"
    record = _record(tmp_path, "left-6g11-aaaa")
    assert record["id"] == board["id"] and record["attempt"] == 2 and record["state"] == "made"


@pytest.mark.parametrize("data", [{"id": 5}, [1, 2], ["id"], "a string", 7, None, {"id": "../../etc"},
                                  {"id": "aaaaaaaaaaaa"}, {"id": "aaaaaaaaaaaa", "at": "yesterday"},
                                  {"id": "aaaaaaaaaaaa", "at": True},
                                  {"id": "aaaaaaaaaaaa", "at": "NOW", "projectId": 5}])
def test_a_malformed_record_never_breaks_the_create(http, tmp_path, data):
    """R4 and R5 of review 9: a record whose id isn't a string, or that holds
    a JSON list, is ignored (no 500)."""
    first = _post(http, None).json()  # a live board the record might name
    if isinstance(data, dict) and data.get("id") == "aaaaaaaaaaaa":
        data = {**data, "id": first["id"]}
        if data.get("at") == "NOW":
            data["at"] = time.time()
    _write_record(tmp_path, "junk-6g12-aaaa", data)

    response = _post(http, "junk-6g12-aaaa")

    assert response.status_code == 200, response.text
    assert response.json()["id"] != first["id"] and "repeated" not in response.json()


def test_a_request_id_from_another_project_is_refused(http, tmp_path, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "_require_canvas_project", lambda project_id: None)
    made = http.post("/api/moodboards", json={"name": "A", "projectId": "projA", "requestId": "shared-6g13-a"})
    assert made.status_code == 200, made.text

    for other in ({"projectId": "projB"}, {}, {"projectId": None}, {"projectId": ""}):
        refused = http.post("/api/moodboards", json={"name": "B", "requestId": "shared-6g13-a", **other})
        assert refused.status_code == 409, refused.text
        assert refused.json() == {
            "detail": "This request id already made a board in another project (or in Global). "
                      "Use a new request id for this board.",
            "code": "request_id_scope"}
        assert made.json()["id"] not in refused.text and "projA" not in refused.text

    # Same scope: the repeat.
    again = http.post("/api/moodboards", json={"name": "A", "projectId": "projA", "requestId": "shared-6g13-a"})
    assert again.status_code == 200 and again.json()["id"] == made.json()["id"] and again.json()["repeated"] is True
    # And the other way: Global first, then a project.
    _post(http, "shared-6g13-b")
    refused = http.post("/api/moodboards", json={"name": "B", "projectId": "projA", "requestId": "shared-6g13-b"})
    assert refused.status_code == 409 and refused.json()["code"] == "request_id_scope"
    assert sorted(path.name for path in (tmp_path / "moodboards").iterdir() if not path.name.startswith(".")) == [
        "_global", "projA"]
    assert len(list((tmp_path / "moodboards" / "projA").glob("*.json"))) == 1
    assert len(_boards_on_disk(tmp_path)) == 1


def test_an_empty_project_id_is_global_for_the_repeat(tmp_path, monkeypatch):
    # The route refuses "" (400), but the store reads it as Global, as _scope_dir does.
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    first, _ = MoodboardStore().create_once(name="Dusk", requestId="empty-6g28-aaaa")
    again, made = MoodboardStore().create_once(name="Dusk", projectId="", requestId="empty-6g28-aaaa")
    assert made is False and again["id"] == first["id"]
    other, made_other = MoodboardStore().create_once(name="Dusk", projectId="", requestId="empty-6g28-bbbb")
    again, made = MoodboardStore().create_once(name="Dusk", requestId="empty-6g28-bbbb")
    assert made_other is True and made is False and again["id"] == other["id"]


def test_the_store_refuses_another_scope(tmp_path, monkeypatch):
    """P1 of review 9: never the other scope's board."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    MoodboardStore().create_once(name="A", projectId="projA", requestId="shared-6g14-a")
    with pytest.raises(moodboard_store.RequestIdOtherScope):
        MoodboardStore().create_once(name="B", projectId="projB", requestId="shared-6g14-a")


def test_a_gone_board_from_another_scope_does_not_block_the_id(http, tmp_path, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "_require_canvas_project", lambda project_id: None)
    first = http.post("/api/moodboards", json={"name": "A", "projectId": "projA", "requestId": "gone-6g15-aaaa"}).json()
    assert http.delete(f"/api/moodboards/{first['id']}").status_code == 200

    again = _post(http, "gone-6g15-aaaa")
    assert again.status_code == 200 and again.json()["id"] != first["id"] and "repeated" not in again.json()


def test_a_corrupt_board_behind_a_record_is_a_plain_500(http, tmp_path):
    """NIT-1 / P4 of review 9: never the JSON parser's words."""
    first = _post(http, "corrupt-6g16-a").json()
    (tmp_path / "moodboards" / "_global" / f"{first['id']}.json").write_text("{not json")

    again = _post(http, "corrupt-6g16-a")

    assert again.status_code == 500
    assert again.json() == {"detail": "Nebula couldn't read the board this request id made. Use a new request id."}
    assert "Expecting" not in again.text and "line 1" not in again.text
    # A board file that holds a list reads the same.
    (tmp_path / "moodboards" / "_global" / f"{first['id']}.json").write_text("[1]")
    assert _post(http, "corrupt-6g16-a").status_code == 500


def test_a_record_older_than_seven_days_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board, _ = MoodboardStore().create_once(name="Dusk", requestId="old-6g17-aaaa")
    record = _record(tmp_path, "old-6g17-aaaa")
    assert moodboard_store.CREATE_RECORD_DAYS == 7 and moodboard_store.CREATE_RECORD_TTL == 7 * 24 * 3600

    _write_record(tmp_path, "old-6g17-aaaa", {**record, "at": time.time() - 6.9 * 24 * 3600})
    assert MoodboardStore().create_once(name="Dusk", requestId="old-6g17-aaaa") == (
        MoodboardStore().get(board["id"]), False)

    _write_record(tmp_path, "old-6g17-aaaa", {**record, "at": time.time() - 7.1 * 24 * 3600})
    newer, made = MoodboardStore().create_once(name="Dusk", requestId="old-6g17-aaaa")
    assert made is True and newer["id"] != board["id"]


def test_old_and_unreadable_records_are_pruned(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    now = time.time()
    fresh = {"id": "aaaaaaaaaaaa", "attempt": None, "version": 1, "projectId": None, "state": "made", "at": now - 3600}
    _write_record(tmp_path, "fresh-6g18-aaaa", fresh)
    _write_record(tmp_path, "edge-6g18-aaaa", {**fresh, "at": now - 6.99 * 24 * 3600})
    _write_record(tmp_path, "stale-6g18-aaaa", {**fresh, "at": now - 8 * 24 * 3600})
    _write_record(tmp_path, "junk-6g18-aaaa", [1])
    folder = tmp_path / "moodboards" / ".creates"
    (folder / "half-6g18-aaaa.json.tmp").write_text("{")
    os.utime(folder / "half-6g18-aaaa.json.tmp", (now - 7200, now - 7200))
    (folder / "busy-6g18-aaaa.json.tmp").write_text("{")

    assert moodboard_store.prune_create_records(now=now) == 3

    assert sorted(path.name for path in folder.iterdir()) == [
        "busy-6g18-aaaa.json.tmp", "edge-6g18-aaaa.json", "fresh-6g18-aaaa.json"]


def test_startup_prunes_old_records(told, tmp_path):
    import main as main_module

    _write_record(tmp_path, "stale-6g19-aaaa", {"id": "aaaaaaaaaaaa", "state": "made", "at": time.time() - 30 * 24 * 3600})
    asyncio.run(main_module._moodboard_brief_fields_startup())
    assert not (tmp_path / "moodboards" / ".creates" / "stale-6g19-aaaa.json").exists()


def test_a_create_prunes_at_most_once_a_day(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setattr(moodboard_store, "_last_prune", 0.0)
    _write_record(tmp_path, "stale-6g20-aaaa", {"id": "aaaaaaaaaaaa", "state": "made", "at": time.time() - 30 * 24 * 3600})
    MoodboardStore().create_once(name="Dusk", requestId="new-6g20-aaaa")
    assert not (tmp_path / "moodboards" / ".creates" / "stale-6g20-aaaa.json").exists()

    _write_record(tmp_path, "stale-6g20-bbbb", {"id": "aaaaaaaaaaaa", "state": "made", "at": time.time() - 30 * 24 * 3600})
    MoodboardStore().create_once(name="Dusk", requestId="new-6g20-bbbb")
    # Pruned an instant ago: the next is a day away.
    assert (tmp_path / "moodboards" / ".creates" / "stale-6g20-bbbb.json").exists()


def test_purging_a_board_removes_its_records(http, tmp_path):
    keep = _post(http, "keep-6g21-aaaa").json()
    doomed = _post(http, "doomed-6g21-aa").json()
    # A second record naming the same board (an id reused after a restore
    # can't happen, but a pending one left behind can).
    _write_record(tmp_path, "doomed-6g21-bb", {**_record(tmp_path, "doomed-6g21-aa"), "state": "pending"})
    assert http.delete(f"/api/moodboards/{doomed['id']}").status_code == 200
    # In Recently deleted the record stays (a restore brings the same id back).
    assert (tmp_path / "moodboards" / ".creates" / "doomed-6g21-aa.json").exists()

    MoodboardStore().purge(doomed["id"])

    assert sorted(path.name for path in (tmp_path / "moodboards" / ".creates").iterdir()) == ["keep-6g21-aaaa.json"]
    assert _post(http, "keep-6g21-aaaa").json()["id"] == keep["id"]


def test_purging_through_the_trash_route_removes_its_records(http, tmp_path, person):
    from tests.conftest import PERSON

    doomed = _post(http, "doomed-6g22-aa").json()
    assert http.delete(f"/api/moodboards/{doomed['id']}").status_code == 200
    purged = http.delete(f"/api/trash/moodboard/{doomed['id']}", headers=PERSON)
    assert purged.status_code == 200, purged.text
    assert not (tmp_path / "moodboards" / ".creates" / "doomed-6g22-aa.json").exists()


def test_a_repeat_answers_what_a_get_answers(http):
    """R6 of review 9: the repeat is the board as GET shows it (brief,
    outsideImages and the rest), plus the repeat's own fields."""
    first = _post(http, "get-6g23-aaaa", urls=stored_image_urls(2, name="get")).json()
    again = _post(http, "get-6g23-aaaa").json()
    shown = http.get(f"/api/moodboards/{first['id']}").json()

    assert {key: again[key] for key in ("repeated", "madeAttempt", "madeVersion")} == {
        "repeated": True, "madeAttempt": None, "madeVersion": 1}
    assert {key: value for key, value in again.items() if key not in ("repeated", "madeAttempt", "madeVersion")} == shown
    assert "brief" in again


# -- the scans, exports and imports leave .creates alone -----------------------------

def test_the_commons_import_and_the_project_rehome_skip_the_records(tmp_path, monkeypatch):
    from commons import intake
    from services import asset_project_rehome

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board, _ = MoodboardStore().create_once(name="Dusk", requestId="scan-6g24-aaaa")
    # A record that looks like a board to a careless reader.
    _write_record(tmp_path, "scan-6g24-bbbb", {**board, "at": time.time()})
    root = tmp_path / "moodboards"

    assert [row["id"] for row in intake._moodboards()] == [board["id"]]
    assert root / ".creates" not in asset_project_rehome._legacy_folders(root, set())
    assert [row["id"] for row in MoodboardStore().list("global")] == [board["id"]]
    assert moodboard_store._find_moodboard_file(root, "scan-6g24-bbbb") is None


# -- agents: a repeat says so --------------------------------------------------------

def test_the_client_sends_an_empty_id_through_so_nebula_refuses_it(api, tmp_path):
    """R7 of review 9: "" is sent, not dropped, so the create is refused
    instead of silently making a board with no id."""
    sent: list[dict] = []

    class Api:
        def request(self, method, path, json=None, headers=None):
            sent.append(json)
            return {"id": "b1", "images": []}

    boards.create_board(Api(), "Dusk", [], project="none", request_id="")
    assert sent[0]["requestId"] == ""

    with pytest.raises(Exception) as refused:
        boards.create_board(api.api, "Dusk", [], request_id="")
    assert "requestId" in str(refused.value)
    assert _boards_on_disk(tmp_path) == []


def test_the_client_skips_the_image_count_on_a_repeat(api, http, tmp_path):
    """P3 of review 9: the person added an image before the agent's retry."""
    urls = stored_image_urls(2, name="p3")
    first = asyncio.run(mcp_server.moodboard_create("Agent", [urls[0]], request_id="agent-6g25-aaaa"))
    put = http.put(f"/api/moodboards/{first['id']}", json={"images": [{"url": urls[0]}, {"url": urls[1]}]})
    assert put.status_code == 200, put.text

    again = asyncio.run(mcp_server.moodboard_create("Agent", [urls[0]], request_id="agent-6g25-aaaa"))

    assert again["id"] == first["id"] and len(again["images"]) == 2
    assert again["repeated"] is True
    assert again["note"] == "Board “Agent” was already made by an earlier call with this request id."
    assert "repeated" not in first and "note" not in first


def test_the_client_still_checks_the_count_on_a_made_board(monkeypatch):
    monkeypatch.setattr(boards, "source_urls", lambda api, sources, **_: ["/api/outputs/a.png"])

    class Api:
        def request(self, method, path, json=None, headers=None):
            return {"id": "b1", "images": []}

    with pytest.raises(boards.MoodboardError, match="saved 0 of 1"):
        boards.create_board(Api(), "Dusk", ["/api/outputs/a.png"], project="none")


def test_brief_carries_repeated_only_when_it_is_true():
    assert boards.brief({"id": "b1", "repeated": True})["repeated"] is True
    assert "repeated" not in boards.brief({"id": "b1"})
    assert "repeated" not in boards.brief({"id": "b1", "repeated": "yes"})


def test_mcp_repeat_returns_the_first_board_whatever_the_name(api, tmp_path):
    first = asyncio.run(mcp_server.moodboard_create("First", [], request_id="agent-6g26-aaaa"))
    again = asyncio.run(mcp_server.moodboard_create("Second name", [], request_id="agent-6g26-aaaa"))

    assert again["id"] == first["id"] and again["name"] == "First"
    assert again["note"] == "Board “First” was already made by an earlier call with this request id."


def test_cli_new_says_a_repeat_was_already_made(api, capsys):
    """P5 of review 9: never "Made" for a board this run didn't make."""
    moodboard_cmd.run(api, build_parser().parse_args(["moodboard", "new", "First", "--request-id", "cli-6g27-aaaa"]))
    first = re.search(r"Made First \((\w+)\)", capsys.readouterr().out).group(1)
    moodboard_cmd.run(api, build_parser().parse_args(["moodboard", "new", "Second name", "--request-id", "cli-6g27-aaaa"]))
    out = capsys.readouterr().out

    assert out.startswith("Board “First” was already made by an earlier call with this request id. ")
    assert f"Its id is {first}, with 0 images." in out and "Made" not in out and "Second name" not in out

    moodboard_cmd.run(api, build_parser().parse_args(
        ["moodboard", "new", "Second name", "--request-id", "cli-6g27-aaaa", "--json"]))
    shown = json.loads(capsys.readouterr().out)
    assert shown["id"] == first and shown["repeated"] is True


def test_the_agent_docs_say_a_reused_id_returns_the_first_board():
    doc = " ".join((mcp_server.moodboard_create.__doc__ or "").split())
    assert "new id for each board" in doc and "whatever the" in doc and "another project" in doc
    client_doc = " ".join((boards.create_board.__doc__ or "").split())
    assert "new id for each board" in client_doc and "another project" in client_doc
    repo = BACKEND.parent
    for path in (repo / "docs" / "MCP-SETUP.md", repo / "skills" / "nebula" / "SKILL.md"):
        text = " ".join(path.read_text(encoding="utf-8").split())
        assert "request_id_scope" in text and "new id for each board" in text, path
