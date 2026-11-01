"""The stored alpha facts on a board image, and the guards around them
(PR #208 round 4, review 3 L1 and L3).

Each board image entry stores ``hasTransparency`` and ``hasClearPixels``
with the stat of the file they were read from (``alphaFileStat``). A use
trusts them only while that stat still matches, so a file replaced in place
at the same path is read again instead of being kept as opaque. The images
are synthetic.
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest
from PIL import Image

from services import moodboard_analysis
from services.moodboard_analysis import (
    ALPHA_OUTDATED,
    ALPHA_RERUN_WARNING,
    analyze_moodboard,
    file_alpha_facts,
    predates_alpha,
    stamp_transparency,
)
from services.output import OUTPUT_ROOT

from tests.test_colour_alpha import _board, _file_of, _raw, _saved_v5, _stamped, _write, sprite_49

SIZE = (48, 32)


def current_alpha_facts(image):
    from services.moodboard_analysis import current_alpha_facts as facts  # new in round 4

    return facts(image)


def _png(image: Image.Image) -> bytes:
    """Uncompressed, so two RGBA images of one size give files of one size."""
    out = io.BytesIO()
    image.save(out, format="PNG", compress_level=0)
    return out.getvalue()


def _opaque_rgba() -> Image.Image:
    return Image.new("RGBA", SIZE, (40, 120, 200, 255))


def _clear_rgba() -> Image.Image:
    return Image.new("RGBA", SIZE, (0, 0, 0, 0))


def _put(image: Image.Image) -> str:
    path = OUTPUT_ROOT / "alpha-facts" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_png(image))
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _replace(path: Path, image: Image.Image, *, keep_mtime: bool = False) -> None:
    """Write ``image`` over ``path`` in place: a later mtime, or the same one."""
    before = path.stat()
    path.write_bytes(_png(image))
    if keep_mtime:
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    else:
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns + 5_000_000_000))


# -- L1: a fact read from an older version of the file isn't trusted -------------------------

def test_a_file_replaced_in_place_is_read_again(tmp_path, monkeypatch) -> None:
    from services import moodboard_reader as reader
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    url = _put(_opaque_rgba())
    made = store.create(name="Swap", images=[{"url": url}])
    store.update(made["id"], analysis={**analyze_moodboard(store.get(made["id"])), "version": 5})
    entry = _raw(tmp_path / "boards", made["id"])["images"][0]
    stat = _file_of(url).stat()
    assert (entry["hasTransparency"], entry["hasClearPixels"]) == (False, False)
    assert entry["alphaFileStat"] == [stat.st_mtime_ns, stat.st_size]
    assert "outdated" not in store.get(made["id"])["analysis"]

    _replace(_file_of(url), _clear_rgba())  # same path, same size, a later mtime
    board = store.get(made["id"])
    # The stored "opaque" is from the old file: every use reads the new one.
    assert current_alpha_facts(board["images"][0]) == {"hasTransparency": True, "hasClearPixels": True}
    assert reader.clear_targets(reader.select_targets(board)) == {board["images"][0]["id"]}
    assert predates_alpha(board, board["analysis"])
    assert board["analysis"]["outdated"] == ALPHA_OUTDATED


def test_a_stamp_that_matches_is_trusted_with_no_decode(monkeypatch) -> None:
    from services import moodboard_reader as reader

    board = _stamped(_board(_put(_opaque_rgba())))

    def no_decode(*args, **kwargs):
        raise AssertionError("decoded a file whose stamp matches")

    monkeypatch.setattr(moodboard_analysis, "_file_alpha_facts", no_decode)
    monkeypatch.setattr(reader, "_path_is_clear", no_decode)
    assert current_alpha_facts(board["images"][0]) == {"hasTransparency": False, "hasClearPixels": False}
    assert reader.clear_targets(reader.select_targets(board)) == set()


def test_a_board_without_stored_facts_is_unknown_with_no_stat() -> None:
    entry = {"id": "a", "url": _put(_clear_rgba())}
    assert current_alpha_facts(entry) is None


def test_a_client_cant_send_the_stamp(tmp_path, monkeypatch, person) -> None:
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))

    async def ignore(*args, **kwargs):
        return None

    monkeypatch.setattr(main.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main.manager, "broadcast_browser", ignore)
    client = TestClient(main.app)
    url = _put(_clear_rgba())
    made = client.post("/api/moodboards", json={"name": "Forge", "images": [{"url": url}]})
    assert made.status_code == 200, made.text
    board = made.json()
    stored = _raw(tmp_path / "boards", board["id"])["images"][0]
    assert stored["hasClearPixels"] is True
    # A client echoing the board back, with its facts and stamp "opaque" and
    # a stamp of its own: accepted (no 422) and ignored.
    images = [{**board["images"][0], "hasTransparency": False, "hasClearPixels": False, "alphaFileStat": [1, 2]}]
    put = client.put(f"/api/moodboards/{board['id']}", json={"images": images})
    assert put.status_code == 200, put.text
    after = _raw(tmp_path / "boards", board["id"])["images"][0]
    assert {k: after[k] for k in ("hasTransparency", "hasClearPixels", "alphaFileStat")} == {
        k: stored[k] for k in ("hasTransparency", "hasClearPixels", "alphaFileStat")}


def test_facts_stored_before_the_stamp_get_it_at_startup_on_any_board(tmp_path, monkeypatch) -> None:
    from services.moodboard_store import MoodboardStore, stamp_transparency_once

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    url = _put(_opaque_rgba())
    made = store.create(name="Current", images=[{"url": url}])
    store.update(made["id"], analysis=analyze_moodboard(store.get(made["id"])))  # version 6
    path = next((tmp_path / "boards").rglob(f"{made['id']}.json"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["images"][0].pop("alphaFileStat")  # as a round 3 build stored it
    path.write_text(json.dumps(raw), encoding="utf-8")
    report = stamp_transparency_once()
    assert [Path(p).stem for p in report["saved"]] == [made["id"]]
    stat = _file_of(url).stat()
    assert _raw(tmp_path / "boards", made["id"])["images"][0]["alphaFileStat"] == [stat.st_mtime_ns, stat.st_size]
    assert stamp_transparency_once()["saved"] == []


# -- L3: the guards no test pinned ----------------------------------------------------------

def test_an_image_whose_url_changed_at_the_same_id_wasnt_measured() -> None:
    # R4: the analysis measured id i0 at its old url; the file there now has clear pixels.
    board = _stamped(_board(_write(sprite_49())))
    old = {**_saved_v5(board), "images": [{"id": "i0", "url": "/api/outputs/alpha-facts/was-here.png"}]}
    assert board["images"][0]["hasClearPixels"] is True
    assert not predates_alpha(board, old)
    assert predates_alpha(board, _saved_v5(board))


def test_the_cache_reads_a_file_again_when_its_mtime_changes() -> None:
    # R5: same path, same size, a later mtime.
    path = _file_of(_put(_opaque_rgba()))
    assert file_alpha_facts(path) == {"hasTransparency": False, "hasClearPixels": False}
    _replace(path, _clear_rgba())
    assert file_alpha_facts(path) == {"hasTransparency": True, "hasClearPixels": True}


def test_the_cache_reads_a_file_again_when_its_size_changes() -> None:
    # R6: same path, same mtime, another size.
    path = _file_of(_put(_opaque_rgba()))
    assert file_alpha_facts(path) == {"hasTransparency": False, "hasClearPixels": False}
    _replace(path, Image.new("RGBA", (SIZE[0] * 2, SIZE[1]), (0, 0, 0, 0)), keep_mtime=True)
    assert file_alpha_facts(path) == {"hasTransparency": True, "hasClearPixels": True}


@pytest.mark.asyncio
async def test_a_changed_pre_alpha_board_gets_the_board_changed_warning(tmp_path, monkeypatch) -> None:
    # R12: changed since its analysis and pre-alpha with clear pixels: the
    # board-changed line, not the alpha one.
    from handlers.moodboard import handle_moodboard_node
    from models.graph import GraphNode
    from services.moodboard_store import MoodboardStore

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))
    store = MoodboardStore()
    made = store.create(name="Sprites", images=[{"url": _write(sprite_49())}])
    analysis = {**analyze_moodboard(store.get(made["id"])), "version": 5}
    assert analysis.get("styleBrief")
    store.update(made["id"], analysis=analysis)
    images = store.get(made["id"])["images"]
    store.update(made["id"], images=[{**images[0], "weight": 0.5}])
    board = store.get(made["id"])
    assert predates_alpha(board, board["analysis"])
    result = await handle_moodboard_node(
        GraphNode(id="n1", definitionId="nebula-moodboard", params={"moodboard": made["id"]}), {}, {})
    first = result["moodboard"]["value"]["analysis"]["warnings"][0]
    assert first != ALPHA_RERUN_WARNING
    assert first.startswith("The board changed after its saved analysis")


def test_a_truncated_png_at_intake_is_unknown_not_a_500(tmp_path, monkeypatch, person) -> None:
    # R21: a file PIL can identify but not load raises OSError at load.
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "boards"))

    async def ignore(*args, **kwargs):
        return None

    monkeypatch.setattr(main.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main.manager, "broadcast_browser", ignore)
    data = io.BytesIO()
    Image.fromarray(np.random.default_rng(1).integers(0, 255, (64, 64, 4), np.uint8), "RGBA").save(data, "PNG")
    path = OUTPUT_ROOT / "alpha-facts" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.getvalue()[: len(data.getvalue()) // 2])
    with Image.open(path) as identified:
        assert identified.mode == "RGBA"  # identified: only the load fails
    url = f"/api/outputs/alpha-facts/{path.name}"
    made = TestClient(main.app).post("/api/moodboards", json={"name": "Cut", "images": [{"url": url}]})
    assert made.status_code == 200, made.text
    entry = _raw(tmp_path / "boards", made.json()["id"])["images"][0]
    assert "hasTransparency" not in entry and "alphaFileStat" not in entry
    assert stamp_transparency([{"url": url}]) is False
