"""Fake Hugging Face hosts for the Idol node (handlers/speridlabs_idol.py).

Nothing here reaches the network: every httpx client answers from a
FakeHosts table. The Space's /run signature comes from the pinned
``fixtures/provider_schemas/speridlabs_idol_gradio_info.json``, an exact copy
of GET https://speridlabs-idol.hf.space/gradio_api/info read 2026-10-29
(a GET that runs nothing on the Space).
"""
from __future__ import annotations

import base64
import ipaddress
import json
import re
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from tests.test_route_clients import FakeHosts

INFO_PATH = Path(__file__).parent / "fixtures" / "provider_schemas" / "speridlabs_idol_gradio_info.json"
INFO = json.loads(INFO_PATH.read_text())
SPACE = "https://speridlabs-idol.hf.space"
API = SPACE + "/gradio_api"
HUB = "https://huggingface.co/api/spaces/speridlabs/idol"
RESULT_PATH = "/tmp/gradio/abc123/idol-seed42-262144-deadbeef.ply"
RESULT_URL = f"{API}/file={RESULT_PATH}"
# The wired image: a public https URL Nebula fetches itself (load_media) and
# uploads to the Space under a neutral name.
IMAGE = "https://example.com/chair.png"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")
UPLOADED = "/tmp/gradio/up/input.png"

PROPERTIES = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
              "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def splat_ply(count: int = 64, *, seed: int = 0, properties: list[str] | None = None,
              fmt: str = "binary_little_endian", extra: bytes = b"") -> bytes:
    """A 3DGS PLY like Idol's save_ply writes (SH0, 17 float32 properties),
    Gaussians inside [-0.5, 0.5]^3 with -y up."""
    names = properties or PROPERTIES
    rng = np.random.default_rng(seed)
    values = np.zeros((count, len(names)), dtype="<f4")
    for column, name in enumerate(names):
        if name in ("x", "y", "z"):
            values[:, column] = rng.uniform(-0.5, 0.5, count)
        elif name.startswith("f_dc"):
            values[:, column] = rng.normal(0, 1, count)
        elif name == "opacity":
            values[:, column] = rng.normal(2, 1, count)
        elif name.startswith("scale"):
            values[:, column] = np.log(rng.uniform(0.002, 0.02, count))
        elif name == "rot_0":
            values[:, column] = 1.0
    header = (f"ply\nformat {fmt} 1.0\nelement vertex {count}\n"
              + "".join(f"property float {name}\n" for name in names) + "end_header\n").encode("ascii")
    return header + values.tobytes() + extra


def sse(*events: tuple[str, Any]) -> bytes:
    """A Gradio /call stream: each (event, data) as server-sent events."""
    return "".join(
        f"event: {event}\ndata: {data if isinstance(data, str) else json.dumps(data)}\n\n"
        for event, data in events).encode()


def complete(seed: int = 42, url: str | None = RESULT_URL) -> tuple[str, Any]:
    file_data = {"path": RESULT_PATH, "url": url, "size": None, "orig_name": "idol.ply", "mime_type": None,
                 "is_stream": False, "meta": {"_type": "gradio.FileData"}}
    return ("complete", [file_data, seed, "<div class=\"sl-meta\"></div>"])


def public_dns(monkeypatch) -> None:
    """example.com resolves to a public address (services/public_url), with no DNS lookup."""
    from services import public_url

    async def resolve(_host, _port):
        return {ipaddress.ip_address("93.184.216.34")}

    monkeypatch.setattr(public_url, "resolve_host", resolve)


def image_route(content: bytes = PNG, url: str = IMAGE) -> tuple[str, str, Any]:
    """The wired image's own host. `url` is a pattern: idol_hosts serves any
    example.com image (the shared route tests wire https://example.com/ref.png)."""
    pattern = url if url != IMAGE else re.escape(IMAGE)
    return ("GET", pattern, httpx.Response(200, content=content, headers={"content-type": "image/png"}))


def space_routes(*, info: Any = None, upload: Any = None) -> list[tuple[str, str, Any]]:
    """The wired image, a running Space, its pinned /info and its upload."""
    return [
        image_route(),
        ("GET", re.escape(HUB), httpx.Response(200, json={"runtime": {"stage": "RUNNING"}})),
        ("GET", re.escape(f"{API}/info"), httpx.Response(200, json=INFO if info is None else info)),
        ("POST", re.escape(f"{API}/upload"), upload or httpx.Response(200, json=[UPLOADED])),
    ]


def idol_hosts(monkeypatch, *, stage: Any = "RUNNING", info: Any = None, stream: bytes | None = None,
               ply: bytes | None = None, upload: Any = None, call: Any = None) -> FakeHosts:
    """The wired image's host, the Hub's Space API, the Space's Gradio API and its file route."""
    public_dns(monkeypatch)
    stage_answer = stage if isinstance(stage, (httpx.Response, list)) or callable(stage) else httpx.Response(
        200, json={"id": "speridlabs/idol", "runtime": {"stage": stage}})
    return FakeHosts(monkeypatch, [
        image_route(url=r"https://example\.com/[^?#]+\.(?:png|jpe?g|webp)(?:\?.*)?"),
        ("GET", re.escape(HUB), stage_answer),
        ("GET", re.escape(f"{API}/info"), httpx.Response(200, json=INFO if info is None else info)),
        ("POST", re.escape(f"{API}/upload"), upload or httpx.Response(200, json=[UPLOADED])),
        ("POST", re.escape(f"{API}/call/run"), call or httpx.Response(200, json={"event_id": "ev1"})),
        ("GET", re.escape(f"{API}/call/run/ev1"), httpx.Response(
            200, content=stream if stream is not None else sse(("heartbeat", "null"), complete()),
            headers={"content-type": "text/event-stream"})),
        ("GET", re.escape(f"{API}/file=") + ".*", httpx.Response(200, content=ply if ply is not None else splat_ply())),
    ])


def _number_range(description: str) -> dict[str, float]:
    match = re.search(r"between ([0-9.]+) and ([0-9.]+)", description or "")
    return {"minimum": float(match.group(1)), "maximum": float(match.group(2))} if match else {}


def run_schema(info: Any = None) -> dict[str, Any]:
    """The /call/run request body as a JSON schema, from /gradio_api/info:
    ``{"data": [...]}`` with one item per /run parameter, in order, each
    against that parameter's own type (and a slider's stated range)."""
    run = (info or INFO)["named_endpoints"]["/run"]
    items = []
    for parameter in run["parameters"]:
        schema = dict(parameter["type"])
        if schema.get("type") == "number":
            schema = {"type": "number", **_number_range(schema.get("description", ""))}
        items.append(schema)
    return {"type": "object", "required": ["data"], "properties": {"data": {
        "type": "array", "prefixItems": items, "items": False, "minItems": len(items)}}}
