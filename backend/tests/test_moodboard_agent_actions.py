"""An agent's moodboard writes reach the canvas's Agent log.

The log is fed by the same `agentPresence` events that move an agent's cursor
(frontend store/agentLogStore.ts). Graph edits always sent one; a board write
over MCP or the CLI (Set aside, Analyze, ...) sent none, so the person never
saw it. A board has no place on the canvas, so before Phase 3 these events
carried no `target`. They now carry a surface anchor (the board, the image or
the control the write touched), and the delete's, which has nothing left to
point at, still none.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from services.agent_presence import AgentPresence, identify
from services.moodboard_actions import describe_change
from services.moodboard_edits import diff
from services.output import OUTPUT_ROOT

AGENT = {"X-Nebula-Agent": "Claude Code"}


@pytest.fixture
def api(tmp_path, monkeypatch, canvas_project):
    import main as main_module

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    presence = AgentPresence()
    sent: list[dict] = []

    async def capture(data, **_kw):
        sent.append(data)

    async def ignore(data):
        return None

    monkeypatch.setattr(main_module, "agent_presence", presence)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", ignore)
    return TestClient(main_module.app), sent, presence, canvas_project


def _url(color=(200, 80, 40)) -> str:
    path = OUTPUT_ROOT / "moodboard-agent-action-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _said(sent: list[dict]) -> list[str]:
    return [event["say"] for event in sent if event.get("type") == "agentPresence"]


def _create(client, headers=None, **body) -> dict:
    response = client.post("/api/moodboards", headers=headers or {},
                           json={"name": "Dusk dunes", "images": [{"url": _url()}, {"url": _url((20, 40, 200))}],
                                 **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_an_agents_set_aside_and_analyze_are_named_in_the_log(api):
    client, sent, presence, _ = api
    board = _create(client, AGENT)
    first, second = board["images"]

    # The list is the board's images (moodboard_client sends every one).
    aside = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"images": [
        {"id": first["id"], "url": first["url"], "excluded": True},
        {"id": second["id"], "url": second["url"]},
    ]})
    assert aside.status_code == 200, aside.text
    assert client.post(f"/api/moodboards/{board['id']}/analyze", headers=AGENT).status_code == 200

    assert _said(sent) == ["Made “Dusk dunes” with 2 images", "Set aside image 1 on “Dusk dunes”",
                           "Analyzed “Dusk dunes”"]
    events = [event for event in sent if event.get("type") == "agentPresence"]
    # Who, in the cursor's own name and colour, and when.
    assert {event["agent"]["name"] for event in events} == {"Claude Code"}
    assert events[0]["agent"] == identify(AGENT).as_dict()
    assert all(isinstance(event["at"], int) for event in events)
    # No place on the canvas, but one on the Moodboard panel (Phase 3): each
    # carries a surface anchor (the full table is tests/test_cursor_anywhere_writes.py).
    assert [(event["target"]["itemId"], event["target"].get("part"), event["action"]) for event in events] == [
        (board["id"], None, "click"),
        (f"{board['id']}/{first['id']}", None, "click"),
        (board["id"], "colors", "look"),
    ]
    assert [row["target"] for row in presence.active()] == [events[-1]["target"]]


def test_the_persons_own_board_writes_send_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    first = board["images"][0]
    client.put(f"/api/moodboards/{board['id']}",
               json={"images": [{"id": first["id"], "url": first["url"], "excluded": True}]})
    client.post(f"/api/moodboards/{board['id']}/analyze")
    client.delete(f"/api/moodboards/{board['id']}")
    assert _said(sent) == []


def test_a_dry_run_writes_nothing_so_it_logs_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    assert client.post(f"/api/moodboards/{board['id']}/analyze/dry-run", headers=AGENT).status_code == 200
    assert _said(sent) == []


def test_move_and_delete_by_an_agent_are_logged(api):
    client, sent, _, project_id = api
    board = _create(client, projectId=project_id)
    moved = client.post(f"/api/moodboards/{board['id']}/move", headers=AGENT, json={"projectId": None})
    assert moved.status_code == 200, moved.text
    assert client.delete(f"/api/moodboards/{board['id']}", headers=AGENT).status_code == 200
    assert _said(sent) == ["Moved “Dusk dunes” to “Global”", "Deleted “Dusk dunes”"]


def test_an_agents_restore_from_recently_deleted_is_logged(api):
    # MCP restore_from_trash and `nebula trash restore` bring a board back.
    client, sent, _, _ = api
    board = _create(client)
    assert client.delete(f"/api/moodboards/{board['id']}").status_code == 200
    restored = client.post(f"/api/trash/moodboard/{board['id']}/restore", headers=AGENT)
    assert restored.status_code == 200, restored.text
    assert _said(sent) == ["Restored “Dusk dunes”"]


def test_a_refused_write_logs_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    # Turning notes on for generators is the person's call.
    refused = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"sendNotes": True})
    assert refused.status_code == 403
    assert _said(sent) == []


# -- the words ---------------------------------------------------------------
# One set of words for a board change: the journal's (moodboard_edits.journal_entry),
# with the board fields it leaves out named by moodboard_edits.FIELD_LABELS.

def _board(**fields) -> dict:
    images = [{"id": "a", "url": "/a.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": False},
              {"id": "b", "url": "/b.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": True}]
    return {"id": "mb1", "name": "Dusk", "images": images, "notes": "", "direction": "", "avoid": [], **fields}


def _describe(before: dict, after: dict) -> str:
    return describe_change(diff(before, after), before, after)


def test_describe_change_is_the_journal_summary_with_the_fields_it_leaves_out():
    before = _board()
    aside = _board()
    aside["images"] = [{**before["images"][0], "excluded": True}, before["images"][1]]
    assert _describe(before, aside) == "Set aside image 1 on “Dusk”"
    added = _board()
    added["images"] = [*before["images"], {"id": "c", "url": "/c.png", "weight": 1.0}]
    assert _describe(before, added) == "Added image 3 to “Dusk”"
    assert _describe(before, _board(images=before["images"][:1])) == "Removed image 2 from “Dusk”"
    assert _describe(before, _board(direction="warm dusk", avoid=["neon"])) == (
        "Changed “Direction” and “Avoid” on “Dusk”")
    assert _describe(before, _board(name="Dawn")) == "Changed “Name” on “Dawn”"
    both = _board(direction="warm dusk")
    both["images"] = aside["images"]
    assert _describe(before, both) == "Set aside image 1 on “Dusk” and changed “Direction”"
    # The board's notes are a field, named as the board.fields event names them (Q91).
    assert _describe(before, _board(notes="calm")) == "Changed “Board notes” on “Dusk”"
    # ...and named after the journal's summary when it is about something else.
    added_and_noted = _board(notes="calm")
    added_and_noted["images"] = added["images"]
    assert _describe(before, added_and_noted) == "Added image 3 to “Dusk” and changed “Board notes”"
    noted_image = _board(notes="calm")
    noted_image["images"] = [{**before["images"][0], "notes": "warm"}, before["images"][1]]
    assert _describe(before, noted_image) == (
        "Changed the notes on image 1 on “Dusk” and changed “Board notes”")


def test_every_line_names_the_board_as_the_journal_does():
    # One set of words: the journal's summary and the Agent log's other lines
    # both name a board through moodboard_edits.board_where.
    from services.moodboard_actions import describe_create, describe_move, describe_write
    from services.moodboard_edits import board_where, journal_entry

    long_name = "Dusk " + "dunes " * 20
    before = _board(name=long_name)
    after = _board(name=long_name)
    after["images"] = [{**before["images"][0], "excluded": True}, before["images"][1]]
    where = board_where(after)
    assert where.startswith("\u201cDusk dunes") and where.endswith("\u2026\u201d") and len(where) <= 62
    assert journal_entry(diff(before, after), before, after)["summary"] == f"set aside image 1 on {where}"
    assert describe_write("analyzed", after) == f"Analyzed {where}"
    assert describe_move(after, "Global") == f"Moved {where} to \u201cGlobal\u201d"
    assert describe_create(after) == f"Made {where} with 2 images"
    assert board_where({"id": "mb1"}) == "\u201cmb1\u201d"
    assert board_where({"id": "mb1", "name": ""}, {"name": "Old"}) == "\u201cOld\u201d"


def test_describe_change_never_quotes_what_the_person_wrote_privately():
    before = _board()
    after = _board()
    after["images"] = [{**before["images"][0], "privateNote": "my secret label"}, before["images"][1]]
    said = _describe(before, after)
    assert said == "Private note changed on image 1 on “Dusk”"
    assert "secret" not in said


def test_an_old_boards_unsaved_defaults_are_not_named_as_the_agents_change(api, tmp_path):
    # Images saved before weights and notes were written read without them;
    # the PUT saves their defaults. Only the agent's own change is named.
    import json

    client, sent, _, _ = api
    board = _create(client)
    path = next((tmp_path / "moodboards").rglob(f"{board['id']}.json"))
    saved = json.loads(path.read_text(encoding="utf-8"))
    for image in saved["images"]:
        for key in ("weight", "notes", "privateNote", "excluded"):
            image.pop(key, None)
    path.write_text(json.dumps(saved), encoding="utf-8")
    first, second = board["images"]
    aside = client.put(f"/api/moodboards/{board['id']}", headers=AGENT, json={"images": [
        {"id": first["id"], "url": first["url"], "excluded": True},
        {"id": second["id"], "url": second["url"]},
    ]})
    assert aside.status_code == 200, aside.text
    assert _said(sent) == ["Set aside image 1 on “Dusk dunes”"]


# -- checked board edits (POST /edits): moodboard_add, `nebula moodboard add`, undo ----

def _edit(client, board_id, ops, headers=None, **body):
    response = client.post(f"/api/moodboards/{board_id}/edits", headers=headers or {}, json={"ops": ops, **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_an_agents_edit_batch_logs_one_line_in_its_own_words(api):
    client, sent, presence, _ = api
    board = _create(client)
    first, second = board["images"]
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True},
                                {"op": "weight", "image": second["id"], "value": 0.5}],
          AGENT, say="Set aside the red one, eased the blue")
    events = [event for event in sent if event.get("type") == "agentPresence"]
    assert [event["say"] for event in events] == ["Set aside the red one, eased the blue"]
    assert events[0]["agent"] == identify(AGENT).as_dict()
    # Two images in one batch: the board (not one of the images), click.
    assert events[0]["target"] == {"surface": "moodboard", "itemId": board["id"]} and events[0]["action"] == "click"


def test_an_agents_edit_batch_without_say_logs_the_journal_summary(api):
    client, sent, _, _ = api
    board = _create(client)
    added = _edit(client, board["id"], [{"op": "add", "images": [{"url": _url((90, 200, 90))}]}], AGENT)
    # Its undo is a batch like any other (undo_board, `set --restore`).
    _edit(client, board["id"], added["undo"]["ops"], AGENT)
    assert _said(sent) == ["Added image 3 to “Dusk dunes”", "Undid a change to “Dusk dunes”"]


def test_the_persons_edit_batch_and_a_batch_that_changes_nothing_send_nothing(api):
    client, sent, _, _ = api
    board = _create(client)
    first = board["images"][0]
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True}], say="mine")
    # The agent sets aside what is already set aside: unchanged, nothing written.
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True}], AGENT)
    assert _said(sent) == []


def test_an_agents_put_takes_before_from_the_write_itself(api, monkeypatch):
    # The line compares the board the store changed (update_with_before) with
    # the result: no second read of the board, which another write could
    # change between the read and the save.
    from services.moodboard_store import MoodboardStore

    client, sent, _, _ = api
    board = _create(client)
    calls: list[str] = []
    real_get = MoodboardStore.get

    def counted_get(self, *args, **kwargs):
        calls.append("get")
        return real_get(self, *args, **kwargs)

    monkeypatch.setattr(MoodboardStore, "get", counted_get)
    response = client.put(f"/api/moodboards/{board['id']}", headers=AGENT,
                          json={"direction": "warm dusk", "baseVersion": board["version"]})
    assert response.status_code == 200, response.text
    assert calls == []
    assert _said(sent) == ["Changed “Direction” on “Dusk dunes”"]


# -- one set of words (GM - Design on PR #233): the Agent log, the cursor's say and the journal ---------
# Every line GM listed, once, for each surface. "Dusk" is the board unless a row says otherwise.

LQ, RQ = "“", "”"


def _imgs(n: int, **extra) -> list[dict]:
    return [{"id": f"i{k}", "url": f"/{k}.png", "weight": 1.0, "notes": "", "privateNote": "", "excluded": False,
             **extra} for k in range(1, n + 1)]


def _named(name: str, **fields) -> dict:
    return _board(name=name, **{"images": _imgs(2), **fields})


def _words_rows() -> list[tuple[str, dict, dict, str]]:
    """(label, before, after, the say GM listed)."""
    dusk, light = _named("Dusk"), _named("Desert light")
    aside = _named("Dusk")
    aside["images"][0]["excluded"] = True
    return [
        ("add one", light, {**light, "images": _imgs(3)}, f"Added image 3 to {LQ}Desert light{RQ}"),
        ("add several", light, {**light, "images": _imgs(5)}, f"Added 3 images to {LQ}Desert light{RQ}"),
        ("remove", {**dusk, "images": _imgs(3)}, {**dusk, "images": _imgs(2)}, f"Removed image 3 from {LQ}Dusk{RQ}"),
        ("set aside", dusk, aside, f"Set aside image 1 on {LQ}Dusk{RQ}"),
        ("fields and send notes", {**dusk, "sendNotes": True},
         {**dusk, "sendNotes": False, "direction": "warm dusk"},
         f"Changed {LQ}Direction{RQ} on {LQ}Dusk{RQ} and turned off {LQ}Send notes{RQ}"),
        ("undo", dusk, aside, f"Undid a change to {LQ}Dusk{RQ}"),
    ]


@pytest.mark.parametrize("label,before,after,line", _words_rows(), ids=[row[0] for row in _words_rows()])
def test_every_board_change_line_in_gms_words_for_each_surface(label, before, after, line):
    from services.moodboard_edits import journal_entries

    changes = diff(before, after)
    said = describe_change(changes, before, after, undo=label == "undo")
    assert said == line  # the say and the Agent log line (the log shows the say)
    assert not said.endswith(".")  # a say has no period
    summaries = [entry["summary"] for entry in journal_entries(changes, before, after)]
    if label == "undo":
        return  # an undo is a batch like any other: its journal events are the changes it made
    # The journal is the same phrase lower-case, since the actor's name leads it: one source. It names
    # fields, never values, so Send notes is "changed", where the say adds which way it went.
    assert summaries and all(s[0].islower() and not s.endswith(".") and ";" not in s for s in summaries)
    assert all("#" not in s and "board " not in s for s in summaries)
    expected = (f"changed {LQ}Direction{RQ} and {LQ}Send notes{RQ} on {LQ}Dusk{RQ}" if label == "fields and send notes"
                else line[0].lower() + line[1:])
    assert summaries == [expected]


def test_the_whole_lines_gm_listed_for_writes_with_no_journal_event():
    from services.moodboard_actions import describe_create, describe_move, describe_write

    dusk = {"id": "b", "name": "Dusk", "images": _imgs(3)}
    assert describe_create(dusk) == f"Made {LQ}Dusk{RQ} with 3 images"
    assert describe_create({**dusk, "images": []}) == f"Made {LQ}Dusk{RQ}"
    assert describe_create({**dusk, "images": _imgs(1)}) == f"Made {LQ}Dusk{RQ} with 1 image"
    assert describe_write("analyzed", dusk) == f"Analyzed {LQ}Dusk{RQ}"
    assert describe_write("kept the brief for", dusk) == f"Kept the brief for {LQ}Dusk{RQ}"
    assert describe_write("restored", dusk) == f"Restored {LQ}Dusk{RQ}"
    assert describe_write("deleted", dusk) == f"Deleted {LQ}Dusk{RQ}"
    assert describe_move(dusk, "Global") == f"Moved {LQ}Dusk{RQ} to {LQ}Global{RQ}"
    assert describe_move(dusk, "Desert trip") == f"Moved {LQ}Dusk{RQ} to {LQ}Desert trip{RQ}"


def test_the_journal_names_images_and_boards_like_the_say(api, monkeypatch):
    # The same write, end to end: the cursor's say and the journal's summary.
    import main as main_module
    from services.canvas_events import CanvasEventJournal

    fresh = CanvasEventJournal()
    monkeypatch.setattr(main_module, "canvas_events", fresh)
    client, sent, _, _ = api
    board = _create(client, AGENT)
    first = board["images"][0]
    added = _edit(client, board["id"], [{"op": "add", "images": [{"url": _url((9, 9, 9))}, {"url": _url((8, 8, 8))}]}],
                  AGENT)
    _edit(client, board["id"], [{"op": "setAside", "image": first["id"], "value": True}], AGENT)
    _edit(client, board["id"], added["undo"]["ops"], AGENT)
    says = _said(sent)
    assert says == [f"Made {LQ}Dusk dunes{RQ} with 2 images", f"Added 2 images to {LQ}Dusk dunes{RQ}",
                    f"Set aside image 1 on {LQ}Dusk dunes{RQ}", f"Undid a change to {LQ}Dusk dunes{RQ}"]
    events = fresh.read(after=0, kinds={"board"}, limit=100)["events"]
    assert [e["summary"] for e in events] == [
        f"added 2 images to {LQ}Dusk dunes{RQ}", f"set aside image 1 on {LQ}Dusk dunes{RQ}",
        f"removed 2 images from {LQ}Dusk dunes{RQ}"]
    # No say carries a period, and no board line sends a separate `log` (the Agent log shows the say).
    assert not any(s.endswith(".") for s in says)
    assert not any("log" in e for e in sent if e.get("type") == "agentPresence")


def test_a_journal_entry_renders_from_data_not_stored_text():
    # The journal is a ring buffer in memory (canvas_events: "memory-only"), so no entry outlives the
    # words that wrote it and nothing is stored in the old form. What it keeps (data.refs, data.kinds,
    # boardName) is enough to name an image and a board without the stored summary.
    from services.moodboard_edits import board_where, image_words

    entry = {"data": {"boardName": "Dusk", "refs": [{"number": 3, "id": "i3"}]}}
    where = board_where({"name": entry["data"]["boardName"]})
    assert f"removed {image_words([r['number'] for r in entry['data']['refs']])} from {where}" == (
        f"removed image 3 from {LQ}Dusk{RQ}")


def test_the_words_modules_use_curly_quotes_only():
    # An apostrophe/quote scan of every string that builds a board line: all of moodboard_actions, and in
    # moodboard_edits the journal's words (board_where, image_words, journal_entry, fields_entry, cover_words,
    # field_label, SENTENCE_LABELS). Edit refusals ("an image's id must be...") are other copy, left as they are.
    import ast
    from pathlib import Path

    import services.moodboard_actions as actions
    import services.moodboard_edits as edits

    words_in_edits = {"quoted", "board_where", "image_words", "image_count_words", "journal_entry", "field_label",
                      "listed_words", "fields_entry", "journal_entries", "cover_words"}

    def scan(module, only: set[str] | None) -> list[str]:
        tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
        roots = [tree] if only is None else [node for node in tree.body
                                            if isinstance(node, ast.FunctionDef) and node.name in only]
        if only is not None:  # the label table is data, not a function
            roots += [node for node in tree.body if isinstance(node, ast.Assign)
                      and any(getattr(t, "id", "") == "SENTENCE_LABELS" for t in node.targets)]
        found: list[str] = []
        for root in roots:
            docs = {id(n.body[0].value) for n in ast.walk(root)
                    if isinstance(n, (ast.Module, ast.FunctionDef)) and n.body and isinstance(n.body[0], ast.Expr)
                    and isinstance(n.body[0].value, ast.Constant)}
            for node in ast.walk(root):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                    if "'" in node.value or '"' in node.value:
                        found.append(f"{module.__name__}:{node.lineno}: {node.value!r}")
        return found

    assert scan(actions, None) + scan(edits, words_in_edits) == []
    assert "\u201c" in edits.board_where({"name": "x"}) and edits.SENTENCE_LABELS["sendNotes"] == "Send notes"
