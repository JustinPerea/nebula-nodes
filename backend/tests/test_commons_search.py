from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from commons import intake, records, search
from commons.db import CommonsDB
from commons.store import CommonsStore
from commons.vocab import load_vocabulary


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def add(store, collection, seed, *, why=None, role="neutral", fields=None, color=None):
    rng = np.random.default_rng(seed)
    pixels = rng.integers(0, 255, (32, 32, 3), dtype=np.uint8)
    if color:
        pixels[:] = color
        pixels[0:4, 0:4] = rng.integers(0, 255, (4, 4, 3), dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(pixels, "RGB").save(buf, "PNG")
    res = intake.add_bytes(store, buf.getvalue(), filename=f"{seed}.png", collection_id=collection["id"],
                           actor="human:justin", source={"kind": "file"}, why=why, role=role)
    if fields:
        records.write_analysis_ok(store, res.asset["id"], fields=fields, raw_output="{}", fewshot_ids=[],
                                  prompt_version="reader-1", model_id="claude-opus-5-5", vocab_version="1",
                                  candidates=[], proposed_regions=[], duration_ms=1)
    return res


def fields(summary, keywords, layout="grid", quiet=0.0):
    return {"summary": {"value": summary, "why": "-"}, "keywords": keywords,
            "layout": {"value": layout, "why": "-"}, "subject": {"value": "screen", "why": "-"},
            "axes": {"quiet_loud": {"value": quiet, "why": "-"}}}


def test_vocabulary_loads_154_unique_terms():
    v = load_vocabulary()
    assert len(v.terms) == 154
    assert v.canonical("minimalist") == "minimal"
    assert "minimal" in v.expand("minimalism")
    assert v.expand("zzzz") == ["zzzz"]


def test_synonym_expansion_and_bm25(store):
    col = store.ensure_collection("ui", "manual")
    a = add(store, col, 1, fields=fields("Sparse dashboard with a strict grid", ["minimal", "dashboard"]))
    add(store, col, 2, fields=fields("Loud collage poster", ["maximal", "collage"], layout="freeform"))
    rows = search.search(store, query="minimalist dashboards")
    assert rows[0]["id"] == a.asset["id"]
    assert "keywords" in rows[0]["matched"] or "summary" in rows[0]["matched"]


def test_brand_scope_and_inheritance(store):
    free = store.ensure_collection("free", "manual")
    mita = store.ensure_collection("mita", "manual", brand="mitamaton")
    gm = store.ensure_collection("gm", "manual", brand="good-machines")
    other = store.ensure_collection("other", "manual", brand="acme")
    ids = {}
    for name, col, seed in (("free", free, 1), ("mita", mita, 2), ("gm", gm, 3), ("other", other, 4)):
        ids[name] = add(store, col, seed, why=f"grid reference {name}").asset["id"]
    seen = {r["id"] for r in search.search(store, query="grid", brand="mitamaton")}
    assert seen == {ids["free"], ids["mita"], ids["gm"]}
    assert {r["id"] for r in search.search(store, query="grid")} == {ids["free"]}
    assert {r["id"] for r in search.search(store, query="grid", brand="acme")} == {ids["free"], ids["other"]}
    assert len(search.search(store, query="grid", all_scopes=True)) == 4


def test_avoid_inbox_and_quarantine_are_excluded_by_default(store):
    col = store.ensure_collection("x", "manual")
    keep = add(store, col, 1, why="grid ok")
    avoid = add(store, col, 2, why="grid bad", role="avoid")
    inbox = intake.agent_add_bytes(store, actor=__import__("commons.actors", fromlist=["Actor"]).Actor(
        "agent:mcp:x", "agent", self_reported=True), data=_png(3), filename="c.png",
        collection_id=col["id"], why="grid found")
    quarantined = add(store, col, 4, why="grid held out")
    records.quarantine_add(store, [(quarantined.asset["phash"], "x.png")])
    ids = {r["id"] for r in search.search(store, query="grid")}
    assert ids == {keep.asset["id"]}
    assert {r["id"] for r in search.search(store, query="grid", filters=search.Filters.from_dict({"role": "avoid"}))} \
        == {avoid.asset["id"]}
    assert inbox.asset["id"] in {r["id"] for r in search.search(
        store, query="grid", filters=search.Filters.from_dict({"inbox": True}))}


def _png(seed):
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (32, 32, 3), dtype=np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def test_filters_axes_keywords_palette(store):
    col = store.ensure_collection("x", "manual")
    quiet = add(store, col, 1, fields=fields("a", ["calm"], quiet=-0.8), color=(20, 60, 200))
    loud = add(store, col, 2, fields=fields("b", ["energetic"], quiet=0.9), color=(230, 30, 40))
    f = search.Filters.from_dict({"axes": {"quiet_loud": [-1, -0.5]}})
    assert [r["id"] for r in search.search(store, filters=f)] == [quiet.asset["id"]]
    f = search.Filters.from_dict({"keywords": ["energetic"]})
    assert [r["id"] for r in search.search(store, filters=f)] == [loud.asset["id"]]
    f = search.Filters.from_dict({"palette_near": {"hex": "#e61e28", "max_delta_e": 10}})
    assert [r["id"] for r in search.search(store, filters=f)] == [loud.asset["id"]]
    with pytest.raises(ValueError):
        search.Filters.from_dict({"palette_near": {"hex": "#000000", "max_delta_e": 30}})
    with pytest.raises(ValueError):
        search.Filters.from_dict({"axes": {"shiny": [0, 1]}})


def test_human_corrections_boost_and_reindex(store):
    col = store.ensure_collection("x", "manual")
    a = add(store, col, 1, fields=fields("grid layout study", ["grid"]))
    b = add(store, col, 2, fields=fields("grid layout study", ["grid"]))
    records.add_correction(store, b.asset["id"], field_path="keywords", op="add", value="swiss", actor="human:justin")
    rows = search.search(store, query="grid")
    assert rows[0]["id"] == b.asset["id"]
    assert [r["id"] for r in search.search(store, query="swiss")] == [b.asset["id"]]
    records.add_comment(store, a.membership["id"], text="lovely risograph grain", actor="human:justin")
    assert [r["id"] for r in search.search(store, query="riso")] == [a.asset["id"]]


def test_limit_is_clamped(store):
    col = store.ensure_collection("x", "manual")
    for seed in range(25):
        add(store, col, seed, why="grid")
    assert len(search.search(store, query="grid", limit=500)) == 20
