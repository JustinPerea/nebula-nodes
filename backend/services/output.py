from __future__ import annotations

import base64
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# Project-local output dir by default; override via NEBULA_OUTPUT_ROOT so the
# test suite can sandbox to a tmp dir (pytest conftest sets this) and ops can
# point a prod deploy at persistent storage without editing source.
_DEFAULT_OUTPUT_ROOT = Path(__file__).resolve().parent.parent.parent / "output"
OUTPUT_ROOT = (
    Path(os.environ["NEBULA_OUTPUT_ROOT"])
    if os.environ.get("NEBULA_OUTPUT_ROOT")
    else _DEFAULT_OUTPUT_ROOT
)


def get_run_dir() -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    run_dir = OUTPUT_ROOT / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def save_base64_image(b64_data: str, run_dir: Path, extension: str = "png") -> Path:
    image_bytes = base64.b64decode(b64_data)
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    file_path.write_bytes(image_bytes)
    return file_path


def save_base64_image_named(
    b64_data: str, run_dir: Path, name: str, extension: str = "png"
) -> Path:
    image_bytes = base64.b64decode(b64_data)
    file_path = run_dir / f"{name}.{extension}"
    file_path.write_bytes(image_bytes)
    return file_path


async def save_video_from_url(url: str, run_dir: Path, extension: str = "mp4") -> Path:
    import httpx
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        file_path.write_bytes(response.content)
    return file_path


async def save_mesh_from_url(url: str, run_dir: Path, extension: str = "glb") -> Path:
    import httpx
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        file_path.write_bytes(response.content)
    return file_path


def image_to_data_uri(file_path: Path) -> str:
    image_bytes = file_path.read_bytes()
    b64 = base64.b64encode(image_bytes).decode("ascii")
    suffix = file_path.suffix.lstrip(".").lower()
    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
    mime = mime_map.get(suffix, "image/png")
    return f"data:{mime};base64,{b64}"
