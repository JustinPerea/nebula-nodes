"""PR #203 round 20, section 2a: what CI caught on round 19 (81bb9b41).

1. A spatial value's metadata is never taken for a file. Storing a World
   rewrote every string that named an existing path under OUTPUT_ROOT into an
   /api/outputs URL, so "source": "generated" became "/api/outputs/generated"
   whenever a folder called "generated" existed there, and the World failed
   its own validation (CI ran another test first that left that folder). Only
   an asset reference's ``uri`` is a path.
2. The route-schema harness (test_route_schema_coverage.py) runs each route
   as the person: Idol's Hugging Face call with the person's token set is
   theirs alone, and the harness checks what a route sends, not who sends it.
"""
from __future__ import annotations

import shutil

import pytest

import main
from services.output import OUTPUT_ROOT
from tests.conftest import PERSON
from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_idol_round19_gate import _run, world  # noqa: F401 - fixture
from tests.test_worldlabs_handler import _world_v2

# Strings an Idol World carries as metadata: its session's source, provider,
# model and label, and its display name.
METADATA_NAMES = ("generated", "speridlabs", "idol", "Idol object")


@pytest.fixture
def folders_named_like_metadata():
    made = []
    for name in METADATA_NAMES:
        folder = OUTPUT_ROOT / name
        if not folder.exists():
            folder.mkdir(parents=True)
            made.append(folder)
    yield
    for folder in made:
        shutil.rmtree(folder, ignore_errors=True)


def test_a_worlds_metadata_stays_as_sent_when_folders_share_its_names(folders_named_like_metadata):
    value = _world_v2(provider="speridlabs", model="idol")
    value["displayName"] = "Idol object"
    value["session"]["label"] = "Idol object"
    splat = OUTPUT_ROOT / "run-r20" / "object.ply"
    splat.parent.mkdir(parents=True, exist_ok=True)
    splat.write_bytes(b"ply\n")
    try:
        value["assets"]["splats"][0]["asset"]["uri"] = str(splat)
        stored = main._normalize_output_value_for_storage({"type": "World", "value": value})["value"]
    finally:
        shutil.rmtree(splat.parent, ignore_errors=True)
    session = stored["session"]
    assert (session["source"], session["provider"], session["model"], session["label"]) == (
        "generated", "speridlabs", "idol", "Idol object")
    assert stored["displayName"] == "Idol object"
    # The asset's path is still made portable.
    assert stored["assets"]["splats"][0]["asset"]["uri"] == "/api/outputs/run-r20/object.ply"


def test_the_persons_idol_run_finishes_with_those_folders_present(world, folders_named_like_metadata):
    body = _run(world, PERSON)
    assert body["status"] == "finished", body
    session = body["results"][world.idol]["world"]["value"]["session"]
    assert (session["source"], session["provider"], session["model"]) == ("generated", "speridlabs", "idol")

