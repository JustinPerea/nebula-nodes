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
async def test_the_analysis_records_the_assets_measurement_version(store):
    from commons.measure import CODE_VERSION

    new = add(store, seed=2).asset["id"]
    old = add(store, seed=3).asset["id"]
    with store.db.tx() as conn:  # measured before alpha counted
        conn.execute("UPDATE assets SET code_version = 'measure-1' WHERE id = ?", (old,))
    w = AnalysisWorker(store, reader=fake_reader(), load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "analyzed" and await w.run_once() == "analyzed"
    assert effective(store, new)["analysis"]["code_version"] == CODE_VERSION == "measure-2"
    assert effective(store, old)["analysis"]["code_version"] == "measure-1"


def _add_image(store, image: Image.Image, name: str):
    col = store.ensure_collection("x", "manual")
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue(), intake.add_bytes(store, buf.getvalue(), filename=name, collection_id=col["id"],
                                           actor="human:justin", source={"kind": "file"})


@pytest.mark.asyncio
async def test_the_reader_sees_a_transparent_reference_over_the_commons_tile(store):
    from commons import media
    from commons.worker import COMMONS_READER_SURFACE

    pixels = np.zeros((40, 40, 4), np.uint8)
    pixels[:, :20] = (232, 89, 60, 255)  # the left half orange, the rest clear over hidden black
    _, added = _add_image(store, Image.fromarray(pixels, "RGBA"), "mark.png")
    seen = []

    async def run(png, palette, fewshots, *, vocab, **kw):
        seen.append(png)
        data = good_output(len(palette))
        return reader.ReaderResult(structured=data, raw=json.dumps(data), model="claude-opus-5-5", duration_ms=5,
                                   event_types=["result"], error=None)

    w = AnalysisWorker(store, reader=run, load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "analyzed"
    sent = np.asarray(Image.open(io.BytesIO(seen[0])))
    assert sent.shape == (40, 40, 3)
    assert tuple(sent[0, 30]) == COMMONS_READER_SURFACE == (10, 10, 10)
    assert tuple(sent[0, 5]) == (232, 89, 60)
    assert media.load_image(seen[0], "image/png").mode == "RGB"


@pytest.mark.asyncio
async def test_an_opaque_reference_is_sent_byte_for_byte_as_before(store):
    from commons import media

    data, _ = _add_image(store, Image.fromarray(
        np.random.default_rng(9).integers(0, 255, (30, 50, 3), dtype=np.uint8)).convert("RGBA"), "opaque.png")
    reader_ = fake_reader()
    seen = []

    async def run(png, palette, fewshots, *, vocab, **kw):
        seen.append(png)
        return await reader_(png, palette, fewshots, vocab=vocab)

    w = AnalysisWorker(store, reader=run, load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "analyzed"
    # What the worker sent before alpha counted: the RGB decode, as PNG.
    assert seen == [media.encode_png(media.load_image(data, "image/png"), max_edge=1568)]


@pytest.mark.asyncio
async def test_a_fully_transparent_reference_is_never_sent(store):
    from commons.worker import CLEAR_ERROR

    _, added = _add_image(store, Image.new("RGBA", (24, 24), (0, 0, 0, 0)), "clear.png")
    reader_ = fake_reader()
    w = AnalysisWorker(store, reader=reader_, load_avg=lambda: 1.0, budget=5)
    assert await w.run_once() == "failed"
    assert reader_.calls == [] and w.budget_used == 0 and records.meter_today(store)["calls"] == 0
    asset = store.get_asset(added.asset["id"])
    assert asset["analysis_state"] == "analysis_failed" and asset["last_error"] == CLEAR_ERROR
    assert CLEAR_ERROR == "too transparent to add colors; not sent to the reader"
    assert await w.run_once() == "idle"  # no retry: it won't change


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


@pytest.mark.asyncio
@pytest.mark.skipif(__import__("os").name != "posix", reason="POSIX process groups")
async def test_read_image_timeout_kills_the_whole_claude_tree():
    # claude runs in its own session, so a leader-only kill would orphan its
    # children where no group kill aimed at the backend can reach them.
    import asyncio
    import os
    import sys
    import time

    from services.agent_process import spawn_agent_process

    fake = (
        "import subprocess, sys, time\n"
        "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "sys.stderr.write(str(c.pid) + '\\n'); sys.stderr.flush()\n"
        "time.sleep(60)\n"
    )
    started = {}

    async def spawn(*cmd, **kwargs):
        proc = await spawn_agent_process(sys.executable, "-c", fake, **kwargs)
        started["proc"] = proc
        return proc

    def alive(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        import subprocess
        stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(stat) and not stat.startswith("Z")

    child = None
    try:
        # Read the child's pid from the leader's stderr before the timeout.
        async def spawn_and_note(*cmd, **kwargs):
            proc = await spawn(*cmd, **kwargs)
            started["child"] = int((await proc.stderr.readline()).decode())
            return proc

        res = await reader.read_image(b"png", [], [], vocab=load_vocabulary(), timeout=0.5, spawn=spawn_and_note)
        child = started["child"]
        assert res.error == "reader timed out"
        assert started["proc"].returncode is not None
        deadline = time.monotonic() + 5
        while alive(child) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        assert not alive(child), "the reader's timeout left claude's child running"
    finally:
        for pid in (child, getattr(started.get("proc"), "pid", None)):
            if pid:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass


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
