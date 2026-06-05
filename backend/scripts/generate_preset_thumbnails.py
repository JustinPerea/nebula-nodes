#!/usr/bin/env python3
"""Generate shipped preset thumbnails by dogfooding the app's own pipeline.

For each style in ``backend/data/presets/seed.json`` this fires a one-shot
generation through the running backend (``POST /api/quick`` with
``nano-banana``), downloads the result, downsizes it, and writes a compact
WebP to ``backend/data/presets/thumbnails/<slug>.webp``.

The ``<slug>`` is computed by ``services.preset_store.slug_for_preset`` — the
SAME helper the seeder uses to build the ``Preset.thumbnail`` URL, so the
shipped filename and the served URL can never drift.

Usage (backend must be running on :8000 with a Google API key configured):

    cd backend && .venv/bin/python scripts/generate_preset_thumbnails.py

Re-run any time to refresh the thumbnails. Idempotent: overwrites in place.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path

# Make ``services`` importable when run from anywhere.
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from services.preset_store import slug_for_preset  # noqa: E402

from PIL import Image  # noqa: E402

API = "http://localhost:8000"
MODEL = "nano-banana"
SEED_JSON = BACKEND_DIR / "data" / "presets" / "seed.json"
OUT_DIR = BACKEND_DIR / "data" / "presets" / "thumbnails"
LONGEST_EDGE = 640  # px; cards are small, this is crisp on retina
WEBP_QUALITY = 82
TIMEOUT = 180  # nano-banana cold calls can be slow


def _post_quick(prompt: str, params: dict) -> dict:
    body = json.dumps({"definitionId": MODEL, "inputs": {"prompt": prompt}, "params": params}).encode()
    req = urllib.request.Request(
        f"{API}/api/quick", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def _image_ref(outputs: dict) -> str | None:
    """Find the first image-typed output value."""
    for port in outputs.values():
        if not isinstance(port, dict):
            continue
        val = port.get("value")
        if not isinstance(val, str):
            continue
        if port.get("type") == "Image" or val.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            return val
    return None


def _load_bytes(ref: str) -> bytes:
    """Read the generated image. ``/api/quick`` returns an absolute filesystem
    path (e.g. ``/Users/.../output/<run>/<id>.jpeg``); read it straight from
    disk. Fall back to HTTP for ``/api/outputs/...`` or ``http(s)://`` refs."""
    p = Path(ref)
    if p.is_absolute() and p.exists():
        return p.read_bytes()
    url = ref if ref.startswith("http") else f"{API}{ref}"
    with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
        return resp.read()


def _to_webp(raw: bytes) -> bytes:
    img = Image.open(BytesIO(raw)).convert("RGB")
    img.thumbnail((LONGEST_EDGE, LONGEST_EDGE), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue()


def main() -> int:
    presets = json.loads(SEED_JSON.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ok, failed = 0, []
    for i, preset in enumerate(presets, 1):
        name = preset["name"]
        slug = slug_for_preset(name)
        prompt = preset["prompt"]
        params = preset.get("params", {})
        print(f"[{i:2}/{len(presets)}] {name:<20} → {slug}.webp ... ", end="", flush=True)
        try:
            result = _post_quick(prompt, params)
            ref = _image_ref(result.get("outputs", {}))
            if not ref:
                raise RuntimeError(f"no image output (got {list(result.get('outputs', {}).keys())})")
            webp = _to_webp(_load_bytes(ref))
            (OUT_DIR / f"{slug}.webp").write_bytes(webp)
            print(f"ok ({len(webp) // 1024} KB, {result.get('duration', '?')}s)")
            ok += 1
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, OSError) as exc:
            print(f"FAILED: {exc}")
            failed.append(name)

    print(f"\n{ok}/{len(presets)} thumbnails written to {OUT_DIR}")
    if failed:
        print(f"failed: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
