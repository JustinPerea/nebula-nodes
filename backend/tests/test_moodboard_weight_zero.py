"""Weight 0 is set aside (plan section 4.4: ``excluded || weight == 0``), and
no generator gets a set-aside image.

The Moodboard node's bundle leaves a weight-0 image out of ``images`` and
``analysis.images`` and out of the summary's count, as it does a switched
one. Generators never read those keys for weight-0 images anyway (Krea 2
skips ``weight <= 0``, the brief's colours and cues come from steering images
only), so leaving them out changes no request. This pins that: GPT Image,
Nano Banana, FLUX.2 [pro] and Krea 2, each through its real handler and route
with every HTTP call intercepted, send exactly the same requests for a board
with a weight-0 image as for the same board without it.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx
import numpy as np
import pytest
import respx
from PIL import Image

from execution.engine import execute_graph
from execution.sync_runner import get_handler_registry
from models.graph import GraphEdge, GraphNode
from services.moodboard_analysis import analyze_moodboard
from services.moodboard_store import MoodboardStore
from services.output import OUTPUT_ROOT

GENERATORS = {"gpt": "gpt-image-2-generate", "banana": "nano-banana", "flux": "flux-2-pro",
              "krea": "krea-2-generate"}
# Placeholders: respx answers every call, so none of these reaches a provider.
KEYS = {"OPENAI_API_KEY": "sk-test", "GEMINI_API_KEY": "g-test", "GOOGLE_API_KEY": "g-test",
        "BFL_API_KEY": "bfl-test", "FAL_KEY": "fal-test", "KREA_API_TOKEN": "krea-test"}


def _png(name: str, colour: tuple[int, int, int], accent: tuple[int, int, int] | None = None) -> str:
    rng = np.random.default_rng(sum(colour))
    pixels = np.zeros((72, 96, 3), dtype=np.int16)
    pixels[:] = colour
    if accent:
        pixels[2:8, 2:10] = accent
    pixels += rng.integers(-2, 3, size=pixels.shape, dtype=np.int16)
    path = OUTPUT_ROOT / "moodboard-weight-zero" / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)).save(path)
    return f"/api/outputs/moodboard-weight-zero/{name}.png"


def _images(with_zero: bool) -> list[dict[str, Any]]:
    images = [
        {"url": _png("navy", (30, 40, 90)), "weight": 1.0, "notes": "night sea"},
        {"url": _png("cream", (235, 225, 205), (240, 110, 30)), "weight": 0.6},
        {"url": _png("lime", (150, 220, 40)), "weight": 0.0, "notes": "weight zero"},
        {"url": _png("magenta", (220, 30, 160)), "weight": 1.0, "excluded": True},
        {"url": _png("sage", (120, 150, 120)), "weight": 0.8},
    ]
    return images if with_zero else [img for img in images if img["weight"] != 0.0]


def _board(with_zero: bool, analyzed: bool) -> dict[str, Any]:
    store = MoodboardStore()
    board = store.create(name="Weight zero", images=_images(with_zero), notes="quiet harbour", mode="look",
                         strength=0.7, direction="sun-faded", avoid=["neon signage"])
    if analyzed:
        board = store.update(board["id"], analysis=analyze_moodboard(store.get(board["id"])))
    return board


async def _requests(board_id: str) -> list[dict[str, Any]]:
    """Every request the four generators send for the board, in a stable order."""
    seen: list[dict[str, Any]] = []

    def answer(request: httpx.Request) -> httpx.Response:
        content = request.content or b""
        ctype = request.headers.get("content-type", "")
        try:
            body: Any = json.loads(content)
        except ValueError:
            body = content.decode("utf-8", "replace")
            if "boundary=" in ctype:
                body = body.replace(ctype.split("boundary=")[1], "<boundary>")
        seen.append({"method": request.method, "url": str(request.url), "body": body})
        if str(request.url).endswith("/assets"):  # Krea's upload: a URL made from the bytes
            boundary = ctype.split("boundary=")[1].encode() if "boundary=" in ctype else b""
            digest = hashlib.sha256(content.replace(boundary, b"") if boundary else content).hexdigest()[:12]
            return httpx.Response(200, json={"id": f"asset-{digest}", "image_url": f"https://krea.assets/{digest}.png",
                                             "uploaded_at": "now", "width": None, "height": None,
                                             "size_bytes": len(content), "mime_type": "image/png"})
        return httpx.Response(400, json={"error": {"message": "test: not sent"}})

    async def emit(event: Any) -> None:
        return None

    nodes = [GraphNode(id="text", definitionId="text-input", params={"value": "A lighthouse at dusk"}),
             GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board_id})]
    edges: list[GraphEdge] = []
    for nid, definition_id in GENERATORS.items():
        nodes.append(GraphNode(id=nid, definitionId=definition_id, params={}))
        edges.append(GraphEdge(id=f"p-{nid}", source="text", sourceHandle="text", target=nid, targetHandle="prompt"))
        edges.append(GraphEdge(id=f"m-{nid}", source="board", sourceHandle="moodboard", target=nid,
                               targetHandle="moodboard"))
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as mock:
        mock.route().mock(side_effect=answer)
        await execute_graph(nodes, edges, dict(KEYS), get_handler_registry(emit), emit, run_id="weight-zero")
    return sorted(seen, key=lambda r: (r["url"], json.dumps(r["body"], sort_keys=True)))


@pytest.mark.asyncio
@pytest.mark.parametrize("analyzed", [True, False], ids=["saved analysis", "analyzed on the run"])
async def test_a_weight_zero_image_changes_no_generator_request(tmp_path, monkeypatch, analyzed):
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    with_zero = await _requests(_board(True, analyzed)["id"])
    without = await _requests(_board(False, analyzed)["id"])

    hosts = {r["url"].split("/")[2] for r in with_zero}
    assert hosts == {"api.openai.com", "generativelanguage.googleapis.com", "api.bfl.ai", "api.krea.ai"}
    assert any(r["url"].endswith("/generate/image/krea/krea-2/medium") for r in with_zero)
    assert with_zero == without
    # Neither the weight-0 image nor its note went anywhere.
    sent = json.dumps(with_zero)
    assert "lime.png" not in sent and "weight zero" not in sent


@pytest.mark.asyncio
async def test_a_version_1_analysis_that_lists_a_weight_zero_image_sends_it_nowhere(tmp_path, monkeypatch):
    # Review of the weight-0 fix: an analysis from before 2026-10-18 (version
    # 1) ranked every readable image as representative, weight 0 included,
    # and it stays current while the board is unchanged. Krea 2 skipped it
    # only because the bundle's images said its weight was 0; with weight 0
    # out of those images it read as full weight and went to Krea.
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    from services.moodboard_analysis import analysis_is_current, source_hash
    from execution.sync_runner import get_handler_registry as registry
    store = MoodboardStore()
    board = store.create(name="Old", images=_images(True), notes="quiet harbour", mode="look", strength=0.7)
    urls = [img["url"] for img in board["images"] if not img.get("excluded")]
    lime = next(img["url"] for img in board["images"] if img["weight"] == 0.0)
    analysis = {"version": 1, "sourceHash": source_hash(board, 1), "styleBrief": "Old brief.", "mode": "look",
                "summary": "4 reference image(s) analyzed as visual direction.", "palette": [],
                "representativeImages": urls,
                "providerHints": {"krea": {"strategy": "image_style_references", "representativeImages": urls,
                                           "strength": 0.7, "styleBrief": "Old brief."}}}
    board = store.update(board["id"], analysis=analysis)
    assert analysis_is_current(store.get(board["id"]), store.get(board["id"])["analysis"])

    sent = json.dumps(await _requests(board["id"]))
    assert "lime.png" not in sent and "weight zero" not in sent

    async def emit(event: Any) -> None:
        return None

    handler = registry(emit)["nebula-moodboard"]
    result = await handler(GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]}),
                           {}, {})
    bundle = result["moodboard"]["value"]
    assert lime not in result["representative_images"]["value"]
    assert lime not in bundle["representativeImages"]
    assert lime not in bundle["analysis"]["representativeImages"]
    assert lime not in bundle["providerHints"]["krea"]["representativeImages"]
    assert lime not in bundle["analysis"]["providerHints"]["krea"]["representativeImages"]
    assert lime not in json.dumps(bundle)
