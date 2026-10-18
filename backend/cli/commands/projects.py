from __future__ import annotations

import sys

from ..client import NebulaClient


def run_list(client: NebulaClient) -> None:
    listing = client.list_projects()
    active = listing.get("activeProjectId")
    projects = listing.get("projects") or []
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
