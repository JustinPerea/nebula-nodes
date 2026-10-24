"""Updates: what an agent or the reader noticed, saved for the person.

Plan section 5.9 (PR9a). On screen the corner, its chip, its cards and its
list are called "Updates", and one item is "an update". In code they keep the
name ``agentNotes``: "update" already names board writes (the board's PUT,
``moodboard_update``, ``MoodboardStore.update``), and a bare "notes" would
mean image notes (plan section 10.6).

The rule: an agent's cursor ``say`` is for its own action ("Moved #12 into
Dither"); anything it *noticed*, *reports* or *suggests* is an update, posted
here, and the person reads it in the Updates corner in the top right. Nebula
itself posts template updates (the reader's run results, later PRs), which may
carry edit actions from a closed set.

Where updates are saved:

- **Main canvas:** on the project record,
  ``catalog["projects"][id]["agentNotes"]``, next to ``pins`` and outside
  ``snapshot``, so the browser's autosave never drops them, switching
  projects brings each project's own, and Recently deleted keeps them with the
  project (it moves the whole record).
- **A moodboard:** a side file, ``MOODBOARD_ROOT/.notes/<boardId>.json``
  (``{boardId, notes}``). Posting or marking read never writes the board file,
  so its ``version`` never moves and no Studio rebases. Keyed by board id, so
  it follows a move and a trash restore; purging the board deletes it
  (``MoodboardStore.purge``). The start-up scans skip it (``board_scopes``).

Checks, all on the server: text is plain, one line, at most ``MAX_TEXT``
characters; refs are node ids on the canvas the server holds (the graph
``look_at_canvas`` reads) or image ids on the board, and an unknown one is
dropped and listed (never outlined from a guess); on a board, ``#n`` in the
text becomes a stored image id, so it is drawn later with the image's
current number, and a ``#n`` not on the board refuses the update; an agent
may set ``about`` to ``sinceLastTurn`` or ``other`` only and sends no
actions; an agent update that quotes a private note is refused; caps prune
the oldest read update first; agents are rate limited per surface.
"""
from __future__ import annotations

import copy
import json
import re
import secrets
import string
import threading
import time
import unicodedata
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from services.agent_presence import AgentIdentity
from services.project_store import ProjectStore

MAX_TEXT = 240
MAX_REFS = 12
MAX_ACTIONS = 2
MAX_BOARD_NOTES = 100
MAX_PROJECT_NOTES = 200
# Posts a minute per author per surface, for agent-written updates only.
RATE_LIMIT = 6
RATE_WINDOW_SECONDS = 60.0

NOTES_DIR = ".notes"

ABOUT_VALUES = ("sinceLastTurn", "analyze", "suggestion", "removedLook", "changedWords", "proposal", "question",
                "other")
AGENT_ABOUT = ("sinceLastTurn", "other")

# Edit actions: a closed set, each with its fixed labels and the keys its op
# carries. Only updates Nebula writes may hold them; later PRs run them.
ACTIONS: dict[str, dict[str, Any]] = {
    "suggestion.accept": {"labels": ("Make frame", "Add copies"), "keys": {"suggestionIds": list}},
    "suggestion.dismiss": {"labels": ("Not now",), "keys": {"suggestionIds": list}},
    "run.undo": {"labels": ("Undo the move", "Undo the sort"), "keys": {"boardId": str, "runId": str}},
    "history.restore": {"labels": ("Restore",), "keys": {"boardId": str, "historyIds": list}},
    "proposal.accept": {"labels": ("Accept",), "keys": {"proposalId": str}},
    "proposal.reject": {"labels": ("Reject",), "keys": {"proposalId": str}},
    # A proposal's Update (Q92 a, Q112 a): takes the person to where they decide
    # it (``target`` is the proposal's kind: project, moodboard, commons, or
    # canvas for a canvas proposal, whose ``targetId`` is its project).
    "proposal.review": {"labels": ("Review",), "keys": {"proposalId": str, "target": str, "targetId": str}},
    # A question set's Update (Q125 item 1): opens the answer form in the
    # Updates corner. Only the person's canvas answers (services/agent_questions.py).
    "question.answer": {"labels": ("Answer",), "keys": {"questionId": str}},
}

# A board image ref inside saved text: private-use characters, which
# clean_note_text strips from anything an agent writes, so a ref can't be forged.
_REF_OPEN = ""
_REF_CLOSE = ""
_REF_TOKEN = re.compile(f"{_REF_OPEN}([^{_REF_OPEN}{_REF_CLOSE}]{{1,128}}){_REF_CLOSE}")
_HASH_NUMBER = re.compile(r"(?<![\w#&])#(\d{1,5})(?!\w)")
_NODE_ID = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")

# The private-note guard (plan section 5.9).
PRIVATE_MIN_CHARS = 12
PRIVATE_RUN_CHARS = 32
_PUNCTUATION = set(string.punctuation)


class NoteError(Exception):
    """A refused update: ``status`` for HTTP, ``code`` names the reason for clients."""

    def __init__(self, status: int, detail: str, code: str | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds")


# -- text ---------------------------------------------------------------------

def clean_note_text(raw: Any, *, limit: int = MAX_TEXT) -> str:
    """Plain, single-line text: control, format and private-use characters
    dropped, whitespace collapsed, 1..limit characters."""
    if not isinstance(raw, str):
        raise NoteError(422, "An update's text must be text", "text_invalid")
    kept = "".join(
        " " if char in "\t\n\r" else char
        for char in raw
        if char in "\t\n\r" or unicodedata.category(char) not in {"Cc", "Cf", "Co"}
    )
    text = " ".join(kept.split())
    if not text:
        raise NoteError(422, "An update can't be empty", "text_invalid")
    if len(text) > limit:
        raise NoteError(422, f"An update must be {limit} characters or fewer (this one is {len(text)})",
                        "text_too_long")
    return text


def _normalize(text: str) -> str:
    """NFKC, case-folded, punctuation dropped, whitespace collapsed."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    stripped = "".join(
        char for char in folded
        if char not in _PUNCTUATION and not unicodedata.category(char).startswith("P")
    )
    return " ".join(stripped.split())


def quotes_private_note(text: str, private_notes: Iterable[str]) -> bool:
    """True when ``text`` holds a whole private note of 12 to 32 normalized
    characters, or any 32-character run of a longer one. A note under 12
    characters can't be checked without false hits, so it isn't."""
    return quotes_normalized_note(text, normalized_private_notes(private_notes))


def normalized_private_notes(private_notes: Iterable[str]) -> list[str]:
    """The notes the guard can check, normalized: 12 characters or more."""
    kept: list[str] = []
    for raw in private_notes:
        if not isinstance(raw, str) or not raw:
            continue
        normalized = _normalize(raw)
        if len(normalized) >= PRIVATE_MIN_CHARS:
            kept.append(normalized)
    return kept


def quotes_normalized_note(text: str, normalized_notes: Iterable[str]) -> bool:
    """``quotes_private_note`` against notes already normalized, so a post on
    the main canvas normalizes only its own text (PrivateNoteIndex)."""
    haystack = _normalize(text)
    if len(haystack) < PRIVATE_MIN_CHARS:
        return False
    runs: set[str] | None = None
    for normalized in normalized_notes:
        if len(normalized) <= PRIVATE_RUN_CHARS:
            if normalized in haystack:
                return True
            continue
        if runs is None:
            runs = {haystack[i:i + PRIVATE_RUN_CHARS] for i in range(len(haystack) - PRIVATE_RUN_CHARS + 1)}
        if not runs:
            continue
        if any(normalized[i:i + PRIVATE_RUN_CHARS] in runs
               for i in range(len(normalized) - PRIVATE_RUN_CHARS + 1)):
            return True
    return False


def _board_private_notes(board: Mapping[str, Any]) -> list[str]:
    return [str(image.get("privateNote") or "") for image in board.get("images") or []
            if isinstance(image, dict) and image.get("privateNote")]


class PrivateNoteIndex:
    """Every private note the boards a project can see hold: its own and the
    Global ones, normalized for the guard. Cached per board file by its stat
    (mtime and size), so a post on the main canvas reads and normalizes only
    the boards that changed since."""

    def __init__(self, root: Callable[[], Path]) -> None:
        self._root = root
        self._cache: dict[str, tuple[tuple[int, int], list[str]]] = {}
        self._lock = threading.Lock()

    def notes_for(self, project_id: str | None) -> list[str]:
        root = self._root()
        folders = [root / "_global"]
        if project_id:
            folders.append(root / project_id)
        notes: list[str] = []
        seen: set[str] = set()
        with self._lock:
            for folder in folders:
                if not folder.is_dir():
                    continue
                for path in folder.glob("*.json"):
                    key = str(path)
                    seen.add(key)
                    try:
                        stat = path.stat()
                    except OSError:
                        continue
                    signature = (stat.st_mtime_ns, stat.st_size)
                    cached = self._cache.get(key)
                    if cached is None or cached[0] != signature:
                        try:
                            board = json.loads(path.read_text(encoding="utf-8"))
                        except (OSError, json.JSONDecodeError):
                            continue
                        found = normalized_private_notes(_board_private_notes(board)) if isinstance(board, dict) else []
                        cached = (signature, found)
                        self._cache[key] = cached
                    notes.extend(cached[1])
            # Drop entries for files that went (deleted or moved boards).
            for key in [key for key in self._cache if key not in seen and
                        any(key.startswith(str(folder)) for folder in folders)]:
                self._cache.pop(key, None)
        return notes


# -- refs ----------------------------------------------------------------------

def _ref_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise NoteError(422, "refs must be a list of ids", "refs_invalid")
    refs: list[str] = []
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, (str, int)):
            raise NoteError(422, "refs must be a list of ids", "refs_invalid")
        text = str(item).strip()
        if text and text not in refs:
            refs.append(text)
    return refs


def _check_ref_count(refs: list[str]) -> None:
    if len(refs) > MAX_REFS:
        raise NoteError(422, f"An update names at most {MAX_REFS} things (this one names {len(refs)})",
                        "too_many_refs")


def _image_index(board: Mapping[str, Any]) -> tuple[list[str], dict[str, int]]:
    ids = [str(image.get("id")) for image in board.get("images") or []
           if isinstance(image, dict) and image.get("id")]
    return ids, {image_id: index + 1 for index, image_id in enumerate(ids)}


def _tokenize_board_text(text: str, board: Mapping[str, Any]) -> tuple[str, list[str]]:
    """Turn each ``#n`` into a stored image id token. A ``#n`` that isn't on
    the board refuses the update, so an update never names the wrong card."""
    ids, _numbers = _image_index(board)
    named: list[str] = []

    def replace(match: re.Match[str]) -> str:
        number = int(match.group(1))
        if not 1 <= number <= len(ids):
            raise NoteError(422, f"#{number} isn't on this board", "unknown_image_number")
        image_id = ids[number - 1]
        if _REF_OPEN in image_id or _REF_CLOSE in image_id:
            return match.group(0)
        if image_id not in named:
            named.append(image_id)
        return f"{_REF_OPEN}{image_id}{_REF_CLOSE}"

    return _HASH_NUMBER.sub(replace, text), named


def text_parts(text: str, board: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Saved text as parts: plain ``{text}`` runs and ``{ref, number}`` for each
    board image it names (``number`` is the image's current one, None once gone)."""
    numbers = _image_index(board)[1] if board is not None else {}
    parts: list[dict[str, Any]] = []
    position = 0
    for match in _REF_TOKEN.finditer(text):
        if match.start() > position:
            parts.append({"text": text[position:match.start()]})
        parts.append({"ref": match.group(1), "number": numbers.get(match.group(1))})
        position = match.end()
    if position < len(text):
        parts.append({"text": text[position:]})
    return parts


def render_text(text: str, board: Mapping[str, Any] | None) -> str:
    """Saved text as a reader sees it: each image ref drawn with its current
    number ("#12"), or "(removed)" once the image is gone."""
    return "".join(
        part["text"] if "text" in part else (f"#{part['number']}" if part["number"] else "(removed)")
        for part in text_parts(text, board)
    )


# -- records -------------------------------------------------------------------

def _unread(note: Mapping[str, Any]) -> bool:
    return not note.get("readAt") and not note.get("dismissedAt")


def unread_count(notes: Iterable[Mapping[str, Any]]) -> int:
    return sum(1 for note in notes if _unread(note))


def _prune(notes: list[dict[str, Any]], cap: int) -> list[str]:
    """Over the cap: the oldest read update goes first, then the oldest unread.
    Returns the ids that went."""
    removed: list[str] = []
    while len(notes) > cap:
        read = [note for note in notes if not _unread(note)]
        pool = read or notes
        oldest = min(pool, key=lambda note: str(note.get("at") or ""))
        notes.remove(oldest)
        removed.append(str(oldest.get("id")))
    return removed


def _author_for(identity: AgentIdentity) -> dict[str, Any]:
    return {"kind": "agent", **identity.as_dict()}


def _clean_author(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, Mapping) or raw.get("kind") not in ("agent", "reader"):
        raise NoteError(422, "An update's author is an agent or the reader", "author_invalid")
    color = str(raw.get("color") or "")
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
        raise NoteError(422, "An update's author needs a #rrggbb colour", "author_invalid")
    author = {"kind": raw["kind"], "id": str(raw.get("id") or raw["kind"])[:64],
              "name": " ".join(str(raw.get("name") or "").split())[:40] or "Agent", "color": color}
    if "verified" in raw:
        author["verified"] = bool(raw["verified"])
    return author


def _clean_actions(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise NoteError(422, "actions must be a list", "actions_invalid")
    if len(raw) > MAX_ACTIONS:
        raise NoteError(422, f"An update carries at most {MAX_ACTIONS} actions", "actions_invalid")
    cleaned = []
    for action in raw:
        op = action.get("op") if isinstance(action, Mapping) else None
        kind = op.get("kind") if isinstance(op, Mapping) else None
        spec = ACTIONS.get(kind) if isinstance(kind, str) else None
        if spec is None:
            raise NoteError(422, f"Unknown update action {kind!r}", "actions_invalid")
        label = action.get("label")
        if label not in spec["labels"]:
            raise NoteError(422, f"{kind} is labelled {' or '.join(spec['labels'])}", "actions_invalid")
        clean_op: dict[str, Any] = {"kind": kind}
        for key, kind_type in spec["keys"].items():
            value = op.get(key)
            if kind_type is list:
                if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
                    raise NoteError(422, f"{kind} needs {key}", "actions_invalid")
                clean_op[key] = list(value)[:200]
            elif not isinstance(value, str) or not value:
                raise NoteError(422, f"{kind} needs {key}", "actions_invalid")
            else:
                clean_op[key] = value[:128]
        cleaned.append({"label": label, "op": clean_op})
    return cleaned


def note_view(note: Mapping[str, Any], board: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """An update as the API returns it: ``text`` drawn with current numbers
    (on a board), ``parts`` for clients that draw refs themselves."""
    view = copy.deepcopy(dict(note))
    raw = str(note.get("text") or "")
    view["text"] = render_text(raw, board)
    view["parts"] = text_parts(raw, board)
    return view


class _RateLimiter:
    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    @contextmanager
    def slot(self, surface: str, author_id: str):
        """Check and count one post in a single step, so posts that race
        (board posts run in worker threads) can't all pass the check before
        any is counted. A post that fails inside the block gives its slot back."""
        key = (surface, author_id)
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= RATE_WINDOW_SECONDS:
                hits.popleft()
            if len(hits) >= RATE_LIMIT:
                raise NoteError(429, f"Too many updates: at most {RATE_LIMIT} a minute. Put more in one update.",
                                "notes_rate_limited")
            hits.append(now)
        try:
            yield
        except BaseException:
            with self._lock:
                try:
                    self._hits[key].remove(now)
                except (KeyError, ValueError):
                    pass
            raise


_FILE_LOCKS: dict[str, threading.RLock] = {}
_FILE_LOCKS_GUARD = threading.Lock()


@contextmanager
def _notes_lock(board_id: str):
    with _FILE_LOCKS_GUARD:
        lock = _FILE_LOCKS.setdefault(board_id, threading.RLock())
    with lock:
        yield


def _board_store_root() -> Path:
    from services.moodboard_store import store_root

    return store_root()


Surface = tuple[str, Any]  # ("canvas", None) or ("board", board dict)


class AgentNotes:
    """Updates for the main canvas (the active project) and for each board."""

    def __init__(
        self,
        store: ProjectStore | Callable[[], ProjectStore],
        *,
        board_root: Callable[[], Path] = _board_store_root,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._store_source = store
        self._board_root = board_root
        self._clock = clock
        self._limiter = _RateLimiter(monotonic)
        self.private_notes = PrivateNoteIndex(board_root)

    @property
    def store(self) -> ProjectStore:
        source = self._store_source
        return source if isinstance(source, ProjectStore) else source()

    def forget_cache(self) -> None:
        """Nothing is cached per project; kept so callers can treat this like pins."""

    # -- storage ---------------------------------------------------------
    def _read_project(self) -> tuple[str | None, list[dict[str, Any]]]:
        catalog = self.store.read()
        project_id = catalog.get("activeProjectId")
        project = catalog["projects"].get(project_id) if project_id else None
        notes = [note for note in (project or {}).get("agentNotes") or [] if isinstance(note, dict)]
        return (project_id if project else None), notes

    def _write_project(self, mutate: Callable[[list[dict[str, Any]]], Any], *,
                       project_id: str | None = None,
                       also: Callable[[dict[str, Any], str, Any], bool] | None = None) -> tuple[str, Any]:
        """Change the open project's updates (or ``project_id``'s, for an
        update that follows something decided after the person switched).
        ``also(catalog, project_id, result)`` changes something else in the
        same commit (a question set saved with its Update) and says whether
        it did."""
        store = self.store
        with store.transaction() as catalog:
            if project_id is None:
                project_id = catalog.get("activeProjectId")
                if not project_id or project_id not in catalog["projects"]:
                    raise NoteError(409, "Open or create a project first: updates are kept with a project",
                                    "no_project")
            elif project_id not in catalog["projects"]:
                raise NoteError(404, "That project is gone (or in Recently deleted)", "no_project")
            project = catalog["projects"][project_id]
            notes = project.get("agentNotes")
            if not isinstance(notes, list):
                notes = project["agentNotes"] = []
            before = copy.deepcopy(notes)
            result = mutate(notes)
            other = also(catalog, project_id, result) if also is not None else False
            if notes != before or other:
                store.commit(catalog)
        return project_id, result

    def board_path(self, board_id: str) -> Path:
        from services.moodboard_store import _validate_moodboard_id

        return self._board_root() / NOTES_DIR / f"{_validate_moodboard_id(board_id)}.json"

    def _read_board(self, board_id: str) -> list[dict[str, Any]]:
        path = self.board_path(board_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, json.JSONDecodeError):
            return []
        notes = data.get("notes") if isinstance(data, dict) else None
        return [note for note in notes or [] if isinstance(note, dict)]

    def _write_board(self, board_id: str, mutate: Callable[[list[dict[str, Any]]], Any]) -> Any:
        with _notes_lock(board_id):
            notes = self._read_board(board_id)
            before = copy.deepcopy(notes)
            result = mutate(notes)
            if notes != before:
                path = self.board_path(board_id)
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".json.tmp")
                tmp.write_text(json.dumps({"boardId": board_id, "notes": notes}, ensure_ascii=False, indent=2),
                               encoding="utf-8")
                tmp.replace(path)
            return result

    def purge_board(self, board_id: str) -> None:
        with _notes_lock(board_id):
            self.board_path(board_id).unlink(missing_ok=True)

    # -- shared steps ----------------------------------------------------
    def _surface_key(self, surface: Surface, project_id: str | None = None) -> str:
        kind, board = surface
        return f"board:{board['id']}" if kind == "board" else f"canvas:{project_id or ''}"

    def _new_note(self, *, author: dict[str, Any], source: str, about: str, text: str, refs: list[str],
                  actions: list[dict[str, Any]] | None = None,
                  requested_by: Mapping[str, Any] | None = None) -> dict[str, Any]:
        note: dict[str, Any] = {
            "id": "an_" + secrets.token_hex(6),
            "author": author,
            "source": source,
            "about": about,
            "at": _iso(self._clock()),
            "text": text,
            "refs": refs,
        }
        if actions:
            note["actions"] = actions
        if requested_by:
            note["requestedBy"] = {"kind": str(requested_by.get("kind") or "person")[:16],
                                   "name": " ".join(str(requested_by.get("name") or "").split())[:40]}
        return note

    @staticmethod
    def _add(notes: list[dict[str, Any]], note: dict[str, Any], cap: int) -> list[str]:
        """Add ``note``; returns the ids of the updates that left the list
        (a replaced "since its last turn" one, or the cap's oldest), so the
        socket can tell every tab."""
        removed: list[str] = []
        if note["about"] == "sinceLastTurn":
            # One "since its last turn" update at a time per author: a new one
            # replaces the previous while that one is still unread.
            for old in [n for n in notes if n.get("about") == "sinceLastTurn" and _unread(n)
                        and (n.get("author") or {}).get("id") == note["author"]["id"]
                        and (n.get("author") or {}).get("kind") == note["author"]["kind"]]:
                notes.remove(old)
                removed.append(str(old.get("id")))
        notes.append(note)
        return removed + _prune(notes, cap)

    def _agent_fields(self, body: Mapping[str, Any]) -> tuple[str, list[str], str]:
        unknown = sorted(set(body) - {"text", "refs", "about", "actions"})
        if unknown:
            raise NoteError(422, f"Unknown field {unknown[0][:40]!r}: an update takes text, refs and about",
                            "field_unknown")
        if body.get("actions") is not None:
            raise NoteError(422, "Updates from agents carry no actions: do the change (edit_canvas, "
                                 "moodboard_update) or propose it (propose_change)", "agent_actions_refused")
        about = body.get("about")
        about = "other" if about is None or about == "" else about
        if about not in AGENT_ABOUT:
            raise NoteError(422, f"about must be one of {', '.join(AGENT_ABOUT)}", "about_not_allowed")
        return clean_note_text(body.get("text")), _ref_list(body.get("refs")), about

    # -- the main canvas ---------------------------------------------------
    def canvas_list(self, *, unread_only: bool = False) -> dict[str, Any]:
        project_id, notes = self._read_project()
        shown = [note for note in reversed(notes) if not unread_only or _unread(note)]
        return {"projectId": project_id, "notes": [note_view(note) for note in shown],
                "unread": unread_count(notes), "keptWith": "project"}

    def canvas_post(self, identity: AgentIdentity, body: Mapping[str, Any], *,
                    graph_nodes: Mapping[str, Any]) -> dict[str, Any]:
        text, asked, about = self._agent_fields(body)
        _check_ref_count(asked)
        refs = [ref for ref in asked if _NODE_ID.fullmatch(ref) and ref in graph_nodes]
        dropped = [ref for ref in asked if ref not in refs]
        project_id, _ = self._read_project()
        if not project_id:
            raise NoteError(409, "Open or create a project first: updates are kept with a project", "no_project")
        if quotes_normalized_note(text, self.private_notes.notes_for(project_id)):
            raise NoteError(422, "This update quotes a private note, which is the person's alone. "
                                 "Say it in your own words without the note.", "note_quotes_private_note")
        key = self._surface_key(("canvas", None), project_id)
        note = self._new_note(author=_author_for(identity), source="agent", about=about, text=text, refs=refs)

        def mutate(notes: list[dict[str, Any]]) -> tuple[int, list[str]]:
            removed = self._add(notes, note, MAX_PROJECT_NOTES)
            return unread_count(notes), removed

        with self._limiter.slot(key, identity.id):
            project_id, (unread, removed) = self._write_project(mutate)
        return {"note": note_view(note), "dropped": dropped, "unread": unread, "projectId": project_id,
                "removed": removed}

    def canvas_mark_read(self, up_to: str | None = None, *, ids: list[str] | None = None) -> dict[str, Any]:
        project_id, (ids, unread) = self._write_project(lambda notes: self._mark_read(notes, up_to, ids))
        return {"projectId": project_id, "ids": ids, "unread": unread}

    def canvas_dismiss(self, note_id: str) -> dict[str, Any]:
        project_id, (note, unread) = self._write_project(lambda notes: self._dismiss(notes, note_id))
        return {"projectId": project_id, "note": note_view(note), "unread": unread}

    # -- a board -------------------------------------------------------------
    def board_list(self, board: Mapping[str, Any], *, unread_only: bool = False) -> dict[str, Any]:
        notes = self._read_board(str(board["id"]))
        shown = [note for note in reversed(notes) if not unread_only or _unread(note)]
        return {"boardId": board["id"], "notes": [note_view(note, board) for note in shown],
                "unread": unread_count(notes), "keptWith": "board"}

    def board_post(self, identity: AgentIdentity, board: Mapping[str, Any],
                   body: Mapping[str, Any]) -> dict[str, Any]:
        text, asked, about = self._agent_fields(body)
        if quotes_private_note(text, _board_private_notes(board)):
            raise NoteError(422, "This update quotes a private note, which is the person's alone. "
                                 "Say it in your own words without the note.", "note_quotes_private_note")
        stored, named = _tokenize_board_text(text, board)
        refs, dropped = self._board_refs(board, named, asked)
        key = self._surface_key(("board", board))
        note = self._new_note(author=_author_for(identity), source="agent", about=about, text=stored, refs=refs)

        def mutate(notes: list[dict[str, Any]]) -> tuple[int, list[str]]:
            removed = self._add(notes, note, MAX_BOARD_NOTES)
            return unread_count(notes), removed

        with self._limiter.slot(key, identity.id):
            unread, removed = self._write_board(str(board["id"]), mutate)
        return {"note": note_view(note, board), "dropped": dropped, "unread": unread, "boardId": board["id"],
                "removed": removed}

    @staticmethod
    def _board_refs(board: Mapping[str, Any], named: list[str], asked: list[str]) -> tuple[list[str], list[str]]:
        ids, _numbers = _image_index(board)
        refs = list(named)
        dropped: list[str] = []
        for ref in asked:
            text = ref[1:] if ref.startswith("#") else ref
            image_id = None
            if ref in ids:
                image_id = ref
            elif text.isdigit() and 1 <= int(text) <= len(ids):
                image_id = ids[int(text) - 1]
            if image_id is None:
                dropped.append(ref)
            elif image_id not in refs:
                refs.append(image_id)
        _check_ref_count(refs)
        return refs, dropped

    def board_mark_read(self, board: Mapping[str, Any], up_to: str | None = None, *,
                        ids: list[str] | None = None) -> dict[str, Any]:
        ids, unread = self._write_board(str(board["id"]), lambda notes: self._mark_read(notes, up_to, ids))
        return {"boardId": board["id"], "ids": ids, "unread": unread}

    def board_dismiss(self, board: Mapping[str, Any], note_id: str) -> dict[str, Any]:
        note, unread = self._write_board(str(board["id"]), lambda notes: self._dismiss(notes, note_id))
        return {"boardId": board["id"], "note": note_view(note, board), "unread": unread}

    # -- read, dismiss, acted ------------------------------------------------
    def _mark_read(self, notes: list[dict[str, Any]], up_to: str | None,
                   ids: list[str] | None = None) -> tuple[list[str], int]:
        """Read every update up to ``up_to`` and older (opening the list), or
        just ``ids`` (a click on one dropped card); unknown ids are skipped."""
        if ids is not None:
            if up_to is not None:
                raise NoteError(422, "Send upTo or ids, not both", "read_invalid")
            wanted = set(ids)
            targets = [note for note in notes if note.get("id") in wanted]
        elif up_to is not None:
            index = next((i for i, note in enumerate(notes) if note.get("id") == up_to), None)
            if index is None:
                raise NoteError(404, "That update is no longer in the list", "note_not_found")
            targets = notes[: index + 1]
        else:
            targets = notes
        now = _iso(self._clock())
        changed = []
        for note in targets:
            if not note.get("readAt"):
                note["readAt"] = now
                changed.append(note["id"])
        return changed, unread_count(notes)

    def _find(self, notes: list[dict[str, Any]], note_id: str) -> dict[str, Any]:
        for note in notes:
            if note.get("id") == note_id:
                return note
        raise NoteError(404, "That update is no longer in the list", "note_not_found")

    def _dismiss(self, notes: list[dict[str, Any]], note_id: str) -> tuple[dict[str, Any], int]:
        note = self._find(notes, note_id)
        if not note.get("dismissedAt"):
            note["dismissedAt"] = _iso(self._clock())
        return copy.deepcopy(note), unread_count(notes)

    def mark_acted(self, surface: Surface, note_id: str, actor: Mapping[str, Any], *,
                   action: str | None = None) -> dict[str, Any]:
        """After Nebula ran one of an update's edit actions as the person:
        the update is acted on, and read. ``action`` is the label of the action
        that ran (kept as ``actedWith``, so the list can say "Undone")."""
        def mutate(notes: list[dict[str, Any]]) -> tuple[dict[str, Any], int]:
            note = self._find(notes, note_id)
            labels = [str(item.get("label")) for item in note.get("actions") or []]
            if action is not None and action not in labels:
                raise NoteError(422, f"This update has no {action!r} action", "action_unknown")
            now = _iso(self._clock())
            note["actedAt"] = now
            note["actedBy"] = {"kind": str(actor.get("kind") or "person")[:16],
                               **({"name": str(actor["name"])[:40]} if actor.get("name") else {})}
            if action is not None:
                note["actedWith"] = action
            note.setdefault("readAt", now)
            return copy.deepcopy(note), unread_count(notes)

        kind, board = surface
        if kind == "board":
            note, unread = self._write_board(str(board["id"]), mutate)
            return {"boardId": board["id"], "note": note_view(note, board), "unread": unread}
        project_id, (note, unread) = self._write_project(mutate)
        return {"projectId": project_id, "note": note_view(note), "unread": unread}

    # -- Nebula's own updates --------------------------------------------------
    def post_nebula(self, surface: Surface, *, author: Mapping[str, Any], about: str, text: str,
                    refs: list[str] | None = None, actions: list[dict[str, Any]] | None = None,
                    requested_by: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """A template update Nebula writes (``source: "nebula"``), built from
        ids only. It skips the rate limit, since it follows from one write
        already made, and may carry edit actions from the closed set."""
        if about not in ABOUT_VALUES:
            raise NoteError(422, f"about must be one of {', '.join(ABOUT_VALUES)}", "about_invalid")
        clean_author = _clean_author(author)
        clean_actions = _clean_actions(actions)
        body_text = clean_note_text(text)
        asked = _ref_list(refs)
        kind, board = surface
        if kind == "board":
            stored, named = _tokenize_board_text(body_text, board)
            clean_refs, _dropped = self._board_refs(board, named, asked)
            note = self._new_note(author=clean_author, source="nebula", about=about, text=stored, refs=clean_refs,
                                  actions=clean_actions, requested_by=requested_by)

            def mutate_board(notes: list[dict[str, Any]]) -> tuple[int, list[str]]:
                removed = self._add(notes, note, MAX_BOARD_NOTES)
                return unread_count(notes), removed

            unread, removed = self._write_board(str(board["id"]), mutate_board)
            return {"note": note_view(note, board), "unread": unread, "boardId": board["id"], "removed": removed}
        _check_ref_count(asked)
        note = self._new_note(author=clean_author, source="nebula", about=about, text=body_text, refs=asked,
                              actions=clean_actions, requested_by=requested_by)

        def mutate(notes: list[dict[str, Any]]) -> tuple[int, list[str]]:
            removed = self._add(notes, note, MAX_PROJECT_NOTES)
            return unread_count(notes), removed

        project_id, (unread, removed) = self._write_project(mutate)
        return {"note": note_view(note), "unread": unread, "projectId": project_id, "removed": removed}


    # -- a proposal's Update (Justin's Q92 a, Q112 a) -----------------------------
    def post_proposal(self, *, author: Mapping[str, Any], text: str,
                      proposal: Mapping[str, Any], project_id: str | None = None) -> dict[str, Any]:
        """The Update a proposal posts on the open project's list (or
        ``project_id``'s, the project a canvas proposal was made in): written
        by Nebula from names only (``source: "nebula"``), attributed to the
        proposing agent, ``about: "proposal"``, with one Review action. It
        skips the agent's rate limit: Nebula writes it on the agent's behalf,
        following the one proposal already made. An asset proposal's is one
        per agent and target: an earlier one from the same agent about the
        same project, board or reference leaves the list (the socket's
        ``removed``), so a re-proposal replaces it instead of stacking. A
        canvas proposal's replaces only the same agent's canvas Updates it
        withdrew itself (``_same_ask``); every other one stays (Q112 a:
        "every one")."""
        clean_author = _clean_author(author)
        ref = {"id": str(proposal["id"])[:64], "kind": str(proposal["kind"])[:16],
               "targetId": str(proposal["targetId"])[:128]}
        actions = _clean_actions([{"label": "Review", "op": {
            "kind": "proposal.review", "proposalId": ref["id"], "target": ref["kind"], "targetId": ref["targetId"]}}])
        note = self._new_note(author=clean_author, source="nebula", about="proposal", text=clean_note_text(text),
                              refs=[], actions=actions)
        note["proposal"] = ref

        def mutate(notes: list[dict[str, Any]]) -> tuple[int, list[str]]:
            removed = []
            for old in [n for n in notes if _same_ask(n, note)]:
                notes.remove(old)
                removed.append(str(old.get("id")))
            notes.append(note)
            return unread_count(notes), removed + _prune(notes, MAX_PROJECT_NOTES)

        project_id, (unread, removed) = self._write_project(mutate, project_id=project_id)
        return {"note": note_view(note), "unread": unread, "projectId": project_id, "removed": removed}

    # -- a question set's Update (Q125 item 1) ------------------------------------
    def post_questions(self, *, author: Mapping[str, Any], text: str, questions: Mapping[str, Any],
                       refs: list[str] | None = None, project_id: str | None = None,
                       save_set: Callable[[dict[str, Any], str, str], bool] | None = None) -> dict[str, Any]:
        """The Update a question set posts on the project's list: written by
        Nebula from a template (``source: "nebula"``, never the questions
        themselves), attributed to the asking agent, ``about: "question"``,
        with one Answer action, and ``refs`` the set's node ids (checked by
        main against the canvas, so Show on canvas outlines them). Like a
        proposal's, it skips the agent's rate limit: Nebula writes it on the
        agent's behalf, following the one set already asked. Every set gets
        its own Update; none replaces another.

        ``save_set(catalog, project_id, note_id)`` puts the set on the
        project's record in the same commit (main._post_question_update), so
        a set is never kept without its Update nor an Update without its set."""
        clean_author = _clean_author(author)
        ref = {"id": str(questions["id"])[:64]}
        actions = _clean_actions([{"label": "Answer", "op": {"kind": "question.answer", "questionId": ref["id"]}}])
        asked = _ref_list(refs)
        _check_ref_count(asked)
        note = self._new_note(author=clean_author, source="nebula", about="question", text=clean_note_text(text),
                              refs=asked, actions=actions)
        note["questions"] = ref

        def mutate(notes: list[dict[str, Any]]) -> tuple[int, list[str]]:
            notes.append(note)
            return unread_count(notes), _prune(notes, MAX_PROJECT_NOTES)

        def also(catalog: dict[str, Any], at: str, _result: Any) -> bool:
            return save_set(catalog, at, note["id"]) if save_set is not None else False

        project_id, (unread, removed) = self._write_project(mutate, project_id=project_id, also=also)
        return {"note": note_view(note), "unread": unread, "projectId": project_id, "removed": removed}

    def resolve_questions(self, project_id: str, note_id: str, *, outcome: str,
                          by: Mapping[str, Any]) -> dict[str, Any] | None:
        """The set closed (answered, dismissed, withdrawn, or one that
        couldn't be read back after a restart): the Update says how, as a
        proposal's does, and is read. The answers never go on the Update:
        every agent can read it with list_notes. They stay in the set's own
        record (services/agent_questions.py), which no agent route reads."""
        return self.resolve_proposal(project_id, note_id, outcome=outcome, by=by)

    def retarget_proposal(self, project_id: str, note_id: str, proposal_id: str) -> dict[str, Any] | None:
        """The agent's other proposal on the same target is still open: the
        Update now reviews that one. None when the update has left the list."""
        def mutate(notes: list[dict[str, Any]]) -> dict[str, Any] | None:
            note = next((n for n in notes if n.get("id") == note_id), None)
            if note is None or note.get("resolvedAt"):
                return None
            note["proposal"] = {**(note.get("proposal") or {}), "id": proposal_id[:64]}
            for action in note.get("actions") or []:
                if (action.get("op") or {}).get("kind") == "proposal.review":
                    action["op"]["proposalId"] = proposal_id[:64]
            return copy.deepcopy(note)

        _, note = self._write_project(mutate, project_id=project_id)
        return None if note is None else {"projectId": project_id, "note": note_view(note)}

    def reopen_proposal(self, project_id: str, note_id: str, proposal_id: str) -> dict[str, Any] | None:
        """The undo of a node delete reopened the proposal (GM, 2026-10-23):
        its Update reviews it again. The outcome line goes and Review is back;
        it stays read (the person's own undo brought it back). None when the
        update has left the list or still reviews another open proposal."""
        def mutate(notes: list[dict[str, Any]]) -> tuple[dict[str, Any], int] | None:
            note = next((n for n in notes if n.get("id") == note_id), None)
            if note is None:
                return None
            if not note.get("resolvedAt"):
                return None
            for key in ("resolvedAt", "resolvedBy", "outcome"):
                note.pop(key, None)
            note["proposal"] = {**(note.get("proposal") or {}), "id": proposal_id[:64]}
            for action in note.get("actions") or []:
                if (action.get("op") or {}).get("kind") == "proposal.review":
                    action["op"]["proposalId"] = proposal_id[:64]
            return copy.deepcopy(note), unread_count(notes)

        _, result = self._write_project(mutate, project_id=project_id)
        if result is None:
            return None
        note, unread = result
        return {"projectId": project_id, "note": note_view(note), "unread": unread}

    def resolve_proposal(self, project_id: str, note_id: str, *, outcome: str,
                         by: Mapping[str, Any]) -> dict[str, Any] | None:
        """The proposal closed (accepted, rejected, withdrawn, expired or no
        longer fits): the Update says how in one short line (``outcome``) and
        is read, so no stale Review stays. None when it has left the list."""
        def mutate(notes: list[dict[str, Any]]) -> tuple[dict[str, Any], int] | None:
            note = next((n for n in notes if n.get("id") == note_id), None)
            if note is None or note.get("resolvedAt"):
                return None
            now = _iso(self._clock())
            note["resolvedAt"] = now
            note["resolvedBy"] = {"kind": str(by.get("kind") or "system")[:16],
                                  **({"name": str(by["name"])[:40]} if by.get("name") else {})}
            note["outcome"] = clean_note_text(outcome, limit=80)
            if not note.get("readAt"):
                note["readAt"] = now
            return copy.deepcopy(note), unread_count(notes)

        _, result = self._write_project(mutate, project_id=project_id)
        if result is None:
            return None
        note, unread = result
        return {"projectId": project_id, "note": note_view(note), "unread": unread}


def _same_ask(note: Mapping[str, Any], new: Mapping[str, Any]) -> bool:
    """Whether ``new`` replaces ``note`` on the list. An asset proposal's:
    the same agent's Update about the same target. A canvas proposal's is its
    own ask (Q112 a, "every one"), so it replaces only the same agent's
    canvas Updates that the agent withdrew itself: Q109's "withdraw it
    first, then propose again" is a revision, and without this a
    propose/withdraw loop stacks one read Update per cycle, which the cap
    then makes push the person's older Updates out. Open ones, and those the
    person decided, expired or a restart closed, stay."""
    if note.get("about") != "proposal" or not isinstance(note.get("proposal"), Mapping):
        return False
    old_author, author = note.get("author") or {}, new["author"]
    if old_author.get("kind") != author["kind"] or old_author.get("id") != author["id"]:
        return False
    if note["proposal"].get("kind") != new["proposal"]["kind"]:
        return False
    if new["proposal"]["kind"] == "canvas":
        return bool(note.get("resolvedAt")) and (note.get("resolvedBy") or {}).get("kind") == "agent"
    return note["proposal"].get("targetId") == new["proposal"]["targetId"]


def note_summary(note: Mapping[str, Any]) -> str:
    text = str(note.get("text") or "")
    return f'posted an update: "{text[:80]}{"…" if len(text) > 80 else ""}"'
