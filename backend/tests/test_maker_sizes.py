"""Fixed maker size lists and the notes that say when a size changes (services/maker_sizes.py).

tests/fixtures/maker_size_cases.json is shared with
frontend/tests/lib/makerSizes.test.ts, so the Inspector's note and the size
the backend sends can't drift apart. Nothing reaches a provider.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from models.events import ExecutedEvent, add_run_note
from models.graph import GraphNode
from services import maker_sizes, node_route
from services.node_registry import NodeRegistry

DEFINITIONS = NodeRegistry().get_all()
SHARED = json.loads((Path(__file__).parent / "fixtures" / "maker_size_cases.json").read_text())
CASES = SHARED["cases"]
START_SHAPE_CASES = SHARED["startShapeCases"]
SNAPPED = {
    "krea-image-ideogram-ideogram-3": "krea-ideogram-3",
    "krea-image-ideogram-ideogram-2-turbo": "krea-ideogram-2a",
    "krea-image-runway-gen-4-image": "krea-runway-gen4-image",
}


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['nodeId']}-{c['width']}x{c['height']}")
def test_shared_cases(case):
    snap = maker_sizes.definition_snap(DEFINITIONS[case["nodeId"]], {"width": case["width"], "height": case["height"]})
    assert snap is not None
    assert snap.value == case["value"]
    assert snap.note() == case["note"]


@pytest.mark.parametrize("case", START_SHAPE_CASES, ids=lambda c: f"{c['nodeId']}-{c['params']}-{c['wired']}")
def test_shared_start_shape_cases(case):
    note = maker_sizes.definition_start_shape_note(DEFINITIONS[case["nodeId"]], case["params"], set(case["wired"]))
    assert note == case["note"]


def test_start_shape_rules_reach_the_catalog():
    """scripts/sync-krea-catalog.py copies maker_sizes.START_SHAPES into
    directRoute.startShape, by the route's model."""
    carried = {node_id: d["directRoute"] for node_id, d in DEFINITIONS.items()
               if isinstance(d.get("directRoute"), dict) and "startShape" in d["directRoute"]}
    assert set(carried) == {"krea-video-bytedance-seedance-2-5"}
    for route in carried.values():
        assert route["startShape"] == maker_sizes.START_SHAPES[route["model"]]


def test_every_snapping_route_carries_its_list_in_the_catalog():
    """scripts/sync-krea-catalog.py copies maker_sizes.SNAPS into directRoute.snap."""
    carried = {node_id: d["directRoute"]["snap"] for node_id, d in DEFINITIONS.items()
               if isinstance(d.get("directRoute"), dict) and "snap" in d["directRoute"]}
    assert set(carried) == set(SNAPPED)
    for node_id, translation in SNAPPED.items():
        assert DEFINITIONS[node_id]["directRoute"]["translation"] == translation
        assert carried[node_id] == {"widthParam": "width", "heightParam": "height", **maker_sizes.SNAPS[translation]}
    assert {case["nodeId"] for case in CASES} == set(SNAPPED)


def test_the_handlers_validate_against_the_same_lists():
    from handlers.ideogram import IDEOGRAM_V3_RESOLUTIONS
    from handlers.runway import RUNWAY_IMAGE_MODELS

    assert IDEOGRAM_V3_RESOLUTIONS == frozenset(maker_sizes.IDEOGRAM_V3_RESOLUTIONS)
    assert len(maker_sizes.IDEOGRAM_V3_RESOLUTIONS) == 69
    assert RUNWAY_IMAGE_MODELS["gen4_image"]["ratios"] == maker_sizes.RUNWAY_GEN4_IMAGE_RATIOS


def test_nearest_keeps_the_shape_then_the_pixel_count():
    ratios = maker_sizes.RUNWAY_GEN4_IMAGE_RATIOS
    # Same shape, nearest pixel count: 1024:1024, not 720:720 or 1080:1080.
    assert maker_sizes.nearest(1024, 1024, ratios, ":") == "1024:1024"
    assert maker_sizes.nearest(700, 700, ratios, ":") == "720:720"
    assert maker_sizes.nearest(3000, 1000, maker_sizes.IDEOGRAM_ASPECT_RATIOS, "x") == "3x1"
    assert maker_sizes.nearest(1000, 1250, maker_sizes.IDEOGRAM_ASPECT_RATIOS, "x") == "4x5"


def test_defaults_and_unusable_sizes():
    ideogram_3 = DEFINITIONS["krea-image-ideogram-ideogram-3"]
    # Krea's defaults (1024 x 1024) when the recipe sets no size: exact, no note.
    snap = maker_sizes.definition_snap(ideogram_3, {})
    assert snap is not None and snap.value == "1024x1024" and snap.note() is None
    assert maker_sizes.definition_snap(ideogram_3, {"width": "wide", "height": 1024}) is None
    assert maker_sizes.definition_snap(ideogram_3, {"width": True, "height": 1024}) is None
    assert maker_sizes.definition_snap(DEFINITIONS["krea-image-ideogram-ideogram-4-5-precise"], {}) is None


def test_made_note_says_what_the_maker_made():
    spec = maker_sizes.SNAPS["krea-ideogram-3"]
    snap = maker_sizes.snap(spec, 1000, 560)
    assert snap.made_note(1312, 736) == "Ideogram made 1312x736, the closest it could get to your 1000x560."
    assert maker_sizes.snap(spec, 1024, 1024).made_note(1024, 1024) is None
    shape = maker_sizes.snap(maker_sizes.SNAPS["krea-ideogram-2a"], 1600, 900)
    assert shape.note() is None  # exact shape: nothing to say before the run
    assert shape.made_note(1312, 736) == ("Ideogram made 1312x736 (its 16:9 size), the closest it could get "
                                          "to your 1600x900.")


def test_routes_without_a_list_never_snap():
    """Every other maker route sends a size or shape as given, or keeps the run
    on the copy (directRoute.size / accepts / blockedBy): no other node has a
    snap list, and no other translator rounds a width/height."""
    for node_id, definition in DEFINITIONS.items():
        if node_id in SNAPPED or node_id == "krea-video-bytedance-seedance-2-5":
            continue
        assert maker_sizes.rule_note(definition) is None, node_id
    # Seedance 2.5 keeps a start image's shape on BytePlus: agents are told.
    assert maker_sizes.rule_note(DEFINITIONS["krea-video-bytedance-seedance-2-5"]) == (
        "On the maker route (BytePlus key), a run with a start_image makes the video in the start image's shape "
        "and aspect_ratio is not used (Seedance 2.5 takes no other ratio then); the run's notes say so. On the "
        "Krea copy it is sent as given.")


@pytest.mark.parametrize(("keys", "route", "note"), [
    ({"IDEOGRAM_API_KEY": "k", "KREA_API_TOKEN": "k"}, "direct", True),
    # On the Krea copy the size is sent as given; describe_node still says
    # what the maker route would do, since that's what the key would change.
    ({"KREA_API_TOKEN": "k"}, "krea", True),
])
def test_describe_node_says_sizes_round_on_the_maker_route(monkeypatch, keys, route, note):
    from fastapi.testclient import TestClient
    import main

    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": keys})
    body = TestClient(main.app).get("/api/agent/nodes/krea-image-ideogram-ideogram-3").json()
    assert body["route"] == route
    assert body["sizeNote"] == (
        "On the maker route (Ideogram key), width/height round to the nearest of the 69 sizes Ideogram makes; "
        "the run's notes say the size it made. On the Krea copy they are sent as given.")
    other = TestClient(main.app).get("/api/agent/nodes/krea-image-google-nano-banana").json()
    assert "sizeNote" not in other


def test_cli_info_prints_the_size_rule():
    from cli.formatter import format_node_detail, format_run_results

    text = format_node_detail(DEFINITIONS["krea-image-ideogram-ideogram-2-turbo"])
    assert ("SIZE: On the maker route (Ideogram key), width/height round to the nearest of Ideogram's 15 aspect "
            "ratios, and Ideogram picks the pixel size") in text
    shown = format_run_results({"results": {"n1": {"image": {"type": "Image", "value": "/x.png"}}},
                                "notes": {"n1": ["Ideogram made 1312x736, the closest it could get to your 1000x560."]}})
    assert "n1: note — Ideogram made 1312x736, the closest it could get to your 1000x560." in shown


def test_the_route_decides_when_a_size_note_applies():
    """The Inspector shows the note only on the maker route (the frontend reads
    node_route.select_route's twin); the backend rule is the same."""
    definition = DEFINITIONS["krea-image-ideogram-ideogram-3"]
    params = {"_kreaAuth": "api-token", "width": 1000, "height": 560}
    assert node_route.select_route(definition, params, {"IDEOGRAM_API_KEY": "k"}).kind == node_route.DIRECT
    assert node_route.select_route(definition, params, {"KREA_API_TOKEN": "k"}).kind == node_route.FALLBACK


# -- the run's notes: executed event, cache replay, manifest ---------------------

@pytest.mark.asyncio
async def test_run_notes_reach_the_event_the_cache_and_the_manifest():
    from execution.engine import execute_graph
    from services.cache import ExecutionCache
    from services.output import get_run_dir, read_manifest

    calls = []

    async def handler(node, inputs, keys):
        calls.append(node.id)
        path = get_run_dir() / "made.png"
        path.write_bytes(b"\x89PNG fixture")
        add_run_note("Ideogram made 1312x736, the closest it could get to your 1000x560.")
        add_run_note("Ideogram made 1312x736, the closest it could get to your 1000x560.")  # once only
        return {"image": {"type": "Image", "value": str(path)}}

    cache = ExecutionCache()
    events: list = []

    async def emit(event):
        events.append(event)

    async def run(run_id):
        node = GraphNode(id="n", definitionId="gpt-image-1-generate", params={"prompt": "p"})
        await execute_graph([node], [], {}, {"gpt-image-1-generate": handler}, emit, cache=cache, run_id=run_id)
        return next(e for e in reversed(events) if isinstance(e, ExecutedEvent))

    first = await run("notes-first")
    note = ["Ideogram made 1312x736, the closest it could get to your 1000x560."]
    assert first.notes == note
    assert first.model_dump(by_alias=True)["notes"] == note
    manifest = read_manifest(Path(first.outputs["image"]["value"]).parent)
    assert manifest["outputs"][0]["notes"] == note
    replay = await run("notes-replay")
    assert calls == ["n"]  # the second run replayed the cache
    assert replay.notes == note
    # Outside a run, a note goes nowhere.
    add_run_note("ignored")


@pytest.mark.asyncio
async def test_a_run_without_notes_carries_none():
    from execution.engine import execute_graph

    events: list = []

    async def handler(node, inputs, keys):
        return {"text": {"type": "Text", "value": "ok"}}

    async def emit(event):
        events.append(event)

    node = GraphNode(id="n", definitionId="gpt-image-1-generate", params={"prompt": "p"})
    await execute_graph([node], [], {}, {"gpt-image-1-generate": handler}, emit)
    executed = next(e for e in events if isinstance(e, ExecutedEvent))
    assert executed.notes is None
