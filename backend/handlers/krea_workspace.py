"""Krea workspace nodes beyond single-model generation.

Job history, node apps, Krea Files, Krea Nodes workflows, the Krea Agent,
connected desktop apps and workspace usage. Each node runs only from an
explicit graph run, offers the billing paths Krea offers for that feature,
and refuses anything the chosen path cannot do before the first request.

Media Krea returns is copied into the run directory, so history and later
graph steps never depend on short-lived provider URLs.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from jsonschema import Draft202012Validator

from handlers.krea import (
    KREA_BASE_URL, _api_key, _auth_headers, _auth_mode, _cancel_krea_job, _clean_str, _int_value,
    _json_headers, _poll_krea_job, _port_values, _raise_for_krea_response, _upload_asset,
)
from handlers.krea_gateway import _JOB_ID, _asset_data, _http_url
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.cancellation import schedule_detached_cancel
from services.output import _MEDIA_EXTENSIONS, get_run_dir, portable_output_ref, write_media_bytes
from services.public_url import fetch_public_media

Emit = Callable[[ExecutionEvent], Awaitable[None]] | None
_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_FILE_URI = re.compile(r"^(?:file|folder|asset|moodboard|style|session|collection):[0-9a-fA-F-]{36}$")
_PRIMARY = {"Image": "image", "Video": "video", "Audio": "audio", "Mesh": "mesh"}
_MIME_MAJOR = {"image": "Image", "video": "Video", "audio": "Audio", "model": "Mesh"}
DIRECT_UPLOAD_LIMIT = 20_000_000
MAX_SAVE_BYTES = 2_000_000_000
MAX_MEDIA_BYTES = 1_000_000_000
# Image types a desktop app may return as a frame, with fixed extensions.
_FRAME_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _typed_id(node: GraphNode, key: str, label: str) -> str:
    value = _clean_str(node.params.get(key))
    if not _ID.fullmatch(value):
        raise ValueError(f"Enter a valid {label}")
    return value


def _json_object(value: Any, label: str) -> dict[str, Any]:
    if value in (None, ""):
        return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise ValueError(f"{label} must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _csv(value: Any) -> list[str]:
    return [part.strip() for part in _clean_str(value).split(",") if part.strip()]


def media_type_for(url: str, mime: str | None = None) -> str | None:
    """Nebula media type for a Krea output, from its MIME type or extension."""
    if mime:
        mime = mime.split(";", 1)[0].strip().lower()
        if mime == "image/svg+xml":
            return "SVG"
        major = _MIME_MAJOR.get(mime.split("/", 1)[0])
        if major:
            return major
    suffix = Path(urlsplit(url).path).suffix.lstrip(".").lower()
    return next((kind for kind, extensions in _MEDIA_EXTENSIONS.items() if suffix in extensions), None)


def job_urls(job: dict[str, Any]) -> list[tuple[str, str]]:
    """(output key, url) pairs from any of Krea's `result.urls` shapes; previews are skipped."""
    result = job.get("result") if isinstance(job.get("result"), dict) else {}
    urls = result.get("urls")
    pairs: list[tuple[str, str]] = []

    def add(key: str, value: Any) -> None:
        if isinstance(value, str):
            pairs.append((key, value))
        elif isinstance(value, dict) and value.get("type") != "preview" and isinstance(value.get("url"), str):
            pairs.append((key, value["url"]))
        elif isinstance(value, list):
            for item in value:
                add(key, item)

    if isinstance(urls, dict):
        for key, value in urls.items():
            add(str(key), value)
    else:
        add("output", urls)
    return pairs


async def save_media(items: list[tuple[str, str, str | None]]) -> list[dict[str, Any]]:
    """Copy (key, url, mime) media into the run directory as typed records.

    URLs come from Krea answers that other people or the Krea Agent can shape,
    so they are fetched only from public https hosts, redirects included."""
    run_dir = get_run_dir()
    saved = []
    for key, url, mime in items:
        kind = media_type_for(url, mime)
        if kind is None:
            continue
        payload, content_type = await fetch_public_media(url, label="Krea", max_bytes=MAX_MEDIA_BYTES)
        path = await write_media_bytes(payload, content_type, kind, run_dir, url)
        saved.append({"key": key, "type": kind, "value": portable_output_ref(str(path), require_file=True),
                      "path": str(path)})
    return saved


def media_outputs(saved: list[dict[str, Any]]) -> dict[str, Any]:
    """`media` array plus the first image/video/audio/mesh as typed ports."""
    outputs: dict[str, Any] = {"media": {"type": "Array", "value": [
        {"type": item["type"], "value": item["value"], "key": item["key"]} for item in saved]}}
    for kind, port in _PRIMARY.items():
        first = next((item["path"] for item in saved if item["type"] == kind), None)
        outputs[port] = {"type": kind, "value": first}
    return outputs


async def _api_upload(client: httpx.AsyncClient, api_key: str, value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("url") or value.get("image_url") or value.get("value")
    raw = _clean_str(value)
    if raw.startswith(("http://", "https://")) and _asset_data(raw) is None:
        return raw
    return await _upload_asset(client, api_key, raw, description="Nebula Krea input")


# ---------------------------------------------------------------------------
# Job history (phase 7)
# ---------------------------------------------------------------------------

async def handle_krea_job_history(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                                  emit: Emit = None) -> dict[str, Any]:
    """List past Krea jobs (API token) or fetch one job (either path), optionally saving its media."""
    mode = _auth_mode(node)
    wired = inputs["job"].value if inputs.get("job") else None
    job_id = _clean_str((wired.get("job_id") or wired.get("id")) if isinstance(wired, dict) else wired
                        or node.params.get("job_id"))
    if job_id and not _JOB_ID.fullmatch(job_id):
        raise ValueError("Enter a valid Krea job ID")
    if not job_id and mode == "mcp":
        raise ValueError("Listing job history needs a Krea API token; the Krea account can fetch one job by ID. Nothing was sent")

    if mode == "mcp":
        from services.krea_account import account_tools
        from services.krea_mcp_generation import JOB_KEYS, _job
        async with account_tools() as account:
            jobs = [_job(await account.tools.call("get_job", [(JOB_KEYS, job_id)]))]
    else:
        api_key = _api_key(api_keys)
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client:
            if job_id:
                response = await client.get(f"{KREA_BASE_URL}/jobs/{job_id}", headers=_auth_headers(api_key))
                _raise_for_krea_response(response, "job lookup")
                jobs = [response.json()]
            else:
                params: dict[str, Any] = {"limit": _int_value(node.params.get("limit"), 20, 1, 1000)}
                for key in ("status", "types", "cursor"):
                    value = _clean_str(node.params.get(key))
                    if value and value != "any":
                        params[key] = value
                response = await client.get(f"{KREA_BASE_URL}/jobs", headers=_auth_headers(api_key), params=params)
                _raise_for_krea_response(response, "job history")
                payload = response.json()
                jobs = payload.get("items") if isinstance(payload, dict) else None
                if not isinstance(jobs, list):
                    raise RuntimeError("Krea job history returned no job list")

    saved: list[dict[str, Any]] = []
    if node.params.get("download"):
        limit = _int_value(node.params.get("download_limit"), 10, 1, 100)
        completed = [job for job in jobs if isinstance(job, dict) and job.get("status") == "completed"][:limit]
        saved = await save_media([(str(job.get("job_id") or job.get("id")), url, None)
                                  for job in completed for _key, url in job_urls(job)])
    lines = [f"{job.get('job_id') or job.get('id')} · {job.get('type') or ''} · {job.get('status')} · {job.get('created_at') or ''}"
             for job in jobs if isinstance(job, dict)]
    return {
        "jobs": {"type": "Array", "value": jobs},
        "job": {"type": "Any", "value": jobs[0] if jobs else None},
        **media_outputs(saved),
        "text": {"type": "Text", "value": "\n".join(lines)},
    }


# ---------------------------------------------------------------------------
# Node apps (phase 5)
# ---------------------------------------------------------------------------

def _wire_type(schema: dict) -> str:
    return str(schema.get("x-krea-wire-type") or ("image" if schema.get("format") == "uri" else schema.get("type", "")))


def node_app_input(schema: dict, explicit: dict[str, Any], images: list[Any], text: Any) -> dict[str, Any]:
    """Fill a node app's input: explicit values win, then wired images fill the
    remaining image fields in schema order, then wired text fills the first text field."""
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    unknown = set(explicit) - set(properties)
    if unknown:
        raise ValueError(f"This node app has no input named {', '.join(sorted(unknown))}")
    body = dict(explicit)
    open_images = [key for key, field in properties.items() if _wire_type(field) == "image" and key not in body]
    if len(images) > len(open_images):
        raise ValueError(f"This node app takes {len(open_images)} more image(s); {len(images)} are wired")
    body.update(zip(open_images, images))
    if text not in (None, ""):
        field = next((key for key, value in properties.items() if _wire_type(value) == "text" and key not in body), None)
        if field is None:
            raise ValueError("This node app has no free text input for the wired text")
        body[field] = text
    return body


def _media_fields(schema: dict) -> set[str]:
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    return {key for key, field in properties.items()
            if field.get("format") == "uri" or _wire_type(field) in {"image", "video", "audio", "3d"}}


def _check_input(schema: dict, body: dict[str, Any]) -> None:
    preview = {key: ("https://assets.krea.ai/validated-local-input" if key in _media_fields(schema) else value)
               for key, value in body.items()}
    errors = sorted(Draft202012Validator(schema).iter_errors(preview), key=lambda error: list(error.path))
    if errors:
        field = ".".join(str(part) for part in errors[0].path) or "input"
        raise ValueError(f"Node app {field}: {errors[0].message}; nothing was sent")


async def _account_node_app(account, version_id: str) -> dict[str, Any]:
    cursor = None
    for _page in range(20):
        payload = await account.call("get_node_apps", {"limit": 1000, **({"cursor": cursor} if cursor else {})})
        apps = payload.get("node_apps") if isinstance(payload, dict) else None
        if not isinstance(apps, list):
            raise RuntimeError("Krea get_node_apps returned no node app list")
        match = next((app for app in apps if isinstance(app, dict) and app.get("node_app_version_id") == version_id), None)
        if match:
            return match
        cursor = payload.get("next_cursor")
        if not cursor:
            break
    raise ValueError("This node app version is not runnable from your Krea account (only public and workspace-shared apps are)")


async def _node_app_outputs(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    saved = await save_media([(key, url, None) for job in jobs for key, url in job_urls(job)])
    by_key: dict[str, Any] = {}
    for item in saved:
        by_key.setdefault(item["key"], {"type": item["type"], "value": item["value"]})
    return {**media_outputs(saved), "outputs": {"type": "Any", "value": by_key},
            "jobs": {"type": "Array", "value": jobs}}


async def handle_krea_node_app(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                               emit: Emit = None) -> dict[str, Any]:
    """Run one version of a Krea node app with schema-checked inputs."""
    version_id = _typed_id(node, "node_app_version_id", "node app version ID")
    explicit = {**_json_object(node.params.get("input"), "Input"),
                **_json_object(inputs["inputs"].value if inputs.get("inputs") else None, "Inputs")}
    images = _port_values(inputs.get("images"))
    text = inputs["text"].value if inputs.get("text") else None
    mode = _auth_mode(node)

    if mode == "mcp":
        from services.krea_account import account_tools, run_jobs
        async with account_tools() as account:
            app = await _account_node_app(account, version_id)
            schema = app.get("input_openapi_schema") or {}
            body = node_app_input(schema, explicit, images, text)
            _check_input(schema, body)
            account.check("execute_node_app", {"nodeAppVersionId": version_id, "input": {}, "sync": False})
            async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
                for key in _media_fields(schema) & set(body):
                    body[key] = await account.upload(client, body[key])
            jobs = await run_jobs(account, "execute_node_app",
                                  {"nodeAppVersionId": version_id, "input": body, "sync": False}, node.id, emit)
        return await _node_app_outputs(jobs)

    api_key = _api_key(api_keys)
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
        response = await client.get(f"{KREA_BASE_URL}/node-apps/{version_id}", headers=_auth_headers(api_key))
        _raise_for_krea_response(response, "node app lookup")
        schema = response.json().get("input_openapi_schema") or {}
        body = node_app_input(schema, explicit, images, text)
        _check_input(schema, body)
        for key in _media_fields(schema) & set(body):
            body[key] = await _api_upload(client, api_key, body[key])
        response = await client.post(f"{KREA_BASE_URL}/node-apps/{version_id}/execute",
                                     headers=_json_headers(api_key), json=body)
        _raise_for_krea_response(response, "node app run")
        submitted = response.json()
        submitted = submitted if isinstance(submitted, list) else [submitted]
        ids = [str(job.get("job_id") or "") for job in submitted if isinstance(job, dict)]
        if not ids or not all(_JOB_ID.fullmatch(job_id) for job_id in ids):
            raise RuntimeError("Krea node app run returned no valid job id; it was not retried")
        pending = set(ids)
        try:
            jobs = []
            for job_id in ids:
                jobs.append(await _poll_krea_job(client, api_key, job_id, node_id=node.id, emit=emit))
                pending.discard(job_id)
        finally:
            for job_id in pending:
                schedule_detached_cancel(lambda j=job_id: _cancel_krea_job(j, api_key))
    return await _node_app_outputs(jobs)


# ---------------------------------------------------------------------------
# Krea Files (phase 6, Krea account only)
# ---------------------------------------------------------------------------

def _download_url(entry: dict[str, Any]) -> str | None:
    for key in ("url", "download_url", "downloadUrl", "signedUrl", "signed_url"):
        value = entry.get(key)
        if isinstance(value, str) and value.startswith("https://"):
            return value
    return None


async def handle_krea_files(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                            emit: Emit = None) -> dict[str, Any]:
    """List Krea Files and optionally bring their contents into Nebula."""
    from services.krea_account import account_tools
    scope = _clean_str(node.params.get("scope")) or "user"
    arguments: dict[str, Any] = {
        "scope": scope, "limit": _int_value(node.params.get("limit"), 25, 1, 200),
        "all_tags": _csv(node.params.get("tags")), "any_tags": [], "without_tags": [],
    }
    file_type = _clean_str(node.params.get("file_type")) or "file"
    if file_type != "any":
        arguments["type"] = file_type
    for key, param in (("filename", "filename"), ("root_uri", "folder_uri")):
        value = _clean_str(node.params.get(param))
        if value:
            arguments[key] = value
    if arguments.get("root_uri") and not _FILE_URI.fullmatch(arguments["root_uri"]):
        raise ValueError("Folder must be a Krea Files URI like folder:<uuid>")
    run_dir = get_run_dir()
    saved: list[dict[str, Any]] = []
    texts: list[str] = []
    async with account_tools() as account:
        listing = await account.call("list_files", arguments)
        files = listing.get("files") if isinstance(listing, dict) else None
        if not isinstance(files, list):
            raise RuntimeError("Krea list_files returned no file list")
        uris = [item["file_uri"] for item in files if isinstance(item, dict)
                and str(item.get("file_uri", "")).startswith("file:")]
        if node.params.get("download", True) and uris:
            for start in range(0, len(uris), 50):
                answer = await account.call("read_files", {"uris": uris[start:start + 50]})
                for entry in answer.get("files", []) if isinstance(answer, dict) else []:
                    if not isinstance(entry, dict) or entry.get("error"):
                        continue
                    name, mime = _clean_str(entry.get("name")), _clean_str(entry.get("mimeType") or entry.get("mime_type"))
                    url = _download_url(entry)
                    if url:
                        saved.extend(await save_media([(entry.get("uri", name), url, mime)]))
                    elif isinstance(entry.get("content"), str):
                        kind = media_type_for(name, mime)
                        if kind == "SVG":
                            path = run_dir / f"krea-file-{uuid4().hex[:8]}.svg"
                            path.write_text(entry["content"])
                            saved.append({"key": entry.get("uri", name), "type": "SVG", "path": str(path),
                                          "value": portable_output_ref(str(path), require_file=True)})
                        else:
                            texts.append(entry["content"])
    names = [f"{item.get('name')} — {item.get('file_uri')}" for item in files if isinstance(item, dict)]
    return {
        "files": {"type": "Array", "value": files},
        **media_outputs(saved),
        "text": {"type": "Text", "value": texts[0] if texts else ""},
        "summary": {"type": "Text", "value": "\n".join(names)},
    }


def _local_path(value: Any) -> Path:
    from handlers.krea import _resolve_local_path
    from services.file_access import require_allowed_path
    if isinstance(value, dict):
        value = value.get("value") or value.get("url") or value.get("path")
    path = _resolve_local_path(_clean_str(value))
    if path is None:
        raise ValueError("Save to Krea Files takes Nebula media from this machine, not remote URLs")
    path = require_allowed_path(path)
    if not path.is_file():
        raise ValueError("Save to Krea Files input is not a readable file")
    return path


def _checked_upload_target(url: Any) -> str:
    try:
        parsed = _http_url(url)
    except (ValueError, TypeError):
        raise RuntimeError("Krea returned no usable upload URL") from None
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise RuntimeError("Krea returned an unexpected upload URL")
    return url


async def _send_file(client: httpx.AsyncClient, grant: dict[str, Any], path: Path, mime: str) -> None:
    """Send raw bytes the way Krea's write_files_upload grant asks; never multipart."""
    if grant.get("multipart"):
        raise RuntimeError("Krea asked for a multipart upload, which Nebula does not send yet; nothing was saved")
    upload_url = _checked_upload_target(grant.get("uploadUrl") or grant.get("upload_url"))
    method = str(grant.get("method") or "POST").upper()
    if method not in {"POST", "PUT"}:
        raise RuntimeError("Krea returned an unexpected upload method")
    headers = {str(k): str(v) for k, v in (grant.get("headers") or {}).items()} if isinstance(grant.get("headers"), dict) else {}
    headers.setdefault("content-type", mime)
    response = await client.request(method, upload_url, content=path.read_bytes(), headers=headers)
    if response.status_code >= 300:
        raise RuntimeError(f"Krea Files upload failed ({response.status_code})")
    commit = grant.get("commitUrl") or grant.get("commit_url")
    if commit:
        response = await client.post(_checked_upload_target(commit), json={})
        if response.status_code >= 300:
            raise RuntimeError(f"Krea Files upload commit failed ({response.status_code})")


async def handle_krea_files_save(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                                 emit: Emit = None) -> dict[str, Any]:
    """Save Nebula media or text into Krea Files, optionally in a folder and with tags."""
    from services.krea_account import account_tools
    paths = [_local_path(value) for value in _port_values(inputs.get("media"))]
    text = _clean_str(inputs["text"].value if inputs.get("text") else "")
    if not paths and not text:
        raise ValueError("Wire media or text to save to Krea Files")
    for path in paths:
        if path.stat().st_size > MAX_SAVE_BYTES:
            raise ValueError(f"{path.name} is larger than 2 GB")
    scope = _clean_str(node.params.get("scope")) or "user"
    folder = _clean_str(node.params.get("folder"))
    tags = _csv(node.params.get("tags"))
    base = _clean_str(node.params.get("name"))
    uploaded: list[str] = []
    written_uris: list[str] = []
    async with account_tools() as account:
        parent: dict[str, Any] = {}
        if folder:
            made = await account.call("create_folders", {"folders": [{"scope": scope, "name": folder}]})
            items = made.get("folders") if isinstance(made, dict) else made
            folder_uri = next((item.get("uri") or item.get("folder_uri") for item in items or [] if isinstance(item, dict)), None)
            if not isinstance(folder_uri, str) or not folder_uri.startswith("folder:"):
                raise RuntimeError("Krea create_folders returned no folder")
            parent = {"parent_uri": folder_uri}
        if paths:
            specs = []
            for index, path in enumerate(paths):
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                name = f"{base}-{index + 1}{path.suffix}" if base and len(paths) > 1 else f"{base}{path.suffix}" if base else path.name
                spec = {"scope": scope, "name": name, "mime_type": mime, **parent}
                if path.stat().st_size > DIRECT_UPLOAD_LIMIT:
                    spec["size_bytes"] = path.stat().st_size
                specs.append((spec, path, mime))
            granted = await account.call("write_files_upload", {"files": [spec for spec, _, _ in specs]})
            grants = granted.get("files") if isinstance(granted, dict) else granted
            if not isinstance(grants, list) or len(grants) != len(specs):
                raise RuntimeError("Krea write_files_upload returned an unexpected answer; nothing was sent")
            async with httpx.AsyncClient(timeout=600.0, follow_redirects=False) as client:
                for (spec, path, mime), grant in zip(specs, grants):
                    if not isinstance(grant, dict) or grant.get("error"):
                        raise RuntimeError(f"Krea refused to store {spec['name']}")
                    await _send_file(client, grant, path, mime)
                    uri = grant.get("uri") or grant.get("file_uri")
                    if isinstance(uri, str):
                        uploaded.append(uri)
        if text:
            written = await account.call("write_files_inline", {"files": [{
                "scope": scope, "name": f"{base or 'nebula-text'}.md", "content": text, "mime_type": "text/markdown",
                **({"tags": tags} if tags else {}), **parent}]})
            entries = written.get("files") if isinstance(written, dict) else written
            written_uris.extend(item.get("uri") or item.get("file_uri") for item in entries or []
                                if isinstance(item, dict) and (item.get("uri") or item.get("file_uri")))
        # Inline text carries its tags already; uploads are tagged afterwards.
        media_uris = [uri for uri in uploaded if uri.startswith("file:")]
        if tags and media_uris:
            await account.call("tag_files", {"uris": media_uris[:50], "add": tags, "remove": []})
    uris = uploaded + written_uris
    return {
        "uris": {"type": "Array", "value": uris},
        "text": {"type": "Text", "value": f"Saved {len(uris)} item(s) to Krea Files" + (f" in {folder}" if folder else "")},
    }


# ---------------------------------------------------------------------------
# Krea Nodes workflows (phase 9, Krea account only)
# ---------------------------------------------------------------------------

def _workflow_link(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value if value.startswith("https://") else f"https://www.krea.ai{value if value.startswith('/') else '/' + value}"


async def handle_krea_nodes_workflow(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                                     emit: Emit = None) -> dict[str, Any]:
    """Create, read or edit a Krea Nodes workflow. Nothing runs in Krea Nodes until the user opens it there."""
    from services.krea_account import account_tools
    action = _clean_str(node.params.get("action")) or "create"
    wired = inputs["workflow"].value if inputs.get("workflow") else None
    if action == "create":
        spec = _json_object(wired if isinstance(wired, (dict, str)) and wired else node.params.get("spec"), "Workflow")
        name = _clean_str(node.params.get("name")) or _clean_str(spec.get("name")) or "Nebula workflow"
        arguments = {"name": name, "nodes": spec.get("nodes"), **({"edges": spec["edges"]} if spec.get("edges") else {})}
        tool = "create_node_workflow"
    else:
        # Reading or editing names one of the user's existing workflows. It is
        # typed, never wired, so a shared recipe cannot target the user's work.
        workflow = _clean_str(node.params.get("workflow_id"))
        if not workflow or len(workflow) > 300:
            raise ValueError("Enter the Krea Nodes workflow ID or link")
        if action == "read":
            arguments = {"workflow": workflow, "mode": _clean_str(node.params.get("read_mode")) or "list"}
            tool = "read_node_workflow"
        elif action == "update":
            operations = node.params.get("operations")
            operations = json.loads(operations) if isinstance(operations, str) and operations.strip() else operations
            if not isinstance(operations, list) or not operations:
                raise ValueError("Operations must be a JSON list of Krea Nodes edits")
            arguments = {"workflow": workflow, "operations": operations}
            tool = "update_node_workflow"
        else:
            raise ValueError(f"Unknown Krea Nodes action: {action}")
    async with account_tools() as account:
        result = await account.call(tool, arguments)
    link = _workflow_link(result.get("url") if isinstance(result, dict) else None)
    return {
        "workflow": {"type": "Any", "value": result},
        "url": {"type": "Text", "value": link or ""},
        "text": {"type": "Text", "value": f"Open in Krea Nodes: {link}" if link else json.dumps(result)[:4000]},
    }


# ---------------------------------------------------------------------------
# Krea Agent (phase 10, Krea account only)
# ---------------------------------------------------------------------------

def _agent_text(view: dict[str, Any]) -> str:
    for key in ("latestAssistantText", "latest_assistant_text", "assistantText", "text", "message", "output"):
        value = view.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _deliverable_urls(value: Any, found: list[tuple[str, str, str | None]]) -> None:
    if isinstance(value, dict):
        url = value.get("url")
        if isinstance(url, str) and url.startswith("https://"):
            found.append((str(value.get("name") or value.get("id") or "deliverable"), url,
                          value.get("contentType") or value.get("mimeType") or value.get("mime_type")))
        for key, item in value.items():
            if key != "url":
                _deliverable_urls(item, found)
    elif isinstance(value, list):
        for item in value:
            _deliverable_urls(item, found)


async def handle_krea_agent(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                            emit: Emit = None) -> dict[str, Any]:
    """Send one turn to the Krea Agent and wait for its deliverables.

    The Agent runs unattended and bills the workspace; it approves its own cost
    prompts. Krea offers no way to stop a turn, so Stop only stops waiting."""
    from services.krea_account import account_tools
    prompt = _clean_str(inputs["prompt"].value if inputs.get("prompt") else node.params.get("prompt"))
    if not prompt:
        raise ValueError("The Krea Agent needs a prompt")
    session = inputs["session"].value if inputs.get("session") else None
    session_id = _clean_str(session.get("sessionId") if isinstance(session, dict) else node.params.get("session_id"))
    arguments: dict[str, Any] = {"prompt": prompt}
    if session_id:
        arguments["sessionId"] = session_id
    elif _clean_str(node.params.get("name")):
        arguments["name"] = _clean_str(node.params.get("name"))
    for key in ("effort", "model"):
        value = _clean_str(node.params.get(key))
        if value and value != "auto":
            arguments[key] = value
    wait_total = _int_value(node.params.get("wait_seconds"), 900, 30, 3600)
    async with account_tools() as account:
        account.check("send_agent_message", {**arguments, "attachments": []})
        attachments = []
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
            for value in _port_values(inputs.get("attachments")):
                attachments.append({"url": await account.upload(client, value)})
        if attachments:
            arguments["attachments"] = attachments
        started = await account.call("send_agent_message", arguments)
        if not isinstance(started, dict) or not started.get("sessionId"):
            raise RuntimeError("Krea Agent returned no session")
        view: dict[str, Any] = started
        waited = 0
        while waited < wait_total:
            step = min(300, wait_total - waited)
            view = await account.call("wait_for_agent_session", {
                "sessionId": started["sessionId"], "timeoutSeconds": step,
                **({"runId": started["runId"]} if started.get("runId") else {})})
            waited += step
            if not isinstance(view, dict) or view.get("finished") or not view.get("timedOut"):
                break
    if not isinstance(view, dict):
        raise RuntimeError("Krea Agent returned no session view")
    if not view.get("finished") and view.get("timedOut"):
        raise RuntimeError(f"The Krea Agent is still working after {wait_total}s; it keeps running in Krea: {started.get('url', '')}")
    found: list[tuple[str, str, str | None]] = []
    _deliverable_urls(view.get("deliverables") or [], found)
    saved = await save_media(found)
    session_value = {"sessionId": started["sessionId"], "url": view.get("url") or started.get("url"),
                     "status": view.get("status")}
    return {
        **media_outputs(saved),
        "text": {"type": "Text", "value": _agent_text(view)},
        "session": {"type": "Any", "value": session_value},
        "url": {"type": "Text", "value": _clean_str(session_value["url"])},
    }


# ---------------------------------------------------------------------------
# Desktop apps (phase 12, Krea account only)
# ---------------------------------------------------------------------------

async def handle_krea_desktop(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                              emit: Emit = None) -> dict[str, Any]:
    """List connected desktop apps and their tools, or run one tool in an app.

    Tool calls change the open project immediately. The app ID is typed and
    changes whenever the user reopens the app, so a shared recipe cannot reach
    into someone's project."""
    from services.krea_account import account_tools
    action = _clean_str(node.params.get("action")) or "list-apps"
    async with account_tools() as account:
        if action == "list-apps":
            result = await account.call("list_desktop_apps")
            apps = result.get("apps") if isinstance(result, dict) else result
            return {"result": {"type": "Any", "value": result}, "image": {"type": "Image", "value": None},
                    "text": {"type": "Text", "value": json.dumps(apps, indent=1)[:4000]}}
        app_id = _clean_str(node.params.get("app_id"))
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", app_id):
            raise ValueError("Enter the app ID from Krea Desktop Apps (list apps first)")
        tools_answer = await account.call("get_desktop_tools", {"appId": app_id})
        if action == "list-tools":
            return {"result": {"type": "Any", "value": tools_answer}, "image": {"type": "Image", "value": None},
                    "text": {"type": "Text", "value": "\n".join(
                        f"{tool.get('name')}: {tool.get('description', '')}" for tool in
                        (tools_answer.get("tools") if isinstance(tools_answer, dict) else tools_answer) or []
                        if isinstance(tool, dict))}}
        if action != "call-tool":
            raise ValueError(f"Unknown desktop action: {action}")
        tool_name = _clean_str(node.params.get("tool"))
        tools = (tools_answer.get("tools") if isinstance(tools_answer, dict) else tools_answer) or []
        spec = next((tool for tool in tools if isinstance(tool, dict) and tool.get("name") == tool_name), None)
        if spec is None:
            raise ValueError(f"The connected app has no tool named {tool_name or '(none)'}")
        tool_input = _json_object(node.params.get("input"), "Tool input")
        job = inputs["job"].value if inputs.get("job") else None
        schema = spec.get("inputSchema") or spec.get("input_schema") or {"type": "object"}
        if isinstance(job, dict) and "jobId" in schema.get("properties", {}) and "jobId" not in tool_input:
            tool_input["jobId"] = job.get("job_id") or job.get("id")
            tool_input.setdefault("outputIndex", _int_value(node.params.get("output_index"), 0, 0))
        errors = list(Draft202012Validator(schema).iter_errors(tool_input))
        if errors:
            raise ValueError(f"{tool_name} input: {errors[0].message}; nothing was sent")
        raw = await account.tools.session.call_tool("call_desktop_tool", account.check(
            "call_desktop_tool", {"appId": app_id, "tool": tool_name, "input": tool_input}))
    if raw.isError:
        raise RuntimeError(f"{tool_name} failed in the desktop app; inspect the project before retrying")
    frame = None
    for block in raw.content:
        suffix = _FRAME_EXTENSIONS.get(str(getattr(block, "mimeType", "")).split(";", 1)[0].strip().lower())
        if getattr(block, "type", None) == "image" and frame is None and suffix:
            path = get_run_dir() / f"krea-desktop-{uuid4().hex[:8]}{suffix}"
            path.write_bytes(base64.b64decode(block.data))
            frame = str(path)
    texts = [block.text for block in raw.content if getattr(block, "type", None) == "text"]
    return {"result": {"type": "Any", "value": raw.structuredContent if raw.structuredContent is not None else texts},
            "image": {"type": "Image", "value": frame},
            "text": {"type": "Text", "value": "\n".join(texts)[:8000]}}


# ---------------------------------------------------------------------------
# Workspace usage (phase 11, enterprise workspace service key)
# ---------------------------------------------------------------------------

async def handle_krea_usage(node: GraphNode, inputs: dict[str, PortValueDict], api_keys: dict[str, str],
                            emit: Emit = None) -> dict[str, Any]:
    """Completed metered jobs and their compute units for a date window."""
    api_key = _clean_str(api_keys.get("KREA_USAGE_KEY"))
    if not api_key:
        raise ValueError("Krea usage needs a workspace service key (KREA_USAGE_KEY); personal API tokens are refused by Krea")
    params = {key: _clean_str(node.params.get(key)) for key in ("start_date", "end_date") if _clean_str(node.params.get(key))}
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client:
        response = await client.get(f"{KREA_BASE_URL}/usage", headers=_auth_headers(api_key), params=params)
        _raise_for_krea_response(response, "usage")
        payload = response.json()
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    if not isinstance(jobs, list):
        raise RuntimeError("Krea usage returned no job list")
    total = round(sum(float(job.get("compute_units") or 0) for job in jobs if isinstance(job, dict)), 2)
    by_type: dict[str, float] = {}
    for job in jobs:
        if isinstance(job, dict):
            by_type[str(job.get("type"))] = by_type.get(str(job.get("type")), 0) + float(job.get("compute_units") or 0)
    lines = [f"{payload.get('start_date')} → {payload.get('end_date')}: {total} compute units over {len(jobs)} jobs"]
    lines += [f"  {kind}: {round(units, 2)}" for kind, units in sorted(by_type.items(), key=lambda item: -item[1])]
    return {
        "jobs": {"type": "Array", "value": jobs},
        "total": {"type": "Text", "value": str(total)},
        "text": {"type": "Text", "value": "\n".join(lines)},
    }
