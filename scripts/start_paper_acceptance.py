"""Local acceptance runtime: real Paper, deterministic downstream video fixture.

Never configures provider credentials. Generated videos composite the original
PNG over white; this proves recipe/input reuse, not any generative provider.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

REPO = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8019)
parser.add_argument("--root", type=Path, default=REPO / "output/paper-acceptance")
args = parser.parse_args()
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=True)
os.environ.update(NEBULA_OUTPUT_ROOT=str(root), NEBULA_STATE_DIR=str(root / "state"),
                  NEBULA_SETTINGS_PATH=str(root / "settings.json"), NEBULA_COMMONS_ROOT=str(root / "commons"),
                  NEBULA_COMMONS_NO_STARTUP_SCAN="1", NEBULA_CHARACTER_ROOT=str(root / "characters"), NEBULA_PRESET_ROOT=str(root / "presets"))
(root / "settings.json").write_text(json.dumps({"apiKeys": {}, "executionMode": "manual"}))
sys.path.insert(0, str(REPO / "backend"))

import main
from execution import engine
from services.output import get_run_dir
from services.paper_routes import paper_sources
from PIL import Image

FIXTURE = {
    # Use the existing Image→Video canvas card, overriding ONLY this isolated
    # process's handler/catalog. The visible label makes the fixture explicit.
    "id": "runway-video", "displayName": "Paper video · deterministic fixture",
    "category": "utility", "apiProvider": "utility", "apiEndpoint": "", "envKeyName": [], "executionPattern": "sync",
    "inputPorts": [{"id": "image", "label": "Actual logo", "dataType": "Image", "required": True}],
    "outputPorts": [{"id": "video", "label": "Fixture video", "dataType": "Video", "required": False}],
    "params": main.node_registry._nodes["runway-video"]["params"] + [{"key": "delaySeconds", "label": "Fixture delay", "type": "integer", "default": 0, "required": False}],
}
main.node_registry._nodes[FIXTURE["id"]] = FIXTURE
engine._registry_node_defs()[FIXTURE["id"]] = FIXTURE
engine.LOCAL_EXECUTION_NODE_IDS = engine.LOCAL_EXECUTION_NODE_IDS | {FIXTURE["id"]}


async def render(node, inputs, api_keys):
    input_path = Path(str(inputs["image"].value))
    raw = input_path.read_bytes()  # pin the immutable input before the delay
    await asyncio.sleep(min(30, max(0, int(node.params.get("delaySeconds", 0)))))
    run_dir = get_run_dir()
    from io import BytesIO
    logo = Image.open(BytesIO(raw)).convert("RGBA")
    canvas = Image.new("RGB", logo.size, "white")
    canvas.paste(logo, mask=logo.getchannel("A"))
    poster = run_dir / f"paper-fixture-{uuid4().hex}.png"
    canvas.save(poster)
    output = poster.with_suffix(".mp4")
    process = await asyncio.create_subprocess_exec("ffmpeg", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", str(poster), "-t", "2", "-r", "30", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, stderr = await process.communicate()
    if process.returncode:
        raise ValueError("Deterministic fixture encoding failed")
    return {"video": {"type": "Video", "value": str(output)}}


original_registry = main.get_handler_registry
def registry(*a, **kw):
    handlers = original_registry(*a, **kw)
    handlers[FIXTURE["id"]] = render
    return handlers
main.get_handler_registry = registry

if not main.cli_graph.nodes:
    source = main.cli_graph.add_node("paper-source", {}, position={"x": 100, "y": 100})
    target = main.cli_graph.add_node(FIXTURE["id"], {"delaySeconds": 0}, position={"x": 530, "y": 100})
    main.cli_graph.connect(source, "image", target, "image")
for node in main.cli_graph.nodes.values():
    if node["definitionId"] == "paper-acceptance-render":
        node["definitionId"] = FIXTURE["id"]
main.cli_graph._maybe_persist()

print(f"Real Paper / deterministic video fixture: http://127.0.0.1:{args.port}; state: {root}", flush=True)
import uvicorn
uvicorn.run(main.app, host="127.0.0.1", port=args.port)
