"""A board's cover never reaches a generator: the requests are byte-identical.

The cover is presentation only (services/moodboard_store.py, contract 07
section 1.1). This runs a saved, analysed board through the engine into
Krea 2, GPT Image 2, Nano Banana and FLUX.2 [pro], with their real handlers
and every provider mocked at the transport (an unexpected request fails the
test; nothing is billed), before and after a cover is set: on a later image,
and on a set-aside one. Every request each node sends must be the same
bytes. Krea 2's uploads are multipart, whose boundary is random per request
even between two identical runs, so the boundary is replaced by a fixed
token before comparing (a control run without a cover shows that is the
only thing that varies).
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from execution.engine import execute_graph
from execution.sync_runner import get_handler_registry
from models.graph import GraphEdge, GraphNode
from services.output import OUTPUT_ROOT

GENERATORS = {"krea": "krea-2-generate", "gpt": "gpt-image-2-generate", "banana": "nano-banana",
              "flux": "flux-2-pro"}
KEYS = {"KREA_API_TOKEN": "fixture-krea", "OPENAI_API_KEY": "fixture-openai", "GOOGLE_API_KEY": "fixture-google",
        "BFL_API_KEY": "fixture-bfl"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
OPENAI_SSE = (Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "handlers" / "openai"
              / "gpt-image-2-generate-sse.txt").read_bytes()
BFL_POLL = "https://api.us1.bfl.ai/v1/get_result?id=t1"
BFL_SAMPLE = "https://delivery-us1.bfl.ai/results/t1/sample"
REAL_CLIENT = httpx.AsyncClient


def _answer(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if request.method == "POST" and url == "https://api.krea.ai/assets":
        return httpx.Response(200, json={"image_url": f"https://assets.krea.ai/{uuid4().hex[:6]}.png"})
    if request.method == "POST" and url.startswith("https://api.krea.ai/generate/image/"):
        return httpx.Response(200, json={"job_id": "job-1", "status": "completed",
                                         "created_at": "2026-10-20T00:00:00Z",
                                         "completed_at": "2026-10-20T00:00:02Z",
                                         "result": {"urls": ["https://cdn.krea.ai/job-1.png"]}})
    if request.method == "GET" and url == "https://cdn.krea.ai/job-1.png":
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
    if request.method == "POST" and url == "https://api.openai.com/v1/images/generations":
        return httpx.Response(200, content=OPENAI_SSE, headers={"content-type": "text/event-stream"})
    if request.method == "POST" and url.startswith("https://generativelanguage.googleapis.com/"):
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [
            {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(PNG).decode()}}]}}]})
    if request.method == "POST" and url.startswith("https://api.bfl.ai/v1/"):
        return httpx.Response(200, json={"id": "t1", "polling_url": BFL_POLL, "cost": 4.8})
    if request.method == "GET" and url == BFL_POLL:
        return httpx.Response(200, json={"id": "t1", "status": "Ready", "cost": 4.8, "result": {"sample": BFL_SAMPLE}})
    if request.method == "GET" and url == BFL_SAMPLE:
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
    raise AssertionError(f"unexpected request: {request.method} {url}")


def _normalized(request: httpx.Request) -> tuple[str, str, bytes]:
    body = request.content
    found = re.search(r"boundary=([^;\s]+)", request.headers.get("content-type", ""))
    if found:
        body = body.replace(found.group(1).encode(), b"<boundary>")
    # Each Krea upload answers with its own asset url; the order is fixed.
    body = re.sub(rb"https://assets\.krea\.ai/[0-9a-f]{6}\.png", b"<asset>", body)
    return request.method, str(request.url), body


@pytest.fixture
def transport(monkeypatch):
    from handlers import bfl

    sent: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return _answer(request)

    class Client(REAL_CLIENT):  # a class, so annotations reading httpx.AsyncClient still work
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs.pop("transport", None)
            super().__init__(*args, transport=httpx.MockTransport(record), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    monkeypatch.setattr(bfl, "POLL_INTERVAL", {"Image": 0.0, "Video": 0.0})
    return sent


def _board(tmp_path: Path) -> dict[str, Any]:
    from services.moodboard_analysis import analyze_moodboard
    from services.moodboard_store import MoodboardStore

    folder = OUTPUT_ROOT / "moodboard-cover-requests" / uuid4().hex[:8]
    folder.mkdir(parents=True, exist_ok=True)
    images = []
    for n, (colour, weight) in enumerate([((20, 40, 90), 1.0), ((200, 120, 40), 0.6), ((10, 10, 40), 0.4)],
                                         start=1):
        Image.new("RGB", (48, 32), colour).save(folder / f"{n}.png")
        images.append({"url": f"/api/outputs/moodboard-cover-requests/{folder.name}/{n}.png", "weight": weight,
                       "notes": f"image {n}"})
    store = MoodboardStore()
    board = store.create(name="Painterly space", images=images, strength=0.7, direction="Deep space, painterly",
                         avoid=["neon signage"], by="person")
    return store.update(board["id"], by="person", analysis=analyze_moodboard(store.get(board["id"])))


async def _run(board_id: str, sent: list[httpx.Request]) -> dict[str, list[tuple[str, str, bytes]]]:
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    by_node: dict[str, list[tuple[str, str, bytes]]] = {}
    for nid, definition_id in GENERATORS.items():
        nodes = [GraphNode(id="text", definitionId="text-input", params={"value": "A lighthouse"}),
                 GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board_id}),
                 GraphNode(id=nid, definitionId=definition_id, params={})]
        edges = [GraphEdge(id="p", source="text", sourceHandle="text", target=nid, targetHandle="prompt"),
                 GraphEdge(id="m", source="board", sourceHandle="moodboard", target=nid, targetHandle="moodboard")]
        start = len(sent)
        await execute_graph(nodes, edges, dict(KEYS), get_handler_registry(emit=emit), emit,
                            run_id=f"cover-{nid}-{uuid4().hex[:6]}")
        errors = [e for e in events if getattr(e, "type", "") == "error"]
        assert not errors, errors
        by_node[nid] = [_normalized(request) for request in sent[start:]]
    return by_node


@pytest.mark.asyncio
async def test_every_generator_sends_the_same_bytes_with_any_cover(tmp_path, monkeypatch, transport):
    from services.moodboard_analysis import analyze_moodboard
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board = _board(tmp_path)
    store = MoodboardStore()

    before = await _run(board["id"], transport)
    control = await _run(board["id"], transport)
    assert control == before
    # Each node reached its own provider, with the board in the request.
    hosts = {nid: {httpx.URL(url).host for _m, url, _b in requests} for nid, requests in before.items()}
    assert hosts == {"krea": {"api.krea.ai", "cdn.krea.ai"}, "gpt": {"api.openai.com"},
                     "banana": {"generativelanguage.googleapis.com"},
                     "flux": {"api.bfl.ai", "api.us1.bfl.ai", "delivery-us1.bfl.ai"}}
    for nid, requests in before.items():
        sent_text = b"".join(body for _m, _u, body in requests)
        assert b"Deep space, painterly" in sent_text, nid
    krea = json.loads(next(body for m, url, body in before["krea"] if "/generate/" in url))
    assert krea["image_style_references"], "the board's images went to Krea 2"

    _before, covered, result = store.apply_edits(board["id"], [{"op": "cover", "image": 3}], by="person")
    assert covered["coverImageId"] == covered["images"][2]["id"] and covered["analysis"] == board["analysis"]
    assert covered["thumbnail"] == covered["images"][2]["url"] != board["thumbnail"]
    assert await _run(board["id"], transport) == before

    # A set-aside cover: the set-aside switch changes what goes (as it always
    # has); the cover on top of it changes nothing more.
    store.apply_edits(board["id"], [{"op": "cover", "image": None}, {"op": "setAside", "image": 2, "value": True}],
                      by="person")
    store.update(board["id"], by="person", analysis=analyze_moodboard(store.get(board["id"])))
    aside = await _run(board["id"], transport)
    store.apply_edits(board["id"], [{"op": "cover", "image": 2}], by="person")
    assert store.get(board["id"])["coverImageId"] == covered["images"][1]["id"]
    assert await _run(board["id"], transport) == aside
