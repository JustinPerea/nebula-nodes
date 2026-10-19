"""Characters from the CLI and MCP: find one by id or name, and move it
between Global and a canvas project (`nebula character move`,
`character_move`).

Only the move is here (Justin's call P4, 2026-10-19). The machinery is
moodboard_client's: the same project resolution (`resolve_move_target`) and
the same POST .../move call, so a board and a Character move the same way.
"""
from __future__ import annotations

from typing import Any

import moodboard_client as boards
from moodboard_client import MoodboardError
from nebula_api import NebulaAPI


def _list(api: NebulaAPI, scope: str, project: str | None, headers: dict[str, str] | None) -> list[dict[str, Any]]:
    params = {"scope": scope, **({"projectId": project} if project else {})}
    found = api.request("GET", "/api/characters", params=params, headers=headers)
    return [item for item in found if isinstance(item, dict)] if isinstance(found, list) else []


def find_character(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """A live Character by exact name (case-insensitive), across Global and
    every live canvas project."""
    ref = str(ref or "").strip()
    if not ref:
        raise MoodboardError("name a Character by its id or exact name")
    listing = api.request("GET", "/api/projects", headers=headers)
    projects = [p.get("id") for p in ((listing or {}).get("projects") or []) if isinstance(p, dict) and p.get("id")]
    candidates = _list(api, "global", None, headers)
    for project_id in projects:
        candidates.extend(_list(api, "project", project_id, headers))
    matches = [item for item in candidates if str(item.get("name", "")).casefold() == ref.casefold()]
    if not matches:
        raise MoodboardError(f"no Character '{ref}' (Character Studio lists them; use its id or exact name)")
    if len(matches) > 1:
        ids = ", ".join(str(item.get("id")) for item in matches)
        raise MoodboardError(f"{len(matches)} Characters are named '{ref}' ({ids}); use the id")
    return matches[0]


def move_character(api: NebulaAPI, ref: str, to: str | None,
                   headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Move a Character (id or exact name) to Global or a canvas project.
    Anyone may, agents included: moving it back undoes it. Nodes that use it
    keep working in every project."""
    character = boards.asset_for_move(api, "character", ref, find_character, headers)
    return boards.move_asset(api, "character", character, to, headers)
