"""Projects, Recently deleted, settings and provider health, as agents read
them: MCP's list_projects / rename_project / get_project / project_size /
list_trash / get_settings / provider_status and their `nebula` twins
(`nebula projects --json`, `nebula project rename|show|size`, `nebula trash
list`, `nebula keys`, `nebula providers`).

Every call goes through the route the canvas uses (/api/projects,
/api/trash, /api/settings, /api/health/providers, /api/krea/connection), so
its checks and journal run unchanged. What is here is only the shaping both
surfaces share, so a CLI command's `--json` equals its tool's result: a
project's "current", a cover's links, settings as booleans (no part of a key,
whoever asks: the CLI and MCP never hold the person token) and a Krea
sign-in link left with the person. `via` ("mcp" or "cli") words the hints as
that surface's own calls, as GET /api/agent/start does.
"""
from __future__ import annotations

import shlex
from typing import Any
from urllib.parse import quote

from nebula_api import NebulaAPI, NebulaAPIError

# The Settings an agent reads besides which keys are set (get_settings).
SETTINGS_SHOWN = ("executionMode", "batchSizeCap", "exportFolder", "kreaConnectionMode")
_TIMEOUT = 10.0
# Health probes can take 10 s each when the cache is cold.
_HEALTH_TIMEOUT = 60.0


class ProjectRefError(RuntimeError):
    """A project reference that names nothing, with what to pass instead."""


def _call(api: NebulaAPI, method: str, path: str, headers: dict[str, str] | None,
          timeout: float = _TIMEOUT, **kwargs: Any) -> dict[str, Any]:
    payload = api.request(method, path, headers=headers, timeout=timeout, **kwargs)
    if not isinstance(payload, dict):
        raise RuntimeError("Nebula canvas endpoint returned an invalid response")
    return payload


def _absolute(api: NebulaAPI, value: str) -> str:
    return f"{api.base_url}{value}" if value.startswith("/api/outputs/") else value


def project_ref(api: NebulaAPI, project_id: str, *, headers: dict[str, str] | None = None,
                via: str = "mcp") -> str:
    """A project's id, or "current": the one open on the canvas."""
    if project_id != "current":
        return project_id
    active = _call(api, "GET", "/api/projects", headers).get("activeProjectId")
    if not isinstance(active, str) or not active:
        where = "list_projects" if via == "mcp" else "`nebula projects`"
        raise ProjectRefError(f"No project is open on the canvas: pass a project id from {where}.")
    return active


def cover_for_agents(api: NebulaAPI, cover: Any) -> dict[str, Any] | None:
    """A card's picture as look_at_canvas shows links: a signed link keeps its
    path only; Nebula's own outputs come back as full URLs."""
    from services.selection_context import _safe_value

    if not isinstance(cover, dict):
        return None
    shown = _safe_value(cover, key="cover")
    images = shown.get("images") if isinstance(shown, dict) else None
    if isinstance(images, list):
        shown["images"] = [_absolute(api, image) for image in images if isinstance(image, str)]
    return shown


def list_projects(api: NebulaAPI, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """MCP list_projects: each project's id, name, `open`, node count, last
    edit and cover, most recently edited first, `catalogRestore` after
    Nebula restored a damaged project list (until the person closes its
    notice), `canvasNotFiled` while the live canvas couldn't be saved as
    its own project because the list is at a limit (with the agents' `note`
    and `roomNow`), `canvasSaved` for a while after such a canvas was saved,
    and `projectLimit`."""
    listing = _call(api, "GET", "/api/projects", headers)
    active = listing.get("activeProjectId")
    rows = [{"id": project.get("id"), "name": project.get("name"), "open": project.get("id") == active,
             "nodes": project.get("nodeCount", 0), "updatedAt": project.get("updatedAt"),
             "cover": cover_for_agents(api, project.get("cover"))}
            for project in listing.get("projects") or []]
    reply: dict[str, Any] = {"projects": rows, "openProjectId": active}
    # Nebula restored a damaged project list and the person hasn't closed its
    # notice yet: what came back, from where, and where the damaged file is kept.
    if isinstance(listing.get("catalogRestore"), dict):
        reply["catalogRestore"] = listing["catalogRestore"]
    # The live canvas isn't a project and couldn't be filed as its own: the
    # list is at a limit, so opening or making a project is refused until
    # the person frees room (PR #199, review 2 L4).
    # With its `note` (what frees room for which limit) and `projectLimit`.
    if isinstance(listing.get("canvasNotFiled"), dict):
        reply["canvasNotFiled"] = listing["canvasNotFiled"]
    # A waiting canvas was saved as its own project (the person sees a toast).
    if isinstance(listing.get("canvasSaved"), dict):
        reply["canvasSaved"] = listing["canvasSaved"]
    # A restore from Recently deleted is refused now, held canvases counted,
    # and how many deletes free a place (review 6 of PR #199, L-3).
    if isinstance(listing.get("restoreRoom"), dict):
        reply["restoreRoom"] = listing["restoreRoom"]
    # canvas-held.json didn't read whole and a held canvas may be lost (L-1).
    if isinstance(listing.get("canvasHeldUnreadable"), dict):
        reply["canvasHeldUnreadable"] = listing["canvasHeldUnreadable"]
    # The list's project limit (a restore or create past it is refused).
    if isinstance(listing.get("projectLimit"), int):
        reply["projectLimit"] = listing["projectLimit"]
    return reply


def undo_rename_hint(project_id: str, previous: str, via: str) -> str:
    if via == "cli":
        # shlex.quote leaves `-draft` bare and argparse would read it as an
        # option, so a name that starts with a dash gets `--` before it.
        sep = "-- " if previous.startswith("-") else ""
        return f"`nebula project rename {project_id} {sep}{shlex.quote(previous)}` puts the old name back."
    return f"rename_project('{project_id}', {previous!r}) puts the old name back."


def rename_project(api: NebulaAPI, project_id: str, name: str, *, headers: dict[str, str] | None = None,
                   via: str = "mcp") -> dict[str, Any]:
    """PUT /api/projects/{id} {name}, the canvas header's rename: the route
    trims and checks the name and journals `project.renamed` for the caller.
    Returns `project` ({id, name}), `previousName` and, when it changed, a
    `note` with the call that puts the old name back."""
    target = project_ref(api, project_id, headers=headers, via=via)
    result = _call(api, "PUT", f"/api/projects/{quote(target, safe='')}", headers, json={"name": name})
    project = result.get("project") or {}
    previous = result.get("previousName")
    reply: dict[str, Any] = {"project": {"id": project.get("id"), "name": project.get("name")},
                             "previousName": previous}
    if isinstance(previous, str) and previous != project.get("name"):
        reply["note"] = undo_rename_hint(target, previous, via)
    return reply


def get_project(api: NebulaAPI, project_id: str, *, headers: dict[str, str] | None = None,
                via: str = "mcp") -> dict[str, Any]:
    """GET /api/projects/{id}?view=agent: a saved project as look_at_canvas
    shows nodes (redacted on the server, quoted keys hidden), its wires,
    cover and run history, without opening it."""
    target = project_ref(api, project_id, headers=headers, via=via)
    view = _call(api, "GET", f"/api/projects/{quote(target, safe='')}", headers, params={"view": "agent"})
    view["cover"] = cover_for_agents(api, view.get("cover"))
    return view


def project_size(api: NebulaAPI, project_id: str = "current", *, headers: dict[str, str] | None = None,
                 via: str = "mcp") -> dict[str, Any]:
    """GET /api/projects/{id}/size (Q118): the project's size as a save
    measures it, the save limit, whether the person's canvas has paused
    saving it, and what is large, largest first, with node ids. Read-only."""
    target = project_ref(api, project_id, headers=headers, via=via)
    return _call(api, "GET", f"/api/projects/{quote(target, safe='')}/size", headers)


def list_trash(api: NebulaAPI, *, kind: str | None = None, scope: str | None = None,
               project_id: str | None = None, headers: dict[str, str] | None = None,
               via: str = "mcp") -> dict[str, Any]:
    """GET /api/trash. `project_id` (an id or "current") alone means scope
    "project"; the route refuses a project scope without one."""
    params: dict[str, Any] = {"kind": kind} if kind else {}
    if project_id:
        params["projectId"] = project_ref(api, project_id, headers=headers, via=via)
        scope = scope or "project"
    if scope:
        params["scope"] = scope
    return _call(api, "GET", "/api/trash", headers, params=params or None)


def get_settings(api: NebulaAPI, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """GET /api/settings as agents need it: `configured` maps each key's name
    to whether it is set, never any part of it, whatever the route sent."""
    settings = _call(api, "GET", "/api/settings", headers)
    keys = settings.get("apiKeys")
    routing = settings.get("routing")
    return {
        "configured": {str(name): bool(value) for name, value in keys.items()} if isinstance(keys, dict) else {},
        "routing": ({str(node): choice for node, choice in routing.items() if isinstance(choice, str)}
                    if isinstance(routing, dict) else {}),
        **{key: settings.get(key) for key in SETTINGS_SHOWN},
    }


def provider_status(api: NebulaAPI, *, refresh: bool = False, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """GET /api/health/providers (free, read-only probes, cached 5 minutes)
    and GET /api/krea/connection. The Krea sign-in link is the person's to
    open: an agent only learns one waits (`signInPending`)."""
    health = _call(api, "GET", "/api/health/providers", headers, timeout=_HEALTH_TIMEOUT,
                   params={"refresh": "true"} if refresh else None)
    providers: dict[str, Any] = {}
    for name, entry in (health.get("providers") or {}).items():
        if not isinstance(entry, dict):
            continue
        row = {"configured": bool(entry.get("configured")), "status": entry.get("status"),
               "lastChecked": entry.get("last_checked")}
        if entry.get("detail"):
            row["detail"] = entry["detail"]
        providers[str(name)] = row
    try:
        connection = _call(api, "GET", "/api/krea/connection", headers)
    except NebulaAPIError as exc:
        krea: dict[str, Any] = {"status": "unknown", "error": exc.detail}
    else:
        krea = {"status": connection.get("status")}
        if connection.get("authorizationUrl"):
            krea["signInPending"] = True
        for key in ("error", "tools"):
            if connection.get(key):
                krea[key] = connection[key]
    return {"providers": providers, "krea": krea}
