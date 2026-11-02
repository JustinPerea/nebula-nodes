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

    async def ignore(data):
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


@pytest.mark.parametrize("request_id", ["short", "has space here", "a/b/../c-d-e", "x" * 129, 12345678, True])
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
    for _ in range(2):
        moodboard_cmd.run(api, build_parser().parse_args(["moodboard", "new", "CLI board", "--request-id", "cli-run-0003"]))
        made.append(re.search(r"Made CLI board \((\w+)\)", capsys.readouterr().out).group(1))
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
