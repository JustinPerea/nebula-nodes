"""PR #203 round 16: GM r30.

Item 1: every refused run the person sees in the Agent log reads the merged
line, whoever asked for it (an MCP agent, a CLI agent, an in-app chat turn),
and the log lists it once. The agents' own text keeps every node by id.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
from commons.actors import agent_registry
from services import agent_presence
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture

HEADING = "Nebula couldn’t start the run."
MCP = {"X-Nebula-Agent": "Claude Code"}
CLI = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Surface": "cli"}
TTS = "openai-tts"
GPT = "gpt-image-2-generate"


@pytest.fixture
def chat_turn():
    """An in-app chat turn's agent: its own token, as the chat's runner."""
    token = agent_registry.mint("claude", [], session="chat-r16")
    yield {"Authorization": f"Agent {token}"}
    agent_registry.revoke(token)


def _refused(monkeypatch, definitions: list[str], headers: dict[str, str],
             lines: list[str]) -> tuple[dict, list[str], list[str]]:
    """Run a canvas whose nodes can't run here; the reply, the node ids and
    what the Agent log listed for the run (before the canvas is cleared)."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            prompt = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "x"}}).json()["id"]
            ids = []
            for definition in definitions:
                node = client.post("/api/graph/node", json={"definitionId": definition, "params": {}}).json()["id"]
                handle = "text" if definition == TTS else "prompt"
                client.post("/api/graph/connect", json={"source": prompt, "sourceHandle": "text",
                                                        "target": node, "targetHandle": handle})
                ids.append(node)
            lines.clear()
            body = client.post("/api/graph/run", json={}, headers=headers).json()
            return body, ids, list(lines)
        finally:
            client.delete("/api/graph?force=true")


CASES = [
    ([GPT, TTS], f"{HEADING} “GPT Image 2” and “OpenAI TTS” need your OpenAI API key. "
                 "Add it in Settings, then run the nodes again."),
    ([GPT, GPT, TTS], f"{HEADING} 2 “GPT Image 2” nodes and “OpenAI TTS” need your OpenAI API key. "
                      "Add it in Settings, then run the nodes again."),
    ([GPT, GPT, GPT, TTS], f"{HEADING} 4 nodes can’t run here yet."),
]
CASE_IDS = ["two-names-one-reason", "same-name-group", "counted-from-4"]


@pytest.mark.parametrize("definitions,line", CASES, ids=CASE_IDS)
@pytest.mark.parametrize("who", ["mcp", "cli", "chat"])
def test_every_refused_run_is_one_merged_line_in_the_agent_log(monkeypatch, agent_log, chat_turn,  # noqa: F811
                                                               who, definitions, line):
    headers = {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]
    body, ids, said = _refused(monkeypatch, definitions, headers, agent_log)
    assert body["status"] == "failed" and body["nodesExecuted"] == 0
    # The log lists the run once, in the merged words, never a node's own line.
    assert said == [line]
    # The agents' own text keeps every node by id.
    assert set(body["errors"]) == set(ids)
    assert all(node_id in body["error"] for node_id in ids)
    assert "Missing API key: OPENAI_API_KEY" in body["error"]


def test_the_cursor_still_points_at_the_first_node_with_its_own_line(monkeypatch):
    sent: list[dict] = []
    original = main.manager.broadcast_raw

    async def heard(data, **kwargs):
        sent.append(data)
        await original(data, **kwargs)

    monkeypatch.setattr(main.manager, "broadcast_raw", heard)
    _, ids, _ = _refused(monkeypatch, [GPT, TTS], MCP, [])
    [event] = [e for e in sent if e.get("type") == "agentPresence"]
    assert event["target"] == {"nodeId": ids[0]}
    assert event["say"] == "“GPT Image 2” can’t run. Add your OpenAI API key in Settings, then run the node again."
    assert event["log"] == (f"{HEADING} “GPT Image 2” and “OpenAI TTS” need your OpenAI API key. "
                            "Add it in Settings, then run the nodes again.")


def test_a_refused_run_with_no_agent_name_goes_to_an_in_app_chat_turn_once(monkeypatch, agent_log):  # noqa: F811
    """No cursor to carry it (a caller with no agent name): the chat turn's
    log gets it, still once."""
    _, _, said = _refused(monkeypatch, [GPT, TTS], {}, agent_log)
    assert said == [f"{HEADING} “GPT Image 2” and “OpenAI TTS” need your OpenAI API key. "
                         "Add it in Settings, then run the nodes again."]


def test_an_agents_refused_execute_node_reads_the_same_line(monkeypatch, agent_log):  # noqa: F811
    """Every run route's refusal goes through the one announcer."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {}})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            prompt = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "x"}}).json()["id"]
            image = client.post("/api/graph/node", json={"definitionId": GPT, "params": {}}).json()["id"]
            client.post("/api/graph/connect", json={"source": prompt, "sourceHandle": "text",
                                                    "target": image, "targetHandle": "prompt"})
            graph = client.get("/api/graph").json()
            agent_log.clear()
            body = client.post("/api/execute-node", headers=MCP, json={
                "nodes": [{"id": n["id"], "definitionId": n["definitionId"], "params": n.get("params") or {}}
                          for n in graph["nodes"]],
                "edges": [{"id": e.get("id") or f"{e['source']}-{e['target']}", "source": e["source"],
                           "sourceHandle": e["sourceHandle"], "target": e["target"], "targetHandle": e["targetHandle"]}
                          for e in graph["edges"]],
                "targetNodeId": image}).json()
            said = list(agent_log)
            assert body.get("errors") or body.get("validationErrors") or body.get("detail"), body
            assert said == [f"{HEADING} “GPT Image 2” needs your OpenAI API key. "
                                 "Add it in Settings, then run the node again."]
        finally:
            client.delete("/api/graph?force=true")


def test_the_log_line_has_room_for_three_reasons():
    """A bubble is cut at MAX_SAY_CHARS; the log's line isn't."""
    line = (f"{HEADING} “Writer” needs your Anthropic API key. Add it in Settings, then run the node again. "
            "“Nano Banana” needs your Gemini API key. Add it in Settings, then run the node again. "
            "“FLUX.2” needs your Black Forest Labs or fal.ai API key. Add one in Settings, then run the node again.")
    assert len(line) > agent_presence.MAX_SAY_CHARS
    assert agent_presence.clean_log(line) == line
    assert len(agent_presence.clean_log("x" * 5000)) == agent_presence.MAX_LOG_CHARS


def test_a_long_log_line_is_kept_when_its_start_is_the_bubble(monkeypatch):
    """The event drops ``log`` only when it is the bubble's own words, compared
    at the log's own length: a line past MAX_SAY_CHARS whose start is the
    bubble still reaches the log whole."""
    import asyncio

    sent: list[dict] = []

    async def heard(data, **kwargs):
        sent.append(data)

    monkeypatch.setattr(main.manager, "broadcast_raw", heard)
    line = f"{HEADING} " + "“Writer” needs your Anthropic API key. Add it in Settings, then run the node again. " * 3
    bubble = line[:agent_presence.MAX_SAY_CHARS]
    with agent_presence.request_headers_scope(MCP):
        asyncio.run(main._show_agent({"nodeId": "n1"}, say=bubble, log=line))
    [event] = sent
    assert event["say"] == agent_presence.clean_say(bubble)
    assert event["log"] == agent_presence.clean_log(line)
    assert len(event["log"]) > agent_presence.MAX_SAY_CHARS


# -- section 2, review 15 (settings-keychain): every way a save can write ------------------------
# Atomic where that is safe, in place where it isn't, refused only when
# neither way can write, with the line naming the real cause (GM r31 items 1
# and 2).

import errno  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402

import services.settings as settings  # noqa: E402
from tests.test_idol_round10 import sockets  # noqa: E402,F401 - fixture
from tests.test_idol_round12 import _person  # noqa: E402
from tests.test_idol_round15 import _refused as _refusal
from tests.test_idol_round15 import PERSON_LINE, SAVED, home_file  # noqa: E402,F401 - fixture

FOLDER = f"~{os.sep}.nebula"
FOLDER_LINE = (f"Nothing was saved because Nebula isn’t allowed to change {FOLDER}. "
               "Check the folder’s permissions, then try again.")
NOT_A_FOLDER_LINE = (f"Nothing was saved because {FOLDER} is a file, and Nebula needs a folder there. "
                     "Move or rename that file, then try again.")


def _put(client=None):
    return (client or _person()).put("/api/settings", json={"favorites": ["saved"]})


def _saved(path):
    return json.loads(path.read_text(encoding="utf-8"))["favorites"]


def _left(folder):
    return sorted(p.name for p in folder.iterdir())


@pytest.mark.unprivileged
def test_a_writable_file_in_a_read_only_folder_saves_in_place(home_file):
    inode = home_file.stat().st_ino
    home_file.parent.chmod(0o555)
    try:
        assert _put().status_code == 200
        assert client_delete_ok()
    finally:
        home_file.parent.chmod(0o755)
    assert _saved(home_file) == ["saved"] and home_file.stat().st_ino == inode
    assert "FAL_KEY" not in json.loads(home_file.read_text(encoding="utf-8"))["apiKeys"]
    assert _left(home_file.parent) == ["settings.json"]


def client_delete_ok():
    return _person().delete("/api/settings/api-keys/FAL_KEY").status_code == 200


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS ACLs (chmod +a)")
def test_an_acl_that_denies_delete_saves_in_place_and_keeps_the_acl(home_file):
    subprocess.run(["chmod", "+a", "everyone deny delete", str(home_file)], check=True)
    try:
        inode = home_file.stat().st_ino
        assert _put().status_code == 200
        assert _saved(home_file) == ["saved"] and home_file.stat().st_ino == inode
        listed = subprocess.run(["ls", "-le", str(home_file)], capture_output=True, text=True, check=True).stdout
        assert "deny delete" in listed
    finally:
        subprocess.run(["chmod", "-N", str(home_file)], check=True)
    assert _left(home_file.parent) == ["settings.json"]


def test_a_symlinked_settings_path_writes_through_to_its_target(home_file, tmp_path, monkeypatch):
    target = tmp_path / "elsewhere" / "real.json"
    target.parent.mkdir()
    shutil.copy(home_file, target)
    link = tmp_path / "home" / ".nebula" / "link.json"
    link.symlink_to(target)
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(link))
    assert _put().status_code == 200
    assert link.is_symlink() and os.readlink(link) == str(target)
    assert _saved(target) == ["saved"]


def test_a_hard_linked_file_is_written_in_place_so_both_names_keep_it(home_file, tmp_path):
    other = tmp_path / "other-name.json"
    os.link(home_file, other)
    assert _put().status_code == 200
    assert _saved(home_file) == _saved(other) == ["saved"]
    assert home_file.stat().st_ino == other.stat().st_ino


def _set_xattr(path, name, value):
    if hasattr(os, "setxattr"):
        os.setxattr(path, f"user.{name}", value)
    else:
        subprocess.run(["xattr", "-w", name, value.decode(), str(path)], check=True)


def _xattrs(path):
    if hasattr(os, "listxattr"):
        return [n.removeprefix("user.") for n in os.listxattr(path)]
    return subprocess.run(["xattr", str(path)], capture_output=True, text=True, check=True).stdout.split()


@pytest.mark.skipif(not hasattr(os, "setxattr") and not shutil.which("xattr"), reason="no xattr support")
def test_a_file_with_its_own_extended_attribute_is_written_in_place_and_keeps_it(home_file):
    _set_xattr(home_file, "nebula-tag", b"kept")
    inode = home_file.stat().st_ino
    assert _put().status_code == 200
    assert home_file.stat().st_ino == inode and "nebula-tag" in _xattrs(home_file)


def test_a_file_another_user_owns_or_with_two_names_is_never_replaced(home_file):
    real = home_file.stat()
    assert settings._replace_keeps_the_file(home_file, real)

    class Like:
        def __init__(self, **changed):
            self.__dict__.update({k: getattr(real, k) for k in ("st_mode", "st_nlink", "st_uid", "st_gid")}, **changed)

    assert not settings._replace_keeps_the_file(home_file, Like(st_uid=real.st_uid + 1))
    assert not settings._replace_keeps_the_file(home_file, Like(st_nlink=2))
    assert not settings._replace_keeps_the_file(home_file, Like(st_mode=stat.S_IFIFO | 0o644))


def test_a_plain_file_is_replaced_whole(home_file):
    """The safe case stays atomic: a new inode, the mode kept."""
    home_file.chmod(0o640)
    inode = home_file.stat().st_ino
    assert _put().status_code == 200
    assert home_file.stat().st_ino != inode and stat.S_IMODE(home_file.stat().st_mode) == 0o640


@pytest.mark.unprivileged
def test_a_read_only_file_is_refused_with_the_file_line(home_file):
    home_file.chmod(0o444)
    assert _refusal(_put()) == (409, PERSON_LINE, "settings_unwritable")


@pytest.mark.unprivileged
def test_a_read_only_file_in_a_read_only_folder_is_refused_with_the_file_line(home_file):
    before = home_file.read_bytes()
    home_file.chmod(0o444)
    home_file.parent.chmod(0o555)
    try:
        assert _refusal(_put()) == (409, PERSON_LINE, "settings_unwritable")
    finally:
        home_file.parent.chmod(0o755)
    assert home_file.read_bytes() == before


@pytest.mark.unprivileged
def test_no_file_in_a_read_only_folder_names_the_folder(home_file):
    home_file.unlink()
    home_file.parent.chmod(0o555)
    try:
        response = _put()
        assert _refusal(response) == (409, FOLDER_LINE, "settings_unwritable")
        assert response.json()["fix"] == f"Check the permissions of {FOLDER}, then try again."
    finally:
        home_file.parent.chmod(0o755)
    assert _left(home_file.parent) == []


def test_the_folder_lines_follow_gm_r31_for_each_reader():
    assert main.SETTINGS_FOLDER_UNWRITABLE == {
        "person": "Nothing was saved because Nebula isn’t allowed to change {folder}. "
                  "Check the folder’s permissions, then try again.",
        "agent": "Nothing was saved because Nebula isn’t allowed to change {folder}. "
                 "Ask the person to check the folder’s permissions.",
    }
    assert main.SETTINGS_NOT_A_FOLDER == {
        "person": "Nothing was saved because {folder} is a file, and Nebula needs a folder there. "
                  "Move or rename that file, then try again.",
        "agent": "Nothing was saved because {folder} is a file, and Nebula needs a folder there. "
                 "Ask the person to move or rename that file.",
    }


def test_a_missing_settings_folder_is_made_this_users_only_and_the_save_lands(home_file):
    shutil.rmtree(home_file.parent)
    assert _put().status_code == 200
    assert stat.S_IMODE(home_file.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(home_file.stat().st_mode) == 0o600
    assert _saved(home_file) == ["saved"]


@pytest.mark.unprivileged  # the scan can't prove a parametrized mode keeps access (it does)
@pytest.mark.parametrize("mode", [0o644, 0o755], ids=["plain-file", "executable-file"])
def test_a_file_where_the_folder_must_be_gets_its_own_409_never_a_500(home_file, mode):
    shutil.rmtree(home_file.parent)
    home_file.parent.write_text("a file, not a folder", encoding="utf-8")
    home_file.parent.chmod(mode)
    client = TestClient(main.app, raise_server_exceptions=False, headers=main_person_headers())
    for response in (_put(client), client.delete("/api/settings/api-keys/FAL_KEY")):
        assert _refusal(response) == (409, NOT_A_FOLDER_LINE, "settings_not_a_folder")
        assert response.json()["fix"] == f"Move or rename {FOLDER}, then try again."
    assert home_file.parent.read_text(encoding="utf-8") == "a file, not a folder"
    home_file.parent.unlink()
    home_file.parent.mkdir()


def main_person_headers():
    from tests.conftest import PERSON
    return PERSON


def test_a_desktop_key_save_works_with_a_read_only_settings_file(home_file, monkeypatch):
    """credentials/update keeps only the read check (review 15, MEDIUM-2);
    PUT still refuses."""
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {"OPENAI_API_KEY": "sk-desktop-0000"})
    monkeypatch.setattr(settings, "settings_write_block",
                        lambda: settings.SettingsUnwritable(errno.EACCES, "ro", home_file, "file"))
    monkeypatch.setattr(main, "settings_write_block", settings.settings_write_block)
    client = _person()
    assert client.post("/api/credentials/update", json={"provider": "FAL_KEY", "key": "fal-1", "check": True}).status_code == 200
    assert client.post("/api/credentials/update", json={"provider": "FAL_KEY", "key": "fal-1"}).status_code == 200
    assert settings._INJECTED_KEYS["FAL_KEY"] == "fal-1"
    assert _refusal(client.put("/api/settings", json={"favorites": []}))[::2] == (409, "settings_unwritable")


# -- the temp file: 0600, removed on any failure, swept at startup -------------------------------


@pytest.mark.parametrize("raised", [KeyboardInterrupt, RuntimeError, OSError])
def test_a_save_cut_short_after_the_temp_file_leaves_no_copy(home_file, monkeypatch, raised):
    before = home_file.read_bytes()

    def cut(_src, _dst):
        raise raised("cut short")

    monkeypatch.setattr(settings, "_replace", cut)
    with pytest.raises(raised):
        settings.save_settings({"apiKeys": {"FAL_KEY": "fal-secret-9999"}})
    assert _left(home_file.parent) == ["settings.json"]
    assert home_file.read_bytes() == before


def test_the_temp_file_is_this_users_only_while_it_holds_the_keys(home_file, monkeypatch):
    home_file.chmod(0o644)
    seen = []
    real = settings._replace

    def look(src, dst):
        seen.append(stat.S_IMODE(os.stat(src).st_mode))
        real(src, dst)

    monkeypatch.setattr(settings, "_replace", look)
    real_write = settings._write_atomically

    def spy(path, text, before):
        made = settings.tempfile.mkstemp

        def mkstemp(**kwargs):
            fd, name = made(**kwargs)
            seen.append(("made", stat.S_IMODE(os.stat(name).st_mode)))
            return fd, name

        real_fsync = settings.os.fsync

        def fsync(fd):  # the keys are written by now: the temp file's mode while it holds them
            seen.append(("written", stat.S_IMODE(os.fstat(fd).st_mode)))
            real_fsync(fd)

        monkeypatch.setattr(settings.tempfile, "mkstemp", mkstemp)
        monkeypatch.setattr(settings.os, "fsync", fsync)
        try:
            real_write(path, text, before)
        finally:
            monkeypatch.setattr(settings.tempfile, "mkstemp", made)
            monkeypatch.setattr(settings.os, "fsync", real_fsync)

    monkeypatch.setattr(settings, "_write_atomically", spy)
    settings.save_settings({"favorites": []})
    assert seen == [("made", 0o600), ("written", 0o600), 0o644]


def test_stale_temp_files_beside_the_settings_are_swept_at_startup(home_file):
    folder = home_file.parent
    old = folder / ".settings-abc123.tmp"
    old.write_text(json.dumps(SAVED), encoding="utf-8")
    fresh = folder / ".settings-def456.tmp"
    fresh.write_text("{}", encoding="utf-8")
    other = folder / "notes.tmp"
    other.write_text("x", encoding="utf-8")
    shaped_folder = folder / ".settings-dir.tmp"
    shaped_folder.mkdir()
    past = time.time() - settings.STALE_TEMP_SECONDS - 5
    for path in (old, other, shaped_folder):
        os.utime(path, (past, past))
    with TestClient(main.app):
        pass
    assert _left(folder) == [".settings-def456.tmp", ".settings-dir.tmp", "notes.tmp", "settings.json"]


# -- GM r31 item 4: the Vertex paste error -----------------------------------

VERTEX_PASTE_LINE = ("The Vertex AI service account key saved in Settings isn’t a valid key file. "
                     "Paste the whole key file again.")


@pytest.mark.parametrize("raw", ["{not json", '{"type": "authorized_user"}', "[]"], ids=["not-json", "another-kind", "not-an-object"])
def test_a_pasted_vertex_key_that_isnt_a_key_file_says_gm_r31s_line(raw):
    from execution.person_line import person_line
    from services.google_vertex import VertexCredentialsError, parse_service_account

    with pytest.raises(VertexCredentialsError) as caught:
        parse_service_account(raw)
    assert person_line(caught.value) == VERTEX_PASTE_LINE
