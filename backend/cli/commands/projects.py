"""`nebula projects` and `nebula project new|open|rename|show|size`.

`rename` and `show` are MCP rename_project and get_project, and `projects
--json` is list_projects: each goes through project_client.py, which the tools
share, so `--json` prints what the tool returns (hints in `nebula` words).
"""
from __future__ import annotations

import json
import sys

import project_client

from ..client import NebulaClient
from ..formatter import catalog_restore_lines, format_project


def _print_json(data) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def run_list(client: NebulaClient, *, as_json: bool = False) -> None:
    if as_json:
        _print_json(client.shared(project_client.list_projects))
        return
    listing = client.list_projects()
    active = listing.get("activeProjectId")
    projects = listing.get("projects") or []
    restore = listing.get("catalogRestore")
    if isinstance(restore, dict) and restore.get("note"):
        # Nebula restored a damaged project list (until the person closes its notice).
        print(f"Note: {restore['note']}")
        for line in catalog_restore_lines(restore):
            print(line)
        print()
    waiting = listing.get("canvasNotFiled")
    if isinstance(waiting, dict):
        print(f"Note: the live canvas isn't a saved project and couldn't be saved as one: the project list is at "
              f"its {waiting.get('reason')} limit. Opening or making a project is refused until the person frees "
              "room (moves a project to Recently deleted, or deletes one for good); the next listing then saves it.")
        print()
    if not projects:
        print("No saved projects.")
        return
    for project in projects:
        mark = "*" if project.get("id") == active else " "
        updated = str(project.get("updatedAt", ""))[:16].replace("T", " ")
        print(f"{mark} {project.get('id')}  {project.get('name', '')}  (updated {updated})")
    print("\n* is open on the canvas. `nebula project open <id>` switches to another.")


def run_open(client: NebulaClient, project_id: str) -> None:
    listing = client.list_projects()
    if project_id == listing.get("activeProjectId"):
        print(f"{project_id} is already open.")
        return
    if not any(project.get("id") == project_id for project in listing.get("projects") or []):
        print(f"error: no project '{project_id}' (`nebula projects` lists them)", file=sys.stderr)
        sys.exit(1)
    result = client.open_project(project_id, listing.get("workspaceRevision", ""))
    print(f"Opened {result.get('project', {}).get('name', project_id)}. The canvas now shows it.")


def run_new(client: NebulaClient, name: str) -> None:
    """Start a new, empty project and open it. The one that was open is saved
    as it is; the person's canvas follows and offers a way back to it."""
    name = name.strip()
    if not name:
        print('error: give the project a name: nebula project new "<name>"', file=sys.stderr)
        sys.exit(1)
    listing = client.list_projects()
    previous_id = listing.get("activeProjectId")
    previous = next((project for project in listing.get("projects") or [] if project.get("id") == previous_id), None)
    result = client.create_project(name, listing.get("workspaceRevision", ""))
    project = result.get("project") or {}
    print(f"Made and opened {project.get('name', name)} ({project.get('id', '?')}). The canvas now shows it.")
    if previous:
        print(f"{previous.get('name', previous_id)} is saved as it was: "
              f"`nebula project open {previous_id}` goes back to it.")


def run_rename(client: NebulaClient, project_id: str, name: str, *, as_json: bool = False) -> None:
    """Rename a saved project ("current" is the open one) through the canvas
    header's route: it journals `project.renamed` as this agent
    ($NEBULA_AGENT_NAME) and the person's canvas shows the name at once."""
    result = client.shared(project_client.rename_project, project_id, name, via="cli")
    if as_json:
        _print_json(result)
        return
    project = result.get("project") or {}
    new, previous = project.get("name"), result.get("previousName")
    if previous == new:
        print(f"{project.get('id')} is already named {json.dumps(new, ensure_ascii=False)}; nothing changed.")
        return
    print(f"Renamed {project.get('id')}: {json.dumps(previous, ensure_ascii=False)} → "
          f"{json.dumps(new, ensure_ascii=False)}. The person's canvas and Projects screen show it now.")
    if result.get("note"):
        print(result["note"])


def run_show(client: NebulaClient, project_id: str, *, as_json: bool = False) -> None:
    """A saved project without opening it: MCP get_project."""
    view = client.shared(project_client.get_project, project_id, via="cli")
    if as_json:
        _print_json(view)
        return
    print(format_project(view))


def run_size(client: NebulaClient, project_id: str = "current", *, as_json: bool = False) -> None:
    """A project's size against the save limit and what takes the space: MCP
    project_size (Q118)."""
    result = client.shared(project_client.project_size, project_id, via="cli")
    if as_json:
        _print_json(result)
        return
    project = result.get("project") or {}
    state = ("saving paused" if result.get("savingPaused")
             else "over the limit" if result.get("overLimit") else "under the limit")
    print(f"PROJECT {project.get('name')} ({project.get('id')}): {result.get('size')} of {result.get('limit')}, "
          f"{state} ({result.get('sizeBytes'):,} of {result.get('limitBytes'):,} bytes)")
    print("LARGEST FIRST:")
    for row in result.get("largest") or []:
        if row.get("kind") == "node":
            what = f"{row.get('nodeId'):<6}{row.get('name')} ({row.get('definitionId')}), {row.get('part')}"
        else:
            count = f", {row['count']}" if "count" in row else ""
            what = f"{row.get('name')}{count}"
        print(f"  {row.get('size'):>9}  {what}")
    smaller = result.get("smaller") or {}
    if smaller.get("count"):
        print(f"  {smaller.get('size'):>9}  {smaller.get('count')} smaller items")
    print(result.get("note", ""))
