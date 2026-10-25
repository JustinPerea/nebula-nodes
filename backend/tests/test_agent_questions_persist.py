"""Question sets survive a restart (Q125 item 1, follow-up in the same PR).

A side agent pointed out that open sets lived in memory only, so a restart
closed them and lost the person's unsent answers; Justin was told it would
change before the merge OK. Unlike proposals (staged against the live
graph, 15-minute expiry), a question set depends on nothing in the graph,
has no time limit, and matters most while the person is away during a long
run, and an outside agent (Claude Code in a terminal) outlives a Nebula
restart. GM - Design agreed.

So sets are kept on the project record, ``catalog["projects"][id]
["agentQuestions"]``, next to pins and agentNotes and outside the snapshot
(services/agent_notes.py's storage rules). The answer key never is: a new
one is made on load and goes only to the person's sockets, as before. The
person's typed answers are their message to the asking agent: on disk only
in that record, and no agent route but the asker's get_answers returns them.

A restart here is a new QuestionBook over the same project store, which is
what a new process builds.
"""
from __future__ import annotations

import json

import pytest

from services.agent_notes import AgentNotes
from services.agent_questions import CAP_LINE, CLOSED_KEEP_SECONDS, MAX_OPEN_PER_AGENT, QuestionBook
from services.project_store import ProjectStoreError
from tests.conftest import FORGED_ORIGIN, PERSON, PERSON_HELLO
from tests.test_agent_questions import GOOD_ANSWERS, SECRET_ANSWER, TWO, _answer, _ask, _key, _question_updates
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, api  # noqa: F401 - api is a fixture

SECRET_BIT = "client hates orange"  # part of SECRET_ANSWER


@pytest.fixture
def kept(api, monkeypatch):
    """The canvas app with a question book kept on the project store."""
    monkeypatch.setattr(api.main, "agent_notes", AgentNotes(lambda: api.main.project_store))

    def restart():
        book = QuestionBook(api.clock, store=lambda: api.main.project_store)
        monkeypatch.setattr(api.main, "agent_questions", book)
        api.questions = book
        api.browser.clear()
        return book

    api.restart = restart
    restart()
    return api


def _record(api, project_id=None, *, group="projects") -> dict:
    catalog = api.main.project_store.read()
    return catalog[group][project_id or api.project_id]


def _stored(api, project_id=None, *, group="projects") -> list[dict]:
    return list(_record(api, project_id, group=group).get("agentQuestions") or [])


def _hello(api) -> list[dict]:
    """What the person's socket gets after hello (proposals, asset proposals, questions)."""
    with api.client.websocket_connect("/ws", headers=FORGED_ORIGIN) as ws:
        for _ in range(3):
            ws.receive_json()
        ws.send_json(PERSON_HELLO)
        return [ws.receive_json() for _ in range(3)]


def _sync(api) -> dict:
    (sync,) = [m for m in _hello(api) if m["type"] == "questionsSync"]
    return {entry["id"]: entry for entry in sync["sets"]}


def _read(api, set_id, headers=CLAUDE):
    return api.client.get(f"/api/canvas/questions/{set_id}", headers=headers)


def _notes_listing(api, headers=PERSON) -> list[dict]:
    return api.client.get("/api/canvas/agent-notes", headers=headers).json()["notes"]


# -- an open set survives ------------------------------------------------------------

def test_an_open_set_survives_a_restart_with_its_id_owner_and_update(kept):
    asked = _ask(kept).json()["questions"]
    set_id = asked["id"]
    (stored,) = _stored(kept)
    assert stored["id"] == set_id and stored["status"] == "open"

    kept.restart()
    read = _read(kept, set_id)
    assert read.status_code == 200, read.text
    view = read.json()["questions"]
    assert view["status"] == "open"
    assert view["agent"] == asked["agent"]
    assert view["questions"] == asked["questions"] and view["note"] == asked["note"]
    assert view["update"] == asked["update"] and view["projectId"] == kept.project_id
    assert view["createdAt"] == asked["createdAt"]
    # Still the asker's only.
    assert _read(kept, set_id, headers=CODEX).status_code == 404

    # Listing the Updates (and a socket connecting) settles proposal Updates;
    # this one's set is still open, so it keeps Answer and gets no outcome.
    (note,) = [n for n in _notes_listing(kept) if n.get("about") == "question"]
    assert "outcome" not in note and "resolvedAt" not in note
    assert note["actions"] == [{"label": "Answer", "op": {"kind": "question.answer", "questionId": set_id}}]
    entry = _sync(kept)[set_id]
    assert entry["status"] == "open" and entry["answerKey"]
    (note,) = _question_updates(kept)
    assert "outcome" not in note


def test_an_answer_after_a_restart_reaches_get_answers(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    old_key = _key(kept, set_id)
    kept.restart()
    new_key = _sync(kept)[set_id]["answerKey"]
    assert new_key != old_key
    # The old launch's key is no good any more.
    assert _answer(kept, set_id, GOOD_ANSWERS, key=old_key).status_code == 403
    answered = _answer(kept, set_id, GOOD_ANSWERS, key=new_key)
    assert answered.status_code == 200, answered.text
    view = _read(kept, set_id).json()["questions"]
    assert view["status"] == "answered"
    assert view["answers"][1]["text"] == SECRET_ANSWER
    (note,) = _question_updates(kept)
    assert note["outcome"] == "Answered."
    # Saved at once: another restart still has the answers for the asker.
    kept.restart()
    again = _read(kept, set_id).json()["questions"]
    assert again["status"] == "answered" and again["answers"] == view["answers"]


def test_the_person_dismisses_after_a_restart(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    kept.restart()
    key = _sync(kept)[set_id]["answerKey"]
    response = kept.client.post(f"/api/canvas/questions/{set_id}/dismiss", headers={**PERSON, KEY: key})
    assert response.status_code == 200
    kept.restart()
    assert _read(kept, set_id).json()["questions"]["status"] == "dismissed"
    (note,) = _question_updates(kept)
    assert note["outcome"] == "Dismissed."


def test_withdraw_after_a_restart(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    kept.restart()
    assert kept.client.delete(f"/api/canvas/questions/{set_id}", headers=CODEX).status_code == 404
    response = kept.client.delete(f"/api/canvas/questions/{set_id}", headers=CLAUDE)
    assert response.status_code == 200, response.text
    assert response.json()["questions"]["status"] == "withdrawn"
    (note,) = _question_updates(kept)
    assert note["outcome"] == "Withdrawn by Claude Code."
    kept.restart()
    assert _read(kept, set_id).json()["questions"]["status"] == "withdrawn"
    assert _sync(kept)[set_id].get("answerKey") is None


def test_the_cap_counts_saved_sets(kept):
    ids = [_ask(kept).json()["questions"]["id"] for _ in range(MAX_OPEN_PER_AGENT)]
    kept.restart()
    refused = _ask(kept)
    assert refused.status_code == 429
    body = refused.json()
    assert body["detail"] == CAP_LINE
    assert [row["id"] for row in body["stillOpen"]] == ids
    assert body["stillOpen"][0]["withdrawWith"] == f"DELETE /api/canvas/questions/{ids[0]}"
    assert kept.questions.open_for_agent("ext:claude-code")[0].id == ids[0]


# -- the key ---------------------------------------------------------------------------

def test_the_answer_key_is_never_stored_and_is_new_after_a_restart(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    old_key = _key(kept, set_id)
    raw = kept.main.project_store.path.read_text(encoding="utf-8")
    assert old_key not in raw
    (stored,) = _stored(kept)
    assert not {"answerKey", "answer_key", "key"} & set(stored)
    kept.restart()
    new_key = _sync(kept)[set_id]["answerKey"]
    assert new_key and new_key != old_key
    assert new_key not in kept.main.project_store.path.read_text(encoding="utf-8")


# -- the closed view and pruning ------------------------------------------------------------

def test_the_closed_view_survives_a_restart(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    assert _answer(kept, set_id, GOOD_ANSWERS).status_code == 200
    kept.restart()
    entry = _sync(kept)[set_id]
    assert entry["status"] == "answered" and "answerKey" not in entry
    assert entry["answers"][1]["text"] == SECRET_ANSWER
    assert [q["text"] for q in entry["questions"]] == ["Which crop for the hero?", "Anything to avoid?"]


def test_pruning_holds_across_restarts(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    assert _answer(kept, set_id, GOOD_ANSWERS).status_code == 200
    kept.clock.now += CLOSED_KEEP_SECONDS + 1
    kept.restart()
    gone = _read(kept, set_id)
    assert gone.status_code == 404
    # The load wrote the prune, so the person's words left the disk too.
    assert _stored(kept) == []
    assert SECRET_BIT not in kept.main.project_store.path.read_text(encoding="utf-8")


# -- whose project ------------------------------------------------------------------------

def _new_project(api, name="Other") -> str:
    revision = api.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    made = api.client.post("/api/projects", headers=PERSON, json={"name": name, "workspaceRevision": revision})
    assert made.status_code == 200, made.text
    return made.json()["project"]["id"]


def test_a_set_stays_with_the_project_it_was_asked_in(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    other = _new_project(kept)  # opens it
    assert kept.main.project_store.read()["activeProjectId"] == other
    assert _stored(kept, other) == []
    # Answering doesn't check the open project: it is kept with the set's.
    assert _answer(kept, set_id, GOOD_ANSWERS).status_code == 200
    kept.restart()
    view = _read(kept, set_id).json()["questions"]
    assert view["status"] == "answered" and view["projectId"] == kept.project_id
    (stored,) = _stored(kept)
    assert stored["status"] == "answered"
    assert _stored(kept, other) == []


def test_recently_deleted_keeps_them_with_the_project(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    revision = kept.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    deleted = kept.client.request("DELETE", f"/api/projects/{kept.project_id}", headers=PERSON,
                                  json={"workspaceRevision": revision})
    assert deleted.status_code == 200, deleted.text
    assert [s["id"] for s in _stored(kept, group="trash")] == [set_id]
    kept.restart()
    assert _read(kept, set_id).json()["questions"]["status"] == "open"
    restored = kept.client.post(f"/api/projects/{kept.project_id}/restore", headers=PERSON)
    assert restored.status_code == 200, restored.text
    kept.restart()
    assert _read(kept, set_id).json()["questions"]["status"] == "open"


def test_deleting_the_project_for_good_forgets_its_sets(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    _new_project(kept)
    revision = kept.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    assert kept.client.request("DELETE", f"/api/projects/{kept.project_id}", headers=PERSON,
                               json={"workspaceRevision": revision}).status_code == 200
    assert kept.client.delete(f"/api/projects/trash/{kept.project_id}", headers=PERSON).status_code == 200
    # Without a restart: the set went with its project, so it doesn't count
    # toward the cap and the asker is told to ask again.
    gone = _read(kept, set_id)
    assert gone.status_code == 404 and "ask again" in gone.json()["detail"]
    assert kept.questions.open_list() == []


# -- a save that fails loses nothing ------------------------------------------------------------

def test_an_answer_that_cannot_be_saved_leaves_the_set_open(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    key = _key(kept, set_id)
    store = kept.main.project_store

    def broken(catalog):
        raise ProjectStoreError("Project storage is unavailable; the canvas was preserved")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(store, "commit", broken)
        failed = _answer(kept, set_id, GOOD_ANSWERS, key=key)
        assert failed.status_code >= 500
        assert SECRET_BIT not in failed.text
    # Nothing was announced as answered, and the person can send again.
    assert kept.questions.get(set_id).is_open
    assert not [m for m in kept.browser if m.get("type") == "questionsClosed"]
    assert _answer(kept, set_id, GOOD_ANSWERS, key=key).status_code == 200
    kept.restart()
    assert _read(kept, set_id).json()["questions"]["status"] == "answered"


# -- a record that can't be read: GM's restart line ---------------------------------------------

def test_a_record_that_cannot_be_read_closes_its_update_with_gm_line(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    store = kept.main.project_store
    with store.transaction() as catalog:
        catalog["projects"][kept.project_id]["agentQuestions"][0]["questions"] = "not a list"
        store.commit(catalog)
    kept.restart()
    (note,) = [n for n in _notes_listing(kept) if n.get("about") == "question"]
    assert note["outcome"] == "Closed when Nebula restarted."
    gone = _read(kept, set_id)
    assert gone.status_code == 404 and "ask again" in gone.json()["detail"]


# GM - Design (PR #193 review, item 6): a set that closed, whose Update then
# couldn't be resolved (a note or project store error), and that was pruned
# after its 30 minutes, says just "Closed." The real restart path above keeps
# "Closed when Nebula restarted."

def _answer_with_update_unresolved(api, monkeypatch) -> tuple[str, dict]:
    set_id = _ask(api).json()["questions"]["id"]
    from services.agent_notes import NoteError

    real = api.main.agent_notes.resolve_questions

    def broken(*_args, **_kwargs):
        raise NoteError(500, "the note store is down")

    monkeypatch.setattr(api.main.agent_notes, "resolve_questions", broken)
    assert _answer(api, set_id, GOOD_ANSWERS).status_code == 200
    (note,) = _question_updates(api)
    assert "outcome" not in note  # the Update didn't hear it closed
    monkeypatch.setattr(api.main.agent_notes, "resolve_questions", real)
    return set_id, note


def test_a_closed_set_pruned_before_its_update_resolved_says_closed(kept, monkeypatch):
    set_id, _ = _answer_with_update_unresolved(kept, monkeypatch)
    kept.clock.now += CLOSED_KEEP_SECONDS + 1
    # Anything that prunes (another ask does), with no restart.
    assert _ask(kept, headers=CODEX).status_code == 201
    assert _read(kept, set_id).status_code == 404
    (note,) = [n for n in _notes_listing(kept) if n.get("about") == "question" and n.get("outcome")]
    assert note["outcome"] == "Closed."


def test_a_closed_set_pruned_at_a_restart_before_its_update_resolved_says_closed(kept, monkeypatch):
    set_id, _ = _answer_with_update_unresolved(kept, monkeypatch)
    kept.clock.now += CLOSED_KEEP_SECONDS + 1
    kept.restart()  # the load prunes it
    assert _read(kept, set_id).status_code == 404
    (note,) = [n for n in _notes_listing(kept) if n.get("about") == "question"]
    assert note["outcome"] == "Closed."
    # The person's words still left the disk.
    assert SECRET_BIT not in kept.main.project_store.path.read_text(encoding="utf-8")


def test_a_resolved_closed_update_leaves_the_record_at_the_next_load(kept, monkeypatch):
    """The #193 review: once "Closed." resolved the Update, its id leaves
    agentQuestionsClosed (kept only while that Update is unresolved), in
    memory at once and on disk at the next load, with no new ask needed."""
    set_id, note = _answer_with_update_unresolved(kept, monkeypatch)
    kept.clock.now += CLOSED_KEEP_SECONDS + 1
    kept.restart()  # the load prunes the set; listing the notes settles its Update
    (settled,) = [n for n in _notes_listing(kept) if n.get("about") == "question"]
    assert settled["outcome"] == "Closed."
    assert not kept.questions.closed_before(kept.project_id, note["id"])
    kept.restart()
    kept.questions.closed_before(kept.project_id, "an_load")  # loads
    assert note["id"] not in (_record(kept).get("agentQuestionsClosed") or [])


# -- the person's words: only the project record and the asker's read ---------------------------

AGENT_ROUTES = (
    "/api/canvas/agent-notes",
    "/api/canvas/events?after=0&wait=0",
    "/api/canvas/pins",
    "/api/canvas/proposals",
    "/api/canvas/snapshot",
    "/api/canvas/selection",
    "/api/asset-proposals",
    "/api/graph",
    "/api/graph/export",
    "/api/project",
    "/api/projects",
    "/api/projects/{pid}",
    "/api/projects/{pid}?view=agent",
    "/api/projects/{pid}/size",
    "/api/projects/{pid}/covers",
    "/api/trash",
    "/api/trash?kind=projects",
    "/api/agent/start?via=mcp",
    "/api/agent/start?via=cli",
)


def _agent_reads(api, project_id: str) -> dict[str, str]:
    seen = {}
    for route in AGENT_ROUTES:
        url = route.replace("{pid}", project_id)
        for name, headers in (("claude", CLAUDE), ("codex", CODEX)):
            response = api.client.get(url, headers=headers)
            seen[f"{name} {url} {response.status_code}"] = response.text
    return seen


def test_the_answers_reach_no_agent_but_the_asker(kept):
    n1 = kept.graph.add_node("text-input", {"value": "a cat"})
    set_id = _ask(kept, {**TWO, "nodeIds": [n1]}).json()["questions"]["id"]
    assert _answer(kept, set_id, GOOD_ANSWERS).status_code == 200
    kept.restart()
    # The asker reads them.
    assert SECRET_BIT in _read(kept, set_id).text
    # Every other agent read, before and after the project goes to Recently deleted.
    reads = _agent_reads(kept, kept.project_id)
    revision = kept.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    assert kept.client.request("DELETE", f"/api/projects/{kept.project_id}", headers=PERSON,
                               json={"workspaceRevision": revision}).status_code == 200
    reads.update({f"trashed {k}": v for k, v in _agent_reads(kept, kept.project_id).items()})
    leaked = [route for route, text in reads.items() if SECRET_BIT in text]
    assert leaked == []
    # The routes really answered (a refusal would prove nothing).
    assert sum(1 for key in reads if key.endswith(" 200")) >= len(AGENT_ROUTES) * 2
    assert _read(kept, set_id, headers=CODEX).status_code == 404
    # The person's own project list (what the canvas loads) doesn't carry them either.
    assert SECRET_BIT not in kept.client.get("/api/projects", headers=PERSON).text
    # The journal, every broadcast to agents, and the Update.
    assert SECRET_BIT not in json.dumps(kept.journal.read(after=0, limit=500)["events"])
    assert SECRET_BIT not in json.dumps(kept.sent)
    # On disk: only inside the set's own record.
    trashed = _record(kept, group="trash")
    rest = {key: value for key, value in trashed.items() if key != "agentQuestions"}
    assert SECRET_BIT not in json.dumps(rest)
    assert SECRET_BIT in json.dumps(trashed["agentQuestions"])


def test_a_project_restored_from_the_trash_and_switched_to_keeps_the_answers_private(kept):
    set_id = _ask(kept).json()["questions"]["id"]
    assert _answer(kept, set_id, GOOD_ANSWERS).status_code == 200
    other = _new_project(kept)
    revision = kept.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    opened = kept.client.post(f"/api/projects/{kept.project_id}/open", headers=PERSON,
                              json={"workspaceRevision": revision})
    assert opened.status_code == 200, opened.text
    assert SECRET_BIT not in opened.text
    assert other != kept.project_id
    reads = _agent_reads(kept, kept.project_id)
    assert [route for route, text in reads.items() if SECRET_BIT in text] == []


# -- review: every way a project goes for good forgets its sets ------------------------------

def _trash_the_project(api) -> None:
    """Open another project, then send the asked-in one to Recently deleted."""
    _new_project(api)
    revision = api.client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]
    deleted = api.client.request("DELETE", f"/api/projects/{api.project_id}", headers=PERSON,
                                 json={"workspaceRevision": revision})
    assert deleted.status_code == 200, deleted.text


def test_emptying_recently_deleted_from_the_panel_forgets_its_sets(kept):
    # The Recently deleted panel empties with POST /api/trash/empty
    # (frontend/src/lib/trash.ts), not /api/projects/trash/empty.
    ids = [_ask(kept).json()["questions"]["id"] for _ in range(MAX_OPEN_PER_AGENT)]
    _trash_the_project(kept)
    emptied = kept.client.post("/api/trash/empty", headers=PERSON)
    assert emptied.status_code == 200, emptied.text
    assert emptied.json()["purged"] >= 1
    assert kept.questions.open_list() == []
    for set_id in ids:
        gone = _read(kept, set_id)
        assert gone.status_code == 404 and "ask again" in gone.json()["detail"]
    # Its sets no longer fill the asker's cap.
    assert _ask(kept).status_code == 201


def test_the_panel_emptying_only_what_it_showed_forgets_those_sets(kept, monkeypatch):
    set_id = _ask(kept).json()["questions"]["id"]
    _trash_the_project(kept)
    # The same gap left the project's node errors behind (/api/projects/trash/empty forgets them).
    kept_errors: list[set] = []
    monkeypatch.setattr(kept.main.node_errors, "keep_projects", lambda ids: kept_errors.append(set(ids)))
    emptied = kept.client.post("/api/trash/empty", headers=PERSON,
                               json={"items": [{"kind": "project", "id": kept.project_id}]})
    assert emptied.status_code == 200, emptied.text
    assert kept.questions.get(set_id) is None
    assert kept_errors and all(kept.project_id not in ids for ids in kept_errors)


def test_recently_deleted_expiring_when_its_list_opens_forgets_its_sets(kept):
    # GET /api/trash (what the panel loads each time it opens) purges trash
    # past its 30 days before /api/projects or a restore gets to.
    set_id = _ask(kept).json()["questions"]["id"]
    _trash_the_project(kept)
    store = kept.main.project_store
    with store.transaction() as catalog:
        catalog["trash"][kept.project_id]["deletedAt"] = "2020-01-01T00:00:00+00:00"
        store.commit(catalog)
    listed = kept.client.get("/api/trash", headers=PERSON)
    assert listed.status_code == 200, listed.text
    assert kept.project_id not in kept.main.project_store.read().get("trash", {})
    assert kept.questions.open_list() == []
    gone = _read(kept, set_id)
    assert gone.status_code == 404 and "ask again" in gone.json()["detail"]


# -- review: a set is kept only while the person can reach it ---------------------------------

def _drop_update(api, set_id: str) -> None:
    """Take a set's Update off its project's list (a hand-edited or damaged record)."""
    store = api.main.project_store
    with store.transaction() as catalog:
        record = catalog["projects"][api.project_id]
        note_id = next(s["update"]["id"] for s in record["agentQuestions"] if s["id"] == set_id)
        record["agentNotes"] = [n for n in record["agentNotes"] if n.get("id") != note_id]
        store.commit(catalog)


def test_an_open_set_whose_update_is_gone_is_not_kept_after_a_restart(kept):
    lost = _ask(kept).json()["questions"]["id"]
    still = _ask(kept).json()["questions"]["id"]
    _drop_update(kept, lost)
    kept.restart()
    assert [s.id for s in kept.questions.open_list()] == [still]
    assert _read(kept, lost).status_code == 404
    # The load rewrote the record without it.
    assert [s["id"] for s in _stored(kept)] == [still]


def test_an_open_set_whose_update_left_the_list_stops_counting_at_once(kept):
    # The 200-Update prune never takes an open set's Update any more
    # (tests/test_agent_questions_final.py), so only a hand-edited or damaged
    # record gets here; the book still forgets such a set without a restart.
    ids = [_ask(kept).json()["questions"]["id"] for _ in range(MAX_OPEN_PER_AGENT)]
    _drop_update(kept, ids[0])
    # Withdraw one so the agent has room, then ask: the ask sees the first set can't be reached.
    assert kept.client.delete(f"/api/canvas/questions/{ids[2]}", headers=CLAUDE).status_code == 200
    asked = _ask(kept)
    assert asked.status_code == 201, asked.text
    assert ids[0] not in {s.id for s in kept.questions.open_list()}
    assert ids[0] not in {s["id"] for s in _stored(kept)}
    assert _read(kept, ids[0]).status_code == 404


def test_write_into_never_keeps_a_set_whose_update_is_not_on_the_record(kept):
    from services.agent_questions import parse_questions

    asked = _ask(kept).json()["questions"]["id"]
    book = kept.questions
    ghost = book.create(agent=book.get(asked).agent, project_id=kept.project_id, spec=parse_questions(TWO))
    # As if save_set ran but its commit failed and another save got in first.
    ghost.update = {"id": "never-committed", "projectId": kept.project_id}
    assert _answer(kept, asked, GOOD_ANSWERS).status_code == 200
    assert [s["id"] for s in _stored(kept)] == [asked]
    assert book.get(ghost.id) is None
    kept.restart()
    assert kept.questions.open_list() == []


# -- review: unreachable sets don't hold the total cap ---------------------------------------

def _agents(n: int) -> list[dict]:
    return [{"X-Nebula-Agent": f"Helper {i}"} for i in range(n)]


def test_sets_in_recently_deleted_dont_hold_the_total_cap(kept):
    from services.agent_questions import MAX_OPEN_TOTAL

    helpers = _agents(MAX_OPEN_TOTAL // MAX_OPEN_PER_AGENT)
    for headers in helpers:
        for _ in range(MAX_OPEN_PER_AGENT):
            assert _ask(kept, headers=headers).status_code == 201
    full = _ask(kept, headers={"X-Nebula-Agent": "Newcomer"})
    assert full.status_code == 429  # all 12 reachable: the cap holds
    _trash_the_project(kept)
    # The person can't answer sets in Recently deleted, so a new agent may ask.
    assert _ask(kept, headers={"X-Nebula-Agent": "Newcomer"}).status_code == 201
    kept.restart()
    assert _ask(kept, headers={"X-Nebula-Agent": "Latecomer"}).status_code == 201
    # The trashed sets are still kept with their project, and its own agents
    # still see theirs (they count toward each one's own cap, which lists them).
    assert len(_stored(kept, kept.project_id, group="trash")) == MAX_OPEN_TOTAL
    refused = _ask(kept, headers=helpers[0])
    assert refused.status_code == 429 and refused.json()["detail"] == CAP_LINE
    assert len(refused.json()["stillOpen"]) == MAX_OPEN_PER_AGENT
