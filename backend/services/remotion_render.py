"""Server-side Remotion renderer backed by the repository's React composition."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from services.output import get_run_dir


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_RENDER_SCRIPT = _REPO_ROOT / "frontend" / "scripts" / "render-remotion.mjs"
_spawn_subprocess = getattr(asyncio, "create_subprocess_exec")


async def render_remotion_manifest(
    manifest: dict[str, Any],
    *,
    output_dir: Path | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> Path:
    """Render one manifest to a real H.264 MP4 with progress and cancellation.

    The Node worker passes one immutable ``{manifest}`` inputProps object to
    both ``selectComposition()`` and ``renderMedia()``. Cancelling this coroutine
    terminates the worker, whose Remotion cancel signal stops browser/ffmpeg work.
    """
    if not _RENDER_SCRIPT.is_file():
        raise RuntimeError(f"Remotion render worker not found: {_RENDER_SCRIPT}")

    destination_dir = output_dir or get_run_dir()
    destination_dir.mkdir(parents=True, exist_ok=True)
    token = uuid4().hex[:12]
    request_path = destination_dir / f".{token}-remotion-request.json"
    output_path = destination_dir / f"{token}.mp4"
    request_path.write_text(json.dumps({"manifest": manifest}), encoding="utf-8")

    proc = await _spawn_subprocess(
        "node",
        str(_RENDER_SCRIPT),
        str(request_path),
        str(output_path),
        cwd=str(_REPO_ROOT / "frontend"),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stderr_chunks: list[bytes] = []
    worker_error: str | None = None

    async def _read_stderr() -> None:
        assert proc.stderr is not None
        async for chunk in proc.stderr:
            stderr_chunks.append(chunk)

    stderr_task = asyncio.create_task(_read_stderr())
    try:
        assert proc.stdout is not None
        async for raw_line in proc.stdout:
            try:
                event = json.loads(raw_line.decode(errors="replace"))
            except json.JSONDecodeError:
                continue
            if event.get("type") == "progress" and on_progress is not None:
                try:
                    on_progress(max(0.0, min(float(event.get("value", 0.0)), 1.0)))
                except (TypeError, ValueError):
                    pass
            elif event.get("type") == "error":
                worker_error = str(event.get("error") or "Remotion render failed")

        return_code = await proc.wait()
        await stderr_task
        if return_code != 0:
            tail = b"".join(stderr_chunks)[-2048:].decode(errors="replace").strip()
            detail = worker_error or tail or f"worker exited {return_code}"
            raise RuntimeError(f"Remotion render failed: {detail}")
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError("Remotion render completed without an output file")
        if on_progress is not None:
            on_progress(1.0)
        return output_path
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        await stderr_task
        output_path.unlink(missing_ok=True)
        raise
    except BaseException:
        output_path.unlink(missing_ok=True)
        raise
    finally:
        request_path.unlink(missing_ok=True)
