"""Questions: an agent asks the person, the person answers or dismisses.

Q125 item 1 (Justin, 2026-10-24: "Yes, all four, in that order"; then "go
with your suggestions"). When an agent hits a decision only the person can
make (which direction, a name, a detail it can't find), it asks 1-5 short
questions (``ask_person``, ``nebula ask``, ``POST /api/canvas/questions``)
and waits for the answers (``get_answers``). A concrete change to approve is
a proposal instead (services/canvas_proposals.py), and what it noticed is an
Update (post_note).

Modelled on proposals, with one difference: sets are kept.

- Kept with the project they were asked in (follow-up in the same PR,
  2026-10-24: a side agent noted that memory-only sets closed on a restart
  and lost the person's unsent answers, and GM - Design agreed). Each lives
  on its project's record, ``catalog["projects"][id]["agentQuestions"]``,
  next to pins and agentNotes and outside ``snapshot`` (services/
  agent_notes.py's storage rules): the browser's autosave never drops them,
  Recently deleted keeps them with the project (it moves the whole record)
  and deleting the project for good forgets them (``keep_projects``). An
  open set survives a restart with its id, owner and Update; so does the
  closed view (each question and its answer) of a recent one (CLOSED_KEEP_
  SECONDS, at most MAX_CLOSED). Unlike a proposal it depends on nothing in
  the graph and has no time limit, and an outside agent outlives a restart.
  There is no time expiry: a set closes when the person answers or
  dismisses it, or the agent withdraws it. Only a record that can't be read
  back (or an Update older than kept sets) loses its set; that Update then
  says "Closed when Nebula restarted." (main._settle_question_update).
- Open caps: MAX_OPEN_PER_AGENT per agent identity and MAX_OPEN_TOTAL in
  all (only sets the person can answer now: not those in Recently deleted).
  An open set whose Update has left its project's list isn't kept. The
  refusal (CAP_LINE) lists the agent's open sets with the exact call that
  withdraws each (``still_open``), as a proposal's ``stillOpen`` does.
- Only the person answers or dismisses. Every set carries an ``answer_key``
  that goes only to browser sockets that said hello with this launch's person
  token; the answer and dismiss routes require it as well as
  person_gate.require_person (no agent marker, the person token). ``view()``
  and the stored record leave the key out by construction: each launch makes
  a new one when it loads the sets.
- Owner-scoped. The answers go to the agent that asked: every agent route
  answers another agent's set as not there (404). The person's typed text is
  their message to that agent: it is never journaled, logged, put on an
  Update or sent to a socket other than the person's own. On disk it is only
  in the set's own record, which no agent route reads (project_store's
  metadata, public_project and project_view.agent_project name their keys).

Forward (Q125 items 2 and 3, not built here): ``open_for_agent`` lists one
agent identity's open sets, so a later "Needs you" count is proposals plus
questions without new plumbing.
"""
from __future__ import annotations

import re
import secrets
import threading
import time
import unicodedata
from collections import OrderedDict
from contextlib import nullcontext
from dataclasses import dataclass, field
from typing import Any, Callable, Container, Iterable, Mapping

from services.agent_presence import AgentIdentity
from services.project_store import ProjectStore

MAX_QUESTIONS = 5
MAX_TEXT = 200
MIN_OPTIONS = 2
MAX_OPTIONS = 6
MAX_OPTION = 80
MAX_NOTE = 160
MAX_NODE_IDS = 12  # an Update names at most 12 things (agent_notes.MAX_REFS)
MAX_ANSWER_TEXT = 1000
MAX_OPEN_PER_AGENT = 3
MAX_OPEN_TOTAL = 12
# As proposals keep a decided one (canvas_proposals.CLOSED_KEEP_SECONDS, MAX_CLOSED).
CLOSED_KEEP_SECONDS = 1800
MAX_CLOSED = 50

OPEN = "open"
CLOSED_STATUSES = frozenset({"answered", "dismissed", "withdrawn"})

# Where a project's sets are kept on its record (next to pins and agentNotes).
RECORD_KEY = "agentQuestions"
_SET_ID = re.compile(r"^qs_[0-9a-f]{8}$")

# GM - Design's agent-facing line at the cap, verbatim.
CAP_LINE = "You already have 3 open question sets. Wait for answers or withdraw one."
TOTAL_LINE = "Too many question sets are waiting for the person. Wait for answers or withdraw one of yours."

# How each surface's agent withdraws a set ({id} is its id).
WITHDRAW_HTTP = "DELETE /api/canvas/questions/{id}"
WITHDRAW_MCP = 'withdraw_questions(question_id="{id}")'
WITHDRAW_CLI = "nebula questions withdraw {id}"

_SET_KEYS = frozenset({"questions", "note", "nodeIds"})
_QUESTION_KEYS = ("text", "options", "multiple", "allowText")
_ANSWER_KEYS = frozenset({"questionId", "choices", "text"})


class QuestionError(Exception):
    def __init__(self, status: int, detail: str, *, still_open: list[dict[str, Any]] | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        # At the cap: the agent's open sets ({id, questions, askedAt}).
        self.still_open = list(still_open or [])


# -- text ---------------------------------------------------------------------------

def _plain(raw: str, *, keep_lines: bool) -> str:
    """Control, format and private-use characters dropped (as agent_notes'
    clean_note_text: private use is how an Update marks a board image ref)."""
    kept = []
    for char in raw:
        if char in "\t\r\n":
            kept.append("\n" if keep_lines and char == "\n" else " ")
        elif unicodedata.category(char) not in {"Cc", "Cf", "Co"}:
            kept.append(char)
    text = "".join(kept)
    if not keep_lines:
        return " ".join(text.split())
    lines = [" ".join(line.split()) for line in text.split("\n")]
    # At most one blank line in a row, none at either end.
    out: list[str] = []
    for line in lines:
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip("\n")


def clean_line(raw: Any, *, limit: int, label: str) -> str:
    """One plain line, 1..limit characters (pins and Updates clean text the same way)."""
    if not isinstance(raw, str):
        raise QuestionError(422, f"{label} must be text")
    text = _plain(raw, keep_lines=False)
    if not text:
        raise QuestionError(422, f"{label} can't be empty")
    if len(text) > limit:
        raise QuestionError(422, f"{label} must be {limit} characters or fewer (this one is {len(text)})")
    return text


def clean_answer_text(raw: Any, *, label: str) -> str | None:
    """The person's typed answer: plain text, line breaks kept, at most
    MAX_ANSWER_TEXT characters; None when blank. A refusal never quotes it."""
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise QuestionError(422, f"{label} must be text")
    text = _plain(raw, keep_lines=True)
    if not text:
        return None
    if len(text) > MAX_ANSWER_TEXT:
        raise QuestionError(422, f"{label} must be {MAX_ANSWER_TEXT} characters or fewer (this one is {len(text)})")
    return text


def _flag(raw: Any, label: str, default: bool) -> bool:
    if raw is None:
        return default
    if not isinstance(raw, bool):
        raise QuestionError(422, f"{label} must be true or false")
    return raw


# -- the request ----------------------------------------------------------------------

@dataclass(frozen=True)
class Question:
    id: str
    text: str
    options: tuple[str, ...] = ()
    multiple: bool = False
    allow_text: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "text": self.text, "options": list(self.options), "multiple": self.multiple,
                "allowText": self.allow_text}


@dataclass(frozen=True)
class QuestionSpec:
    questions: tuple[Question, ...]
    note: str | None = None
    node_ids: tuple[str, ...] = ()

    def question(self, question_id: str) -> Question | None:
        return next((q for q in self.questions if q.id == question_id), None)


def _options(raw: Any, label: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise QuestionError(422, f"{label} must be a list of {MIN_OPTIONS} to {MAX_OPTIONS} short choices")
    if not raw:
        return ()
    if not MIN_OPTIONS <= len(raw) <= MAX_OPTIONS:
        raise QuestionError(422, f"{label} takes {MIN_OPTIONS} to {MAX_OPTIONS} options (this one has {len(raw)}); "
                                 "leave options out for a typed answer only")
    options: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        option = clean_line(item, limit=MAX_OPTION, label=f"{label}[{index}]")
        folded = option.casefold()
        if folded in seen:
            raise QuestionError(422, f"{label} must all be different ('{option[:40]}' is there twice)")
        seen.add(folded)
        options.append(option)
    return tuple(options)


def parse_questions(body: Any) -> QuestionSpec:
    """Shape-check and clean a question set. Node ids are checked against the
    canvas in main (unknown ones are dropped and listed, as an Update's refs)."""
    if not isinstance(body, dict):
        raise QuestionError(422, "a question set must be a JSON object: {questions, note?, nodeIds?}")
    unknown = sorted(str(key) for key in body if key not in _SET_KEYS)
    if unknown:
        raise QuestionError(422, f"unknown field '{unknown[0][:40]}': a question set is {{questions, note, nodeIds}}")
    raw_questions = body.get("questions")
    if not isinstance(raw_questions, list) or not 1 <= len(raw_questions) <= MAX_QUESTIONS:
        raise QuestionError(422, f"ask 1 to {MAX_QUESTIONS} questions: questions is a list of "
                                 '{"text": "...", "options"?: [...], "multiple"?: false, "allowText"?: true}')
    questions: list[Question] = []
    for index, raw in enumerate(raw_questions):
        label = f"questions[{index}]"
        if not isinstance(raw, dict):
            raise QuestionError(422, f'{label} must be an object: {{"text": "...", "options"?: [...]}}')
        extra = sorted(str(key) for key in raw if key not in _QUESTION_KEYS)
        if extra:
            raise QuestionError(422, f"{label} has unknown field '{extra[0][:40]}': a question is "
                                     "{text, options, multiple, allowText}")
        text = clean_line(raw.get("text"), limit=MAX_TEXT, label=f"{label}.text")
        options = _options(raw.get("options"), f"{label}.options")
        multiple = _flag(raw.get("multiple"), f"{label}.multiple", False)
        allow_text = _flag(raw.get("allowText"), f"{label}.allowText", True)
        if multiple and not options:
            raise QuestionError(422, f"{label}.multiple needs options to pick from")
        if not options and not allow_text:
            raise QuestionError(422, f"{label} has no options, so it must allow a typed answer (allowText)")
        questions.append(Question(id=f"q{index + 1}", text=text, options=options, multiple=multiple,
                                  allow_text=allow_text))
    note = None
    if body.get("note") not in (None, ""):
        note = clean_line(body.get("note"), limit=MAX_NOTE, label="note")
    raw_ids = body.get("nodeIds")
    node_ids: list[str] = []
    if raw_ids is not None:
        if not isinstance(raw_ids, list) or not all(isinstance(item, str) for item in raw_ids):
            raise QuestionError(422, "nodeIds must be a list of node ids like n4")
        for item in raw_ids:
            if item.strip() and item.strip() not in node_ids:
                node_ids.append(item.strip())
        if len(node_ids) > MAX_NODE_IDS:
            raise QuestionError(422, f"a question set names at most {MAX_NODE_IDS} nodes (this one names "
                                     f"{len(node_ids)})")
    return QuestionSpec(questions=tuple(questions), note=note, node_ids=tuple(node_ids))


def parse_answers(spec: QuestionSpec, body: Any) -> list[dict[str, Any]]:
    """The person's answers, one per question in the set's order:
    {questionId, answered, choices, text}. A question left out or left blank
    is answered=false; at least one must be answered (else dismiss)."""
    if not isinstance(body, dict):
        raise QuestionError(422, "body must be a JSON object: {answers: [...]}")
    raw = body.get("answers")
    if not isinstance(raw, list):
        raise QuestionError(422, "answers must be a list of {questionId, choices?, text?}")
    given: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        label = f"answers[{index}]"
        if not isinstance(item, dict):
            raise QuestionError(422, f"{label} must be an object: {{questionId, choices?, text?}}")
        extra = sorted(str(key) for key in item if key not in _ANSWER_KEYS)
        if extra:
            raise QuestionError(422, f"{label} has unknown field '{extra[0][:40]}'")
        question_id = item.get("questionId")
        question = spec.question(question_id) if isinstance(question_id, str) else None
        if question is None:
            raise QuestionError(422, f"{label}: there is no question {str(question_id)[:12]} in this set")
        if question.id in given:
            raise QuestionError(422, f"{label}: {question.id} is answered twice")
        choices_raw = item.get("choices")
        if choices_raw is None:
            choices_raw = []
        if not isinstance(choices_raw, list) or not all(isinstance(c, str) for c in choices_raw):
            raise QuestionError(422, f"{label}.choices must be a list of the question's options")
        if choices_raw and not question.options:
            raise QuestionError(422, f"{label}: {question.id} has no options; type the answer instead")
        picked = set()
        for choice in choices_raw:
            if choice not in question.options:
                raise QuestionError(422, f"{label}: a choice isn't one of its options")
            picked.add(choice)
        if len(picked) > 1 and not question.multiple:
            raise QuestionError(422, f"{label}: {question.id} takes one choice")
        text = clean_answer_text(item.get("text"), label=f"{label}.text")
        if text is not None and not question.allow_text:
            raise QuestionError(422, f"{label}: {question.id} takes no typed answer, only its options")
        choices = [option for option in question.options if option in picked]
        given[question.id] = {"questionId": question.id, "answered": bool(choices or text), "choices": choices,
                              "text": text}
    answers = [given.get(q.id) or {"questionId": q.id, "answered": False, "choices": [], "text": None}
               for q in spec.questions]
    if not any(answer["answered"] for answer in answers):
        raise QuestionError(422, "Answer at least one question, or dismiss them.")
    return answers


# -- stored sets -------------------------------------------------------------------------

@dataclass
class QuestionSet:
    id: str
    agent: AgentIdentity
    project_id: str | None
    spec: QuestionSpec
    created_at: float
    status: str = OPEN
    answers: list[dict[str, Any]] | None = None
    closed_at: float | None = None
    # Its Update on the project's list ({id, projectId}); main posts and settles it.
    update: dict[str, str] | None = None
    # Only ever sent to the person's browser sockets; never in view(), REST, journal or logs.
    answer_key: str = field(default_factory=lambda: secrets.token_urlsafe(24), repr=False)

    @property
    def is_open(self) -> bool:
        return self.status == OPEN


def new_set_id() -> str:
    return "qs_" + secrets.token_hex(4)


def _brief(question_set: QuestionSet, created_ms: int) -> dict[str, Any]:
    return {"id": question_set.id, "questions": [q.text for q in question_set.spec.questions], "askedAt": created_ms}


# -- the stored record ---------------------------------------------------------------------

def to_record(question_set: QuestionSet) -> dict[str, Any]:
    """A set as its project's record keeps it: everything view() shows but
    the project id (the record it is on) and never the answer key."""
    spec = question_set.spec
    return {
        "id": question_set.id,
        "status": question_set.status,
        "agent": question_set.agent.as_dict(),
        "createdAt": int(question_set.created_at * 1000),
        "closedAt": int(question_set.closed_at * 1000) if question_set.closed_at is not None else None,
        "note": spec.note,
        "nodeIds": list(spec.node_ids),
        "questions": [question.as_dict() for question in spec.questions],
        "answers": [dict(answer) for answer in question_set.answers] if question_set.answers else None,
        "update": dict(question_set.update) if question_set.update else None,
    }


def _millis(raw: Any) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw < 0:
        raise ValueError("not a time")
    return raw / 1000


def _text_field(raw: Any, limit: int) -> str:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > limit:
        raise ValueError("not a short text")
    return raw


def from_record(raw: Any, project_id: str) -> QuestionSet | None:
    """A stored set read back, checked as strictly as when it was asked (the
    same parse), or None when it can't be read: its Update then closes with
    GM's restart line. A new answer key comes with it."""
    try:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not _SET_ID.fullmatch(raw["id"]):
            return None
        status = raw.get("status")
        if status != OPEN and status not in CLOSED_STATUSES:
            return None
        agent = raw.get("agent")
        if not isinstance(agent, dict) or not isinstance(agent.get("verified"), bool):
            return None
        identity = AgentIdentity(id=_text_field(agent.get("id"), 128), name=_text_field(agent.get("name"), 80),
                                 color=_text_field(agent.get("color"), 32), verified=agent["verified"])
        questions = raw.get("questions")
        if not isinstance(questions, list):
            return None
        spec = parse_questions({
            "questions": [{key: q.get(key) for key in _QUESTION_KEYS} if isinstance(q, dict) else q
                          for q in questions],
            "note": raw.get("note"),
            "nodeIds": raw.get("nodeIds") or [],
        })
        if [q.get("id") if isinstance(q, dict) else None for q in questions] != [q.id for q in spec.questions]:
            return None
        update = raw.get("update")
        if (not isinstance(update, dict) or not isinstance(update.get("id"), str) or not update["id"]
                or update.get("projectId") != project_id):
            return None
        answers = None
        if status == "answered":
            stored = raw.get("answers")
            if not isinstance(stored, list):
                return None
            answers = parse_answers(spec, {"answers": [
                {"questionId": a.get("questionId"), "choices": a.get("choices") or [], "text": a.get("text")}
                for a in stored if isinstance(a, dict) and a.get("answered")]})
        elif raw.get("answers") is not None:
            return None
        created_at = _millis(raw.get("createdAt"))
        closed_at = None if status == OPEN else _millis(raw.get("closedAt"))
        return QuestionSet(id=raw["id"], agent=identity, project_id=project_id, spec=spec, created_at=created_at,
                           status=status, answers=answers, closed_at=closed_at,
                           update={"id": update["id"][:64], "projectId": project_id})
    except (QuestionError, ValueError, TypeError, KeyError, AttributeError):
        return None


def _note_ids(record: Mapping[str, Any]) -> set[str]:
    notes = record.get("agentNotes")
    return {str(n.get("id")) for n in notes if isinstance(n, dict)} if isinstance(notes, list) else set()


def _has_update(question_set: QuestionSet, note_ids: set[str]) -> bool:
    """Whether the set may be kept: an open one only while its Update (where
    the person answers it) is still on the project's list. A closed one is
    kept for its 30 minutes either way, so the asker still gets its answers."""
    if not question_set.is_open:
        return True
    return bool(question_set.update) and question_set.update.get("id") in note_ids


class QuestionBook:
    """Open question sets plus recently closed ones (30 minutes, at most 50),
    each kept on the record of the project it was asked in.

    With no ``store`` (unit tests of the rules) it is memory only. With one,
    it loads every project's sets (and those in Recently deleted) on first
    use, and again if the store changes (tests swap ``main.project_store``),
    and writes a project's sets back whenever one of them changes. Two locks,
    always taken in this order: the catalog's (``ProjectStore.transaction``),
    then this book's. Nothing holding the book's lock waits for the catalog.
    """

    def __init__(self, clock: Callable[[], float] = time.time, *,
                 store: ProjectStore | Callable[[], ProjectStore] | None = None) -> None:
        self._clock = clock
        self._store_source = store
        self._items: OrderedDict[str, QuestionSet] = OrderedDict()
        # Projects whose stored sets differ from these (written on the next save).
        self._dirty: set[str] = set()
        self._loaded_from: Any = None
        self._lock = threading.RLock()

    def now(self) -> float:
        return self._clock()

    # -- storage ------------------------------------------------------------------
    def _store(self) -> ProjectStore | None:
        source = self._store_source
        if source is None or isinstance(source, ProjectStore):
            return source
        return source()

    def _ensure_loaded(self) -> None:
        store = self._store()
        if store is None or self._loaded_from == store.path:
            return
        with store.transaction() as catalog:
            with self._lock:
                if self._loaded_from == store.path:
                    return
                self._load(catalog)
                self._loaded_from = store.path
                if self._dirty and self._write_into(catalog):
                    store.commit(catalog)
                self._dirty.clear()

    def _load(self, catalog: Mapping[str, Any]) -> None:
        found: list[QuestionSet] = []
        self._items = OrderedDict()
        self._dirty = set()
        for group in ("projects", "trash"):
            for project_id, record in (catalog.get(group) or {}).items():
                stored = record.get(RECORD_KEY) if isinstance(record, dict) else None
                if stored is None:
                    continue
                read = [from_record(raw, project_id) for raw in stored] if isinstance(stored, list) else []
                notes = _note_ids(record)
                # An open set whose Update is gone (pruned past 200) can't be
                # reached by the person: it isn't kept, so it holds no cap.
                kept = [question_set for question_set in read
                        if question_set is not None and _has_update(question_set, notes)]
                if not isinstance(stored, list) or len(kept) != len(stored):
                    self._dirty.add(project_id)  # an unreadable entry: rewritten without it
                found.extend(kept)
        # Oldest first, as they were asked; a stable sort keeps each project's
        # stored order for sets asked in the same millisecond.
        found.sort(key=lambda s: s.created_at)
        for question_set in found:
            if question_set.id in self._items:
                self._dirty.add(question_set.project_id or "")
                continue
            self._items[question_set.id] = question_set
        self._prune()

    def _record_for(self, catalog: Mapping[str, Any], project_id: str) -> dict[str, Any] | None:
        for group in ("projects", "trash"):
            record = (catalog.get(group) or {}).get(project_id)
            if isinstance(record, dict):
                return record
        return None

    def _write_into(self, catalog: Mapping[str, Any], project_ids: Iterable[str] = ()) -> bool:
        """Put the dirty projects' sets (and ``project_ids``') on their records
        in ``catalog`` (the caller commits it). A project that is gone for
        good takes its sets with it. Returns whether the catalog changed.
        Only a set whose Update was posted is kept, and an open one only
        while that Update is still on the record: the person can't reach one
        without it. Call holding the catalog's lock, then this book's."""
        changed = False
        for project_id in sorted(self._dirty | set(project_ids)):
            if not project_id:
                continue
            record = self._record_for(catalog, project_id)
            if record is None:
                for question_set in [s for s in self._items.values() if s.project_id == project_id]:
                    self._items.pop(question_set.id, None)
                continue
            notes = _note_ids(record)
            for question_set in [s for s in self._items.values() if s.project_id == project_id
                                 and s.update and not _has_update(s, notes)]:
                # Its Update was pruned, or never committed (a failed post a
                # concurrent save got ahead of): the person can't reach it.
                self._items.pop(question_set.id, None)
            rows = [to_record(s) for s in self._items.values() if s.project_id == project_id and s.update]
            if rows:
                if record.get(RECORD_KEY) != rows:
                    record[RECORD_KEY] = rows
                    changed = True
            elif RECORD_KEY in record:
                del record[RECORD_KEY]
                changed = True
        return changed

    def write_into(self, catalog: Mapping[str, Any], project_ids: Iterable[str] = ()) -> bool:
        """For a caller already holding the catalog in a transaction
        (AgentNotes.post_questions writes a new set with its Update, in one
        commit). Returns whether the catalog changed."""
        with self._lock:
            return self._write_into(catalog, project_ids)

    def _transaction(self):
        store = self._store()
        return store.transaction() if store is not None else nullcontext(None)

    def keep_projects(self, project_ids: Container[str]) -> None:
        """Forget the sets of projects deleted for good (the trash emptied or
        expired). Memory only: their records are gone already."""
        with self._lock:
            for question_set in list(self._items.values()):
                if question_set.project_id and question_set.project_id not in project_ids:
                    self._items.pop(question_set.id, None)
                    self._dirty.discard(question_set.project_id)

    # -- the sets ---------------------------------------------------------------------
    def create(self, *, agent: AgentIdentity, project_id: str | None, spec: QuestionSpec) -> QuestionSet:
        """Open a set (enforcing the open caps, which count kept sets too).
        It is saved with its Update (main._post_question_update, one commit);
        until then it is in memory only, and drop() forgets it.

        The per-agent cap counts all the agent's open sets: the refusal lists
        each with its withdraw call. The total counts only sets the person
        can answer now: one in a project in Recently deleted waits there
        (restoring it brings it back) but holds no other agent off, since
        nobody but its owner could withdraw it. Blocking: it reads the catalog."""
        self._ensure_loaded()
        with self._transaction() as catalog:
            with self._lock:
                self._prune()
                if catalog is not None:
                    self._forget_unreachable(catalog)
                open_now = [s for s in self._items.values() if s.is_open]
                mine = [s for s in open_now if s.agent.id == agent.id]
                if len(mine) >= MAX_OPEN_PER_AGENT:
                    raise QuestionError(429, CAP_LINE, still_open=[_brief(s, int(s.created_at * 1000)) for s in mine])
                answerable = [s for s in open_now if catalog is None or s.update is None
                              or s.project_id in (catalog.get("projects") or {})]
                if len(answerable) >= MAX_OPEN_TOTAL:
                    raise QuestionError(429, TOTAL_LINE, still_open=[_brief(s, int(s.created_at * 1000)) for s in mine])
                question_set = QuestionSet(id=new_set_id(), agent=agent, project_id=project_id, spec=spec,
                                           created_at=self._clock())
                while question_set.id in self._items:  # ids must be unique
                    question_set.id = new_set_id()
                self._items[question_set.id] = question_set
                return question_set

    def _forget_unreachable(self, catalog: Mapping[str, Any]) -> None:
        """Open sets the person can no longer reach: their project is gone for
        good (whichever route purged it), or their Update is off its list.
        Memory now; their records are rewritten on the next save. A set still
        being posted (no Update yet) is left alone."""
        for question_set in [s for s in self._items.values() if s.is_open and s.project_id and s.update]:
            record = self._record_for(catalog, question_set.project_id)
            if record is None:
                self._items.pop(question_set.id, None)
            elif not _has_update(question_set, _note_ids(record)):
                self._items.pop(question_set.id, None)
                self._dirty.add(question_set.project_id)

    def drop(self, set_id: str) -> None:
        """Forget a set that never reached the person (its Update couldn't be
        posted, so it was never saved either)."""
        with self._lock:
            self._items.pop(set_id, None)

    def get(self, set_id: str) -> QuestionSet | None:
        self._ensure_loaded()
        with self._lock:
            return self._items.get(set_id)

    def open_list(self) -> list[QuestionSet]:
        self._ensure_loaded()
        with self._lock:
            return [s for s in self._items.values() if s.is_open]

    def closed_list(self) -> list[QuestionSet]:
        self._ensure_loaded()
        with self._lock:
            return [s for s in self._items.values() if not s.is_open]

    def open_for_agent(self, agent_id: str) -> list[QuestionSet]:
        """One agent identity's open sets, oldest first (the forward hook for
        Q125 items 2 and 3: "Needs you" counts these with proposals)."""
        return [s for s in self.open_list() if s.agent.id == agent_id]

    def close(self, set_id: str, status: str, *, answers: list[dict[str, Any]] | None = None) -> QuestionSet:
        """Close a set and save it before returning, so an answer the person
        sent is on disk before they are told it was sent. If the save fails
        the set stays open (ProjectStoreError goes to the caller) and they
        can send again. Blocking: call it off the event loop."""
        if status not in CLOSED_STATUSES:
            raise ValueError(f"unknown question set status '{status}'")
        self._ensure_loaded()
        store = self._store()
        with self._transaction() as catalog:
            with self._lock:
                question_set = self._items.get(set_id)
                if question_set is None:
                    raise QuestionError(404, f"No question set {set_id[:20]}")
                if not question_set.is_open:
                    raise QuestionError(409, f"These questions are already {question_set.status}")
                before = (question_set.status, question_set.answers, question_set.closed_at)
                question_set.status = status
                question_set.answers = [dict(a) for a in answers] if status == "answered" and answers else None
                question_set.closed_at = self._clock()
                if catalog is not None and question_set.project_id:
                    try:
                        if self._write_into(catalog, [question_set.project_id]):
                            store.commit(catalog)
                        self._dirty.clear()
                    except BaseException:
                        question_set.status, question_set.answers, question_set.closed_at = before
                        raise
                    if set_id not in self._items:  # its project was deleted for good meanwhile
                        raise QuestionError(404, "These questions are no longer available")
                self._prune()
                return question_set

    def _prune(self) -> None:
        """Closed sets past CLOSED_KEEP_SECONDS, then the oldest past
        MAX_CLOSED; their projects are rewritten on the next save."""
        now = self._clock()
        for question_set in [s for s in self._items.values() if not s.is_open]:
            if question_set.closed_at is not None and now - question_set.closed_at > CLOSED_KEEP_SECONDS:
                self._items.pop(question_set.id, None)
                self._dirty.add(question_set.project_id or "")
        closed = [s for s in self._items.values() if not s.is_open]
        for question_set in closed[: max(0, len(closed) - MAX_CLOSED)]:
            self._items.pop(question_set.id, None)
            self._dirty.add(question_set.project_id or "")

    # -- what the asking agent and the person's canvas see (never the key) -----
    def view(self, question_set: QuestionSet) -> dict[str, Any]:
        """The set as its own agent reads it (get_answers) and the person's
        canvas draws it. Never sent to another agent: it holds the answers."""
        spec = question_set.spec
        return {
            "id": question_set.id,
            "status": question_set.status,
            "agent": question_set.agent.as_dict(),
            "note": spec.note,
            "projectId": question_set.project_id,
            "nodeIds": list(spec.node_ids),
            "createdAt": int(question_set.created_at * 1000),
            "closedAt": int(question_set.closed_at * 1000) if question_set.closed_at else None,
            "questions": [question.as_dict() for question in spec.questions],
            "answers": [dict(answer) for answer in question_set.answers] if question_set.answers else None,
            "update": dict(question_set.update) if question_set.update else None,
        }


def withdraw_call(set_id: str, form: str = WITHDRAW_HTTP) -> str:
    return form.replace("{id}", set_id)


def still_open_rows(rows: Iterable[Mapping[str, Any]], *, withdraw: str = WITHDRAW_HTTP) -> list[dict[str, Any]]:
    """The cap refusal's open sets, each with the call that withdraws it in one surface's words."""
    return [{**row, "withdrawWith": withdraw_call(str(row["id"]), withdraw)} for row in rows if row.get("id")]


def cap_message(detail: str, rows: Iterable[Mapping[str, Any]]) -> str:
    """CAP_LINE (or TOTAL_LINE) and each open set with its withdraw call, in one paragraph."""
    parts = []
    for row in rows:
        questions = [str(q) for q in row.get("questions") or []]
        first = questions[0] if questions else ""
        first = first if len(first) <= 60 else first[:59] + "…"
        more = f" and {len(questions) - 1} more" if len(questions) > 1 else ""
        parts.append(f'{row["id"]} ("{first}"{more}): `{row["withdrawWith"]}`')
    return f"{detail} Open: {'; '.join(parts)}." if parts else detail


# -- the Update each set posts -------------------------------------------------------
#
# GM - Design's copy, verbatim: "{agent} has a question." / "{agent} has {n}
# questions.", one Answer button, and once it closes: "Answered."
# "Dismissed." "Withdrawn by {agent}." "Closed when Nebula restarted."
# (Proposals keep "Closed: Nebula restarted".) Sets are kept with the
# project now, so a restart closes nothing by itself: the restart line is
# left for an Update whose set can't be read back (a damaged or unknown
# record, or a set from a build that didn't keep them).

RESTART_OUTCOME = "Closed when Nebula restarted."
_OUTCOMES = {"answered": "Answered.", "dismissed": "Dismissed."}


def update_text(question_set: QuestionSet) -> str:
    """The Update's line, from a fixed template: never the questions (they are the form's)."""
    agent = question_set.agent.name
    count = len(question_set.spec.questions)
    return f"{agent} has a question." if count == 1 else f"{agent} has {count} questions."


def update_outcome(question_set: QuestionSet) -> str:
    if question_set.status == "withdrawn":
        return f"Withdrawn by {question_set.agent.name}."
    return _OUTCOMES.get(question_set.status, RESTART_OUTCOME)


# main builds the app's book over its project store (main.agent_questions).
