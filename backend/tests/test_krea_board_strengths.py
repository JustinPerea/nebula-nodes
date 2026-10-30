"""Krea 2's board references share out the board's strength (Q21 b, PR13a).

Justin, 2026-10-20: "They should normalize for however any nodes need the
information." The board images sent add up to ``board.strength``; wired
references keep their own strengths; a board at strength 0 sends nothing,
text included (Q32 a, then Q36 a). Plan sections 4.8 item 7 and 5.7.4.
"""
from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from handlers.krea import KREA_BASE_URL, _collect_native_moodboard_style_references, handle_krea_generate
from models.events import execution_notes
from models.graph import GraphNode, PortValueDict


def _board(weights: list[float], strength: float = 0.7, name: str = "Dusk", **extra: Any) -> dict[str, Any]:
    return {
        "kind": "nebula_moodboard",
        "name": name,
        "strength": strength,
        "images": [{"url": f"https://assets.example/{i + 1}.png", "weight": w} for i, w in enumerate(weights)],
        **extra,
    }


async def _same_url(raw: Any, description: str = "") -> Any:
    return raw


async def _refs(board: dict[str, Any], *, remaining_slots: int = 10, wired: list[dict[str, Any]] | None = None,
                ) -> tuple[list[dict[str, Any]], list[str]]:
    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        refs = await _collect_native_moodboard_style_references(
            _same_url, {"moodboard": PortValueDict(type="Moodboard", value=board)},
            remaining_slots=remaining_slots, wired=wired)
    finally:
        execution_notes.reset(token)
    return refs, notes


def _exact_sum(refs: list[dict[str, Any]]) -> Decimal:
    return sum((Decimal(str(ref["strength"])) for ref in refs), Decimal(0))


def _four_decimals(value: float) -> bool:
    return Decimal(str(value)) == Decimal(str(value)).quantize(Decimal("0.0001"))


@pytest.mark.asyncio
@pytest.mark.parametrize("weights", [
    [0.5],
    [1.0, 0.5],
    [1.0, 1.0, 0.8, 0.6, 0.3],
    [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15],
])
async def test_board_strengths_add_up_to_board_strength(weights) -> None:
    refs, _ = await _refs(_board(weights, strength=0.7))
    assert len(refs) == len(weights)
    assert all(_four_decimals(ref["strength"]) for ref in refs)
    assert _exact_sum(refs) == Decimal("0.7")
    # Heaviest first, and the shares follow the weights.
    strengths = [ref["strength"] for ref in refs]
    assert strengths == sorted(strengths, reverse=True)


@pytest.mark.asyncio
async def test_board_scaling_covers_only_images_sent() -> None:
    wired = [{"url": f"https://wired.example/{i}.png", "strength": 0.5} for i in range(7)]
    board = _board([1.0, 0.9, 0.8, 0.7, 0.6], strength=0.6)
    refs, notes = await _refs(board, remaining_slots=10 - len(wired), wired=wired)
    # Only 3 slots were left: those 3 add up to the board's strength.
    assert [ref["url"] for ref in refs] == [f"https://assets.example/{i}.png" for i in (1, 2, 3)]
    assert _exact_sum(refs) == Decimal("0.6")
    assert [ref["strength"] for ref in refs] == [0.2222, 0.2, 0.1778]
    # The wired references are the person's, untouched.
    assert all(ref["strength"] == 0.5 for ref in wired)
    assert "Your 7 references add 3.50 on top of the board's 0.60." in notes


@pytest.mark.asyncio
async def test_single_board_image_goes_at_board_strength() -> None:
    refs, _ = await _refs(_board([0.4], strength=0.7))
    # Before Q21 b it went at 0.7 x 0.4 = 0.28.
    assert refs == [{"url": "https://assets.example/1.png", "strength": 0.7}]


@pytest.mark.asyncio
async def test_board_strength_zero_sends_no_board_refs() -> None:
    # The engine drops a strength-0 board before Krea 2 sees it (Q36 a,
    # tests/test_moodboard_strength_zero.py); called directly, the handler
    # still sends none of its images and says the same.
    refs, notes = await _refs(_board([1.0, 0.5], strength=0.0))
    assert refs == []
    # Q36 a, Justin's wording (2026-10-20), replacing Q32 a's.
    assert notes == ["Board strength is 0: board not sent"]


@pytest.mark.asyncio
async def test_weight_zero_and_set_aside_images_are_still_never_sent() -> None:
    board = _board([1.0, 0.0, 0.5])
    board["images"].append({"url": "https://assets.example/aside.png", "weight": 1.0, "excluded": True})
    refs, _ = await _refs(board)
    assert [ref["url"] for ref in refs] == ["https://assets.example/1.png", "https://assets.example/3.png"]
    assert [ref["strength"] for ref in refs] == [0.4667, 0.2333]


@pytest.mark.asyncio
async def test_an_image_too_light_to_steer_is_left_out_with_a_note() -> None:
    # Its share rounds to 0 at 4 decimals, which Krea reads as "no style
    # influence", so it doesn't go; the others still add up to the board's.
    board = _board([1.0, 0.00001], analysis={
        "images": [{"number": 1, "url": "https://assets.example/1.png"},
                   {"number": 2, "url": "https://assets.example/2.png"}],
    })
    refs, notes = await _refs(board)
    assert refs == [{"url": "https://assets.example/1.png", "strength": 0.7}]
    assert "Board “Dusk”: #2 is too light to steer at this board strength, so it wasn't sent." in notes


@pytest.mark.asyncio
async def test_a_stale_hint_never_sends_a_weight_zero_image() -> None:
    board = _board([1.0, 0.0], analysis={"providerHints": {"krea": {"representativeImages": [
        "https://assets.example/1.png", "https://assets.example/2.png"]}}})
    refs, _ = await _refs(board)
    assert refs == [{"url": "https://assets.example/1.png", "strength": 0.7}]


@pytest.mark.asyncio
async def test_krea_board_run_note_lists_strengths() -> None:
    board = _board([1.0, 1.0, 0.8, 0.6, 0.3], analysis={
        "images": [{"number": n, "url": f"https://assets.example/{n}.png"} for n in range(1, 6)],
    })
    refs, notes = await _refs(board)
    # The plan's example (section 4.8 item 7): prebrief_v2_plain's weights.
    assert [ref["strength"] for ref in refs] == [0.1892, 0.1892, 0.1513, 0.1135, 0.0568]
    assert notes == ["Board “Dusk” sent 5 images; their strengths add up to the board's 0.70 "
                     "(#1 0.19, #2 0.19, #3 0.15, #4 0.11, #5 0.06)."]



@pytest.mark.asyncio
async def test_a_light_image_that_went_never_reads_as_zero_in_the_note() -> None:
    # Review of PR13a: nine cards at 1.0 and one at the card minimum (0.05,
    # moodboard_layout.MIN_WEIGHT). #10 goes at 0.0039; at 2 decimals the note
    # said "#10 0.00", as if it had no weight.
    board = _board([1.0] * 9 + [0.05], analysis={
        "images": [{"number": n, "url": f"https://assets.example/{n}.png"} for n in range(1, 11)],
    })
    refs, notes = await _refs(board)
    assert len(refs) == 10
    assert refs[-1]["strength"] == 0.0039
    assert _exact_sum(refs) == Decimal("0.7")
    assert len(notes) == 1
    assert notes[0].startswith("Board “Dusk” sent 10 images; their strengths add up to the board's 0.70 (#1 0.08, ")
    assert notes[0].endswith(", #9 0.08, #10 0.0039).")
    assert not re.search(r" 0\.00[,)]", notes[0])

def _completed(job_id: str) -> httpx.Response:
    return httpx.Response(200, json={
        "job_id": job_id, "status": "completed", "created_at": "2026-10-20T00:00:00Z",
        "completed_at": "2026-10-20T00:00:02Z", "result": {"urls": [f"https://cdn.krea.ai/{job_id}.png"]},
    })


@pytest.mark.asyncio
async def test_token_route_sends_scaled_body_and_keeps_wired_strengths() -> None:
    captured: dict[str, Any] = {}

    def capture(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return _completed("job-scaled")

    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        with respx.mock:
            respx.post(f"{KREA_BASE_URL}/generate/image/krea/krea-2/medium").mock(side_effect=capture)
            respx.get("https://cdn.krea.ai/job-scaled.png").mock(
                return_value=httpx.Response(200, content=b"png", headers={"Content-Type": "image/png"}))
            await handle_krea_generate(
                GraphNode(id="k", definitionId="krea-2-generate", params={}),
                {
                    "prompt": PortValueDict(type="Text", value="A lighthouse"),
                    "image_style_references": PortValueDict(type="Any", value=[
                        {"kind": "krea_image_style_reference", "url": "https://wired.example/w.png", "strength": 0.9}]),
                    "moodboard": PortValueDict(type="Moodboard", value=_board([1.0, 0.5, 0.5], strength=0.8)),
                },
                {"KREA_API_TOKEN": "krea-token"},
            )
    finally:
        execution_notes.reset(token)

    refs = captured["body"]["image_style_references"]
    assert refs[0] == {"url": "https://wired.example/w.png", "strength": 0.9}
    assert [ref["strength"] for ref in refs[1:]] == [0.4, 0.2, 0.2]
    assert _exact_sum(refs[1:]) == Decimal("0.8")
    assert "Your 1 reference adds 0.90 on top of the board's 0.80." in notes


@pytest.mark.asyncio
async def test_account_route_sends_scaled_body() -> None:
    gateway = AsyncMock(return_value={"image": {"type": "Image", "value": "/tmp/out.png"}, "job": {"type": "Any", "value": {}}})
    with patch("handlers.krea_gateway.run_gateway", gateway), \
            patch("handlers.krea_gateway._model", return_value={"id": "krea-2"}):
        await handle_krea_generate(
            GraphNode(id="k", definitionId="krea-2-generate", params={"_kreaAuth": "mcp"}),
            {
                "prompt": PortValueDict(type="Text", value="A lighthouse"),
                "moodboard": PortValueDict(type="Moodboard", value=_board([1.0, 0.5], strength=0.6)),
            },
            {},
        )
    body = gateway.await_args.args[2]
    assert body["image_style_references"] == [
        {"url": "https://assets.example/1.png", "strength": 0.4},
        {"url": "https://assets.example/2.png", "strength": 0.2},
    ]


@pytest.mark.asyncio
async def test_a_five_image_board_through_the_engine_sends_strengths_that_add_up(tmp_path, monkeypatch) -> None:
    """The live check, mocked: a saved board's node feeds Krea 2 through the
    engine (brief, uploads, run notes on the executed event). No paid run."""
    from PIL import Image

    from execution.engine import execute_graph
    from handlers.moodboard import handle_moodboard_node
    from models.events import ExecutedEvent
    from models.graph import GraphEdge
    from services.moodboard_store import MoodboardStore
    from services.output import OUTPUT_ROOT

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    folder = OUTPUT_ROOT / "krea-board-strengths"
    folder.mkdir(parents=True, exist_ok=True)
    images = []
    for n, (weight, colour) in enumerate(zip([1.0, 1.0, 0.8, 0.6, 0.3],
                                             [(20, 40, 90), (200, 120, 40), (30, 140, 90), (240, 230, 210), (90, 20, 30)]),
                                         start=1):
        Image.new("RGB", (64, 48), colour).save(folder / f"{n}.png")
        images.append({"url": f"/api/outputs/krea-board-strengths/{n}.png", "weight": weight})
    board = MoodboardStore().create(name="Dusk", images=images, strength=0.7)

    uploads = iter(range(1, 6))
    captured: dict[str, Any] = {}

    def upload(_request: httpx.Request) -> httpx.Response:
        n = next(uploads)
        return httpx.Response(200, json={"id": f"a{n}", "image_url": f"https://krea.assets/{n}.png"})

    def generate(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return _completed("job-engine")

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    nodes = [GraphNode(id="text", definitionId="text-input", params={"value": "A lighthouse at dusk"}),
             GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]}),
             GraphNode(id="krea", definitionId="krea-2-generate", params={})]
    edges = [GraphEdge(id="p", source="text", sourceHandle="text", target="krea", targetHandle="prompt"),
             GraphEdge(id="e", source="board", sourceHandle="moodboard", target="krea", targetHandle="moodboard")]
    with respx.mock:
        respx.post(f"{KREA_BASE_URL}/assets").mock(side_effect=upload)
        respx.post(f"{KREA_BASE_URL}/generate/image/krea/krea-2/medium").mock(side_effect=generate)
        respx.get("https://cdn.krea.ai/job-engine.png").mock(
            return_value=httpx.Response(200, content=b"png", headers={"Content-Type": "image/png"}))
        await execute_graph(nodes, edges, {"KREA_API_TOKEN": "krea-token"},
                            {"nebula-moodboard": handle_moodboard_node, "krea-2-generate": handle_krea_generate},
                            emit, run_id="board-strengths")
    errors = [e for e in events if getattr(e, "type", "") == "error"]
    assert not errors, errors

    refs = captured["body"]["image_style_references"]
    assert [ref["strength"] for ref in refs] == [0.1892, 0.1892, 0.1513, 0.1135, 0.0568]
    assert _exact_sum(refs) == Decimal("0.7")
    executed = next(e for e in events if isinstance(e, ExecutedEvent) and e.node_id == "krea")
    assert ("Board “Dusk” sent 5 images; their strengths add up to the board's 0.70 "
            "(#1 0.19, #2 0.19, #3 0.15, #4 0.11, #5 0.06).") in (executed.notes or [])
