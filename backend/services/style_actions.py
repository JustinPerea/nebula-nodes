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
    "restored": "restored",
    "purged": "deleted",
}
_TAILS = {"purged": " for good"}
# A line names up to this many changed fields; past it, it gives a count.
NAMED_FIELDS = 3
# A cursor's say is cut at this length (agent_presence.MAX_SAY_CHARS), and the
# log, the journal and the say share one line, so a long line shortens its
# names instead of losing its end.
_LINE_CHARS = 140


# The cursor part each field goes to (cursor_actions.STYLE_PARTS): no screen
# draws these fields, so the part only chooses the cursor's default line.
FIELD_PARTS = {
    "name": "name",
    "category": "category",
    "prompt": "prompt",
    "params": "settings",
    "modelId": "model",
    "refImages": "references",
    "thumbnail": "thumbnail",
}


def _name(style: Mapping[str, Any] | None, style_id: str = "", limit: int = 60) -> str:
    """A Style's name in curly quotes, cut to ``limit`` characters (else its
    id): “Dusk grain”."""
    style = style or {}
    name = " ".join(str(style.get("name") or "").split()) or str(style.get("id") or style_id or "Untitled")
    if len(name) > limit:
        name = name[:limit - 1].rstrip() + "\u2026"
    return f"\u201c{name}\u201d"


def style_where(style: Mapping[str, Any] | None, style_id: str = "", limit: int = 60) -> str:
    """"the style" and its name: the style “Dusk grain”."""
    return f"the style {_name(style, style_id, limit)}"


def style_anchor(style: Mapping[str, Any] | None, fields: list[str] | None = None, *,
                 style_id: str = "") -> tuple[dict[str, Any], dict[str, Any]]:
    """The cursor's anchor for a Style write and the names to show for it
    (``agent_presence.parse_surface_target``'s two results): the Style, with a
    part when exactly one field changed (a create or a write that changed
    several has none)."""
    style = style or {}
    item = str(style.get("id") or style_id)
    name = " ".join(str(style.get("name") or item).split())[:80]
    target: dict[str, Any] = {"surface": "style", "itemId": item}
    names: dict[str, Any] = {"style": name}
    if fields and len(fields) == 1 and fields[0] in FIELD_PARTS:
        target["part"] = names["part"] = FIELD_PARTS[fields[0]]
    return target, names


def changed_fields(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
    """The fields an update changed, in FIELD_LABELS order."""
    return [key for key in FIELD_LABELS if before.get(key) != after.get(key)]


def _listed(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def _updated(style: Mapping[str, Any] | None, fields: list[str], style_id: str,
             before: Mapping[str, Any] | None, limit: int) -> str:
    where = style_where(style, style_id, limit)
    if not fields:
        return f"saved {where} with no changes"
    if "name" in fields and before is not None and before.get("name"):
        # A rename gives both names: "changed the name" doesn't say which it was.
        said = f"renamed {style_where(before, style_id, limit)} to {_name(style, style_id, limit)}"
        others = [key for key in fields if key != "name"]
        if not others:
            return said
        if len(others) > NAMED_FIELDS:
            return f"{said} and made {len(others)} other changes"
        return f"{said} and changed its {_listed([FIELD_LABELS[key].removeprefix('the ') for key in others])}"
    if len(fields) > NAMED_FIELDS:
        return f"made {len(fields)} changes to {where}"
    return f"changed {_listed([FIELD_LABELS[key] for key in fields])} of {where}"


def describe(change: str, style: Mapping[str, Any] | None, *, fields: list[str] | None = None,
             style_id: str = "", before: Mapping[str, Any] | None = None) -> str:
    """One line for a Style write, lower case first, as journal summaries are
    (GM - Design's wording, 2026-11-14):

    - "made the style “Dusk”", "restored the style “Dusk”", "deleted the
      style “Dusk” for good";
    - a delete: "moved the style “Dusk” to “Recently deleted”";
    - an update names up to three fields, "changed the prompt, the settings
      and the model of the style “Dusk”", and counts more, "made 4 changes to
      the style “Dusk”";
    - a rename (``before`` is the Style as it was) gives both names, "renamed
      the style “Dusk” to “Dusk grain”", then "and changed its prompt and
      settings" or "and made 4 other changes";
    - an update that changed nothing: "saved the style “Dusk” with no
      changes".

    Names are cut to 60 characters, or to 30 when the line would pass a
    cursor say's length."""
    for limit in (60, 30):
        if change == "updated":
            line = _updated(style, list(fields or []), style_id, before, limit)
        elif change == "deleted":
            line = f"moved {style_where(style, style_id, limit)} to \u201cRecently deleted\u201d"
        else:
            line = f"{_VERBS[change]} {style_where(style, style_id, limit)}{_TAILS.get(change, '')}"
        if len(line) <= _LINE_CHARS:
            break
    return line


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
