"""Updates: what an agent or the reader noticed, saved for the person (plan
section 5.9, PR9a). The screen word is "Updates"; the code name is
``agentNotes`` (plan section 10.6)."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentIdentity, AgentPresence
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.selection_context import SelectionContextStore
from tests.conftest import FORGED_ORIGIN, PERSON
from tests.conftest import stored_image_urls

AGENT = {"X-Nebula-Agent": "Claude Code"}
CODEX_HEADERS = {"X-Nebula-Agent": "Codex CLI"}
CLAUDE = AgentIdentity(id="claude", name="Claude", color="#E8825A", verified=True)
CODEX = AgentIdentity(id="codex", name="Codex", color="#5B9DFF", verified=True)


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


def _store_with_projects(tmp_path, *names: str) -> tuple[ProjectStore, list[str]]:
    store = ProjectStore(tmp_path / "projects")
    ids = []
    with store.transaction() as catalog:
        for name in names:
            project = make_project(name)
            catalog["projects"][project["id"]] = project
            ids.append(project["id"])
        catalog["activeProjectId"] = ids[0] if ids else None
        store.commit(catalog)
    return store, ids


def _activate(store: ProjectStore, project_id: str) -> None:
    with store.transaction() as catalog:
        catalog["activeProjectId"] = project_id
        store.commit(catalog)


def _board(board_id: str = "b1", private: list[str] | None = None, n: int = 4) -> dict:
    private = private or []
    images = [{"id": f"img{i}", "url": f"/api/outputs/x{i}.png",
               "privateNote": private[i] if i < len(private) else ""} for i in range(n)]
    return {"id": board_id, "name": "Dusk", "version": 3, "images": images, "projectId": None}


# -- the service, on its own ---------------------------------------------------

@pytest.fixture
def notes(tmp_path):
    from services.agent_notes import AgentNotes

    store, ids = _store_with_projects(tmp_path, "Active", "Other")
    clock = Clock()
    service = AgentNotes(store, board_root=lambda: tmp_path / "moodboards", clock=clock, monotonic=clock)
    return service, store, ids, clock


def test_text_is_plain_capped_and_private_use_characters_never_survive():
    from services.agent_notes import MAX_TEXT, NoteError, clean_note_text

    assert clean_note_text("  two  seeds\n\there\x00‮ ") == "two seeds here"
    # Private-use characters are how Nebula marks image refs in saved text, so
    # an agent can't forge one.
    assert clean_note_text("aimg1b") == "aimg1b"
    assert clean_note_text("x" * MAX_TEXT) == "x" * MAX_TEXT
    for bad in ("", "  \n ", None, 7, "x" * (MAX_TEXT + 1)):
        with pytest.raises(NoteError) as exc:
            clean_note_text(bad)
        assert exc.value.status == 422


def test_canvas_post_keeps_known_node_refs_and_drops_unknown_ones(notes):
    service, _store, (active, _other), _clock = notes
    posted = service.canvas_post(CLAUDE, {"text": "The two portrait branches use different seeds",
                                          "refs": ["n2", "n9", "n3", "n2"]},
                                 graph_nodes={"n2": {}, "n3": {}})
    note = posted["note"]
    assert note["refs"] == ["n2", "n3"]
    assert posted["dropped"] == ["n9"]
    assert note["id"].startswith("an_") and len(note["id"]) == 15
    assert note["author"] == {"kind": "agent", "id": "claude", "name": "Claude", "color": "#E8825A", "verified": True}
    assert note["source"] == "agent" and note["about"] == "other"
    assert "actions" not in note and "readAt" not in note
    assert posted["unread"] == 1 and posted["projectId"] == active


def test_agents_may_only_say_since_last_turn_or_other_and_send_no_actions(notes):
    from services.agent_notes import NoteError

    service, *_ = notes
    for about in ("analyze", "suggestion", "removedLook", "changedWords", "proposal", "made-up"):
        with pytest.raises(NoteError) as exc:
            service.canvas_post(CLAUDE, {"text": "x", "about": about}, graph_nodes={})
        assert exc.value.status == 422 and exc.value.code == "about_not_allowed"
    with pytest.raises(NoteError) as exc:
        service.canvas_post(CLAUDE, {"text": "x", "actions": [{"label": "Undo the sort", "op": {}}]}, graph_nodes={})
    assert exc.value.status == 422 and exc.value.code == "agent_actions_refused"
    with pytest.raises(NoteError) as exc:
        service.canvas_post(CLAUDE, {"text": "x", "refs": [f"n{i}" for i in range(13)]}, graph_nodes={})
    assert exc.value.status == 422


def test_no_project_open_means_no_canvas_updates(tmp_path):
    from services.agent_notes import AgentNotes, NoteError

    store, _ = _store_with_projects(tmp_path)
    service = AgentNotes(store, board_root=lambda: tmp_path / "moodboards")
    assert service.canvas_list() == {"projectId": None, "notes": [], "unread": 0, "keptWith": "project"}
    with pytest.raises(NoteError) as exc:
        service.canvas_post(CLAUDE, {"text": "x"}, graph_nodes={})
    assert exc.value.status == 409 and "Open or create a project first" in exc.value.detail


def test_unread_count_read_up_to_and_dismiss(notes):
    service, *_ , clock = notes
    first = service.canvas_post(CLAUDE, {"text": "one"}, graph_nodes={})["note"]
    clock.now += 1
    second = service.canvas_post(CLAUDE, {"text": "two"}, graph_nodes={})["note"]
    clock.now += 1
    third = service.canvas_post(CODEX, {"text": "three"}, graph_nodes={})["note"]
    listing = service.canvas_list()
    assert [note["id"] for note in listing["notes"]] == [third["id"], second["id"], first["id"]]
    assert listing["unread"] == 3
    # Marking read up to the second marks it and everything older, not the newer one.
    marked = service.canvas_mark_read(second["id"])
    assert sorted(marked["ids"]) == sorted([first["id"], second["id"]]) and marked["unread"] == 1
    assert [note["id"] for note in service.canvas_list(unread_only=True)["notes"]] == [third["id"]]
    dismissed = service.canvas_dismiss(third["id"])
    assert dismissed["unread"] == 0 and dismissed["note"]["dismissedAt"]
    # A dismissed update stays in the list (greyed on screen).
    assert len(service.canvas_list()["notes"]) == 3
    from services.agent_notes import NoteError
    with pytest.raises(NoteError) as exc:
        service.canvas_mark_read("an_000000000000")
    assert exc.value.status == 404


def test_reading_one_card_marks_only_that_update(notes):
    """A click on a dropped card reads that update, not the older unread ones."""
    service, *_, clock = notes
    older = service.canvas_post(CLAUDE, {"text": "older, never opened"}, graph_nodes={})["note"]
    clock.now += 1
    card = service.canvas_post(CLAUDE, {"text": "the card"}, graph_nodes={})["note"]
    marked = service.canvas_mark_read(ids=[card["id"], "an_gone00000000"])
    assert marked["ids"] == [card["id"]] and marked["unread"] == 1
    assert [note["id"] for note in service.canvas_list(unread_only=True)["notes"]] == [older["id"]]


def test_a_second_unread_since_last_turn_update_replaces_the_first(notes):
    service, *_, clock = notes
    first = service.canvas_post(CLAUDE, {"text": "You moved n2", "about": "sinceLastTurn"}, graph_nodes={})["note"]
    clock.now += 1
    posted = service.canvas_post(CLAUDE, {"text": "You moved n3", "about": "sinceLastTurn"}, graph_nodes={})
    second = posted["note"]
    # The socket says which update left, so every tab drops it too.
    assert posted["removed"] == [first["id"]]
    listing = service.canvas_list()
    assert [note["id"] for note in listing["notes"]] == [second["id"]] and listing["unread"] == 1
    # Another author's, or one already read, is kept.
    service.canvas_post(CODEX, {"text": "Codex saw it", "about": "sinceLastTurn"}, graph_nodes={})
    service.canvas_mark_read()
    clock.now += 1
    service.canvas_post(CLAUDE, {"text": "You moved n4", "about": "sinceLastTurn"}, graph_nodes={})
    assert [note["text"] for note in service.canvas_list()["notes"]] == ["You moved n4", "Codex saw it", "You moved n3"]
    assert first["id"] not in {note["id"] for note in service.canvas_list()["notes"]}


def test_rate_limit_covers_agent_updates_only(notes):
    from services.agent_notes import RATE_LIMIT, NoteError

    service, *_, clock = notes
    for index in range(RATE_LIMIT):
        service.canvas_post(CLAUDE, {"text": f"note {index}"}, graph_nodes={})
    with pytest.raises(NoteError) as exc:
        service.canvas_post(CLAUDE, {"text": "one too many"}, graph_nodes={})
    assert exc.value.status == 429 and exc.value.code == "notes_rate_limited"
    # Another author is counted on its own; Nebula's template updates skip it.
    service.canvas_post(CODEX, {"text": "codex"}, graph_nodes={})
    for index in range(RATE_LIMIT + 2):
        service.post_nebula(("canvas", None), author={"kind": "reader", "id": "argon", "name": "Gemini 4 Argon",
                                                      "color": "#B4A7FF"},
                            about="analyze", text=f"template {index}", refs=[])
    clock.now += 61
    service.canvas_post(CLAUDE, {"text": "a minute later"}, graph_nodes={})


def test_rate_limit_holds_when_posts_race(notes, monkeypatch):
    """Board posts run in worker threads (main.py, asyncio.to_thread): posts
    that arrive together must not all pass the check before any is counted."""
    import threading
    import time as real_time

    from services.agent_notes import RATE_LIMIT, NoteError

    service, *_ = notes
    write = service._write_board

    def slow_write(board_id, mutate):
        real_time.sleep(0.5)  # every racing post is past the check by now
        return write(board_id, mutate)

    monkeypatch.setattr(service, "_write_board", slow_write)
    board = _board()
    start = threading.Barrier(RATE_LIMIT + 3)
    outcomes: list[str] = []

    def post(index: int) -> None:
        start.wait()
        try:
            service.board_post(CLAUDE, board, {"text": f"race {index}"})
            outcomes.append("posted")
        except NoteError as exc:
            outcomes.append(exc.code or "error")

    threads = [threading.Thread(target=post, args=(index,)) for index in range(RATE_LIMIT + 3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert outcomes.count("posted") == RATE_LIMIT
    assert outcomes.count("notes_rate_limited") == 3
    assert len(service.board_list(board)["notes"]) == RATE_LIMIT


def test_a_refused_post_does_not_use_up_the_rate_limit(notes):
    from services.agent_notes import RATE_LIMIT, NoteError

    service, *_ = notes
    board = _board()
    for _ in range(RATE_LIMIT):
        with pytest.raises(NoteError):
            service.board_post(CLAUDE, board, {"text": "#45 looks off"})
    for index in range(RATE_LIMIT):
        service.board_post(CLAUDE, board, {"text": f"fine {index}"})


def test_project_cap_prunes_oldest_read_first_then_oldest_unread(notes, monkeypatch):
    from services import agent_notes

    service, *_, clock = notes
    monkeypatch.setattr(agent_notes, "MAX_PROJECT_NOTES", 5)
    monkeypatch.setattr(agent_notes, "RATE_LIMIT", 1000)
    ids = []
    for index in range(4):
        clock.now += 1
        ids.append(service.canvas_post(CLAUDE, {"text": f"n{index}"}, graph_nodes={})["note"]["id"])
    service.canvas_mark_read(ids[1])  # 0 and 1 read; 2 and 3 unread
    clock.now += 1
    service.canvas_post(CLAUDE, {"text": "n4"}, graph_nodes={})
    clock.now += 1
    pruned = service.canvas_post(CLAUDE, {"text": "n5"}, graph_nodes={})  # over the cap: the oldest read (n0) goes
    assert pruned["removed"] == [ids[0]]
    assert [note["text"] for note in service.canvas_list()["notes"]] == ["n5", "n4", "n3", "n2", "n1"]
    clock.now += 1
    service.canvas_post(CLAUDE, {"text": "n6"}, graph_nodes={})  # n1, the last read one, goes
    clock.now += 1
    service.canvas_post(CLAUDE, {"text": "n7"}, graph_nodes={})  # none read: the oldest unread (n2) goes
    assert [note["text"] for note in service.canvas_list()["notes"]] == ["n7", "n6", "n5", "n4", "n3"]


def test_board_cap_is_100_and_the_project_cap_200():
    from services.agent_notes import MAX_BOARD_NOTES, MAX_PROJECT_NOTES

    assert (MAX_BOARD_NOTES, MAX_PROJECT_NOTES) == (100, 200)


def test_updates_stay_with_their_project_across_switches_and_reloads(notes, tmp_path):
    from services.agent_notes import AgentNotes

    service, store, (active, other), _clock = notes
    service.canvas_post(CLAUDE, {"text": "first project"}, graph_nodes={})
    _activate(store, other)
    service.forget_cache()
    assert service.canvas_list()["notes"] == []
    service.canvas_post(CLAUDE, {"text": "second project"}, graph_nodes={})
    _activate(store, active)
    reloaded = AgentNotes(ProjectStore(tmp_path / "projects"), board_root=lambda: tmp_path / "moodboards")
    assert [note["text"] for note in reloaded.canvas_list()["notes"]] == ["first project"]


def test_trash_and_restore_of_a_project_keep_its_updates(notes):
    from services.project_store import move_to_trash, restore_from_trash

    service, store, (active, other), _clock = notes
    service.canvas_post(CLAUDE, {"text": "keep me"}, graph_nodes={})
    with store.transaction() as catalog:
        move_to_trash(catalog, active)
        catalog["activeProjectId"] = other
        store.commit(catalog)
    with store.transaction() as catalog:
        restore_from_trash(catalog, active)
        catalog["activeProjectId"] = active
        store.commit(catalog)
    service.forget_cache()
    assert [note["text"] for note in service.canvas_list()["notes"]] == ["keep me"]


# -- boards: #n, refs, the side file ----------------------------------------------

def test_board_hash_numbers_become_ids_and_draw_the_current_number(notes):
    service, *_ = notes
    board = _board()
    posted = service.board_post(CLAUDE, board, {"text": "#2 and #4 fight; see #2", "refs": ["img0", "9", "#3"]})
    note = posted["note"]
    assert note["refs"] == ["img1", "img3", "img0", "img2"]
    assert posted["dropped"] == ["9"]
    assert note["text"] == "#2 and #4 fight; see #2"
    # Stored as image ids, not numbers.
    stored = json.loads(service.board_path("b1").read_text())["notes"][0]["text"]
    assert "#2" not in stored and "img1" in stored
    # The second image goes: every later number moves up and the gone one reads "removed".
    board["images"].pop(1)
    listed = service.board_list(board)["notes"][0]
    assert listed["text"] == "(removed) and #3 fight; see (removed)"
    assert listed["parts"][0] == {"ref": "img1", "number": None}
    assert {"ref": "img3", "number": 3} in listed["parts"]


def test_a_hash_number_not_on_the_board_refuses_the_update(notes):
    from services.agent_notes import NoteError

    service, *_ = notes
    with pytest.raises(NoteError) as exc:
        service.board_post(CLAUDE, _board(), {"text": "#45 looks off"})
    assert exc.value.status == 422 and exc.value.detail == "#45 isn't on this board"
    assert not service.board_path("b1").exists()


def test_note_quoting_a_private_note_is_refused(notes):
    from services.agent_notes import NoteError, quotes_private_note

    service, *_ = notes
    secret = "The client hates teal, keep it out of the deck"
    board = _board(private=["", secret, "short one"])
    with pytest.raises(NoteError) as exc:
        service.board_post(CLAUDE, board, {"text": "Heads up: the CLIENT hates teal keep it out of the deck!"})
    assert exc.value.status == 422 and exc.value.code == "note_quotes_private_note"
    # A 32-character run of a longer note is enough.
    assert quotes_private_note("they said client hates teal keep it out of things", [secret])
    # Under 12 normalized characters can't be checked without false hits.
    service.board_post(CLAUDE, board, {"text": "short one is fine"})
    # 12 to 32 characters: the whole note must appear.
    assert quotes_private_note("warm amber dusk light", ["Warm amber, dusk"])
    assert not quotes_private_note("warm amber", ["Warm amber, dusk"])


def test_main_canvas_updates_check_every_board_the_project_sees(notes, tmp_path):
    from services.agent_notes import NoteError

    service, _store, (active, other), _clock = notes
    root = tmp_path / "moodboards"
    for scope, board_id, note in ((active, "p1", "the project board says never use the logo"),
                                  ("_global", "g1", "global board: do not show the founder's face"),
                                  (other, "o1", "another project's secret about the launch date")):
        (root / scope).mkdir(parents=True, exist_ok=True)
        (root / scope / f"{board_id}.json").write_text(json.dumps(
            {"id": board_id, "version": 1, "images": [{"id": "i", "url": "/x.png", "privateNote": note}]}))
    for text in ("FYI the project board says never use the logo", "global board: do not show the founder's face"):
        with pytest.raises(NoteError) as exc:
            service.canvas_post(CLAUDE, {"text": text}, graph_nodes={})
        assert exc.value.code == "note_quotes_private_note"
    service.canvas_post(CLAUDE, {"text": "another project's secret about the launch date"}, graph_nodes={})
    # The cache follows a board that changed.
    (root / "_global" / "g1.json").write_text(json.dumps(
        {"id": "g1", "version": 2, "images": [{"id": "i", "url": "/x.png", "privateNote": ""}]}))
    service.canvas_post(CLAUDE, {"text": "global board: do not show the founder's face"}, graph_nodes={})


def test_main_canvas_guard_normalizes_each_saved_note_once(notes, tmp_path, monkeypatch):
    """40 boards of 300 images is 12,000 notes: a post normalizes only its
    own text, the index keeps the notes normalized until their file changes."""
    import services.agent_notes as agent_notes

    service, _store, (active, _other), _clock = notes
    root = tmp_path / "moodboards"
    (root / active).mkdir(parents=True, exist_ok=True)
    images = [{"id": f"i{i}", "url": "/x.png", "privateNote": f"Private note number {i}, keep it"} for i in range(50)]
    (root / active / "b1.json").write_text(json.dumps({"id": "b1", "version": 1, "images": images}))
    service.canvas_post(CLAUDE, {"text": "First post warms the index."}, graph_nodes={})

    calls = []
    real = agent_notes._normalize
    monkeypatch.setattr(agent_notes, "_normalize", lambda text: calls.append(text) or real(text))
    service.canvas_post(CLAUDE, {"text": "Second post reads only itself."}, graph_nodes={})
    assert calls == ["Second post reads only itself."]
    with pytest.raises(agent_notes.NoteError):
        service.canvas_post(CLAUDE, {"text": "they wrote PRIVATE NOTE number 7 keep it"}, graph_nodes={})


def test_board_note_never_writes_the_board_file(notes, tmp_path):
    service, *_ = notes
    root = tmp_path / "moodboards"
    (root / "_global").mkdir(parents=True)
    board_file = root / "_global" / "b1.json"
    board_file.write_text(json.dumps(_board()))
    before = hashlib.sha256(board_file.read_bytes()).hexdigest()
    board = json.loads(board_file.read_text())
    note = service.board_post(CLAUDE, board, {"text": "#1 is the heaviest"})["note"]
    service.board_mark_read(board, note["id"])
    service.board_dismiss(board, note["id"])
    assert hashlib.sha256(board_file.read_bytes()).hexdigest() == before
    assert json.loads(board_file.read_text())["version"] == 3
    saved = json.loads((root / ".notes" / "b1.json").read_text())
    assert saved["boardId"] == "b1" and len(saved["notes"]) == 1


def test_purging_a_board_removes_its_updates_file(notes, tmp_path, monkeypatch):
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    service, *_ = notes
    store = MoodboardStore()
    board = store.create("Dusk", images=[{"url": stored_image_urls(1, name="notes")[0]}])
    service.board_post(CLAUDE, board, {"text": "#1 reads warm"})
    assert service.board_path(board["id"]).exists()
    store.delete(board["id"])
    assert service.board_path(board["id"]).exists()  # Recently deleted keeps them
    store.restore(board["id"])
    assert service.board_list(store.get(board["id"]))["notes"][0]["text"] == "#1 reads warm"
    store.delete(board["id"])
    store.purge(board["id"])
    assert not service.board_path(board["id"]).exists()


def test_a_board_move_keeps_its_updates(notes, tmp_path, monkeypatch, canvas_project):
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    service, *_ = notes
    store = MoodboardStore()
    board = store.create("Dusk", images=[{"url": stored_image_urls(1, name="notes")[0]}])
    service.board_post(CLAUDE, board, {"text": "kept on the move"})
    _before, moved, _ = store.move(board["id"], canvas_project)
    assert moved["projectId"] == canvas_project
    assert [note["text"] for note in service.board_list(moved)["notes"]] == ["kept on the move"]


def test_both_startup_scans_leave_notes_and_history_files_byte_for_byte(tmp_path):
    from services.moodboard_brief import migrate_store, save_colour_checks
    from services.moodboard_store import board_scopes

    root = tmp_path / "moodboards"
    for folder, name, data in ((".notes", "b1.json", {"boardId": "b1", "notes": [{"id": "an_1", "text": "x"}]}),
                               (".history", "b1.json", {"boardId": "b1", "entries": []}),
                               ("_global", "b1.json", {"id": "b1", "name": "Old", "images": []})):
        (root / folder).mkdir(parents=True, exist_ok=True)
        (root / folder / name).write_text(json.dumps(data))
    (root / ".trash").mkdir()
    sides = {path: path.read_bytes() for path in (root / ".notes" / "b1.json", root / ".history" / "b1.json")}
    assert sorted(path.name for path in board_scopes(root)) == [".trash", "_global"]
    migrate_store(root, tmp_path / "backups")
    save_colour_checks(root)
    for path, data in sides.items():
        assert path.read_bytes() == data
    # The board itself still migrates.
    assert "briefVersion" in json.loads((root / "_global" / "b1.json").read_text())


def test_nebula_template_updates_carry_checked_actions(notes):
    from services.agent_notes import NoteError

    service, *_ = notes
    reader = {"kind": "reader", "id": "argon", "name": "Gemini 4 Argon", "color": "#B4A7FF"}
    note = service.post_nebula(("board", _board()), author=reader, about="analyze",
                               text="Sorted 20 into four looks by what they share.", refs=["img2"],
                               actions=[{"label": "Undo the sort", "op": {"kind": "run.undo", "boardId": "b1",
                                                                          "runId": "r1"}}],
                               requested_by={"kind": "person", "name": "You"})["note"]
    assert note["source"] == "nebula" and note["actions"][0]["label"] == "Undo the sort"
    assert note["requestedBy"] == {"kind": "person", "name": "You"}
    for bad in ([{"label": "Delete everything", "op": {"kind": "run.undo", "boardId": "b1", "runId": "r1"}}],
                [{"label": "Undo the sort", "op": {"kind": "graph.clear"}}],
                [{"label": "Not now", "op": {"kind": "suggestion.dismiss", "suggestionIds": []}}] * 3):
        with pytest.raises(NoteError):
            service.post_nebula(("board", _board()), author=reader, about="analyze", text="x", refs=[], actions=bad)
    acted = service.mark_acted(("board", _board()), note["id"], {"kind": "person"}, action="Undo the sort")
    assert acted["note"]["actedAt"] and acted["note"]["actedBy"] == {"kind": "person"} and acted["note"]["readAt"]
    # Which of its actions ran, so the list can show the state ("Undone").
    assert acted["note"]["actedWith"] == "Undo the sort"
    with pytest.raises(NoteError):
        service.mark_acted(("board", _board()), note["id"], {"kind": "person"}, action="Make frame")


# -- the API --------------------------------------------------------------------------

@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module
    from services.agent_notes import AgentNotes

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store, ids = _store_with_projects(tmp_path, "Active", "Other")
    journal = CanvasEventJournal()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "agent_notes", AgentNotes(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    return TestClient(main_module.app), graph, journal, sent, store, ids


def _note_messages(sent):
    return [message for message in sent if message.get("type") == "agentNotes"]


def test_post_note_saves_with_project_and_survives_autosave(api):
    client, graph, _journal, sent, store, (active, _other) = api
    node = graph.add_node("text-input", {"value": "hi"})
    posted = client.post("/api/canvas/agent-notes", headers=AGENT,
                         json={"text": "The two portrait branches use different seeds", "refs": [node]})
    assert posted.status_code == 201, posted.text
    note = posted.json()["note"]
    assert note["author"]["name"] == "Claude Code" and note["refs"] == [node]
    message = _note_messages(sent)[-1]
    assert message["op"] == "added" and message["surface"] == "canvas" and message["projectId"] == active
    assert message["note"]["id"] == note["id"] and message["unread"] == 1
    # The browser's autosave replaces only the snapshot.
    revision = store.read()["workspaceRevision"]
    saved = client.put(f"/api/projects/{active}", json={"workspaceRevision": revision,
                                                         "snapshot": {"nodes": [], "edges": []}})
    assert saved.status_code == 200, saved.text
    assert "agentNotes" not in saved.json()["project"]
    assert [n["id"] for n in client.get("/api/canvas/agent-notes").json()["notes"]] == [note["id"]]
    assert store.read()["projects"][active]["agentNotes"][0]["id"] == note["id"]


def test_note_ref_unknown_id_is_dropped_never_outlined(api):
    client, graph, *_ = api
    node = graph.add_node("text-input", {})
    posted = client.post("/api/canvas/agent-notes", headers=AGENT, json={"text": "x", "refs": [node, "n404"]})
    assert posted.json()["note"]["refs"] == [node] and posted.json()["dropped"] == ["n404"]


def test_only_named_agents_post_and_only_the_person_reads_or_dismisses(api):
    client, *_ = api
    assert client.post("/api/canvas/agent-notes", json={"text": "x"}).status_code == 400
    assert client.post("/api/canvas/agent-notes", headers=PERSON, json={"text": "x"}).status_code == 400
    note = client.post("/api/canvas/agent-notes", headers=AGENT, json={"text": "x"}).json()["note"]
    for headers in (AGENT, {}, FORGED_ORIGIN, {**PERSON, **AGENT}):
        assert client.post("/api/canvas/agent-notes/read", headers=headers, json={}).status_code == 403
        assert client.post(f"/api/canvas/agent-notes/{note['id']}/dismiss", headers=headers).status_code == 403
    read = client.post("/api/canvas/agent-notes/read", headers=PERSON, json={"upTo": note["id"]})
    assert read.status_code == 200 and read.json()["unread"] == 0
    assert client.post(f"/api/canvas/agent-notes/{note['id']}/dismiss", headers=PERSON).status_code == 200
    # Agents list them, unread or all.
    listing = client.get("/api/canvas/agent-notes?unread=1", headers=AGENT).json()
    assert listing["notes"] == [] and listing["unread"] == 0 and listing["keptWith"] == "project"
    assert len(client.get("/api/canvas/agent-notes", headers=AGENT).json()["notes"]) == 1


def test_read_and_dismiss_broadcast_and_are_not_journaled(api):
    client, _graph, journal, sent, *_ = api
    note = client.post("/api/canvas/agent-notes", headers=AGENT, json={"text": "watch n2"}).json()["note"]
    assert _note_messages(sent)[-1]["op"] == "added" and _note_messages(sent)[-1]["removed"] == []
    client.post("/api/canvas/agent-notes/read", headers=PERSON, json={"upTo": note["id"]})
    assert _note_messages(sent)[-1]["op"] == "read" and _note_messages(sent)[-1]["ids"] == [note["id"]]
    other = client.post("/api/canvas/agent-notes", headers=AGENT, json={"text": "watch n3"}).json()["note"]
    read = client.post("/api/canvas/agent-notes/read", headers=PERSON, json={"ids": [other["id"]]})
    assert read.status_code == 200 and read.json()["ids"] == [other["id"]]
    both = client.post("/api/canvas/agent-notes/read", headers=PERSON, json={"ids": [other["id"]], "upTo": other["id"]})
    assert both.status_code == 422
    client.post(f"/api/canvas/agent-notes/{note['id']}/dismiss", headers=PERSON)
    assert _note_messages(sent)[-1]["op"] == "dismissed"
    events = journal.read(after=0, kinds={"note"})["events"]
    # One event per post (two here); reading and dismissing add none.
    assert [event["kind"] for event in events] == ["note.posted", "note.posted"]
    assert events[0]["data"]["noteId"] == note["id"] and events[0]["data"]["surface"] == "canvas"
    assert events[0]["actor"]["name"] == "Claude Code"


def test_agent_note_refusals_over_http(api):
    client, *_ = api
    cases = [({"text": "x", "about": "analyze"}, 422), ({"text": "x", "actions": []}, 422),
             ({"text": ""}, 422), ({"text": "x", "colour": "red"}, 422), ({"text": "x" * 241}, 422)]
    for body, status in cases:
        response = client.post("/api/canvas/agent-notes", headers=AGENT, json=body)
        assert response.status_code == status, body
    for index in range(5):
        client.post("/api/canvas/agent-notes", headers=CODEX_HEADERS, json={"text": f"n{index}"})
    client.post("/api/canvas/agent-notes", headers=CODEX_HEADERS, json={"text": "6"})
    limited = client.post("/api/canvas/agent-notes", headers=CODEX_HEADERS, json={"text": "7"})
    assert limited.status_code == 429 and limited.json()["code"] == "notes_rate_limited"


def test_canvas_updates_follow_the_project_switch_and_the_socket_syncs(api):
    client, _graph, _journal, sent, store, (active, other) = api
    client.post("/api/canvas/agent-notes", headers=AGENT, json={"text": "first project"})
    revision = store.read()["workspaceRevision"]
    opened = client.post(f"/api/projects/{other}/open", json={"workspaceRevision": revision})
    assert opened.status_code == 200, opened.text
    sync = _note_messages(sent)[-1]
    assert sync["op"] == "sync" and sync["projectId"] == other and sync["notes"] == []
    client.post(f"/api/projects/{active}/open", json={"workspaceRevision": opened.json()["workspaceRevision"]})
    assert [n["text"] for n in _note_messages(sent)[-1]["notes"]] == ["first project"]
    with client.websocket_connect("/ws", headers=PERSON) as ws:
        kinds = [ws.receive_json()["type"] for _ in range(3)]
    assert kinds == ["graphSync", "canvasPins", "agentNotes"]


def test_an_import_into_the_open_project_keeps_its_list_without_a_sync(api):
    client, _graph, _journal, sent, *_ = api
    client.post("/api/canvas/agent-notes", headers=AGENT, json={"text": "before the import"})
    before = len(_note_messages(sent))
    imported = client.post("/api/graph/import", json={"nodes": [], "edges": []})
    assert imported.status_code == 200, imported.text
    assert len(_note_messages(sent)) == before
    assert [n["text"] for n in client.get("/api/canvas/agent-notes").json()["notes"]] == ["before the import"]


def test_board_routes_and_the_board_put_refuses_agent_notes(api, tmp_path):
    client, _graph, journal, sent, *_ = api
    created = client.post("/api/moodboards", json={"name": "Dusk", "images": [{"url": url} for url in
                                                                                stored_image_urls(2, name="notes")]})
    board = created.json()
    path = f"/api/moodboards/{board['id']}/agent-notes"
    posted = client.post(path, headers=AGENT, json={"text": "#2 is the heaviest", "refs": ["1"]})
    assert posted.status_code == 201, posted.text
    note = posted.json()["note"]
    assert note["refs"] == [board["images"][1]["id"], board["images"][0]["id"]]
    assert _note_messages(sent)[-1]["surface"] == "board" and _note_messages(sent)[-1]["boardId"] == board["id"]
    assert client.post(path, headers=AGENT, json={"text": "#9 is off"}).json()["detail"] == "#9 isn't on this board"
    listing = client.get(path).json()
    assert listing["keptWith"] == "board" and listing["unread"] == 1
    assert client.post(f"{path}/read", headers=AGENT, json={}).status_code == 403
    assert client.post(f"{path}/read", headers=PERSON, json={}).json()["unread"] == 0
    assert client.post(f"{path}/{note['id']}/dismiss", headers=PERSON).status_code == 200
    refused = client.put(f"/api/moodboards/{board['id']}", json={"agentNotes": []})
    assert refused.status_code == 422 and "/agent-notes" in refused.json()["detail"]
    refused = client.post("/api/moodboards", json={"name": "x", "agentNotes": []})
    assert refused.status_code == 422 and "/agent-notes" in refused.json()["detail"]
    assert client.post("/api/moodboards/nope/agent-notes", headers=AGENT, json={"text": "x"}).status_code == 404
    event = journal.read(after=0, kinds={"note.posted"})["events"][-1]
    assert event["data"]["boardId"] == board["id"] and event["data"]["surface"] == "board"


# -- agents: MCP and CLI ------------------------------------------------------------------

def test_point_at_docstring_has_no_narrate():
    import mcp_server

    assert "narrate" not in (mcp_server.point_at.__doc__ or "")
    for tool in (mcp_server.point_at, mcp_server.edit_canvas, mcp_server.propose_change, mcp_server.resolve_pin):
        assert "post_note" in (tool.__doc__ or ""), tool.__name__
    assert "post_note" in mcp_server.INSTRUCTIONS and "Updates" in mcp_server.INSTRUCTIONS
    assert "Updates" in (mcp_server.post_note.__doc__ or "")
    assert "Updates" in (mcp_server.list_notes.__doc__ or "")


def test_mcp_post_note_and_list_notes_send_named_requests(monkeypatch):
    import mcp_server

    calls: list[dict] = []

    def fake_request(method, url, *, headers, timeout, **kwargs):
        calls.append({"method": method, "url": url, "headers": headers, **kwargs})
        return httpx.Response(201 if method == "POST" else 200, json={"note": {"id": "an_1"}, "notes": []},
                              request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    mcp_server.post_note("Two branches use different seeds", refs=["n2", "n4"], about="sinceLastTurn")
    assert calls[-1]["method"] == "POST" and calls[-1]["url"].endswith("/api/canvas/agent-notes")
    assert calls[-1]["json"] == {"text": "Two branches use different seeds", "refs": ["n2", "n4"],
                                 "about": "sinceLastTurn"}
    assert calls[-1]["headers"]["X-Nebula-Agent"] == "Claude Code"
    mcp_server.list_notes(unread=True)
    assert calls[-1]["method"] == "GET" and calls[-1]["params"] == {"unread": 1}


def test_cli_parser_knows_note_commands():
    from cli.__main__ import build_parser

    args = build_parser().parse_args(["note", "Two seeds", "--node", "n2", "--node", "n4", "--since-last-turn"])
    assert (args.command, args.text, args.nodes, args.since_last_turn) == ("note", "Two seeds", ["n2", "n4"], True)
    args = build_parser().parse_args(["note", "#2 is heavy", "--board", "Dusk", "--ref", "2"])
    assert (args.board, args.refs) == ("Dusk", ["2"])
    args = build_parser().parse_args(["notes", "--unread", "--json"])
    assert (args.command, args.unread, args.json, args.board) == ("notes", True, True, None)
    help_text = build_parser().format_help()
    assert "Updates" in help_text
    apply_help = next(a for a in build_parser()._subparsers._group_actions[0].choices["apply"]._actions
                      if "--note" in a.option_strings).help
    assert "own" in apply_help and "nebula note" in apply_help


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def post_note(self, body, board_id=None, agent_name=None):
        self.calls.append(("post", body, board_id, agent_name))
        return {"note": {"id": "an_1", "text": body["text"], "author": {"name": "Codex"}, "about": "other",
                         "at": "2026-10-20T12:14:00+00:00", "refs": body.get("refs", [])},
                "dropped": ["n9"], "unread": 1}

    def list_notes(self, board_id=None, unread=False):
        self.calls.append(("list", board_id, unread))
        return {"notes": [{"id": "an_1", "text": "Two seeds", "author": {"name": "Codex"}, "about": "other",
                           "at": "2026-10-20T12:14:00+00:00", "refs": ["n2"]}], "unread": 1, "keptWith": "project"}


def test_cli_note_and_notes_print_what_happened():
    from cli.commands import notes as notes_cmd

    client = FakeClient()
    out = io.StringIO()
    args = argparse.Namespace(text=" Two  seeds ", board=None, refs=[], nodes=["n2", "n9"], since_last_turn=False,
                              agent_name="Codex", json=False)
    assert notes_cmd.run_note(client, args, out=out) == 0
    assert client.calls[0] == ("post", {"text": "Two seeds", "refs": ["n2", "n9"]}, None, "Codex")
    assert "Updates" in out.getvalue() and "n9" in out.getvalue()
    bad = argparse.Namespace(text="x", board=None, refs=["2"], nodes=[], since_last_turn=False, agent_name=None,
                             json=False)
    assert notes_cmd.run_note(client, bad, out=io.StringIO()) == 1
    out = io.StringIO()
    assert notes_cmd.run_notes(client, argparse.Namespace(board=None, unread=True, json=False), out=out) == 0
    assert "Two seeds" in out.getvalue() and client.calls[-1] == ("list", None, True)


def test_journal_knows_note_posted():
    from services.canvas_events import EVENT_GROUPS, EVENT_KINDS

    assert "note.posted" in EVENT_KINDS and "note" in EVENT_GROUPS


def test_docs_say_say_is_for_your_own_action():
    root = Path(__file__).resolve().parents[2]
    skill = (root / "skills" / "nebula" / "SKILL.md").read_text()
    setup = (root / "docs" / "MCP-SETUP.md").read_text()
    for text in (skill, setup):
        assert "nebula note" in text or "post_note" in text
        assert "Updates" in text
    assert "narration" not in setup.split("`point_at`", 1)[1].split("\n- ", 1)[0]
