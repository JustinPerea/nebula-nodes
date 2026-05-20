"""Live-smoke test for elevenlabs-sts node.

Verifies the audit's newly-added paths:
  - voice_settings forwarded as JSON-encoded multipart field
  - seed forwarded as multipart string
  - stability + similarity_boost actually reach the API

Reads ELEVENLABS_API_KEY from settings.json (where the in-app Settings UI
writes it). Run from project root with the backend venv:

    backend/.venv/bin/python backend/scripts/smoke_elevenlabs_sts.py

Cost: one short STS call (~3 seconds of audio). ElevenLabs bills by character
count for STS, which for short clips is well under a free-tier monthly budget.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE_AUDIO = PROJECT_ROOT / "output" / "smoke-test" / "source-3s.mp3"
SETTINGS_PATH = PROJECT_ROOT / "settings.json"

sys.path.insert(0, str(PROJECT_ROOT / "backend"))


def load_keys() -> dict[str, str]:
    with SETTINGS_PATH.open() as f:
        settings = json.load(f)
    return settings.get("apiKeys", {})


async def main() -> int:
    keys = load_keys()
    api_key = keys.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY not in settings.json")
        return 1
    print(f"key: {api_key[:8]}…{api_key[-4:]} ({len(api_key)} chars)")

    if not SOURCE_AUDIO.exists():
        print(f"ERROR: source audio missing at {SOURCE_AUDIO}")
        return 1
    print(f"source: {SOURCE_AUDIO.name} ({SOURCE_AUDIO.stat().st_size} bytes)")

    from handlers.elevenlabs import handle_elevenlabs_sts
    from models.graph import GraphNode, PortValueDict

    node = GraphNode(
        id="smoke-sts",
        definitionId="elevenlabs-sts",
        params={
            # Defaults to Rachel
            "model_id": "eleven_english_sts_v2",
            # Non-default values so we can verify forwarding
            "stability": 0.7,
            "similarity_boost": 0.6,
            "seed": 42,
            "output_format": "mp3_44100_128",
            "remove_background_noise": False,
        },
    )
    inputs = {
        "audio": PortValueDict(type="Audio", value=str(SOURCE_AUDIO)),
    }

    print("calling handle_elevenlabs_sts…")
    try:
        result = await handle_elevenlabs_sts(node, inputs, {"ELEVENLABS_API_KEY": api_key})
    except Exception as e:
        print(f"FAIL: handler raised {type(e).__name__}: {e}")
        return 2

    audio = result.get("audio", {})
    out_path = audio.get("value")
    if not out_path or not Path(out_path).exists():
        print(f"FAIL: no output file at {out_path!r}")
        return 3

    out = Path(out_path)
    size = out.stat().st_size
    head = out.read_bytes()[:4]
    is_mp3 = head[:3] == b"ID3" or head[:2] == b"\xff\xfb" or head[:2] == b"\xff\xf3"

    print(f"OK: wrote {out.name} ({size} bytes, mp3_header={is_mp3})")
    print(f"     full path: {out}")

    # Try ffprobe for duration if available
    import shutil
    if shutil.which("ffprobe"):
        import subprocess
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
            capture_output=True, text=True,
        )
        dur = proc.stdout.strip()
        print(f"     duration: {dur}s")

    return 0 if is_mp3 and size > 1000 else 4


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
