"""One "Set aside" switch (moodboard canvas C3, analysis version 5).

The stored key stays ``excluded``; its meaning changes from "not read" to
"read, never steers". A set-aside image is measured and gets an
``analysis.images`` entry with ``setAside: true`` and its colours, but it
adds nothing to what steers: the palette, accents, sources, keywords,
summary, brief, negatives and representative images are what they would be
without it. The node's bundle, the brief's colour lists and Krea's
references never carry it (docs/moodboard-canvas-plan.md section 4.4).
"""
from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
import pytest
from PIL import Image

from services.moodboard_analysis import ANALYSIS_VERSION, analysis_is_current, analyze_moodboard, source_hash
from services.moodboard_brief import compose
from services.output import OUTPUT_ROOT

NAVY = (30, 40, 90)
CREAM = (235, 225, 205)
MAGENTA = (220, 30, 160)
ORANGE = (240, 110, 30)
LIME = (150, 220, 40)


def _blocks(name: str, background: tuple[int, int, int], *, accent: tuple[int, int, int] | None = None,
            seed: int = 0) -> str:
    """A 96×72 image of one colour with light seeded noise; ``accent`` paints a small patch."""
    rng = np.random.default_rng(seed)
    pixels = np.zeros((72, 96, 3), dtype=np.int16)
    pixels[:] = background
    if accent:
        pixels[2:6, 2:8] = accent
    pixels += rng.integers(-2, 3, size=pixels.shape, dtype=np.int16)
    path = OUTPUT_ROOT / "moodboard-set-aside-tests" / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _image(url: str, weight: float = 1.0, *, excluded: bool = False, image_id: str = "",
           notes: str = "") -> dict[str, Any]:
    return {"id": image_id or url.rsplit("/", 1)[-1][:-4], "url": url, "weight": weight, "notes": notes,
            "excluded": excluded}


def _board(images: list[dict[str, Any]], **fields: Any) -> dict[str, Any]:
    return {"name": "Set aside", "mode": "look", "strength": 0.7, "notes": "quiet harbour light", **fields,
            "images": images}


def _set_aside_board() -> dict[str, Any]:
    """1 navy, 2 magenta set aside (heavy, so it would lead the palette if it
    steered), 3 cream with an orange accent, 4 lime at weight 0."""
    return _board([
        _image(_blocks("sa-navy", NAVY, seed=1), image_id="navy"),
        _image(_blocks("sa-magenta", MAGENTA, accent=ORANGE, seed=2), excluded=True, image_id="aside",
               notes="the pink wall"),
        _image(_blocks("sa-cream", CREAM, accent=ORANGE, seed=3), 0.6, image_id="cream"),
        _image(_blocks("sa-lime", LIME, seed=4), 0.0, image_id="zero"),
    ])


# What steers: everything an analysis gives generators.
STEERING_KEYS = ("palette", "accents", "colors", "keywords", "summary", "tasteProfile", "styleBrief",
                 "negativePrompt", "avoids", "lighting", "composition", "subjectBias", "representativeImages",
                 "providerHints")


def _without(board: dict[str, Any], image_id: str) -> dict[str, Any]:
    return {**board, "images": [img for img in board["images"] if img["id"] != image_id]}


def _renumbered(analysis: dict[str, Any], numbers: dict[int, int]) -> dict[str, Any]:
    """The analysis's colours with each source's board number mapped, so a
    board missing image 2 compares with one that has it."""
    colours = [{**c, "sources": [{**s, "number": numbers.get(s["number"], s["number"])} for s in c["sources"]]}
               for c in analysis["colors"]]
    return {**analysis, "colors": colours}


def test_set_aside_is_measured_never_steers() -> None:
    board = _set_aside_board()

    analysis = analyze_moodboard(board)

    assert analysis["version"] == ANALYSIS_VERSION == 5
    # Measured: an entry with its number, its colours and setAside.
    entries = {item["id"]: item for item in analysis["images"]}
    assert [item["number"] for item in analysis["images"]] == [1, 2, 3, 4]
    aside = entries["aside"]
    assert aside["setAside"] is True and aside["status"] == "analyzed" and aside["number"] == 2
    assert aside["colors"] and aside["palette"] and aside["accents"]
    assert aside["weight"] == 1.0 and aside["notes"] == "the pink wall"
    # Only the switch is marked; weight 0 keeps its version 4 entry.
    assert all("setAside" not in entries[key] for key in ("navy", "cream", "zero"))

    # Never steers: every steering output is what the board gives without it.
    alone = _renumbered(analyze_moodboard(_without(board, "aside")), {2: 3, 3: 4})
    for key in STEERING_KEYS:
        assert analysis[key] == alone[key], key
    assert analysis["warnings"] == []
    composed, composed_alone = compose(board, analysis), compose(_without(board, "aside"), alone)
    for key in ("styleBrief", "negativePrompt", "avoidPrompt", "palette", "accents", "leftOut", "mayClash"):
        assert composed[key] == composed_alone[key], key


def test_set_aside_colours_have_no_sources_or_contribution() -> None:
    analysis = analyze_moodboard(_set_aside_board())

    named = {(s["number"], s["id"]) for colour in analysis["colors"] for s in colour["sources"]}
    assert named and all(number != 2 and image_id != "aside" for number, image_id in named)
    # Its colours are its own: none of the board's colours is near its magenta.
    aside = next(item for item in analysis["images"] if item["id"] == "aside")
    magenta = aside["palette"][0]
    assert magenta not in analysis["palette"] and magenta not in analysis["accents"]
    # The board's shares still add up over the images that steer.
    dominant = [c for c in analysis["colors"] if c["role"] == "dominant"]
    assert abs(sum(c["share"] for c in dominant) - 1.0) < 0.01
    # Measured the same as when it steers.
    steering = analyze_moodboard(_board([_image(aside["url"], image_id="aside")]))
    assert aside["colors"] == steering["images"][0]["colors"]


def test_v4_analysis_stays_current() -> None:
    board = _set_aside_board()
    analysis = analyze_moodboard(board)
    # A version 4 analysis of the same board: same hash payload, so it stays
    # current until the board changes, and a version 3 one too.
    for version in (4, 3):
        old = {**analysis, "version": version, "sourceHash": source_hash(board, version),
               "images": [item for item in analysis["images"] if not item.get("setAside")]}
        assert old["sourceHash"] == analysis["sourceHash"]
        assert analysis_is_current(board, old)
    # Setting an image aside (or using it again) is a change.
    flipped = {**board, "images": [{**img, "excluded": not img["excluded"]} if img["id"] == "navy" else img
                                   for img in board["images"]]}
    assert not analysis_is_current(flipped, analysis)


def test_the_summary_counts_only_images_not_set_aside() -> None:
    board = _set_aside_board()

    summary = analyze_moodboard(board)["summary"]

    # Four images, one set aside. Weight 0 still counts, as it did in
    # version 4, so the summary of every pinned board stays as it was.
    assert summary.startswith("3 reference image(s) analyzed as look.")
    assert summary == analyze_moodboard(_without(board, "aside"))["summary"]


def test_every_image_set_aside_warns() -> None:
    navy, cream = _blocks("sa-all-1", NAVY, seed=11), _blocks("sa-all-2", CREAM, seed=12)
    warning = "Every reference is set aside, so none of them shapes the board."

    switched = analyze_moodboard(_board([_image(navy, excluded=True), _image(cream, excluded=True)]))
    mixed = analyze_moodboard(_board([_image(navy, excluded=True), _image(cream, 0.0)]))
    weightless = analyze_moodboard(_board([_image(cream, 0.0)]))

    for analysis in (switched, mixed, weightless):
        assert analysis["warnings"] == [warning]
        assert analysis["palette"] == [] and analysis["representativeImages"] == []
        assert all(item["colors"] for item in analysis["images"])
    assert [item.get("setAside") for item in switched["images"]] == [True, True]
    assert switched["summary"].startswith("Empty moodboard")
    # One image that steers is enough.
    assert analyze_moodboard(_board([_image(navy, excluded=True), _image(cream)]))["warnings"] == []


def test_a_set_aside_image_that_cant_be_read_is_listed_without_a_warning() -> None:
    board = _board([_image(_blocks("sa-read", NAVY, seed=21)),
                    _image("https://elsewhere.example/aside.png", excluded=True, image_id="far")])

    analysis = analyze_moodboard(board)

    far = analysis["images"][1]
    assert far["status"] == "unresolved" and far["setAside"] is True and far["palette"] == []
    # The warnings are the steering board's: what it would say without it.
    assert analysis["warnings"] == []


def _store_board(tmp_path, monkeypatch, images: list[dict[str, Any]]) -> dict[str, Any]:
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    return MoodboardStore().create(name="Set aside", images=images, notes="", mode="look")


def _run_node(board_id: str) -> dict[str, Any]:
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode

    return asyncio.run(handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": board_id}), {}, {}))


def test_krea_references_never_include_a_set_aside_image(tmp_path, monkeypatch) -> None:
    from handlers.krea import _collect_native_moodboard_style_references
    from models.graph import PortValueDict
    from services.moodboard_store import MoodboardStore

    navy = _blocks("sa-krea-navy", NAVY, seed=31)
    aside = _blocks("sa-krea-aside", MAGENTA, seed=32)
    zero = _blocks("sa-krea-zero", LIME, seed=33)
    cream = _blocks("sa-krea-cream", CREAM, seed=34)
    created = _store_board(tmp_path, monkeypatch, [
        {"url": navy, "weight": 0.5}, {"url": aside, "weight": 1.0, "excluded": True},
        {"url": zero, "weight": 0.0}, {"url": cream, "weight": 0.8}])

    async def same_url(raw: Any, description: str = "") -> Any:
        return raw

    def references(bundle: dict[str, Any]) -> list[dict[str, Any]]:
        return asyncio.run(_collect_native_moodboard_style_references(
            same_url, {"moodboard": PortValueDict(type="Moodboard", value=bundle)}, remaining_slots=10))

    # Unanalyzed: the node analyzes the board on the run.
    fresh = _run_node(created["id"])["moodboard"]["value"]
    # Analyzed and saved: the node reads the saved analysis.
    store = MoodboardStore()
    board = store.get(created["id"])
    store.update(created["id"], analysis=analyze_moodboard(board))
    saved = _run_node(created["id"])["moodboard"]["value"]

    for bundle in (fresh, saved):
        refs = references(bundle)
        assert [ref["url"] for ref in refs] == [cream, navy]
        # Q21 b: the two share out the board's 0.7 (weights 0.8 and 0.5).
        assert [ref["strength"] for ref in refs] == [0.4308, 0.2692]
        assert bundle["representativeImages"] == [cream, navy]
        # The bundle carries no set-aside image: not in images, not in the
        # analysis's images, not in a colour's sources.
        assert [img["url"] for img in bundle["images"]] == [navy, zero, cream]
        assert [item["url"] for item in bundle["analysis"]["images"]] == [navy, zero, cream]
        assert not any(item.get("setAside") for item in bundle["analysis"]["images"])
        assert all(s["number"] != 2 for c in bundle["analysis"]["colors"] for s in c["sources"])
    # The saved analysis does list it.
    assert [item.get("setAside") for item in store.get(created["id"])["analysis"]["images"]] == [
        None, True, None, None]


def test_the_cli_brief_says_which_images_are_set_aside() -> None:
    from moodboard_client import brief

    board = {"id": "b1", "name": "B", "images": [
        {"id": "a", "url": "/a.png", "weight": 1.0, "notes": "", "excluded": False},
        {"id": "b", "url": "/b.png", "weight": 1.0, "notes": "", "excluded": True},
        {"id": "c", "url": "/c.png", "weight": 0.0, "notes": "", "excluded": False},
        {"id": "d", "url": "/d.png", "weight": 0.0, "notes": "", "excluded": True}]}

    view = brief(board)

    assert [image["setAside"] for image in view["images"]] == [False, True, True, True]
    # The stored switch is still there as it is.
    assert [image["excluded"] for image in view["images"]] == [False, True, False, True]
