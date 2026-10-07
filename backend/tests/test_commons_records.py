from __future__ import annotations

import io

import pytest
from PIL import Image

from commons import effective, intake, records
from commons.db import CommonsDB
from commons.store import CommonsStore


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def _asset(store, color=(200, 40, 40)):
    # Seeded noise, so different colours give different phashes (a flat
    # colour field hashes the same as any other flat field).
    import numpy as np
    c = store.ensure_collection("x", "manual")
    rng = np.random.default_rng(list(color))  # sum(color) collided: (200,40,40) and (40,40,200) both 280
    pixels = rng.integers(0, 255, (30, 40, 3), dtype=np.uint8)
    pixels[:, :20] = color
    buf = io.BytesIO()
    Image.fromarray(pixels, "RGB").save(buf, "PNG")
    return intake.add_bytes(store, buf.getvalue(), filename="a.png", collection_id=c["id"],
                            actor="human:justin", source={"kind": "file"})


FIELDS = {
    "summary": {"value": "Red swatch", "why": "flat red"},
    "type_style": {"value": "none", "why": "no type"},
    "spacing_density": {"value": "airy", "why": "empty"},
    "layout": {"value": "centered", "why": "single block"},
    "medium": {"value": "illustration", "why": "flat colour"},
    "subject": {"value": "colour swatch", "why": "only colour"},
    "composition_notes": {"value": "one field", "why": "-"},
    "axes": {a: {"value": 0.0, "why": "-"} for a in
             ("quiet_loud", "warm_cold", "geometric_humanist", "dense_airy", "polished_raw")},
    "palette_roles": [{"index": 0, "role": "dominant"}],
    "keywords": ["minimal", "flat"],
}


def _ok(store, asset_id, **kw):
    args = dict(fields=FIELDS, raw_output="{}", fewshot_ids=[], prompt_version="reader-1",
                model_id="claude-opus-5-5", vocab_version="1", candidates=["redness"],
                proposed_regions=[{"box": [0.1, 0.1, 0.5, 0.5], "label": "block"}], duration_ms=10)
    args.update(kw)
    return records.write_analysis_ok(store, asset_id, **args)


def test_effective_merges_code_model_and_corrections_in_order(store):
    r = _asset(store)
    aid = r.asset["id"]
    _ok(store, aid)
    records.add_correction(store, aid, field_path="layout.value", op="set", value="grid",
                           actor="human:justin", reason="it's a grid really")
    records.add_correction(store, aid, field_path="keywords", op="add", value="bold", actor="human:justin")
    records.add_correction(store, aid, field_path="keywords", op="remove", value="flat", actor="human:justin")
    eff = effective.effective(store, aid)
    assert eff["fields"]["layout"]["value"] == "grid"
    assert eff["fields"]["keywords"] == ["minimal", "bold"]
    assert eff["fields"]["palette"] == r.asset["measurements"]["palette"]
    assert eff["sources"]["layout.value"] == "corrected"
    assert eff["sources"]["palette"] == "code"
    assert eff["sources"]["summary.value"] == "model:claude-opus-5-5"
    assert "layout.value" in eff["corrected_paths"]


def test_reanalysis_keeps_corrections_and_never_renumbers_regions(store):
    aid = _asset(store).asset["id"]
    _ok(store, aid)
    first = records.list_regions(store, aid)
    records.add_correction(store, aid, field_path="layout.value", op="set", value="grid", actor="human:justin")
    _ok(store, aid, proposed_regions=[{"box": [0.1, 0.1, 0.5, 0.5], "label": "block"},
                                      {"box": [0.6, 0.6, 0.2, 0.2], "label": "dot"}])
    second = records.list_regions(store, aid)
    assert [r["id"] for r in second][: len(first)] == [r["id"] for r in first]
    assert len(second) == 2  # the duplicate box was not re-added
    assert effective.effective(store, aid)["fields"]["layout"]["value"] == "grid"


def test_failed_analysis_retries_then_fails(store):
    aid = _asset(store).asset["id"]
    kw = dict(raw_output="not json", prompt_version="reader-1", model_id="m", vocab_version="1", fewshot_ids=[])
    for attempt in range(1, 4):
        claimed = records.claim_next(store, now_iso="9999-01-01T00:00:00.000000Z")
        assert claimed["id"] == aid and claimed["attempts"] == attempt
        records.write_analysis_failed(store, aid, error="schema", **kw)
    assert store.get_asset(aid)["analysis_state"] == "analysis_failed"
    assert records.claim_next(store, now_iso="9999-01-01T00:00:00.000000Z") is None
    with store.db.read() as conn:
        raws = [r[0] for r in conn.execute("SELECT raw_output FROM analyses WHERE asset = ?", (aid,))]
    assert raws == ["not json"] * 3  # raw kept for scoring (§6.1 step 4)


def test_claim_respects_backoff(store):
    from datetime import datetime, timedelta, timezone
    aid = _asset(store).asset["id"]
    now = datetime.now(timezone.utc)
    assert records.claim_next(store, now_iso=records._iso(now))["id"] == aid
    records.write_analysis_failed(store, aid, error="x", raw_output=None, prompt_version="p",
                                  model_id="m", vocab_version="1", fewshot_ids=[])
    assert records.claim_next(store, now_iso=records._iso(now + timedelta(seconds=5))) is None
    assert records.claim_next(store, now_iso=records._iso(now + timedelta(seconds=120)))["id"] == aid


def test_fewshots_are_human_only_and_skip_quarantined_clusters(store):
    a = _asset(store, (200, 40, 40)).asset
    b = _asset(store, (40, 40, 200)).asset
    records.add_correction(store, a["id"], field_path="layout.value", op="set", value="grid", actor="human:justin")
    records.add_correction(store, b["id"], field_path="layout.value", op="set", value="modular", actor="human:justin")
    records.add_correction(store, b["id"], field_path="medium.value", op="set", value="ui", actor="agent:claude/x")
    assert {f["asset"] for f in records.pick_fewshots(store)} == {a["id"], b["id"]}
    records.quarantine_add(store, [(b["phash"], "drop/x.png")])
    shots = records.pick_fewshots(store)
    assert {f["asset"] for f in shots} == {a["id"]}
    assert all(f["actor"].startswith("human:") for f in shots)
    assert records.is_quarantined(store, b["id"])


def test_meter_counts_against_daily_cap(store):
    store.set_setting("daily_cap", 2)
    assert records.meter_today(store)["remaining"] == 2
    records.meter_increment(store)
    records.meter_increment(store)
    today = records.meter_today(store)
    assert today["calls"] == 2 and today["remaining"] == 0 and today["resets_at"].endswith("Z")


def test_comments_are_scoped_to_membership(store):
    c1 = store.ensure_collection("one", "manual")
    c2 = store.ensure_collection("two", "manual")
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(buf, "PNG")
    m1 = intake.add_bytes(store, buf.getvalue(), filename="a.png", collection_id=c1["id"],
                          actor="human:justin", source={"kind": "file"}).membership
    m2 = intake.add_bytes(store, buf.getvalue(), filename="a.png", collection_id=c2["id"],
                          actor="human:justin", source={"kind": "file"}).membership
    records.add_comment(store, m1["id"], text="love the grid", actor="human:justin")
    assert [c["text"] for c in records.list_comments(store, m1["id"])] == ["love the grid"]
    assert records.list_comments(store, m2["id"]) == []


def test_region_box_validation():
    assert records.validate_box([0, 0, 1, 1]) == [0.0, 0.0, 1.0, 1.0]
    for bad in ([0, 0, 1.2, 1], [-0.1, 0, 0.5, 0.5], [0.8, 0.8, 0.5, 0.5], [0, 0, 0, 0.5], [1, 2, 3]):
        with pytest.raises(ValueError):
            records.validate_box(bad)
