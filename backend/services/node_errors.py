"""Why each canvas node's last run failed: for its card, and for agents.

The card shows a failed node's message. The backend keeps the same message
here, so it is still there when the page reloads, the person switches
projects and back, or the backend restarts:

- every graph the page loads says it (main._cli_node_to_rf: state "error"
  with the card's error, errorFriendly, errorCategory and errorPerson), in
  graphSync and GET /api/projects/{id} alike;
- look_at_canvas and `nebula look` give it as the node's `error`, and
  view_output and `nebula path` answer with it instead of "no output yet".

Every run path feeds it: a node's ErrorEvent (canvas runs, agent runs, a
single node) and the pre-call check's validation errors (a missing key, an
unwired required input). A node that starts again, finishes or is skipped by
a gate loses its error, as its card does.

Node ids restart in each project (n1, n2, ...), so errors are kept per
project: main points the store at the open project (use_project) and a
project's errors wait while another is open. Replacing a project's canvas
(loading a graph over it, clearing it) forgets its errors; deleting a project
for good forgets them too (keep_projects). They live in one small JSON file
in the state dir, so a restart keeps them. Run history can't stand in for it:
it records a failed run but not each node's message, and agents' runs aren't
in it.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Container, Iterable, Mapping

from models.events import ErrorEvent, ExecutedEvent, ExecutingEvent, SkippedEvent

# What an agent reads is a message, not a log: long provider bodies are cut.
MAX_ERROR_CHARS = 2000
# A project has at most this many failed nodes kept (oldest dropped first).
MAX_NODES_PER_PROJECT = 2000
FILE_VERSION = 1


def _clip(text: Any) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= MAX_ERROR_CHARS else value[: MAX_ERROR_CHARS - 1] + "…"


def _project_key(project_id: str | None) -> str:
    # "" is the canvas with no project open (before the first project).
    return str(project_id or "")


class NodeErrors:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        self._projects: dict[str, dict[str, dict[str, str]]] = self._load()
        self._project = ""

    # -- storage -----------------------------------------------------------

    def _load(self) -> dict[str, dict[str, dict[str, str]]]:
        if self._path is None:
            return {}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            print(f"[node_errors] could not read {self._path}: {exc}; starting empty", flush=True)
            return {}
        projects: dict[str, dict[str, dict[str, str]]] = {}
        for project_id, nodes in ((raw or {}).get("projects") or {}).items() if isinstance(raw, dict) else ():
            if not isinstance(nodes, dict):
                continue
            kept = {
                str(node_id): {key: _clip(value) for key, value in entry.items()
                               if key in {"error", "hint", "category", "person", "providerText", "provider"} and value}
                for node_id, entry in nodes.items()
                if isinstance(entry, dict) and entry.get("error")
            }
            if kept:
                projects[str(project_id)] = kept
        return projects

    def _save(self) -> None:
        if self._path is None:
            return
        # Private like the other state files (provider_recovery): a provider's
        # error body can echo a prompt or part of the request.
        tmp = self._path.with_name(f".{self._path.name}.{os.getpid()}.tmp")
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(json.dumps({"version": FILE_VERSION, "projects": self._projects}))
            os.replace(tmp, self._path)
        except OSError as exc:
            # The card and agents still have it until the backend stops.
            print(f"[node_errors] could not save {self._path}: {exc}", flush=True)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    @property
    def _errors(self) -> dict[str, dict[str, str]]:
        return self._projects.get(self._project, {})

    # -- which project ------------------------------------------------------

    def use_project(self, project_id: str | None) -> None:
        """Point at the project open on the canvas; its nodes' errors apply."""
        self._project = _project_key(project_id)

    def projects(self) -> list[str]:
        return sorted(self._projects)

    def adopt(self, old_project_id: str | None, new_project_id: str | None) -> None:
        """The canvas of ``old_project_id`` is now filed as ``new_project_id``,
        the same live graph and ids (GET /api/projects making "Recovered
        canvas" of the unfiled canvas): its nodes' errors move with it, and
        the store points at it if it pointed at the old one."""
        old, new = _project_key(old_project_id), _project_key(new_project_id)
        if old == new:
            return
        moved = self._projects.pop(old, None)
        if self._project == old:
            self._project = new
        if moved:
            self._projects[new] = {**moved, **self._projects.get(new, {})}
            self._save()

    def renumber(self, project_id: str | None, mapping: Mapping[str, str]) -> None:
        """The project's nodes got new ids ({old: new}; a renumber of tab-local
        ids, PR #199 review 18 handoff-reopen LOW-2): their errors move with
        them. An error already kept under a new id stays."""
        key = _project_key(project_id)
        errors = self._projects.get(key)
        if not errors or not any(node_id in mapping for node_id in errors):
            return
        moved: dict[str, dict[str, str]] = {}
        for node_id, entry in errors.items():
            new = mapping.get(node_id, node_id)
            if new != node_id and new in errors:
                continue
            moved[new] = entry
        self._projects[key] = moved
        self._save()

    def keep_projects(self, project_ids: Container[str]) -> None:
        """Forget projects that no longer exist (deleted for good, trash emptied)."""
        gone = [key for key in self._projects if key and key not in project_ids]
        for key in gone:
            del self._projects[key]
        if gone:
            self._save()

    # -- the open project's nodes -------------------------------------------

    def record(self, node_id: str, message: str, *, friendly: str | None = None,
               category: str | None = None, person: str | None = None, provider_text: bool = False,
               provider: str | None = None) -> None:
        if not node_id or not message:
            return
        entry = {"error": _clip(message)}
        # The person's line (error copy round 3c): the card shows it, agents
        # never get it from here (get() is the specific text, word for word).
        if person:
            entry["person"] = _clip(person)
            # Its line was written for a provider's answer: the card keeps the
            # text behind Details beside it (error copy round 3d).
            if provider_text:
                entry["providerText"] = "1"
        hint = _clip(friendly) if friendly else ""
        # classify_error's fallback is the message itself less its full stop.
        if hint and hint.rstrip(".") != entry["error"].rstrip("."):
            entry["hint"] = hint
        if category:
            entry["category"] = _clip(category)
        # Who the run called (round 3f): the card's general line names them.
        # Card-only, like the person line: get() never returns it.
        if provider:
            entry["provider"] = _clip(provider)
        errors = self._projects.setdefault(self._project, {})
        errors.pop(node_id, None)
        errors[node_id] = entry
        while len(errors) > MAX_NODES_PER_PROJECT:
            del errors[next(iter(errors))]
        self._save()

    def record_validation(self, errors: Iterable[Any]) -> None:
        """A pre-call check's errors (ValidationErrorDetail), several per node joined in order.

        The card's line (error copy round 3e) is their `person` lines joined
        (execution.person_line.joined_lines); a check with none (only agents
        or a damaged saved graph reach it) is kept as category "unknown", so
        after a reload the card shows GM's general line with the text behind
        Details, as it did live. get() is the specific text, as before."""
        from execution.person_line import joined_lines

        by_node: dict[str, list[str]] = {}
        lines: dict[str, list[str | None]] = {}
        for error in errors:
            node_id = str(getattr(error, "node_id", "") or "")
            message = str(getattr(error, "message", "") or "")
            if node_id and message and message not in by_node.setdefault(node_id, []):
                by_node[node_id].append(message)
                lines.setdefault(node_id, []).append(getattr(error, "person", None))
        for node_id, messages in by_node.items():
            person = joined_lines(lines.get(node_id, []))
            self.record(node_id, "; ".join(messages), person=person, category=None if person else "unknown")

    def observe(self, event: Any) -> None:
        """Follow one execution event the way the canvas card does."""
        if isinstance(event, ErrorEvent):
            self.record(event.node_id, event.error, friendly=event.friendly, category=event.category,
                        person=event.person, provider_text=event.provider_text,
                        provider=getattr(event, "provider", None))
        elif isinstance(event, (ExecutingEvent, ExecutedEvent, SkippedEvent)):
            self.forget(event.node_id)

    def forget(self, node_id: str) -> None:
        """The node's last run no longer failed (it ran again), or its id now
        holds another node (an undo that swaps one in)."""
        errors = self._projects.get(self._project)
        if errors and errors.pop(node_id, None) is not None:
            if not errors:
                del self._projects[self._project]
            self._save()

    def get(self, node_id: str) -> dict[str, str] | None:
        """{error, hint?}: what agents read."""
        entry = self._errors.get(node_id)
        return {key: value for key, value in entry.items() if key in {"error", "hint"}} if entry else None

    def card(self, node_id: str) -> dict[str, Any] | None:
        """The node data fields the canvas card shows a failure with (NodeError)."""
        entry = self._errors.get(node_id)
        if not entry:
            return None
        # An entry saved before round 3e's validation lines (no category, no
        # person line) is a check Nebula wrote for agents, so the card reads
        # GM's general line with the text behind Details (round 3f), not the
        # raw text as if it were a line for the person.
        category = entry.get("category") or (None if entry.get("person") else "unknown")
        return {"state": "error", "error": entry["error"],
                **({"errorFriendly": entry["hint"]} if entry.get("hint") else {}),
                **({"errorCategory": category} if category else {}),
                **({"errorProvider": entry["provider"]} if entry.get("provider") else {}),
                **({"errorPerson": entry["person"]} if entry.get("person") else {}),
                **({"errorProviderText": True} if entry.get("person") and entry.get("providerText") else {})}

    def forget_canvas(self) -> None:
        """The open project's canvas was replaced or cleared: node ids restart.

        Deleting a node keeps its error: ids aren't handed out again in a
        project (CLIGraph's counter moves past them), and the canvas's undo
        puts the node back as it was, failure included."""
        if self._projects.pop(self._project, None) is not None:
            self._save()
