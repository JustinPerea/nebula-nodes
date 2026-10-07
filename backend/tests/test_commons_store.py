from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from commons import intake
from commons.db import CommonsDB
from commons.store import CommonsStore


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def png_bytes(color=(200, 40, 40), size=(64, 48)) -> bytes:
    img = Image.new("RGB", size, (240, 240, 240))
    ImageDraw.Draw(img).rectangle([10, 10, 30, 30], fill=color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def test_same_bytes_in_two_collections_is_one_asset_two_memberships(store):
    a = store.ensure_collection("ui-inspo", "manual")
    b = store.ensure_collection("brand-x", "manual", brand="mitamaton")
    data = png_bytes()
    r1 = intake.add_bytes(store, data, filename="a.png", collection_id=a["id"], actor="human:justin",
                          source={"kind": "file", "original_name": "a.png"}, role="attract", why="nice grid")
    r2 = intake.add_bytes(store, data, filename="copy.png", collection_id=b["id"], actor="human:justin",
                          source={"kind": "file", "original_name": "copy.png"}, role="avoid", why="too loud")
    assert r1.asset["id"] == r2.asset["id"]
    assert r1.created_asset and not r2.created_asset
    assert r1.membership["id"] != r2.membership["id"]
    assert r1.membership["role"] == "attract" and r2.membership["role"] == "avoid"
    assert r1.membership["why"] == "nice grid" and r2.membership["why"] == "too loud"
    asset = store.get_asset(r1.asset["id"])
    assert asset["id"].startswith("ast_")
    assert asset["blob_key"].endswith(".png") and "/" not in asset["blob_key"]
    assert store.blob_path(asset["blob_key"]).read_bytes() == data
    assert asset["measurements"]["palette"]
    assert len(asset["phash"]) == 16
    assert asset["analysis_state"] == "queued"


def test_adding_same_bytes_to_same_collection_is_idempotent(store):
    c = store.ensure_collection("x", "manual")
    data = png_bytes()
    first = intake.add_bytes(store, data, filename="a.png", collection_id=c["id"], actor="human:justin",
                             source={"kind": "file"})
    again = intake.add_bytes(store, data, filename="a.png", collection_id=c["id"], actor="human:justin",
                             source={"kind": "file"})
    assert again.membership["id"] == first.membership["id"]
    assert not again.created_membership
    assert len(store.list_sightings(first.membership["id"])) == 2  # each sighting is recorded


def test_rejects_non_media_and_writes_nothing(store):
    c = store.ensure_collection("x", "manual")
    with pytest.raises(intake.IntakeError, match="unsupported"):
        intake.add_bytes(store, b'{"apiKeys":{}}', filename="settings.json", collection_id=c["id"],
                         actor="human:justin", source={"kind": "file"})
    with store.db.read() as conn:
        assert conn.execute("SELECT count(*) FROM assets").fetchone()[0] == 0


def test_blob_key_rejects_traversal(store):
    with pytest.raises(ValueError):
        store.blob_path("../../settings.json")


def test_every_write_emits_an_event(store):
    c = store.ensure_collection("x", "manual")
    intake.add_bytes(store, png_bytes(), filename="a.png", collection_id=c["id"], actor="human:justin",
                     source={"kind": "file"})
    with store.db.read() as conn:
        kinds = [r[0] for r in conn.execute("SELECT kind FROM commons_events ORDER BY created_at")]
    assert "collection_created" in kinds and "asset_added" in kinds and "membership_added" in kinds


def test_inbox_add_is_flagged(store):
    c = store.ensure_collection("x", "manual")
    r = intake.add_bytes(store, png_bytes(), filename="a.png", collection_id=c["id"],
                         actor="agent:mcp:cursor", source={"kind": "agent"}, why="found this", in_inbox=True)
    assert r.membership["in_inbox"] == 1


def test_delete_asset_purges_blob(store):
    c = store.ensure_collection("x", "manual")
    r = intake.add_bytes(store, png_bytes(), filename="a.png", collection_id=c["id"], actor="human:justin",
                         source={"kind": "file"})
    path = store.blob_path(r.asset["blob_key"])
    store.delete_asset(r.asset["id"], actor="human:justin")
    assert store.get_asset(r.asset["id"]) is None
    assert not path.exists()


def test_video_gets_keyframe_children(store, tmp_path):
    import shutil, subprocess
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    video = tmp_path / "v.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=2:r=10",
                    "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2:r=10",
                    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
                    "-pix_fmt", "yuv420p", str(video)], check=True, timeout=120)
    c = store.ensure_collection("x", "manual")
    r = intake.add_bytes(store, video.read_bytes(), filename="v.mp4", collection_id=c["id"],
                         actor="human:justin", source={"kind": "file"})
    assert r.asset["media"] == "video"
    assert r.asset["analysis_state"] == "ready"  # no model reading of motion (§5.1)
    m = r.asset["measurements"]
    assert m["duration"] == pytest.approx(4.0, abs=0.3) and "cuts_per_min" in m
    with store.db.read() as conn:
        kids = conn.execute("SELECT id, keyframe_t, analysis_state FROM assets WHERE parent_asset = ?",
                            (r.asset["id"],)).fetchall()
    assert len(kids) >= 2
    assert all(k["analysis_state"] == "queued" for k in kids)
    assert [k["asset_id"] for k in m["keyframes"]] == [k["id"] for k in sorted(kids, key=lambda k: k["keyframe_t"])]
