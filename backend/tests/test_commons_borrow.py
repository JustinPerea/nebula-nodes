from __future__ import annotations

import io
import json

import numpy as np
import pytest
from PIL import Image, ImageDraw

from commons import borrow, intake, records, search
from commons.db import CommonsDB
from commons.store import CommonsStore


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def poster(color=(230, 30, 40), seed=1) -> bytes:
    rng = np.random.default_rng(seed)
    img = Image.fromarray(rng.integers(200, 255, (120, 160, 3), dtype=np.uint8), "RGB")
    ImageDraw.Draw(img).rectangle([40, 30, 120, 90], fill=color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


FIELDS = {"layout": {"value": "grid", "why": "-"}, "summary": {"value": "red block", "why": "-"},
          "axes": {"quiet_loud": {"value": 0.4, "why": "-"}}, "keywords": ["bold"]}


def analyzed(store, collection, **kw):
    res = intake.add_bytes(store, poster(**kw), filename="p.png", collection_id=collection["id"],
                           actor="human:justin", source={"kind": "file"})
    records.write_analysis_ok(store, res.asset["id"], fields=FIELDS, raw_output="{}", fewshot_ids=[],
                              prompt_version="reader-1", model_id="claude-opus-5-5", vocab_version="1",
                              candidates=[], proposed_regions=[], duration_ms=1)
    return res


def test_integrity_checks(store):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    scope = search.scope_collection_ids(store, None)
    red = next(p["hex"] for p in res.asset["measurements"]["palette"] if p["share"] > 0.2 and p["hex"] != "#ffffff")
    ok = borrow.record_borrow(store, actor_id="agent:claude/claude-opus-5-5", asset_id=res.asset["id"],
                              attribute="palette", value=red, region_id=None,
                              used_in={"kind": "external", "ref": "figma frame 3"}, why="brand red", scope_ids=scope)
    assert ok["value"]["matched_index"] is not None and ok["integrity"]["ok"]
    borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="layout", value="grid",
                         region_id=None, used_in={"kind": "external", "ref": "x"}, why="w", scope_ids=scope)
    for attribute, value, reason in [
        ("layout", "freeform", "does not match"),
        ("palette", "#00ff00", "not in the palette"),
        ("axes.quiet_loud", 0.9, "outside"),
        ("type_style", "serif", "not in the analysis"),
        ("shininess", "x", "unknown attribute"),
    ]:
        with pytest.raises(borrow.BorrowRejected, match=reason):
            borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute=attribute, value=value,
                                 region_id=None, used_in={"kind": "external", "ref": "x"}, why="w", scope_ids=scope)
    with store.db.read() as conn:
        assert conn.execute("SELECT count(*) FROM commons_events WHERE kind = 'borrow_rejected'").fetchone()[0] == 5


def test_brand_scope_and_avoid_block_borrowing(store):
    other = store.ensure_collection("o", "manual", brand="acme")
    res = analyzed(store, other)
    with pytest.raises(borrow.BorrowRejected, match="scope"):
        borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="layout", value="grid",
                             region_id=None, used_in={"kind": "external", "ref": "x"}, why="w",
                             scope_ids=search.scope_collection_ids(store, "mitamaton"))
    avoid_col = store.ensure_collection("av", "manual")
    res2 = intake.add_bytes(store, poster(seed=9), filename="a.png", collection_id=avoid_col["id"],
                            actor="human:justin", source={"kind": "file"}, role="avoid")
    with pytest.raises(borrow.BorrowRejected, match="avoid"):
        borrow.record_borrow(store, actor_id="a", asset_id=res2.asset["id"], attribute="palette",
                             value=res2.asset["measurements"]["palette"][0]["hex"], region_id=None,
                             used_in={"kind": "external", "ref": "x"}, why="w",
                             scope_ids=search.scope_collection_ids(store, None))


def test_stored_value_survives_later_corrections(store):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    b = borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="layout", value="grid",
                             region_id=None, used_in={"kind": "external", "ref": "x"}, why="w",
                             scope_ids=search.scope_collection_ids(store, None))
    records.add_correction(store, res.asset["id"], field_path="layout.value", op="set", value="modular",
                           actor="human:justin")
    with store.db.read() as conn:
        stored = json.loads(conn.execute("SELECT value FROM borrowings WHERE id = ?", (b["id"],)).fetchone()[0])
    assert stored == "grid"


def test_palette_fidelity_and_manifest(store, tmp_path, monkeypatch):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    out_root = tmp_path / "output"
    run = out_root / "run-1"
    run.mkdir(parents=True)
    Image.open(io.BytesIO(poster(seed=5))).save(run / "out.png")
    (run / "manifest.json").write_text(json.dumps({"run_id": "run-1", "started_at": "s", "completed_at": "c",
                                                   "outputs": []}))
    monkeypatch.setattr("services.output._resolve_output_root", lambda: out_root)
    red = res.asset["measurements"]["palette"]
    target = next(p["hex"] for p in red if p["share"] > 0.2 and p["hex"] != "#ffffff")
    b = borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="palette", value=target,
                             region_id=None, used_in={"kind": "nebula_output", "ref": "/api/outputs/run-1/out.png"},
                             why="w", scope_ids=search.scope_collection_ids(store, None))
    manifest = json.loads((run / "manifest.json").read_text())
    assert manifest["commons_borrowings"][0]["borrowing"] == b["id"]
    assert borrow.run_fidelity(store, b["id"])["status"] == "pass"


def test_enum_fidelity_waits_for_the_reader(store, tmp_path, monkeypatch):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    out_root = tmp_path / "output"
    (out_root / "r").mkdir(parents=True)
    Image.open(io.BytesIO(poster(seed=6))).save(out_root / "r" / "o.png")
    monkeypatch.setattr("services.output._resolve_output_root", lambda: out_root)
    b = borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="layout", value="grid",
                             region_id=None, used_in={"kind": "nebula_output", "ref": "/api/outputs/r/o.png"},
                             why="w", scope_ids=search.scope_collection_ids(store, None))
    fid = borrow.run_fidelity(store, b["id"])
    assert fid["status"] == "pending"
    with store.db.read() as conn:
        out_asset = conn.execute("SELECT fidelity_asset FROM borrowings WHERE id = ?", (b["id"],)).fetchone()[0]
    records.write_analysis_ok(store, out_asset, fields={"layout": {"value": "grid", "why": "-"}}, raw_output="{}",
                              fewshot_ids=[], prompt_version="reader-1", model_id="claude-opus-5-5",
                              vocab_version="1", candidates=[], proposed_regions=[], duration_ms=1)
    with store.db.read() as conn:
        fidelity = json.loads(conn.execute("SELECT fidelity FROM borrowings WHERE id = ?", (b["id"],)).fetchone()[0])
    assert fidelity["status"] == "pass"
    assert out_asset not in {r["id"] for r in search.search(store, all_scopes=True)}  # _outputs is hidden


def test_concentration_flags_over_25_percent(store):
    col = store.ensure_collection("x", "manual")
    a = analyzed(store, col, seed=1)
    b = analyzed(store, col, seed=2)
    scope = search.scope_collection_ids(store, None)
    for _ in range(3):
        borrow.record_borrow(store, actor_id="x", asset_id=a.asset["id"], attribute="layout", value="grid",
                             region_id=None, used_in={"kind": "external", "ref": "r"}, why="w", scope_ids=scope)
    borrow.record_borrow(store, actor_id="x", asset_id=b.asset["id"], attribute="layout", value="grid",
                         region_id=None, used_in={"kind": "external", "ref": "r"}, why="w", scope_ids=scope)
    conc = borrow.concentration(store)
    assert conc["total"] == 4 and conc["by_asset"][a.asset["id"]] == 0.75
    assert a.asset["id"] in conc["flagged"] and b.asset["id"] not in conc["flagged"]


def test_malformed_values_are_rejects_not_crashes(store):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    scope = search.scope_collection_ids(store, None)
    for attribute, value in [("palette", "not-a-colour"), ("axes.quiet_loud", "loud"), ("axes.quiet_loud", None),
                             ("axes.quiet_loud", float("nan"))]:
        with pytest.raises(borrow.BorrowRejected):
            borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute=attribute, value=value,
                                 region_id=None, used_in={"kind": "external", "ref": "x"}, why="w", scope_ids=scope)
    with store.db.read() as conn:
        assert conn.execute("SELECT count(*) FROM commons_events WHERE kind = 'borrow_rejected'").fetchone()[0] == 4
        assert conn.execute("SELECT count(*) FROM borrowings").fetchone()[0] == 0


def test_used_in_is_normalised(store):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    b = borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="layout", value="grid",
                             region_id=None, used_in={"kind": "external", "ref": "frame", "actor": "human:justin"},
                             why="w", scope_ids=search.scope_collection_ids(store, None))
    assert b["used_in"] == {"kind": "external", "ref": "frame"}


def test_fidelity_on_an_unreadable_output_is_unverifiable(store, tmp_path, monkeypatch):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    out_root = tmp_path / "output"
    (out_root / "r").mkdir(parents=True)
    (out_root / "r" / "notes.txt").write_text("not an image")
    monkeypatch.setattr("services.output._resolve_output_root", lambda: out_root)
    scope = search.scope_collection_ids(store, None)
    target = res.asset["measurements"]["palette"][0]["hex"]
    for attribute, value in [("palette", target), ("layout", "grid")]:
        b = borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute=attribute, value=value,
                                 region_id=None, used_in={"kind": "nebula_output", "ref": "/api/outputs/r/notes.txt"},
                                 why="w", scope_ids=scope)
        assert borrow.run_fidelity(store, b["id"])["status"] == "unverifiable"


def _fail_until_terminal(store, asset_id):
    for _ in range(3):
        with store.db.tx() as conn:
            conn.execute("UPDATE assets SET attempts = attempts + 1, analysis_state = 'analyzing' WHERE id = ?",
                         (asset_id,))
        records.write_analysis_failed(store, asset_id, error="bad output", raw_output=None,
                                      prompt_version="reader-1", model_id="claude-opus-5-5", vocab_version="1",
                                      fewshot_ids=[])


def _fidelity(store, bid):
    with store.db.read() as conn:
        return json.loads(conn.execute("SELECT fidelity FROM borrowings WHERE id = ?", (bid,)).fetchone()[0])


def test_failed_output_analysis_ends_pending_fidelity_and_a_later_success_resolves_it(store, tmp_path,
                                                                                      monkeypatch):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    out_root = tmp_path / "output"
    (out_root / "r").mkdir(parents=True)
    Image.open(io.BytesIO(poster(seed=7))).save(out_root / "r" / "o.png")
    monkeypatch.setattr("services.output._resolve_output_root", lambda: out_root)
    b = borrow.record_borrow(store, actor_id="a", asset_id=res.asset["id"], attribute="layout", value="grid",
                             region_id=None, used_in={"kind": "nebula_output", "ref": "/api/outputs/r/o.png"},
                             why="w", scope_ids=search.scope_collection_ids(store, None))
    assert borrow.run_fidelity(store, b["id"])["status"] == "pending"
    with store.db.read() as conn:
        out_asset = conn.execute("SELECT fidelity_asset FROM borrowings WHERE id = ?", (b["id"],)).fetchone()[0]
    _fail_until_terminal(store, out_asset)
    assert store.get_asset(out_asset)["analysis_state"] == "analysis_failed"
    fid = _fidelity(store, b["id"])
    assert fid["status"] == "unverifiable" and "reader" in fid["reason"]
    # Re-running fidelity on an output whose analysis already failed doesn't park it as pending again.
    assert borrow.run_fidelity(store, b["id"])["status"] == "unverifiable"
    # A later successful re-analysis (Justin presses Reanalyze) still resolves it.
    records.write_analysis_ok(store, out_asset, fields={"layout": {"value": "grid", "why": "-"}}, raw_output="{}",
                              fewshot_ids=[], prompt_version="reader-1", model_id="claude-opus-5-5",
                              vocab_version="1", candidates=[], proposed_regions=[], duration_ms=1)
    assert _fidelity(store, b["id"])["status"] == "pass"


def test_agents_cannot_borrow_from_quarantined_assets(store):
    col = store.ensure_collection("x", "manual")
    res = analyzed(store, col)
    records.quarantine_add(store, [(res.asset["phash"], "eval/a.png")])
    kwargs = dict(asset_id=res.asset["id"], attribute="layout", value="grid", region_id=None,
                  used_in={"kind": "external", "ref": "x"}, why="w",
                  scope_ids=search.scope_collection_ids(store, None))
    with pytest.raises(borrow.BorrowRejected, match="scope"):
        borrow.record_borrow(store, actor_id="agent:mcp:cursor", hide_quarantined=True, **kwargs)
    with store.db.read() as conn:
        assert conn.execute("SELECT count(*) FROM commons_events WHERE kind = 'borrow_rejected'").fetchone()[0] == 1
