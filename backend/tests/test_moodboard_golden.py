"""Old moodboards keep their outputs: the golden file.

This file is never regenerated to make a failure pass. A failure means a
change altered what an old board gives generators, agents or the Moodboard
node. Fix the change, not ``expected.json``.

The boards in ``fixtures/moodboard_golden/boards/`` are files as Nebula saved
them before the moodboard canvas (item 6), captured on main at 12257250:

- ``prebrief_v2_plain``: saved before the brief fields (no ``direction``,
  ``avoid``, ``pinnedColors``, ``briefOverride`` or ``briefVersion``) and
  before ``privateNote``; a version 2 analysis, current.
- ``prebrief_v2_edited``: the same age, in a project folder; its version 2
  analysis has a hand-edited ``styleBrief`` and extra negatives, which the
  read-time migration turns into the override and Avoid. Has an external
  https image (can't be resolved) and a weight-0 image.
- ``prebrief_unanalyzed``: the same age, never analyzed; a weight-0 and an
  excluded image. The node analyzes it on every run.
- ``v3_current``: brief fields, no ``privateNote``; a version 3 analysis
  (made by the version 3 analyzer, 14f211e7^), current. Weight 0, excluded and
  an external URL.
- ``v3_override_stale``: brief fields, no ``privateNote``; a version 3
  analysis and a hand-written brief with no ``by`` stamp (before c0f74f0a),
  both out of date because an image was re-weighted after them.
- ``v4_current_private``: today's shape with private notes; a version 4
  analysis, current. Weight 0, excluded and an external URL.
- ``v4_override_pinned``: Direction, Avoid, pinned colours (the kept-out one
  is in the palette) and the person's hand-written brief, current; a version
  4 analysis.

For each board, read through ``MoodboardStore.get`` (what every consumer
sees), this compares: ``analysis_is_current``, ``source_hash`` at the
analysis's version, ``brief_basis``, ``compose``, the Moodboard node's
outputs and run notes, the CLI's ``brief()`` view of the GET route's board,
the Krea 2 style references the bundle becomes (with an identity URL
upload, so no network), and ``apply_to_generator`` for an
instruction-following model and a diffusion model with a negative field.
It also checks that ``get()``, ``list()`` and the GET routes leave every board
file's bytes unchanged.

What is left out, and why:

- ``briefOverride.updatedAt`` in the CLI view when the override was made by
  the read-time migration (``prebrief_v2_edited``): it is the time of the read.
- When the node analyzes a board afresh (its saved analysis isn't current),
  the fresh analysis's ``version`` and any per-image key a later analyzer
  adds. A fresh analysis is made by today's analyzer, not saved on the old
  board, and the plan bumps it to version 5 with ``images[].setAside`` (PR2).
  Every other key of it, and every per-image key version 4 writes, is
  compared. Saved analyses are compared whole.

Deliberate changes, each reviewed field by field against the old file
before it was replaced (the review lists every path that moved):

- 2026-10-19, gap 18 (Justin's P1-P4, contract 07 section 1.11). Notes
  reach generators only on opt-in, so the generated brief loses its
  "Notes:" sentence and the cues lifted from the notes; with no override
  active that is the brief, the node's ``style_brief``, the provider hints
  and both generators' prompts. The node's bundle carries ``notes`` and
  ``images[].notes`` as "" and its ``analysis`` as the generator's view
  (measured keywords only, ``summary`` and ``tasteProfile`` without notes,
  ``subjectBias`` empty, and on ``v4_override_pinned`` its colour lists
  without the kept-out ``#075a68``, as the brief's palette already was).
  New keys: ``clashMode``, ``leftOut``, ``mayClash``, ``kept``,
  ``pinnedClashes``, ``paletteClashes`` and ``notesSent`` on ``compose``,
  the bundle and the CLI's brief; ``clashMode``, ``colorChoices``,
  ``sendNotes`` and ``colorCheck`` on the CLI's board. No old board clashes,
  so every list is empty. Unchanged: ``analysisIsCurrent``, ``sourceHash``,
  ``briefBasis``, run notes, Krea style references, the brief's palette and
  accents, negative and avoid prompts, and every hand-written override.
- 2026-10-20, moodboard canvas PR2 (one "Set aside" switch, analysis
  version 5; plan section 4.4, Q7). The CLI's ``brief()`` gives every image
  ``setAside`` (``excluded`` or weight 0): true for the 7 excluded and
  weight-0 images, false for the other 32. ``sourceHash.version`` for the
  never-analyzed ``prebrief_unanalyzed`` is today's analyzer's, 4 to 5; its
  hash is the same. Nothing else moved: the node's bundle (the fresh analysis
  of ``prebrief_unanalyzed`` included) still carries no excluded image, in
  ``images`` or in ``analysis.images``.
- 2026-10-20, Q21 b: Krea 2 board refs scaled to add up to the board's
  strength; unchanged: refs, order, every other key (moodboard canvas
  PR13a, plan section 4.8 item 7; Justin: "They should normalize for however
  any nodes need the information"). Each board's ``kreaStyleReferences``
  strengths go from ``strength x weight`` to ``strength x weight / sum`` over
  the references sent, at 4 decimals by largest remainder, adding up to the
  board's strength (``prebrief_v2_plain``: 0.7, 0.7, 0.56, 0.42, 0.21 become
  0.1892, 0.1892, 0.1513, 0.1135, 0.0568). The diff is 29 paths, every one a
  ``kreaStyleReferences[i].strength`` on the 7 boards; the URLs, their order
  and every other key are as before, which
  ``test_q21b_changed_only_the_krea_style_references`` pins by a hash of the
  file before the change less that key.
- 2026-10-20, clash reason wording (demo dry run). ``LEXICON_VERSION`` 2 to 3,
  so every saved check runs again and no board keeps the old "allows Warm
  for the late" reasons. On the CLI's board only ``colorCheck.basis`` (it
  hashes the version) and ``colorCheck.checks.words.version`` moved, on all
  7 boards. No old board clashes, so every finding list is still empty.
- 2026-10-20, weight 0 is set aside in the bundle and the summary (plan
  section 4.4; Justin's go on #100's review, recommendation a). The 4 boards
  with a weight-0 image (``prebrief_unanalyzed``, ``prebrief_v2_edited``,
  ``v3_current``, ``v4_current_private``) moved on 15 paths: the node
  bundle's ``images`` and ``analysis.images`` each lose that one image, and
  ``analysis.summary``'s count drops by one, on all 4 (12 paths); the CLI's
  ``analysis.summary`` (the saved analysis as read, counted again in memory
  by ``with_steering_count``) drops by one on the 3 analyzed ones (3 paths).
  Nothing else moved: no generator prompt, Krea style reference, brief,
  ``compose`` output, run note, hash or saved analysis key besides that
  summary. ``test_q21b_changed_only_the_krea_style_references`` pins the
  file before the change with those paths normalized
  (``_without_weight_zero``), and ``tests/test_moodboard_weight_zero.py``
  pins that no generator request changes.

The board images are copied into the test OUTPUT_ROOT at
``moodboard-golden/``, so the boards' ``/api/outputs/moodboard-golden/...``
URLs resolve as real ones do.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "moodboard_golden"
BOARDS = FIXTURES / "boards"
IMAGES = FIXTURES / "images"
EXPECTED = FIXTURES / "expected.json"
IMAGE_DIR = "moodboard-golden"

# The per-image keys a version 4 analysis writes (services/moodboard_analysis.py).
V4_IMAGE_KEYS = ("number", "id", "url", "weight", "notes", "status", "error", "width", "height", "palette",
                 "accents", "colors", "lightness", "saturation")

PROMPT = "A lighthouse on a cliff at dusk"
# Two generator kinds, as moodboard_brief.apply_to_generator tells them apart.
GENERATORS = {
    "instruction": ("gpt-image-2", {
        "inputPorts": [{"id": "prompt", "dataType": "Text"}, {"id": "moodboard", "dataType": "Moodboard"}],
        "params": [{"key": "size"}],
    }),
    "diffusion": ("flux-2-pro", {
        "inputPorts": [{"id": "prompt", "dataType": "Text"}, {"id": "moodboard", "dataType": "Moodboard"}],
        "params": [{"key": "negative_prompt"}],
    }),
}


def labels() -> list[str]:
    return sorted(path.stem for path in BOARDS.glob("*.json"))


def seed(moodboard_root: Path) -> dict[str, Path]:
    """Copy the board files (bytes as they are) into the store's folders and
    the images into OUTPUT_ROOT. Returns each board's file in the store."""
    from services.output import OUTPUT_ROOT

    image_dir = OUTPUT_ROOT / IMAGE_DIR
    image_dir.mkdir(parents=True, exist_ok=True)
    for png in sorted(IMAGES.glob("*.png")):
        shutil.copyfile(png, image_dir / png.name)
    files: dict[str, Path] = {}
    for label in labels():
        source = BOARDS / f"{label}.json"
        board = json.loads(source.read_text(encoding="utf-8"))
        target = moodboard_root / (board.get("projectId") or "_global") / f"{board['id']}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        files[label] = target
    return files


def _fresh(analysis: dict[str, Any]) -> dict[str, Any]:
    """A freshly made analysis without what a later analyzer may add (see the
    module docstring)."""
    kept = {key: value for key, value in analysis.items() if key != "version"}
    kept["images"] = [{key: item[key] for key in V4_IMAGE_KEYS if key in item} for item in analysis["images"]]
    return kept


async def _node(board_id: str) -> tuple[dict[str, Any], list[str]]:
    from handlers.moodboard import handle_moodboard_node
    from models.events import execution_notes
    from models.graph import GraphNode

    notes: list[str] = []
    token = execution_notes.set(notes)
    try:
        result = await handle_moodboard_node(
            GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": board_id}), {}, {})
    finally:
        execution_notes.reset(token)
    return result, notes


async def _krea_refs(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    from handlers.krea import _collect_native_moodboard_style_references
    from models.graph import PortValueDict

    async def same_url(raw: Any, description: str = "") -> Any:
        return raw

    return await _collect_native_moodboard_style_references(
        same_url, {"moodboard": PortValueDict(type="Moodboard", value=bundle)}, remaining_slots=10)


def _generators(bundle: dict[str, Any]) -> dict[str, Any]:
    from models.graph import PortValueDict
    from services.moodboard_brief import apply_to_generator

    out: dict[str, Any] = {}
    for kind, (definition_id, definition) in GENERATORS.items():
        inputs = {"prompt": PortValueDict(type="Text", value=PROMPT),
                  "moodboard": PortValueDict(type="Moodboard", value=bundle)}
        new_inputs, params = apply_to_generator(definition_id, definition, inputs, {})
        out[kind] = {"prompt": new_inputs["prompt"].value, "inputs": sorted(new_inputs), "params": params}
    return out


def board_outputs(label: str, file: Path, client: Any) -> dict[str, Any]:
    """Every pinned output for one seeded board."""
    from moodboard_client import brief as cli_brief
    from services.moodboard_analysis import ANALYSIS_VERSION, analysis_is_current, source_hash
    from services.moodboard_brief import brief_basis, compose
    from services.moodboard_store import MoodboardStore

    raw = json.loads(file.read_text(encoding="utf-8"))
    board = MoodboardStore().get(raw["id"])
    analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    version = int(analysis.get("version") or 1) if analysis else ANALYSIS_VERSION
    current = analysis_is_current(board, analysis)

    result, notes = asyncio.run(_node(raw["id"]))
    bundle = result["moodboard"]["value"]
    node = copy.deepcopy(result)
    if not current:
        node["moodboard"]["value"]["analysis"] = _fresh(bundle["analysis"])

    response = client.get(f"/api/moodboards/{raw['id']}")
    assert response.status_code == 200, response.text
    cli = cli_brief(response.json())
    if cli["briefOverride"] is not None and not isinstance(raw.get("briefOverride"), dict):
        cli["briefOverride"]["updatedAt"] = "<time of the read>"

    return {
        "id": raw["id"],
        "analysisIsCurrent": current,
        "sourceHash": {"version": version, "hash": source_hash(board, version)},
        "briefBasis": brief_basis(board),
        "compose": compose(board, analysis),
        "node": node,
        "runNotes": notes,
        "cli": cli,
        "kreaStyleReferences": asyncio.run(_krea_refs(bundle)),
        "generators": _generators(bundle),
    }


def _client():
    from fastapi.testclient import TestClient

    import main as main_module

    # No lifespan (no `with`): the startup migration must not run, as an
    # old board on disk is what's being read.
    return TestClient(main_module.app)


def _digests(files: dict[str, Path]) -> dict[str, str]:
    return {label: hashlib.sha256(path.read_bytes()).hexdigest() for label, path in files.items()}


@pytest.fixture
def seeded(tmp_path, monkeypatch) -> dict[str, Path]:
    root = tmp_path / "moodboards"
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(root))
    return seed(root)


def test_the_golden_boards_cover_every_old_shape() -> None:
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert sorted(expected) == labels()
    boards = {label: json.loads((BOARDS / f"{label}.json").read_text(encoding="utf-8")) for label in labels()}
    versions = {label: (b["analysis"] or {}).get("version") for label, b in boards.items()}
    assert {2, 3, 4} <= set(versions.values()) and None in versions.values()
    assert any("briefVersion" not in b for b in boards.values())
    assert any(all("privateNote" not in img for img in b["images"]) for b in boards.values())
    images = [img for b in boards.values() for img in b["images"]]
    assert any(img["weight"] == 0 for img in images)
    assert any(img["excluded"] for img in images)
    assert any(img["url"].startswith("https://") for img in images)
    assert any(b.get("briefOverride") and b["pinnedColors"]["include"] and b["pinnedColors"]["exclude"]
               for b in boards.values())


@pytest.mark.parametrize("label", labels())
def test_an_old_board_keeps_its_outputs(seeded, label) -> None:
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))[label]
    # Through JSON, as expected.json was written: tuples become lists.
    actual = json.loads(json.dumps(board_outputs(label, seeded[label], _client())))
    assert actual == expected


def test_reading_an_old_board_leaves_its_file_unchanged(seeded) -> None:
    from services.moodboard_store import MoodboardStore

    before = _digests(seeded)
    store = MoodboardStore()
    client = _client()
    projects = set()
    for path in seeded.values():
        board_id = path.stem
        assert store.get(board_id) is not None
        assert client.get(f"/api/moodboards/{board_id}").status_code == 200
        if path.parent.name != "_global":
            projects.add(path.parent.name)
    store.list("global")
    for project in sorted(projects):
        store.list("project", projectId=project)

    assert _digests(seeded) == before
    # No migration backups either: nothing was written beside the boards.
    root = next(iter(seeded.values())).parent.parent
    assert not (root.parent / "moodboard-backups").exists()
    assert sorted(p.name for p in root.iterdir()) == sorted({p.parent.name for p in seeded.values()})


# The file as it stood before PR13a's deliberate update (Q21 b), less its
# ``kreaStyleReferences``: sha256 of the canonical JSON (sorted keys, no
# spaces), taken on main at 26572670. PR13a may change only that key. The
# clash-wording change (``LEXICON_VERSION`` 3, same day) moves only the
# lexicon's own stamps, ``cli.colorCheck.basis`` (it hashes the version) and
# ``cli.colorCheck.checks.words.version``, so those are left out of both sides.
# The weight-0 change (2026-10-20) moves only the paths ``_without_weight_zero``
# normalizes, so the hash is of the file at 26572670 with those normalized too
# (it was c97b6c2d4b07... before them); the file just before that change gives
# the same hash.
BEFORE_Q21B_WITHOUT_KREA_REFS = "ef8f5d4016bb300f95111b0a288b782adcfd4b461503189bc8dae277cc333fbc"


_COUNT = re.compile(r"^\d+ reference image\(s\) analyzed as ")


def _without_weight_zero(outputs: dict[str, Any]) -> None:
    """The paths the weight-0 change moved, normalized in place: weight-0
    images out of the bundle's ``images`` and ``analysis.images`` (where
    the file before it still had them), and the count in the bundle's and
    the CLI's ``analysis.summary``."""
    bundle = ((outputs.get("node") or {}).get("moodboard") or {}).get("value") or {}
    analysis = bundle.get("analysis") or {}
    for holder in (bundle, analysis):
        if isinstance(holder.get("images"), list):
            holder["images"] = [img for img in holder["images"]
                                if not (isinstance(img, dict) and img.get("weight") in (0, 0.0))]
    for view in (analysis, (outputs.get("cli") or {}).get("analysis") or {}):
        if isinstance(view.get("summary"), str):
            view["summary"] = _COUNT.sub("N reference image(s) analyzed as ", view["summary"])


def _without_krea_refs(expected: dict[str, Any]) -> str:
    rest = {label: {key: value for key, value in outputs.items() if key != "kreaStyleReferences"}
            for label, outputs in expected.items()}
    rest = json.loads(json.dumps(rest))
    for outputs in rest.values():
        check = (outputs.get("cli") or {}).get("colorCheck")
        if isinstance(check, dict):
            check.pop("basis", None)
            ((check.get("checks") or {}).get("words") or {}).pop("version", None)
        _without_weight_zero(outputs)
    canonical = json.dumps(rest, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def test_q21b_changed_only_the_krea_style_references() -> None:
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert _without_krea_refs(expected) == BEFORE_Q21B_WITHOUT_KREA_REFS
    # Each board's references add up to its strength, at 4 decimals.
    from decimal import Decimal

    for label in labels():
        board = json.loads((BOARDS / f"{label}.json").read_text(encoding="utf-8"))
        refs = expected[label]["kreaStyleReferences"]
        assert refs, label
        total = sum((Decimal(str(ref["strength"])) for ref in refs), Decimal(0))
        assert total == Decimal(str(board.get("strength", 0.7))), label


def test_the_golden_docstring_records_the_q21b_change() -> None:
    doc = __doc__ or ""
    assert "Q21 b" in doc
    assert ("Krea 2 board refs scaled to add up to the board's strength; unchanged: refs, order, "
            "every other key") in " ".join(doc.split())
