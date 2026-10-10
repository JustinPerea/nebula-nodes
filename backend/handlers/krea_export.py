"""Krea 3D export: convert a completed Krea 3D job to OBJ, FBX, STL or PLY.

Krea offers this only on its API (`POST /export/3d`, API token). The result is
a ZIP, which is downloaded without credentials and unpacked defensively into
the run directory: no absolute or parent paths, no links, and bounded size.
"""
from __future__ import annotations

import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx

from handlers.krea import KREA_BASE_URL, _api_key, _clean_str, _json_headers, _raise_for_krea_response
from handlers.krea_gateway import _JOB_ID, _http_url
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import _MEDIA_EXTENSIONS, get_run_dir, portable_output_ref

EXPORT_FORMATS = {"obj", "fbx", "stl", "ply"}
MAX_ARCHIVE_BYTES = 500_000_000
MAX_EXTRACTED_BYTES = 1_500_000_000
MAX_MEMBERS = 500


def _job_id(node: GraphNode, inputs: dict[str, PortValueDict]) -> str:
    wired = inputs["job"].value if inputs.get("job") else None
    if isinstance(wired, dict):
        wired = wired.get("job_id") or wired.get("id")
    job_id = _clean_str(wired or node.params.get("job_id"))
    if not _JOB_ID.fullmatch(job_id):
        raise ValueError("Wire a Krea 3D job or enter its job ID")
    return job_id


async def _download(url: str, target: Path) -> None:
    parsed = _http_url(url)
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise RuntimeError("Krea returned an unexpected export URL")
    size = 0
    # No Krea credentials: the export URL is a signed download link.
    async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with target.open("wb") as handle:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_ARCHIVE_BYTES:
                        raise RuntimeError("Krea 3D export is larger than 500 MB")
                    handle.write(chunk)


def _extract(archive: Path, destination: Path) -> list[Path]:
    try:
        bundle = zipfile.ZipFile(archive)
    except zipfile.BadZipFile as exc:
        raise RuntimeError("Krea 3D export is not a ZIP archive") from exc
    with bundle:
        members = [info for info in bundle.infolist() if not info.is_dir()]
        if not members or len(members) > MAX_MEMBERS:
            raise RuntimeError("Krea 3D export has no files or too many files")
        if sum(info.file_size for info in members) > MAX_EXTRACTED_BYTES:
            raise RuntimeError("Krea 3D export unpacks to more than 1.5 GB")
        paths = []
        for info in members:
            name = PurePosixPath(info.filename)
            if ("\\" in info.filename or name.is_absolute() or any(part in {"", ".", ".."} for part in name.parts)
                    or stat.S_ISLNK(info.external_attr >> 16)):
                raise RuntimeError("Krea 3D export contains an unsafe path")
            target = destination.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, target.open("wb") as handle:
                written = 0
                while chunk := source.read(1 << 20):
                    written += len(chunk)
                    if written > info.file_size:
                        raise RuntimeError("Krea 3D export file is larger than its archive entry says")
                    handle.write(chunk)
            paths.append(target)
    return paths


async def handle_krea_3d_export(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    job_id = _job_id(node, inputs)
    file_format = _clean_str(node.params.get("file_format")) or "obj"
    if file_format not in EXPORT_FORMATS:
        raise ValueError(f"Krea exports OBJ, FBX, STL or PLY, not {file_format}")
    body: dict[str, Any] = {"job_id": job_id, "file_format": file_format}
    node_app_key = _clean_str(node.params.get("node_app_key"))
    if node_app_key:
        body["node_app_key"] = node_app_key
    api_key = _api_key(api_keys)
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
        response = await client.post(f"{KREA_BASE_URL}/export/3d", headers=_json_headers(api_key), json=body)
        _raise_for_krea_response(response, "3D export")
        url = response.json().get("url") if isinstance(response.json(), dict) else None
    if not isinstance(url, str):
        raise RuntimeError("Krea 3D export returned no download URL")

    folder = get_run_dir() / f"krea-3d-export-{uuid4().hex[:12]}"
    folder.mkdir(parents=True)
    archive = folder / f"{job_id}-{file_format}.zip"
    await _download(url, archive)
    files = _extract(archive, folder / "model")
    model = next((path for path in files if path.suffix.lstrip(".").lower() == file_format), None)
    if model is None:
        raise RuntimeError(f"Krea 3D export has no .{file_format} file")
    # Nebula's 3D viewer reads OBJ/FBX/STL; PLY is saved but not previewed.
    mesh = str(model) if file_format in _MEDIA_EXTENSIONS["Mesh"] else None
    return {
        "mesh": {"type": "Mesh", "value": mesh},
        "file": {"type": "Text", "value": str(model)},
        "files": {"type": "Array", "value": [portable_output_ref(str(path), require_file=True) for path in files]},
        "archive": {"type": "Text", "value": str(archive)},
    }
