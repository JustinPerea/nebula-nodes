from __future__ import annotations

import pytest
from PIL import Image

from handlers.moodboard import handle_moodboard_node
from models.graph import GraphNode
from services.moodboard_analysis import analyze_moodboard
from services.moodboard_store import MoodboardStore
from services.output import OUTPUT_ROOT


def _write_test_image(name: str, color: tuple[int, int, int]) -> str:
    path = OUTPUT_ROOT / "moodboard-tests" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 24), color).save(path)
    rel = path.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"/api/outputs/{rel.as_posix()}"


def test_analyze_moodboard_extracts_palette_and_brief() -> None:
    url = _write_test_image("warm.png", (210, 90, 30))
    moodboard = {
        "id": "m1",
        "name": "Warm board",
        "images": [{"id": "i1", "url": url, "weight": 1.0, "notes": "", "excluded": False}],
        "notes": "editorial warmth",
        "mode": "look",
        "strength": 0.75,
    }

    analysis = analyze_moodboard(moodboard)

    assert analysis["palette"]
    assert analysis["representativeImages"] == [url]
    assert "Warm board" in analysis["styleBrief"]
    assert analysis["providerHints"]["krea"]["strategy"] == "image_style_references"


@pytest.mark.asyncio
async def test_moodboard_node_emits_typed_bundle(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path))
    url = _write_test_image("bundle.png", (20, 140, 190))
    created = MoodboardStore().create(
        name="Blue board",
        images=[{"url": url}],
        notes="cool glass",
        mode="world",
    )

    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"_moodboardId": created["id"]}),
        {},
        {},
    )

    assert result["moodboard"]["type"] == "Moodboard"
    assert result["moodboard"]["value"]["kind"] == "nebula_moodboard"
    assert result["style_brief"]["type"] == "Text"
    assert result["representative_images"]["value"] == [url]
