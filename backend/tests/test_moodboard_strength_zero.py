"""Board strength 0 turns the whole board off for that node (Q36 a).

Justin, 2026-10-20: "Strength 0 turns the whole board off for that node,
text included. The run note becomes "Board strength is 0: board not sent".
For images off with text on, use the node's existing "Send board images"
switch." Plan sections 5.7.3 step 1, 5.7.4 and 7.5 Q36.

A generator that takes a board gets nothing from a strength-0 board: no
brief, Avoid, negatives or images, and the same run note on every node. A
second board wired beside it still goes. The Moodboard node's own outputs
(Brief, Negative, Palette, Images) are explicit wiring and stay as they are.
"""
from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import httpx
import pytest
import respx
from PIL import Image

from execution.engine import _node_def_for, execute_graph
from handlers.krea import KREA_BASE_URL, handle_krea_generate
from handlers.moodboard import handle_moodboard_node
from models.events import ExecutedEvent, execution_notes
from models.graph import GraphEdge, GraphNode, PortValueDict
from services import moodboard_brief
from services.moodboard_brief import apply_to_generator
from services.moodboard_store import MoodboardStore
from services.output import OUTPUT_ROOT

NOTE = "Board strength is 0: board not sent"

# One of each kind of node that takes a board today: instruction-following
# (Avoid in the prompt), diffusion-style (brief only), a negative field, and
# Krea 2, whose handler reads the board's images itself.
GENERATORS = ["gpt-image-2-generate", "nano-banana", "flux-2-pro", "fast-sdxl", "krea-2-generate"]


def _bundle(strength: float | None, name: str = "Dusk", word: str = "neon") -> dict[str, Any]:
    bundle: dict[str, Any] = {
        "kind": "nebula_moodboard",
        "name": name,
        "styleBrief": f"Use the Nebula moodboard '{name}' as look direction.",
        "negativePrompt": f"blurry, low-detail artifacts, {word}",
        "avoidPrompt": f"Keep these out of the image: {word}.",
        "images": [{"url": f"https://assets.example/{name}-1.png", "weight": 1.0},
                   {"url": f"https://assets.example/{name}-2.png", "weight": 0.5}],
    }
    if strength is not None:
        bundle["strength"] = strength
    return bundle


def _apply(definition_id: str, board: Any, params: dict | None = None):
    inputs = {"prompt": PortValueDict(type="Text", value="A chair"),
              "moodboard": PortValueDict(type="Moodboard", value=board)}
    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        new_inputs, new_params = apply_to_generator(definition_id, _node_def_for(definition_id), inputs,
                                                    params or {})
    finally:
        execution_notes.reset(token)
    return new_inputs, new_params, notes


def test_the_note_is_justins_wording():
    assert getattr(moodboard_brief, "BOARD_STRENGTH_ZERO_NOTE", None) == NOTE


@pytest.mark.parametrize("definition_id", GENERATORS)
def test_strength_zero_sends_no_board_text(definition_id):
    own = {"negative_prompt": "watermark"}
    inputs, params, notes = _apply(definition_id, _bundle(0.0), own)

    assert inputs["prompt"].value == "A chair"
    assert params == own and own == {"negative_prompt": "watermark"}
    # Krea 2 runs exactly as with no board: no port, so no board images.
    assert set(inputs) == {"prompt"}
    assert notes == [NOTE]


@pytest.mark.parametrize("definition_id", GENERATORS)
def test_strength_just_above_zero_still_sends(definition_id):
    inputs, params, notes = _apply(definition_id, _bundle(0.01))

    assert inputs["prompt"].value.startswith("A chair\n\nMoodboard direction: Use the Nebula moodboard 'Dusk'")
    assert notes == []
    if definition_id == "krea-2-generate":
        assert inputs["moodboard"].value["strength"] == 0.01
    if definition_id == "fast-sdxl":
        assert params["negative_prompt"] == "blurry, low-detail artifacts, neon"


def test_a_board_saved_without_a_strength_still_sends():
    # The bundle's strength defaults to 0.7 (handlers/moodboard.py), so a
    # missing key is never "off".
    inputs, _, notes = _apply("gpt-image-2-generate", _bundle(None))
    assert "Moodboard direction" in inputs["prompt"].value and notes == []


@pytest.mark.parametrize("definition_id", ["gpt-image-2-generate", "fast-sdxl", "krea-2-generate"])
def test_strength_zero_board_beside_another_board_sends_only_the_other(definition_id):
    boards = [_bundle(0.0, name="Off", word="chrome"), _bundle(0.7, name="On", word="neon")]
    inputs, params, notes = _apply(definition_id, boards)

    prompt = inputs["prompt"].value
    assert "'On'" in prompt and "'Off'" not in prompt and "chrome" not in prompt
    assert "chrome" not in str(params.get("negative_prompt", ""))
    if definition_id == "gpt-image-2-generate":
        assert prompt.endswith("Keep these out of the image: neon.")
    if definition_id == "fast-sdxl":
        assert params["negative_prompt"] == "blurry, low-detail artifacts, neon"
    if definition_id == "krea-2-generate":
        assert [b["name"] for b in inputs["moodboard"].value] == ["On"]
    assert notes == [NOTE]


def test_board_images_off_still_sends_the_text():
    """Images off with text on is the node's "Send board images" switch, not
    strength 0 (§5.7.8). Until PR14 adds ``_boardImages``, every content-slot
    node is on that setting: a board at 0.7 into GPT Image edit sends its
    brief and Avoid, and the wired image is the only image."""
    wired = PortValueDict(type="Image", value=["/tmp/wired.png"])
    inputs = {"prompt": PortValueDict(type="Text", value="A chair"), "images": wired,
              "moodboard": PortValueDict(type="Moodboard", value=_bundle(0.7))}
    new_inputs, _ = apply_to_generator("gpt-image-2-edit", _node_def_for("gpt-image-2-edit"), inputs, {})

    assert new_inputs["prompt"].value == ("A chair\n\nMoodboard direction: Use the Nebula moodboard 'Dusk' as "
                                          "look direction.\n\nKeep these out of the image: neon.")
    assert new_inputs["images"] is wired and "moodboard" not in new_inputs


def _completed(job_id: str) -> httpx.Response:
    return httpx.Response(200, json={
        "job_id": job_id, "status": "completed", "created_at": "2026-10-20T00:00:00Z",
        "completed_at": "2026-10-20T00:00:02Z", "result": {"urls": [f"https://cdn.krea.ai/{job_id}.png"]},
    })


def _saved_board(strength: float) -> dict[str, Any]:
    folder = OUTPUT_ROOT / "moodboard-strength-zero" / uuid4().hex[:8]
    folder.mkdir(parents=True, exist_ok=True)
    images = []
    for n, colour in enumerate([(20, 40, 90), (200, 120, 40)], start=1):
        Image.new("RGB", (48, 32), colour).save(folder / f"{n}.png")
        images.append({"url": f"/api/outputs/moodboard-strength-zero/{folder.name}/{n}.png", "weight": 1.0})
    return MoodboardStore().create(name="Dusk", images=images, strength=strength,
                                   direction="Sunlit", avoid=["neon signage"])


@pytest.mark.asyncio
async def test_strength_zero_through_the_engine_reaches_no_generator(tmp_path, monkeypatch):
    """A saved board at strength 0 wired into GPT Image, Nano Banana, FLUX.2,
    SDXL and Krea 2 (its real handler, mocked HTTP): every request is the
    one it would be with no board, and every node carries the run note."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board = _saved_board(0.0)
    seen: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}

    def fake(node_key):
        async def handler(node, inputs, api_keys):
            seen[node_key] = ({k: v.value for k, v in inputs.items()}, dict(node.params))
            return {"image": {"type": "Image", "value": "/tmp/out.png"}}
        return handler

    captured: dict[str, Any] = {}

    def generate(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return _completed("job-off")

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    targets = {"gpt": "gpt-image-2-generate", "banana": "nano-banana", "flux": "flux-2-pro",
               "sdxl": "fast-sdxl", "krea": "krea-2-generate"}
    nodes = [GraphNode(id="text", definitionId="text-input", params={"value": "A chair"}),
             GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]})]
    edges = []
    for nid, definition_id in targets.items():
        params = {"negative_prompt": "watermark"} if nid == "sdxl" else {}
        nodes.append(GraphNode(id=nid, definitionId=definition_id, params=params))
        edges.append(GraphEdge(id=f"p-{nid}", source="text", sourceHandle="text", target=nid, targetHandle="prompt"))
        edges.append(GraphEdge(id=f"m-{nid}", source="board", sourceHandle="moodboard",
                               target=nid, targetHandle="moodboard"))
    registry = {"nebula-moodboard": handle_moodboard_node, "krea-2-generate": handle_krea_generate,
                **{definition_id: fake(nid) for nid, definition_id in targets.items() if nid != "krea"}}
    with respx.mock:
        uploads = respx.post(f"{KREA_BASE_URL}/assets")
        respx.post(f"{KREA_BASE_URL}/generate/image/krea/krea-2/medium").mock(side_effect=generate)
        respx.get("https://cdn.krea.ai/job-off.png").mock(
            return_value=httpx.Response(200, content=b"png", headers={"Content-Type": "image/png"}))
        await execute_graph(nodes, edges, {"KREA_API_TOKEN": "krea-token"}, registry, emit, run_id="strength-zero")

    errors = [e for e in events if getattr(e, "type", "") == "error"]
    assert not errors, errors
    for nid in ("gpt", "banana", "flux", "sdxl"):
        inputs, params = seen[nid]
        assert inputs == {"prompt": "A chair"}, nid
        assert params == ({"negative_prompt": "watermark"} if nid == "sdxl" else {}), nid
    assert captured["body"]["prompt"] == "A chair"
    assert "image_style_references" not in captured["body"] and "moodboards" not in captured["body"]
    assert not uploads.called
    for nid in targets:
        executed = next(e for e in events if isinstance(e, ExecutedEvent) and e.node_id == nid)
        assert NOTE in (executed.notes or []), nid
        assert not any("no board images sent" in note for note in executed.notes or []), nid
    # The Moodboard node's own run says nothing about strength.
    board_run = next(e for e in events if isinstance(e, ExecutedEvent) and e.node_id == "board")
    assert NOTE not in (board_run.notes or [])


@pytest.mark.asyncio
async def test_strength_zero_leaves_the_moodboard_nodes_own_outputs(tmp_path, monkeypatch):
    """Judgment call (plan §7.5 Q36): the Brief, Negative, Palette and Images
    outputs are wiring the person chose, so strength 0 doesn't empty them.
    "Off for that node" is about a generator's Moodboard input."""
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board = _saved_board(0.0)
    result = await handle_moodboard_node(
        GraphNode(id="m", definitionId="nebula-moodboard", params={"moodboard": board["id"]}), {}, {})

    bundle = result["moodboard"]["value"]
    assert bundle["strength"] == 0.0
    assert result["style_brief"]["value"] == bundle["styleBrief"] and "Sunlit" in bundle["styleBrief"]
    assert "neon signage" in result["negative_prompt"]["value"]
    assert len(result["representative_images"]["value"]) == 2
    assert result["palette"]["value"]


@pytest.mark.asyncio
async def test_a_cache_hit_still_says_the_board_was_not_sent(tmp_path, monkeypatch):
    """With the board off, the request is the one a run without the board
    makes, so it can replay that run's cache entry. The replay still says
    why the board didn't go."""
    from services.cache import ExecutionCache

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board = _saved_board(0.0)
    calls: list[str] = []

    async def gpt(node, inputs, api_keys):
        calls.append(inputs["prompt"].value)
        return {"image": {"type": "Image", "value": "/tmp/out.png"}}

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    text = GraphNode(id="text", definitionId="text-input", params={"value": "A chair"})
    gen = GraphNode(id="gpt", definitionId="gpt-image-2-generate", params={})
    prompt = GraphEdge(id="p", source="text", sourceHandle="text", target="gpt", targetHandle="prompt")
    cache = ExecutionCache()
    registry = {"nebula-moodboard": handle_moodboard_node, "gpt-image-2-generate": gpt}
    await execute_graph(nodes=[text, gen], edges=[prompt], api_keys={}, handler_registry=registry,
                        emit=emit, cache=cache)
    events.clear()
    await execute_graph(
        nodes=[text, GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]}), gen],
        edges=[prompt, GraphEdge(id="m", source="board", sourceHandle="moodboard", target="gpt",
                                 targetHandle="moodboard")],
        api_keys={}, handler_registry=registry, emit=emit, cache=cache)

    assert calls == ["A chair"]
    executed = next(e for e in events if isinstance(e, ExecutedEvent) and e.node_id == "gpt")
    assert executed.notes == [NOTE]


@pytest.mark.asyncio
async def test_a_cache_hit_without_the_board_does_not_say_it(tmp_path, monkeypatch):
    """The other way round: a run with the board off leaves an entry that a
    later run with the board unwired replays. That run had no board, so it
    gets no note about one."""
    from services.cache import ExecutionCache

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    board = _saved_board(0.0)
    calls: list[str] = []

    async def gpt(node, inputs, api_keys):
        calls.append(inputs["prompt"].value)
        return {"image": {"type": "Image", "value": "/tmp/out.png"}}

    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    text = GraphNode(id="text", definitionId="text-input", params={"value": "A chair"})
    gen = GraphNode(id="gpt", definitionId="gpt-image-2-generate", params={})
    prompt = GraphEdge(id="p", source="text", sourceHandle="text", target="gpt", targetHandle="prompt")
    cache = ExecutionCache()
    registry = {"nebula-moodboard": handle_moodboard_node, "gpt-image-2-generate": gpt}
    await execute_graph(
        nodes=[text, GraphNode(id="board", definitionId="nebula-moodboard", params={"moodboard": board["id"]}), gen],
        edges=[prompt, GraphEdge(id="m", source="board", sourceHandle="moodboard", target="gpt",
                                 targetHandle="moodboard")],
        api_keys={}, handler_registry=registry, emit=emit, cache=cache)
    first = next(e for e in events if isinstance(e, ExecutedEvent) and e.node_id == "gpt")
    assert first.notes == [NOTE]
    events.clear()
    await execute_graph(nodes=[text, gen], edges=[prompt], api_keys={}, handler_registry=registry,
                        emit=emit, cache=cache)

    assert calls == ["A chair"]
    executed = next(e for e in events if isinstance(e, ExecutedEvent) and e.node_id == "gpt")
    assert not executed.notes
