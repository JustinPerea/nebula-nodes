from __future__ import annotations

import io
import json

import numpy as np
import pytest
from PIL import Image

from commons import intake, reader, records
from commons.db import CommonsDB
from commons.effective import effective
from commons.store import CommonsStore
from commons.vocab import load_vocabulary
from commons.worker import AnalysisWorker

@pytest.fixture()
def store(tmp_path):
    return CommonsStore(CommonsDB(tmp_path / "c.db"), tmp_path / "blobs")


def add(store, seed=1):
    col = store.ensure_collection("x", "manual")
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(seed).integers(0, 255, (40, 40, 3), dtype=np.uint8)).save(buf, "PNG")
    return intake.add_bytes(store, buf.getvalue(), filename="a.png", collection_id=col["id"], actor="human:justin",
                            source={"kind": "file"})


def good_output(palette_len: int) -> dict:
    field = lambda v: {"value": v, "why": "visible evidence"}
    return {
        "summary": field("Noisy colour field"),
        "palette_roles": [{"index": 0, "role": "dominant"}],
        "type_style": field("none"), "spacing_density": field("tight"), "layout": field("freeform"),
        "composition_notes": field("uniform noise"), "medium": field("illustration"), "subject": field("noise"),
        "axes": {a: field(0.1) for a in ("quiet_loud", "warm_cold", "geometric_humanist", "dense_airy", "polished_raw")},
        "keywords": ["grain", "dense"], "candidate_keywords": ["static"],
        "regions": [{"box": [0.0, 0.0, 0.5, 0.5], "label": "corner"}],
    }


def fake_reader(output=None, error=None):
    calls = []

    async def run(png, palette, fewshots, *, vocab, **kw):
        calls.append({"palette": palette, "fewshots": fewshots})
        data = output if output is not None else good_output(len(palette))
        return reader.ReaderResult(structured=None if error else data, raw=json.dumps(data), model="claude-opus-5-5",
                                   duration_ms=5, event_types=["system", "assistant", "result"], error=error)

    run.calls = calls
    return run


@pytest.mark.asyncio
async def test_analyzes_one_item_and_records_versions(store):
    aid = add(store).asset["id"]
    w = AnalysisWorker(store, reader=fake_reader(), load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "analyzed"
    eff = effective(store, aid)
    assert eff["fields"]["layout"]["value"] == "freeform"
    assert eff["analysis"]["prompt_version"] == reader.PROMPT_VERSION
    assert eff["analysis"]["model_id"] == "claude-opus-5-5"
    assert records.meter_today(store)["calls"] == 1 and w.budget_used == 1
    assert await w.run_once() == "idle"


@pytest.mark.asyncio
async def test_invalid_output_is_rejected_whole_and_raw_kept(store):
    aid = add(store).asset["id"]
    bad = good_output(1)
    bad["palette_roles"] = [{"index": 42, "role": "accent"}]
    w = AnalysisWorker(store, reader=fake_reader(output=bad), load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "failed"
    assert records.latest_analysis(store, aid) is None
    with store.db.read() as conn:
        row = conn.execute("SELECT raw_output, error FROM analyses WHERE asset = ?", (aid,)).fetchone()
    assert "42" in row["raw_output"] and "palette index" in row["error"]
    assert store.get_asset(aid)["analysis_state"] == "queued"  # retry with backoff


@pytest.mark.asyncio
async def test_pauses_on_load_cap_and_budget(store):
    add(store)
    assert await AnalysisWorker(store, reader=fake_reader(), load_avg=lambda: 999.0, budget=5).run_once() == "paused_load"
    store.set_setting("daily_cap", 0)
    assert await AnalysisWorker(store, reader=fake_reader(), load_avg=lambda: 1.0, budget=5).run_once() == "cap_reached"
    store.set_setting("daily_cap", 20)
    assert await AnalysisWorker(store, reader=fake_reader(), load_avg=lambda: 1.0, budget=0).run_once() == "budget_exhausted"


@pytest.mark.asyncio
async def test_fewshots_are_passed_and_recorded(store):
    first = add(store, 1).asset["id"]
    records.add_correction(store, first, field_path="layout.value", op="set", value="grid", actor="human:justin",
                           reason="the cells line up")
    second = add(store, 2).asset["id"]
    with store.db.tx() as conn:
        conn.execute("UPDATE assets SET analysis_state = 'ready' WHERE id = ?", (first,))
    run = fake_reader()
    w = AnalysisWorker(store, reader=run, load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "analyzed"
    assert run.calls[0]["fewshots"][0]["value"] == "grid"
    assert len(records.latest_analysis(store, second)["fewshot_ids"]) == 1


def test_validate_rules():
    vocab = load_vocabulary()
    fields, cands, regions = reader.validate(good_output(3), palette_len=3, vocab=vocab)
    assert fields["keywords"] == ["grain", "dense"] and cands == ["static"] and len(regions) == 1
    for mutate, message in [
        (lambda o: o["keywords"].append("sparkly_nonsense"), "vocabulary"),
        (lambda o: o["candidate_keywords"].extend(["a", "b", "c"]), "at most 3"),
        (lambda o: o["axes"]["quiet_loud"].update(value=1.5), "axis"),
        (lambda o: o["layout"].update(value="diagonal"), "layout"),
        (lambda o: o["regions"].append({"box": [0.9, 0.9, 0.5, 0.5], "label": "x"}), "box"),
        (lambda o: o.pop("summary"), "summary"),
    ]:
        out = good_output(3)
        mutate(out)
        with pytest.raises(reader.AnalysisInvalid, match=message):
            reader.validate(out, palette_len=3, vocab=vocab)
    synonym = good_output(3)
    synonym["keywords"] = ["minimalist"]
    assert reader.validate(synonym, palette_len=3, vocab=vocab)[0]["keywords"] == ["minimal"]


def test_command_is_sealed():
    cmd = reader.build_command("sys", {"type": "object"})
    for flag in ("--restricted", "--no-session-persistence", "--strict-mcp-config"):
        assert flag in cmd
    assert cmd[cmd.index("--tools") + 1] == ""
    assert cmd[cmd.index("--model") + 1] == "claude-opus-5-5"
    assert json.loads(cmd[cmd.index("--settings") + 1]) == {"autoMemoryEnabled": False}
    env = reader.child_env()
    assert env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"
    assert not any(k.startswith("ANTHROPIC_DEFAULT_") for k in env) and "NEBULA_AGENT_TOKEN" not in env


def test_message_never_asks_for_hex_and_lists_palette_indices():
    msg = reader.build_message(b"\x89PNG....", [{"index": 0, "hex": "#112233", "share": 0.5, "is_accent": False}], [])
    content = msg["message"]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/png"
    assert "P0 #112233" in content[1]["text"]
    schema = reader.analysis_schema(load_vocabulary(), 1)
    assert "hex" not in json.dumps(schema)


@pytest.mark.asyncio
async def test_read_image_parses_stream_json():
    lines = [
        {"type": "system", "subtype": "init", "model": "claude-opus-5-5", "tools": ["StructuredOutput"]},
        {"type": "result", "subtype": "success", "is_error": False, "result": "{}", "structured_output": {"a": 1}},
    ]

    class Proc:
        returncode = 0

        async def communicate(self, data):
            self.sent = data
            return ("\n".join(json.dumps(l) for l in lines).encode(), b"")

    proc = Proc()

    async def spawn(*args, **kwargs):
        spawn.kwargs = kwargs
        return proc

    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=spawn)
    assert res.structured == {"a": 1} and res.model == "claude-opus-5-5" and res.error is None
    assert spawn.kwargs["cwd"] and "hook_started" not in res.event_types


@pytest.mark.asyncio
async def test_read_image_refuses_unexpected_tools():
    lines = [{"type": "system", "subtype": "init", "model": "m", "tools": ["Read", "StructuredOutput"]},
             {"type": "result", "is_error": False, "structured_output": {}}]

    class Proc:
        returncode = 0

        async def communicate(self, data):
            return ("\n".join(json.dumps(l) for l in lines).encode(), b"")

    async def spawn(*a, **k):
        return Proc()

    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), spawn=spawn)
    assert res.error and "tools" in res.error


def test_validate_rejects_wrong_shapes_as_invalid():
    vocab = load_vocabulary()
    for mutate in (lambda o: o.update(axes=[1, 2]), lambda o: o.update(keywords="grain"),
                   lambda o: o["palette_roles"].append("P0"), lambda o: o["axes"]["warm_cold"].update(value=True),
                   lambda o: o["palette_roles"][0].update(index=True)):
        out = good_output(3)
        mutate(out)
        with pytest.raises(reader.AnalysisInvalid):
            reader.validate(out, palette_len=3, vocab=vocab)


@pytest.mark.asyncio
async def test_reader_crash_fails_the_item_instead_of_leaving_it_analyzing(store):
    aid = add(store).asset["id"]

    async def boom(*a, **k):
        raise RuntimeError("pipe closed")

    w = AnalysisWorker(store, reader=boom, load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "failed"
    assert store.get_asset(aid)["analysis_state"] == "queued" and w.budget_used == 1


@pytest.mark.asyncio
async def test_read_image_kills_the_child_on_timeout():
    import asyncio

    class Proc:
        returncode = None
        killed = False

        async def communicate(self, data):
            await asyncio.sleep(10)

        def kill(self):
            self.killed = True

    proc = Proc()

    async def spawn(*a, **k):
        return proc

    res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), timeout=0.05, spawn=spawn)
    assert res.error == "reader timed out" and proc.killed
