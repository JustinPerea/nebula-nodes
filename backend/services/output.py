from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from services.ffmpeg import ffprobe_video
from services.settings import load_settings

logger = logging.getLogger(__name__)

# Ensure video/3D mime types are registered (mimetypes may lack these on some
# platforms; FileResponse and inline <video> need the right content-type).
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("model/gltf-binary", ".glb")

# Project-local output dir by default; override via NEBULA_OUTPUT_ROOT so the
# test suite can sandbox to a tmp dir (pytest conftest sets this) and ops can
# point a prod deploy at persistent storage without editing source.
DEFAULT_OUTPUT_ROOT = Path(__file__).resolve().parent.parent.parent / "output"


def _resolve_output_root() -> Path:
    """Resolve the output root with precedence: env override > persisted setting > default.

    Computed once at import time; applies after backend restart.

    Guarantees:
    - Relative paths are anchored to the repo root (sibling of DEFAULT_OUTPUT_ROOT),
      not the process CWD, so the resolved path is deterministic regardless of where
      uvicorn was started from.
    - The chosen directory is always created before returning, so callers never
      encounter a missing directory.
    - If the candidate directory cannot be created (unwritable path, non-directory
      component, etc.) we fall back to DEFAULT_OUTPUT_ROOT so startup never bricks.
    """
    env = os.environ.get("NEBULA_OUTPUT_ROOT")
    if env:
        candidate: Path | None = Path(env).expanduser()
    else:
        candidate = None
        try:
            sp = load_settings().get("outputPath")
            if sp:
                candidate = Path(str(sp)).expanduser()
        except Exception:
            candidate = None
        if candidate is None:
            candidate = DEFAULT_OUTPUT_ROOT

    # Fix 3: anchor relative paths to the repo root for deterministic resolution.
    if not candidate.is_absolute():
        candidate = DEFAULT_OUTPUT_ROOT.parent / candidate

    # Fix 1: guarantee the directory exists; fall back if it can't be created.
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except OSError as exc:
        print(
            f"[output] cannot use output root {candidate}: {exc}"
            f" — falling back to {DEFAULT_OUTPUT_ROOT}",
            flush=True,
        )
        DEFAULT_OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
        return DEFAULT_OUTPUT_ROOT


OUTPUT_ROOT = _resolve_output_root()


def get_run_dir() -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    run_dir = OUTPUT_ROOT / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


# ---------------------------------------------------------------------------
# F-31: media byte validation
# ---------------------------------------------------------------------------
#
# Every file-writing helper below validates the bytes it just wrote before
# returning, so a served ".png" is never actually a JPEG (or worse). Images
# and GLB meshes are identified by magic bytes; video containers are confirmed
# with ffprobe. Mismatches are corrected by renaming within the same
# directory; unknown content is left untouched (never misclassified); invalid
# video is rejected by raising.

_HEADER_READ_BYTES = 12  # enough for RIFF....WEBP and every other signature

# Extensions treated as interchangeable with each detected content type.
_EXTENSION_EQUIVALENTS: dict[str, set[str]] = {
    "jpg": {"jpg", "jpeg"},
    "png": {"png"},
    "webp": {"webp"},
    "gif": {"gif"},
    "glb": {"glb"},
}

# Extensions whose content is verified with ffprobe_video() instead of magic
# bytes (video containers carry their signature at a variable offset).
_VIDEO_EXTENSIONS = {"mp4", "webm", "mov", "m4v", "mkv", "avi"}


def _detect_media_extension(header: bytes) -> str | None:
    """Map magic bytes to a canonical extension, or None if unrecognized.

    Covers JPEG (FF D8), PNG (89 50 4E 47), WebP (RIFF....WEBP),
    GIF (47 49 46 38), and GLB meshes (67 6C 54 46 / "glTF").
    """
    if header[:2] == b"\xff\xd8":
        return "jpg"
    if header[:4] == b"\x89PNG":
        return "png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp"
    if header[:4] == b"GIF8":
        return "gif"
    if header[:4] == b"glTF":
        return "glb"
    return None


def _validate_magic_bytes(path: Path) -> Path:
    """Validate *path* against known magic-byte signatures; rename on mismatch.

    Synchronous core shared by every write path. Returns the final path —
    renamed (same directory, warning logged) when the extension disagrees with
    the detected content, unchanged when content matches, is unknown, or has a
    video extension (those are adjudicated by ffprobe, not magic bytes).
    Never renames unrecognized content.
    """
    try:
        with path.open("rb") as fh:
            header = fh.read(_HEADER_READ_BYTES)
    except OSError as exc:
        logger.warning("[output] could not read %s for validation: %s", path, exc)
        return path

    detected = _detect_media_extension(header)
    suffix = path.suffix.lstrip(".").lower()

    if detected is None:
        if suffix not in _VIDEO_EXTENSIONS:
            logger.warning(
                "[output] %s: bytes match no known media signature; "
                "leaving extension unchanged",
                path.name,
            )
        return path

    if suffix in _EXTENSION_EQUIVALENTS[detected]:
        return path

    # with_suffix keeps the file in the same directory; the replacement
    # extension comes from our fixed detected set, never from caller input.
    new_path = path.with_suffix(f".{detected}")
    logger.warning(
        "[output] extension mismatch: %s contains %s bytes; renamed to %s",
        path.name,
        detected,
        new_path.name,
    )
    path.rename(new_path)
    return new_path


async def _validate_and_correct_extension(path: Path) -> Path:
    """Validate a freshly written media file; correct or reject as needed.

    - Images (JPEG/PNG/WebP/GIF) and GLB meshes: magic-byte check; a
      mismatched extension is corrected by renaming within the same directory
      and a warning is logged.
    - Video extensions: ffprobe_video() must confirm a video stream exists.
      Probe failure or a missing video stream raises RuntimeError — the
      output is rejected rather than served as valid (no false success).
    - Bytes matching no known signature are left untouched (never
      misclassified, nothing fabricated).

    Returns the final path (renamed when a correction was applied).
    """
    path = _validate_magic_bytes(path)
    if path.suffix.lstrip(".").lower() in _VIDEO_EXTENSIONS:
        try:
            await ffprobe_video(path)
        except Exception as exc:
            raise RuntimeError(
                f"output video failed validation ({path.name}): {exc}"
            ) from exc
    return path


def save_base64_image(b64_data: str, run_dir: Path, extension: str = "png") -> Path:
    image_bytes = base64.b64decode(b64_data)
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    file_path.write_bytes(image_bytes)
    # Sync write path: magic-byte validation only (ffprobe is async and image
    # bytes never need it).
    return _validate_magic_bytes(file_path)


def save_base64_image_named(
    b64_data: str, run_dir: Path, name: str, extension: str = "png"
) -> Path:
    image_bytes = base64.b64decode(b64_data)
    file_path = run_dir / f"{name}.{extension}"
    file_path.write_bytes(image_bytes)
    return _validate_magic_bytes(file_path)


async def save_video_from_url(url: str, run_dir: Path, extension: str = "mp4") -> Path:
    import httpx
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        file_path.write_bytes(response.content)
    return await _validate_and_correct_extension(file_path)


async def save_mesh_from_url(url: str, run_dir: Path, extension: str = "glb") -> Path:
    import httpx
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        file_path.write_bytes(response.content)
    return await _validate_and_correct_extension(file_path)


def resolve_output_ref(value: str) -> str:
    """Map a served '/api/outputs/<rel>' URL back to its absolute on-disk path.

    Local paths, http(s) URLs, and data: URIs pass through unchanged. Refuses
    (returns unchanged) any path that escapes OUTPUT_ROOT.
    """
    if not isinstance(value, str) or not value.startswith("/api/outputs/"):
        return value
    rel = value[len("/api/outputs/"):]
    candidate = (OUTPUT_ROOT / rel).resolve()
    try:
        candidate.relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        return value  # traversal attempt — refuse
    return str(candidate)


def image_to_data_uri(file_path: Path) -> str:
    image_bytes = file_path.read_bytes()
    b64 = base64.b64encode(image_bytes).decode("ascii")
    suffix = file_path.suffix.lstrip(".").lower()
    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
    mime = mime_map.get(suffix, "image/png")
    return f"data:{mime};base64,{b64}"


# ---------------------------------------------------------------------------
# F-21: per-execution metadata manifest
# ---------------------------------------------------------------------------
#
# Every completed graph run writes one manifest.json into its run directory:
# run-level metadata (run_id, started_at, completed_at) plus one record per
# generated file (node_id, node_type, model, endpoint, prompt, params,
# output_path, timestamp). output_path values are ALWAYS relative to the
# manifest's directory — manifests (and the /meta endpoint built on them)
# never expose absolute host paths.

MANIFEST_FILENAME = "manifest.json"


class ManifestError(Exception):
    """A manifest.json exists but is malformed (bad JSON or wrong shape)."""


def _iso8601(value: datetime | str) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _relative_output_path(value: Any, output_dir: Path) -> str:
    """Coerce a stored output_path to a relative POSIX path.

    Absolute paths inside *output_dir* are relativized; absolute paths outside
    it collapse to the bare file name. Whatever the caller hands us, the
    manifest never embeds an absolute host path.
    """
    raw = str(value)
    candidate = Path(raw)
    if candidate.is_absolute():
        try:
            return candidate.resolve().relative_to(output_dir.resolve()).as_posix()
        except (ValueError, OSError):
            return candidate.name
    return raw.replace(os.sep, "/")


def write_manifest(
    run_id: str,
    started_at: datetime | str,
    completed_at: datetime | str,
    outputs: list[dict[str, Any]],
    output_dir: Path,
) -> Path:
    """Write manifest.json for one execution run into *output_dir*.

    *started_at*/*completed_at* accept datetimes or ISO-8601 strings. Each
    record in *outputs* should carry node_id, node_type, model, endpoint,
    prompt, params, output_path, and timestamp; output_path is normalized to
    a relative path as a safety net. Returns the manifest path. Raises on
    write failure — callers (the engine) catch so a failed manifest never
    affects generated outputs.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict[str, Any]] = []
    for record in outputs:
        if not isinstance(record, dict):
            continue
        rec = dict(record)
        rec["output_path"] = _relative_output_path(rec.get("output_path", ""), output_dir)
        records.append(rec)

    manifest = {
        "run_id": str(run_id),
        "started_at": _iso8601(started_at),
        "completed_at": _iso8601(completed_at),
        "outputs": records,
    }
    manifest_path = output_dir / MANIFEST_FILENAME
    # ensure_ascii=False keeps prompts/params readable UTF-8; default=str
    # keeps exotic param values (datetime, Path, bytes) from breaking the write.
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def read_manifest(run_dir: Path) -> dict[str, Any]:
    """Load manifest.json from *run_dir*.

    Raises FileNotFoundError when no manifest exists, ManifestError when it
    exists but is malformed (unparseable JSON or wrong top-level shape).
    """
    manifest_path = Path(run_dir) / MANIFEST_FILENAME
    if not manifest_path.is_file():
        raise FileNotFoundError(f"no manifest in {run_dir}")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"malformed manifest: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("outputs"), list):
        raise ManifestError("malformed manifest: missing run fields or outputs list")
    return data


def find_output_record(
    manifest: dict[str, Any], file_path: Path, run_dir: Path
) -> dict[str, Any] | None:
    """Return the manifest record for *file_path*, or None when unlisted.

    Matches on output_path relative to *run_dir* (the manifest's directory),
    so a record can never claim a file outside its own run.
    """
    try:
        rel = Path(file_path).resolve().relative_to(Path(run_dir).resolve()).as_posix()
    except (ValueError, OSError):
        return None
    for record in manifest.get("outputs", []):
        if isinstance(record, dict) and record.get("output_path") == rel:
            return record
    return None
