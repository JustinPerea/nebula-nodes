"""Questions: an agent asks the person, the person answers or dismisses.

Q125 item 1 (Justin, 2026-10-24: "Yes, all four, in that order"; then "go
with your suggestions"). When an agent hits a decision only the person can
make (which direction, a name, a detail it can't find), it asks 1-5 short
questions (``ask_person``, ``nebula ask``, ``POST /api/canvas/questions``)
and waits for the answers (``get_answers``). A concrete change to approve is
a proposal instead (services/canvas_proposals.py), and what it noticed is an
Update (post_note).

Modelled on proposals, so the same rules hold:

- Memory only. Open sets and recently closed ones (CLOSED_KEEP_SECONDS, at
  most MAX_CLOSED) live here; a restart loses them, and the set's Update then
  says "Closed when Nebula restarted." (main._settle_proposal_updates).
  There is no time expiry: a set closes when the person answers or dismisses
  it, or the agent withdraws it.
- Open caps: MAX_OPEN_PER_AGENT per agent identity and MAX_OPEN_TOTAL in
  all. The refusal (CAP_LINE) lists the agent's open sets with the exact call
  that withdraws each (``still_open``), as a proposal's ``stillOpen`` does.
- Only the person answers or dismisses. Every set carries an ``answer_key``
  that goes only to browser sockets that said hello with this launch's person
  token; the answer and dismiss routes require it as well as
  person_gate.require_person (no agent marker, the person token). ``view()``
  leaves the key out by construction.
- Owner-scoped. The answers go to the agent that asked: every agent route
  answers another agent's set as not there (404). The person's typed text is
  their message to that agent: it is never journaled, logged, put on the
  project or sent to a socket other than the person's own.

Forward (Q125 items 2 and 3, not built here): ``open_for_agent`` lists one
agent identity's open sets, so a later "Needs you" count is proposals plus
questions without new plumbing.
"""
from __future__ import annotations

import secrets
import time
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from services.agent_presence import AgentIdentity

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


class QuestionBook:
    """Open question sets plus recently closed ones (30 minutes, at most 50)."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._items: OrderedDict[str, QuestionSet] = OrderedDict()

    def now(self) -> float:
        return self._clock()

    def create(self, *, agent: AgentIdentity, project_id: str | None, spec: QuestionSpec) -> QuestionSet:
        """Open a set (enforcing the open caps)."""
        self._prune()
        open_now = self.open_list()
        mine = [s for s in open_now if s.agent.id == agent.id]
        if len(mine) >= MAX_OPEN_PER_AGENT:
            raise QuestionError(429, CAP_LINE, still_open=[_brief(s, int(s.created_at * 1000)) for s in mine])
        if len(open_now) >= MAX_OPEN_TOTAL:
            raise QuestionError(429, TOTAL_LINE, still_open=[_brief(s, int(s.created_at * 1000)) for s in mine])
        question_set = QuestionSet(id=new_set_id(), agent=agent, project_id=project_id, spec=spec,
                                   created_at=self._clock())
        while question_set.id in self._items:  # ids must be unique
            question_set.id = new_set_id()
        self._items[question_set.id] = question_set
        return question_set

    def drop(self, set_id: str) -> None:
        """Forget a set that never reached the person (its Update couldn't be posted)."""
        self._items.pop(set_id, None)

    def get(self, set_id: str) -> QuestionSet | None:
        return self._items.get(set_id)

    def open_list(self) -> list[QuestionSet]:
        return [s for s in self._items.values() if s.is_open]

    def closed_list(self) -> list[QuestionSet]:
        return [s for s in self._items.values() if not s.is_open]

    def open_for_agent(self, agent_id: str) -> list[QuestionSet]:
        """One agent identity's open sets, oldest first (the forward hook for
        Q125 items 2 and 3: "Needs you" counts these with proposals)."""
        return [s for s in self.open_list() if s.agent.id == agent_id]

    def close(self, set_id: str, status: str, *, answers: list[dict[str, Any]] | None = None) -> QuestionSet:
        if status not in CLOSED_STATUSES:
            raise ValueError(f"unknown question set status '{status}'")
        question_set = self._items.get(set_id)
        if question_set is None:
            raise QuestionError(404, f"No question set {set_id[:20]}")
        if not question_set.is_open:
            raise QuestionError(409, f"These questions are already {question_set.status}")
        question_set.status = status
        question_set.answers = [dict(answer) for answer in answers] if status == "answered" and answers else None
        question_set.closed_at = self._clock()
        self._prune()
        return question_set

    def _prune(self) -> None:
        now = self._clock()
        for question_set in self.closed_list():
            if question_set.closed_at is not None and now - question_set.closed_at > CLOSED_KEEP_SECONDS:
                self._items.pop(question_set.id, None)
        closed = self.closed_list()
        for question_set in closed[: max(0, len(closed) - MAX_CLOSED)]:
            self._items.pop(question_set.id, None)

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
# (Proposals keep "Closed: Nebula restarted".)

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


agent_questions = QuestionBook()
