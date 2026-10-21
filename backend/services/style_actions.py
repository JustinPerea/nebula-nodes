"""What changed in a Style (a preset), in the words the journal and the Agent
log both use.

A Style write has no place on the canvas, so main.py journals one ``style.*``
event per write (``wait_for_canvas_change`` and ``nebula watch`` see it, with
its actor) and, for an agent's write, says the same line in the Agent log
(``main._say_agent_action``). One set of words for both, as boards do
(services/moodboard_actions.py), so a change is never described two ways.
Only names and field labels: never a prompt or a param value.
"""
from __future__ import annotations

from typing import Any, Mapping

# The Style fields a write can change, as the app labels them.
FIELD_LABELS = {
    "name": "the name",
    "category": "the category",
    "prompt": "the prompt",
    "params": "the settings",
    "modelId": "the model",
    "refImages": "the references",
    "thumbnail": "the thumbnail",
}

_VERBS = {
    "created": "made",
    "deleted": "deleted",
    "restored": "restored",
    "purged": "deleted",
}
_TAILS = {"deleted": " (in Recently deleted)", "purged": " for good"}


def style_where(style: Mapping[str, Any] | None, style_id: str = "") -> str:
    """"Style" and its name, cut to 60 characters (else its id)."""
    style = style or {}
    name = " ".join(str(style.get("name") or "").split())[:60]
    return f"Style {name or style.get('id') or style_id or 'Untitled'}"


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
    """The fields an update changed, in FIELD_LABELS order."""
    return [key for key in FIELD_LABELS if before.get(key) != after.get(key)]


def _listed(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def describe(change: str, style: Mapping[str, Any] | None, *, fields: list[str] | None = None,
             style_id: str = "") -> str:
    """One line for a Style write, lower case first, as journal summaries are:
    "made Style Dusk", "changed the prompt of Style Dusk", "deleted Style
    Dusk (in Recently deleted)", "restored Style Dusk", "deleted Style Dusk
    for good". An update that changed nothing reads "saved Style Dusk"."""
    where = style_where(style, style_id)
    if change == "updated":
        if not fields:
            return f"saved {where}"
        return f"changed {_listed([FIELD_LABELS[key] for key in fields])} of {where}"
    return f"{_VERBS[change]} {where}{_TAILS.get(change, '')}"


def journal_data(style: Mapping[str, Any] | None, *, fields: list[str] | None = None,
                 style_id: str = "") -> dict[str, Any]:
    style = style or {}
    data: dict[str, Any] = {"styleId": str(style.get("id") or style_id), "styleName": str(style.get("name") or ""),
                            "scope": style.get("projectId") or "global"}
    if fields is not None:
        data["fields"] = list(fields)
    return data


def sentence(line: str) -> str:
    """The Agent log's form of a journal line: capital first."""
    return line[:1].upper() + line[1:]
