"""Open a graph file on Nebula's canvas: the client side of MCP
`load_graph_file` and `nebula load`, as upload_client.py is for upload_file
and `nebula upload`.

Q123 a (Justin, 2026-10-24): "Yes: `nebula load` and an MCP tool open a
bundle, restoring its files, as Load graph does. A big one opens as a new
project."

It does what the person's Load graph does (frontend/src/lib/graphFile.ts
readGraphSelection, components/GraphFileActions.tsx load):
- The path follows `nebula upload`'s rules (upload_client._local_path): this
  process's permissions, protected storage refused (require_allowed_path),
  and an in-app chat's turn reads only its own workspace. The file is opened
  following no links, up to the bundle ceiling Load graph has (528 MB).
- A `.nebula.zip` streams to POST /api/outputs/restore with this agent's own
  headers (never the person's token), asking for `rewriteLinks`: the files
  are restored and the graph comes back with its links pointing at them,
  checked as the canvas checks them (services/graph_file_links.py).
- A plain `.nebula` / `.json` is read here; its World and spatial outputs
  get the same check. Files `nebula save` writes (the backend's own shape)
  load as they always did.
- The canvas's shape (node.data.definitionId ...) becomes the body the tab
  sends to POST /api/graph/import (``import_body``), and no value in it may
  name a protected file (validate_file_references, as `nebula load` always
  checked).
- Q120's rule (Justin: "Files over the limit open as a new project named
  after the file. The open project is left as it was. Files under the limit
  still replace the canvas, as today."): with a project open, the import
  asks to be refused when the file is over the save limit
  (refuseOverSaveLimit). On that 413 a project named after the file is made
  (project_size.project_name_for_file, the canvas's projectNameForFile) and
  the file loads there (newProjectForFile). The open project is never
  emptied or overwritten for a file over the limit. With no project open,
  the file replaces the canvas.

Nothing here runs in the backend.
"""
from __future__ import annotations

import errno
import json
import os
import stat
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator
from urllib.parse import quote

from nebula_api import NebulaAPI, NebulaAPIError

MIB = 1024 * 1024
# Load graph's ceiling for a file it opens (the frontend's
# GRAPH_BUNDLE_MAX_IMPORT_BYTES: 512 MiB of files plus 16 MiB; the restore's
# graph limit, main.RESTORE_MAX_GRAPH_BYTES). Nothing larger is read or sent.
MAX_GRAPH_FILE_BYTES = 528 * MIB
_CHUNK = MIB
_ZIP_SIGNATURE = b"PK\x03\x04"
# The canvas moves these out of the way unless the node declares them
# (graphFileShared.ts normalizeRuntimeMediaParams; main._restore_runtime_params).
_RUNTIME_MEDIA_PARAM_KEYS = ("sourceDuration", "sourceFps", "sourceIsVfr")
_DAMAGED = "This file is damaged or isn't a Nebula graph."
_NEWER = "This file is from a newer Nebula. Update Nebula, then open it again."


class GraphFileError(RuntimeError):
    """A graph file that wasn't loaded, in words an agent can act on."""


def _size_line(size: int) -> str:
    # GM's line for the same limit on the canvas (graphFile.ts graphSizeLine).
    return (f"This graph is {size / MIB:.1f} MB. "
            f"Nebula opens graphs up to {MAX_GRAPH_FILE_BYTES // MIB} MB.")


def _with_agent_marker(headers: dict[str, str] | None) -> dict[str, str]:
    """This agent's headers: its cursor name ($NEBULA_AGENT_NAME, as the CLI
    client sends it) and always an agent marker. The CLI without a name sends
    none, and the backend would then answer an over the limit file with the
    person gate's reconnect refusal, not the size."""
    headers = dict(headers or {})
    agent_name = os.environ.get("NEBULA_AGENT_NAME")
    if agent_name and "x-nebula-agent" not in {key.lower() for key in headers}:
        headers["X-Nebula-Agent"] = agent_name
    marked = {key.lower() for key in headers} & {"x-nebula-agent", "x-nebula-client"}
    if not marked and not (os.environ.get("NEBULA_AGENT_TOKEN") or os.environ.get("NEBULA_APP_TOKEN")):
        headers["X-Nebula-Client"] = "nebula-cli"
    return headers


def _local_path(source: str) -> Path:
    import upload_client

    path = upload_client._local_path(source, error=GraphFileError)
    if not path.exists():
        raise GraphFileError(f"{source}: file not found")
    return path


def _open(path: Path, shown: str) -> tuple[BinaryIO, int]:
    from moodboard_client import _open_no_follow

    # Checked again at open time, on the path as it resolves now.
    path = _local_path(str(path))
    try:
        descriptor = _open_no_follow(path)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise GraphFileError(f"{shown}: the file changed while it was being read (a link took its place). "
                                 "Load it again.") from exc
        raise GraphFileError(f"{shown}: can't read the file ({exc.strerror})") from exc
    handle = os.fdopen(descriptor, "rb")
    info = os.fstat(handle.fileno())
    if not stat.S_ISREG(info.st_mode):
        handle.close()
        raise GraphFileError(f"{shown}: not a file")
    if info.st_size > MAX_GRAPH_FILE_BYTES:
        handle.close()
        raise GraphFileError(f"{shown}: {_size_line(info.st_size)}")
    return handle, info.st_size


def _reject_constant(value: str) -> Any:
    raise ValueError(f"{value} isn't JSON")


def _parse_plain(data: bytes, shown: str) -> dict[str, Any]:
    """A plain .nebula as the tab reads it (TextDecoder: a leading BOM goes,
    bad bytes become U+FFFD; JSON.parse: no NaN)."""
    try:
        graph = json.loads(data.decode("utf-8-sig", errors="replace"), parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:
        raise GraphFileError(f"{shown}: {_DAMAGED}") from exc
    _check_shape(graph, shown)
    return graph


def _check_shape(graph: Any, shown: str) -> None:
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) \
            or not isinstance(graph.get("edges", []), list):
        raise GraphFileError(f"{shown}: {_DAMAGED}")
    version = graph.get("version")
    if isinstance(version, int) and not isinstance(version, bool) and version > 3:
        raise GraphFileError(f"{shown}: {_NEWER}")


def _chunks(handle: BinaryIO) -> Iterator[bytes]:
    while chunk := handle.read(_CHUNK):
        yield chunk


def _restore(api: NebulaAPI, handle: BinaryIO, shown: str, headers: dict[str, str]) -> dict[str, Any]:
    """The bundle's files restored and its graph's links rewritten to them."""
    try:
        restored = api.request("POST", "/api/outputs/restore", params={"rewriteLinks": "true"},
                               headers={**headers, "Content-Type": "application/zip"},
                               content=_chunks(handle), timeout=900.0)
    except NebulaAPIError as exc:
        raise GraphFileError(f"{shown}: {exc.detail}") from exc
    if (not isinstance(restored, dict) or not isinstance(restored.get("graph"), dict)
            or not isinstance(restored.get("urlMapping"), dict) or not isinstance(restored.get("warnings"), list)):
        raise GraphFileError(f"{shown}: Nebula's restore sent an answer that isn't a graph")
    _check_shape(restored["graph"], shown)
    return restored


def _check_references(graph: Any, shown: str) -> None:
    from services.file_access import ProtectedPathError, validate_file_references

    try:
        validate_file_references(graph)
    except ProtectedPathError as exc:
        raise GraphFileError(f"{shown}: {exc}") from exc


def _is_canvas_node(node: Any) -> bool:
    return isinstance(node, dict) and isinstance(node.get("data"), dict) and "definitionId" not in node


def _runtime_media_params(definition_id: Any, params: dict[str, Any],
                          declared_params: Callable[[str], set[str]]) -> dict[str, Any]:
    normalized = dict(params)
    if not any(key in normalized for key in _RUNTIME_MEDIA_PARAM_KEYS):
        return normalized
    declared = declared_params(str(definition_id or ""))
    for key in _RUNTIME_MEDIA_PARAM_KEYS:
        if key in declared or key not in normalized:
            continue
        normalized.setdefault(f"_{key}", normalized[key])
        del normalized[key]
    return normalized


def import_body(graph: dict[str, Any], *, declared_params: Callable[[str], set[str]]) -> dict[str, Any]:
    """The POST /api/graph/import body for a graph file: for the canvas's
    shape, what the tab sends (GraphFileActions importGraph: id,
    definitionId, label, params, outputs, position; edges' source,
    sourceHandle, target, targetHandle; paramsVersion, 0 for a file saved
    before the marker). A file `nebula save` wrote (the backend's shape)
    goes as it is, as `nebula load` always sent it. `declared_params` names a
    node type's params, for the canvas's runtime media move."""
    nodes = graph.get("nodes") or []
    if not any(_is_canvas_node(node) for node in nodes):
        body: dict[str, Any] = {"nodes": nodes, "edges": graph.get("edges", [])}
        if "paramsVersion" in graph:
            body["paramsVersion"] = graph["paramsVersion"]
        return body
    out_nodes = []
    for node in nodes:
        if not _is_canvas_node(node):
            out_nodes.append(node)
            continue
        data = node["data"]
        position = node.get("position") if isinstance(node.get("position"), dict) else {}
        params = data.get("params") if isinstance(data.get("params"), dict) else {}
        out_nodes.append({
            "id": node.get("id"), "definitionId": data.get("definitionId"), "label": data.get("label"),
            "params": _runtime_media_params(data.get("definitionId"), params, declared_params),
            "outputs": data.get("outputs") if data.get("outputs") is not None else {},
            "position": {"x": position.get("x"), "y": position.get("y")},
        })
    edges = [{
        "source": edge.get("source"),
        "sourceHandle": "" if edge.get("sourceHandle") is None else edge.get("sourceHandle"),
        "target": edge.get("target"),
        "targetHandle": "" if edge.get("targetHandle") is None else edge.get("targetHandle"),
    } for edge in graph.get("edges") or [] if isinstance(edge, dict)]
    version = graph.get("paramsVersion")
    return {"nodes": out_nodes, "edges": edges, "paramsVersion": 0 if version is None else version}


def _declared_params(api: NebulaAPI, headers: dict[str, str]) -> Callable[[str], set[str]]:
    cache: dict[str, set[str]] = {}

    def declared(definition_id: str) -> set[str]:
        if definition_id not in cache:
            try:
                definition = api.request("GET", f"/api/nodes/{quote(definition_id, safe='')}", headers=headers,
                                         timeout=30.0)
            except NebulaAPIError:
                definition = None  # no such node type: the canvas moves the keys too
            params = definition.get("params") if isinstance(definition, dict) else None
            cache[definition_id] = {param.get("key") for param in params or [] if isinstance(param, dict)}
        return cache[definition_id]

    return declared


def prepare(api: NebulaAPI, source: str, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """Read a graph file and get it ready for the import: {name, body,
    filesRestored, warnings}. A bundle's files are restored here."""
    headers = _with_agent_marker(headers)
    path = _local_path(source)
    handle, _size = _open(path, source)
    with handle:
        is_zip = handle.read(4) == _ZIP_SIGNATURE
        handle.seek(0)
        if is_zip:
            restored = _restore(api, handle, source, headers)
            graph, files, warnings = restored["graph"], len(restored["urlMapping"]), list(restored["warnings"])
        else:
            graph = _parse_plain(handle.read(MAX_GRAPH_FILE_BYTES + 1), source)
            files = 0
            from services.graph_file_links import sanitize_imported_spatial_outputs

            warnings = sanitize_imported_spatial_outputs(graph["nodes"])
    _check_references(graph, source)
    body = import_body(graph, declared_params=_declared_params(api, headers))
    return {"name": path.name, "body": body, "filesRestored": files, "warnings": warnings}


def _words(via: str) -> dict[str, str]:
    if via == "cli":
        return {"size": "`nebula project size`", "trim": "`nebula apply` or `nebula delete`",
                "back": "`nebula project open {id}`"}
    return {"size": "project_size", "trim": "edit_canvas or remove_from_canvas", "back": "open_project('{id}')"}


def _size(api: NebulaAPI, project_id: str, headers: dict[str, str]) -> dict[str, Any] | None:
    try:
        size = api.request("GET", f"/api/projects/{quote(project_id, safe='')}/size", headers=headers, timeout=60.0)
    except NebulaAPIError:
        return None
    if not isinstance(size, dict):
        return None
    return {key: size.get(key) for key in ("sizeBytes", "limitBytes", "size", "limit", "overLimit", "savingPaused")}


def _counts(imported: dict[str, Any], files: int) -> str:
    nodes, edges = imported.get("nodeCount", 0), imported.get("edgeCount", 0)
    text = f"{nodes} node{'s' if nodes != 1 else ''}, {edges} connection{'s' if edges != 1 else ''}"
    if files:
        text += f", {files} file{'s' if files != 1 else ''} restored"
    return text


def load(api: NebulaAPI, source: str, *, headers: dict[str, str] | None = None, via: str = "mcp") -> dict[str, Any]:
    """Open a .nebula, .json or .nebula.zip as the person's Load graph does.
    Returns {loaded, project, openedAsNewProject, previousProject (a new
    project only), nodeCount, edgeCount, idMap, filesRestored, warnings,
    savingPaused, size, note}."""
    headers = _with_agent_marker(headers)
    prepared = prepare(api, source, headers=headers)
    body, name = prepared["body"], prepared["name"]
    words = _words(via)

    def call(method: str, path: str, **kwargs: Any) -> Any:
        try:
            return api.request(method, path, headers=headers, **kwargs)
        except NebulaAPIError as exc:
            raise GraphFileError(f"{source}: {exc.detail}") from exc

    listing = call("GET", "/api/projects", timeout=30.0)
    active_id = listing.get("activeProjectId") if isinstance(listing, dict) else None
    active = next((project for project in (listing.get("projects") or []) if project.get("id") == active_id),
                  None) if active_id else None

    def result(imported: dict[str, Any], project: dict[str, Any] | None, *, new: bool) -> dict[str, Any]:
        size = _size(api, project["id"], headers) if project else None
        paused = bool(size and size.get("savingPaused"))
        reply: dict[str, Any] = {
            "loaded": name,
            "project": {"id": project["id"], "name": project.get("name")} if project else None,
            "openedAsNewProject": new,
            "nodeCount": imported.get("nodeCount", 0), "edgeCount": imported.get("edgeCount", 0),
            "idMap": imported.get("idMap") or {},
            "filesRestored": prepared["filesRestored"],
            "warnings": [*prepared["warnings"], *(imported.get("warnings") or [])],
            "savingPaused": paused,
        }
        if size:
            reply["size"] = size
        return reply

    if active is None:
        imported = call("POST", "/api/graph/import", json=body, timeout=600.0)
        reply = result(imported, None, new=False)
        reply["note"] = f"Loaded {name} onto the canvas (no project was open): {_counts(imported, reply['filesRestored'])}."
        return reply

    try:
        imported = api.request("POST", "/api/graph/import", headers=headers, timeout=600.0,
                               json={**body, "refuseOverSaveLimit": True})
    except NebulaAPIError as exc:
        payload = exc.payload if isinstance(exc.payload, dict) else {}
        if exc.status != 413 or payload.get("limit") != "size":
            raise GraphFileError(f"{source}: {exc.detail}") from exc
        return _open_as_new_project(api, source, prepared, active, payload, headers, words, call, result)
    reply = result(imported, active, new=False)
    reply["note"] = (f"Loaded {name} into {active.get('name')}, replacing its canvas: "
                     f"{_counts(imported, reply['filesRestored'])}.")
    if reply["savingPaused"]:
        size = reply["size"]
        reply["note"] += (f" It's {size['size']}, over the {size['limit']} save limit, so saving is paused until "
                          f"it's trimmed: {words['size']} shows what's large.")
    return reply


def _open_as_new_project(api: NebulaAPI, source: str, prepared: dict[str, Any], previous: dict[str, Any],
                         refusal: dict[str, Any], headers: dict[str, str], words: dict[str, str],
                         call: Callable[..., Any], result: Callable[..., dict[str, Any]]) -> dict[str, Any]:
    """Q120: a project named after the file, made the way new_project makes
    one (with the workspace revision), and the file loaded there. The project
    that was open stays as it was."""
    from services.project_size import limit_text, project_name_for_file

    name = prepared["name"]
    project_name = project_name_for_file(name)
    listing = call("GET", "/api/projects", timeout=30.0)
    created = call("POST", "/api/projects", timeout=30.0,
                   json={"name": project_name, "workspaceRevision": listing.get("workspaceRevision", "")})
    project = created.get("project") or {}
    back = words["back"].format(id=previous["id"])
    try:
        imported = api.request("POST", "/api/graph/import", headers=headers, timeout=600.0,
                               json={**prepared["body"], "newProjectForFile": True})
    except NebulaAPIError as exc:
        raise GraphFileError(
            f"{source}: it's over the save limit, so a new project, “{project.get('name')}” ({project.get('id')}), "
            f"was made for it, but loading it there was refused: {exc.detail} {previous.get('name')} is as it "
            f"was; {back} goes back to it.") from exc
    reply = result(imported, project, new=True)
    reply["previousProject"] = {"id": previous["id"], "name": previous.get("name")}
    limit = limit_text(int(refusal.get("limitBytes") or 0)) if refusal.get("limitBytes") else "16 MB"
    reason = (f"{name} is over Nebula's {limit} save limit" if refusal.get("scope") == "graph"
              else f"Loading {name} would take {previous.get('name')} over Nebula's {limit} save limit")
    reply["note"] = (f"{reason}, so it opened as a new project, “{project.get('name')}”: "
                     f"{_counts(imported, reply['filesRestored'])}. {previous.get('name')} is as it was; "
                     f"{back} goes back to it.")
    if reply["savingPaused"]:
        reply["note"] += (f" Saving “{project.get('name')}” is paused until it's {limit} or less: {words['size']} "
                          f"shows what's large. Trim it with {words['trim']}, asking the person before deleting "
                          "their work; it saves again by itself.")
    return reply
