"""Styles (presets) from the CLI and MCP: `nebula style ...` and the MCP's
style_list / style_get / style_create / style_update / style_delete.

Every call goes through the routes the app uses (`/api/presets`), so their
checks run unchanged: a project Style needs a live canvas project, an agent
can't change who bills a Style's model or write internal params, a delete
goes to Recently deleted. What is here is only the asking: finding a Style
by id or exact name, the params version a new Style is made at, and the
`previous` that undoes an update.
"""
from __future__ import annotations

import re
from typing import Any

import moodboard_client as boards
from nebula_api import NebulaAPI, NebulaAPIError
from services.saved_graph_upgrades import PARAMS_VERSION

_STYLE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# style_update's arguments, by the field each sets on the route.
UPDATE_FIELDS = {
    "name": "name", "category": "category", "prompt": "prompt", "params": "params",
    "model_id": "modelId", "ref_images": "refImages", "thumbnail": "thumbnail",
}
# What the app files a Style the person saves from Create under.
DEFAULT_CATEGORY = "My Styles"
RESTORE_HINT = ("It is in Recently deleted: restore_from_trash(kind=\"style\", id=\"{id}\") "
                "(`nebula trash restore style {id}`) brings it back with the same id.")


class StyleError(RuntimeError):
    """A Style call that can't go ahead, with what to do instead."""


def list_styles(api: NebulaAPI, *, project: str | None = None, include_global: bool = True,
                headers: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Global Styles, then project ``project``'s own (newest last in each)."""
    styles: list[dict[str, Any]] = []
    if include_global:
        styles.extend(api.request("GET", "/api/presets", params={"scope": "global"}, headers=headers))
    if project:
        styles.extend(api.request("GET", "/api/presets", params={"scope": "project", "projectId": project},
                                  headers=headers))
    return [style for style in styles if isinstance(style, dict)]


def find_style(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """A live Style by id, else by exact name (case-insensitive) across Global
    and every live canvas project. One in Recently deleted says so."""
    ref = str(ref or "").strip()
    if not ref:
        raise StyleError("name a Style by its id or exact name (`nebula style list`, style_list)")
    if _STYLE_ID.fullmatch(ref):
        try:
            return api.request("GET", f"/api/presets/{ref}", headers=headers)
        except NebulaAPIError as exc:
            if exc.status != 404:
                raise
            if "Recently deleted" in exc.detail:
                raise StyleError(exc.detail) from exc
    listing = api.request("GET", "/api/projects", headers=headers)
    projects = [p.get("id") for p in ((listing or {}).get("projects") or []) if isinstance(p, dict) and p.get("id")]
    candidates = list_styles(api, headers=headers)
    for project_id in projects:
        candidates.extend(list_styles(api, project=project_id, include_global=False, headers=headers))
    matches = [style for style in candidates if str(style.get("name", "")).casefold() == ref.casefold()]
    if not matches:
        raise StyleError(f"no Style “{ref}” (`nebula style list` or style_list shows them)")
    if len(matches) > 1:
        ids = ", ".join(str(style.get("id")) for style in matches)
        raise StyleError(f"{len(matches)} Styles are named “{ref}” ({ids}); use the id")
    return matches[0]


def create_style(api: NebulaAPI, name: str, *, prompt: str = "", category: str = DEFAULT_CATEGORY,
                 params: dict[str, Any] | None = None, model_id: str | None = None,
                 ref_images: list[str] | None = None, project: str | None = None, thumbnail: str = "",
                 headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Save a new Style: Global, or in canvas project ``project`` ("current"
    is the one open on the canvas). It is made at this code's params version,
    so the backend never reads its params as older ones."""
    if not str(name or "").strip():
        raise StyleError("a Style needs a name")
    if params is not None and not isinstance(params, dict):
        raise StyleError("params must be an object of setting keys and values")
    project_id = boards.resolve_project(api, project, headers) if project else None
    body: dict[str, Any] = {
        "name": str(name).strip(), "category": category or DEFAULT_CATEGORY, "prompt": prompt or "",
        "params": dict(params or {}), "modelId": model_id or None, "refImages": list(ref_images or []),
        "scope": "project" if project_id else "global", "thumbnail": thumbnail or "",
        "paramsVersion": PARAMS_VERSION,
    }
    if project_id:
        body["projectId"] = project_id
    return api.request("POST", "/api/presets", json=body, headers=headers)


def _previous(before: dict[str, Any], sent: dict[str, Any]) -> dict[str, Any]:
    """What an update changed, as it was, in style_update's own argument
    names. A Style without a model gets ``model_id: ""`` (clear it)."""
    previous: dict[str, Any] = {}
    for arg, field in UPDATE_FIELDS.items():
        if field not in sent:
            continue
        old = before.get(field)
        if field == "modelId" and not old:
            old = ""
        elif old is None:
            old = [] if field == "refImages" else {} if field == "params" else ""
        previous[arg] = old
    return previous


def update_style(api: NebulaAPI, ref: str, *, base_version: int | None = None,
                 headers: dict[str, str] | None = None, **changes: Any) -> dict[str, Any]:
    """Change a Style's fields (``changes`` in style_update's names; None
    leaves a field as it is, ``model_id=""`` clears the model). ``params``
    replaces the Style's settings whole. The write is checked against the
    version read here (or ``base_version``): if someone saved the Style
    since, nothing is written and this says so.

    Returns ``{style, previous}``: ``previous`` holds the fields it changed as
    they were, with ``base_version`` the version this write made, so passing
    it back as arguments undoes exactly this change, and is refused if
    someone changed the Style again since."""
    unknown = sorted(set(changes) - set(UPDATE_FIELDS))
    if unknown:
        raise StyleError(f"unknown Style field(s): {', '.join(unknown)}")
    style = find_style(api, ref, headers)
    sent = {UPDATE_FIELDS[arg]: value for arg, value in changes.items() if value is not None}
    if "params" in sent and not isinstance(sent["params"], dict):
        raise StyleError("params must be an object of setting keys and values")
    if not sent:
        return {"style": style, "previous": {}}
    body = {**sent, "baseVersion": style.get("version") if base_version is None else base_version}
    if "params" in sent:
        body["paramsVersion"] = PARAMS_VERSION
    try:
        updated = api.request("PUT", f"/api/presets/{style['id']}", json=body, headers=headers)
    except NebulaAPIError as exc:
        if exc.status == 409:
            raise StyleError(
                f"Style '{style.get('name')}' changed since that version was read, so nothing was written. "
                "Read it again (style_get, `nebula style show`) and redo the change on what it is now.") from exc
        raise
    previous = _previous(style, sent)
    previous["base_version"] = updated.get("version")
    return {"style": updated, "previous": previous}


def delete_style(api: NebulaAPI, ref: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Move a Style to Recently deleted, where a restore brings it back with
    the same id. Anyone may, agents included; deleting for good is the
    person's, in the app."""
    style = find_style(api, ref, headers)
    if not deletes_are_restorable(api, headers):
        raise StyleError(PERMANENT_DELETE_REFUSED)
    result = api.request("DELETE", f"/api/presets/{style['id']}", headers=headers)
    result = result if isinstance(result, dict) else {}
    return {**result, "name": style.get("name"), "restorable": result.get("status") == "trashed",
            "detail": RESTORE_HINT.format(id=style["id"])}


PERMANENT_DELETE_REFUSED = (
    "this version of Nebula deletes Styles for good, so `nebula style delete` and style_delete don't: "
    "ask the person to delete it in Nebula, or rename it (style_update) instead."
)


def deletes_are_restorable(api: NebulaAPI, headers: dict[str, str] | None = None) -> bool:
    """True when this Nebula moves a deleted Style to Recently deleted
    (`/api/trash` takes kind "style"). Before 2026-10-20 a Style's DELETE
    was for good, and this never sends one there, for anyone."""
    try:
        api.request("GET", "/api/trash", params={"kind": "style"}, headers=headers)
    except NebulaAPIError as exc:
        if exc.status in (400, 404, 405):
            return False
        raise
    return True
