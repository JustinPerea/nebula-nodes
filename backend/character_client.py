"""Characters from the CLI and MCP: list and read them, find one by id or
name, and move it between Global and a canvas project (`nebula character
list|show|move`, `character_list`, `character_get`, `character_move`).

Reads are the app's own GET /api/characters routes. There is no write here
but the move (Justin's call P4, 2026-10-19), whose machinery is
moodboard_client's: the same project resolution (`resolve_move_target`) and
the same POST .../move call, so a board and a Character move the same way.
"""
from __future__ import annotations

import re
from typing import Any

import moodboard_client as boards
from moodboard_client import MoodboardError
from nebula_api import NebulaAPI, NebulaAPIError
from services.cursor_actions import echoed

_CHARACTER_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


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
    matches = [item for item in candidates if boards.same_name(item.get("name"), ref)]
    if not matches:
        # The caller's text is echoed cleaned and cut to 40 characters, as a cursor refusal echoes it.
        raise MoodboardError(f"no Character “{echoed(ref)}” (Character Studio lists them; use its id or exact name)")
    if len(matches) > 1:
        ids = ", ".join(str(item.get("id")) for item in matches)
        raise MoodboardError(f"{len(matches)} Characters are named “{echoed(ref)}” ({ids}); use the id")
    return matches[0]


def move_character(api: NebulaAPI, ref: str, to: str | None,
                   headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Move a Character (id or exact name) to Global or a canvas project.
    Anyone may, agents included: moving it back undoes it. Nodes that use it
    keep working in every project."""
    character = boards.asset_for_move(api, "character", ref, find_character, headers)
    return boards.move_asset(api, "character", character, to, headers)


def list_characters(api: NebulaAPI, *, project: str | None = None, include_global: bool = True,
                    headers: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Global Characters, then project ``project``'s own, each as ``brief``."""
    found: list[dict[str, Any]] = []
    if include_global:
        found.extend(_list(api, "global", None, headers))
    if project:
        found.extend(_list(api, "project", project, headers))
    return [brief(item) for item in found]


def get_character(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """A live Character by id, else by exact name (case-insensitive) across
    Global and every live canvas project, as ``brief``. One in Recently
    deleted says so."""
    ref = str(ref or "").strip()
    if not ref:
        raise MoodboardError("name a Character by its id or exact name (`nebula character list`, character_list)")
    if _CHARACTER_ID.fullmatch(ref):
        try:
            return brief(api.request("GET", f"/api/characters/{ref}", headers=headers))
        except NebulaAPIError as exc:
            if exc.status != 404:
                raise
            if "Recently deleted" in exc.detail:
                raise MoodboardError(exc.detail) from exc
    return brief(find_character(api, ref, headers))


def brief(character: dict[str, Any]) -> dict[str, Any]:
    """What a read says about a Character: id, name, where it lives
    (``scope``, ``projectId``), subject type, its reference views (their URLs,
    in order: the first is the cover; a cursor names one by its number) and how
    many, the frozen trait string, seed and version."""
    views = [str(view) for view in character.get("referenceViews") or []]
    project = character.get("projectId") or None
    return {
        "id": character.get("id"),
        "name": character.get("name"),
        "scope": "project" if project else "global",
        "projectId": project,
        "subjectType": character.get("subjectType"),
        "viewCount": len(views),
        "referenceViews": views,
        "frozenTraitString": character.get("frozenTraitString") or "",
        "seed": character.get("seed"),
        "version": character.get("version"),
    }
