from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from commons import actors, intake, records
from commons.db import CommonsDB
from commons.store import CommonsStore


@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def png(seed=1) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (16, 16, 3), dtype=np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def test_moodboard_import_is_idempotent_and_marks_ai_outputs(store, tmp_path, monkeypatch):
    out_root = tmp_path / "output"
    (out_root / "run1").mkdir(parents=True)
    (out_root / "chat-uploads").mkdir()
    (out_root / "run1" / "gen.png").write_bytes(png(1))
    (out_root / "chat-uploads" / "mine.png").write_bytes(png(2))
    mb_root = tmp_path / "moodboards"
    (mb_root / "_global").mkdir(parents=True)
    (mb_root / "_global" / "mb1.json").write_text(json.dumps({
        "id": "mb1", "name": "Warm editorial", "notes": "soft light", "createdAt": "2026-05-01T10:00:00Z",
        "images": [{"url": "/api/outputs/run1/gen.png", "weight": 1},
                   {"url": "/api/outputs/chat-uploads/mine.png", "weight": 1},
                   {"url": "blob:xyz", "weight": 1}],
    }))
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(mb_root))
    monkeypatch.setattr("services.output._resolve_output_root", lambda: out_root)

    first = intake.import_moodboards(store)
    second = intake.import_moodboards(store)
    assert first["added"] == 2 and second["added"] == 0
    assert [s["reason"] for s in first["skipped"]] == ["unsupported url"]
    (col,) = [c for c in store.list_collections() if c["kind"] == "moodboard"]
    assert col["name"] == "Warm editorial" and col["source_ref"] == "mb1"
    made = {}
    with store.db.read() as conn:
        for row in conn.execute("SELECT a.made_by, s.url FROM assets a JOIN memberships m ON m.asset = a.id "
                                "JOIN sightings s ON s.membership = m.id"):
            made[row["url"]] = row["made_by"]
    assert made["/api/outputs/run1/gen.png"] == "ai"
    assert made["/api/outputs/chat-uploads/mine.png"] == "unknown"
    with store.db.read() as conn:
        comments = conn.execute("SELECT actor, text, source_date FROM comments").fetchall()
    assert [(c["actor"], c["text"]) for c in comments] == [("import:moodboard", "soft light")]
    assert comments[0]["source_date"] == "2026-05-01T10:00:00Z"


@pytest.mark.asyncio
async def test_agent_add_requires_why_and_confines_paths(store, tmp_path):
    col = store.ensure_collection("x", "manual")
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    (allowed / "ok.png").write_bytes(png(3))
    secret = tmp_path / "settings.json"
    secret.write_text('{"apiKeys": {}}')
    (allowed / "sneaky.png").symlink_to(secret)
    agent = actors.Actor("agent:claude/claude-opus-5-5", "agent", allowed_dirs=(allowed.resolve(),))

    with pytest.raises(intake.IntakeError, match="why"):
        await intake.agent_add(store, actor=agent, source=str(allowed / "ok.png"), collection_id=col["id"], why=" ")
    res = await intake.agent_add(store, actor=agent, source=str(allowed / "ok.png"),
                                 collection_id=col["id"], why="strong grid")
    assert res.membership["in_inbox"] == 1 and res.membership["actor"] == agent.id
    with pytest.raises(intake.PathNotAllowed):
        await intake.agent_add(store, actor=agent, source=str(secret), collection_id=col["id"], why="x")
    with pytest.raises(intake.PathNotAllowed):
        await intake.agent_add(store, actor=agent, source=str(allowed / "sneaky.png"),
                               collection_id=col["id"], why="x")
    mcp = actors.Actor("agent:mcp:cursor", "agent", self_reported=True)
    with pytest.raises(intake.PathNotAllowed):
        await intake.agent_add(store, actor=mcp, source=str(allowed / "ok.png"), collection_id=col["id"], why="x")


def test_agent_adds_past_daily_cap_are_held(store):
    store.set_setting("agent_add_daily_cap", 1)
    col = store.ensure_collection("x", "manual")
    agent = actors.Actor("agent:mcp:cursor", "agent", self_reported=True)
    first = intake.agent_add_bytes(store, actor=agent, data=png(10), filename="a.png",
                                   collection_id=col["id"], why="w")
    second = intake.agent_add_bytes(store, actor=agent, data=png(11), filename="b.png",
                                    collection_id=col["id"], why="w")
    assert first.asset["analysis_state"] == "queued"
    assert second.asset["analysis_state"] == "held"


def test_moodboard_reimport_adds_no_sightings_and_refetches_nothing(store, tmp_path, monkeypatch):
    from commons import net

    mb_root = tmp_path / "moodboards"
    (mb_root / "_global").mkdir(parents=True)
    (mb_root / "_global" / "mb2.json").write_text(json.dumps({
        "id": "mb2", "name": "Remote", "createdAt": "2026-05-02T10:00:00Z",
        "images": [{"url": "https://img.example/a.png", "weight": 1}]}))
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(mb_root))
    calls = []

    async def fake_fetch(url, **kw):
        calls.append(url)
        return net.Fetched(url, url, "image/png", png(20), 200)

    intake.import_moodboards(store, fetch=fake_fetch)
    intake.import_moodboards(store, fetch=fake_fetch)
    with store.db.read() as conn:
        assert conn.execute("SELECT count(*) FROM sightings").fetchone()[0] == 1
    assert calls == ["https://img.example/a.png"]


@pytest.mark.asyncio
async def test_agent_url_add_past_cap_is_created_held(store):
    from commons import net

    store.set_setting("agent_add_daily_cap", 0)
    col = store.ensure_collection("x", "manual")
    agent = actors.Actor("agent:claude/claude-opus-5-5", "agent")

    async def fake_fetch(url, **kw):
        return net.Fetched(url, url, "image/png", png(21), 200)

    res = await intake.agent_add(store, actor=agent, source="https://img.example/b.png",
                                 collection_id=col["id"], why="type contrast", fetch=fake_fetch)
    assert res.created_asset and res.asset["analysis_state"] == "held"
    assert res.membership["in_inbox"] == 1
    with store.db.read() as conn:
        added = conn.execute("SELECT payload FROM commons_events WHERE kind = 'asset_added'").fetchall()
    assert len(added) == 1


def test_agent_add_rejects_humans_and_system_collections(store):
    col = store.ensure_collection("x", "manual")
    sys_col = store.ensure_collection("sys", "system")
    agent = actors.Actor("agent:cli", "agent")
    with pytest.raises(intake.IntakeError, match="humans"):
        intake.agent_add_bytes(store, actor=actors.Actor(actors.HUMAN, "human"), data=png(22),
                               filename="a.png", collection_id=col["id"], why="w")
    with pytest.raises(intake.IntakeError, match="collection"):
        intake.agent_add_bytes(store, actor=agent, data=png(22), filename="a.png",
                               collection_id=sys_col["id"], why="w")
