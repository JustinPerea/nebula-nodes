"""The moodboard reader (services/moodboard_reader.py), against a mocked Google.

docs/moodboard-canvas-plan.md sections 5.6 and 5.6.1, PR4. No test calls a
paid API: every request goes to ``FakeGoogle``, an httpx mock transport that
answers like ``streamGenerateContent?alt=sse`` (or ``generateContent`` for a
reader that can't stream). Images are "encoded" as their own id, so the fake
knows which reference each batch label stands for.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
from datetime import date
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

from services import agent_spend, moodboard_reader as reader
from services.moodboard_reader import MoodboardRead, Target

ARGON = reader.reader_entry("gemini-4-argon")
TODAY = date(2026, 10, 20)


# -- a fake Google ---------------------------------------------------------------------------

class SlowStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], delays: list[float] | None = None) -> None:
        self.chunks = chunks
        self.delays = delays or [0.0] * len(chunks)

    async def __aiter__(self):
        for chunk, delay in zip(self.chunks, self.delays):
            if delay:
                await asyncio.sleep(delay)
            yield chunk

    async def aclose(self) -> None:
        return None


def chunk(parts: list[dict[str, Any]], *, finish: str | None = None, usage: dict | None = None) -> bytes:
    candidate: dict[str, Any] = {"content": {"role": "model", "parts": parts}, "index": 0}
    if finish:
        candidate["finishReason"] = finish
    payload: dict[str, Any] = {"candidates": [candidate]}
    if usage:
        payload["usageMetadata"] = usage
    return b"data: " + json.dumps(payload).encode() + b"\r\n\r\n"


def sse(text: str, *, piece: int = 23, finish: str | None = "STOP", thoughts: list[str] = (),
        usage: dict | None = None) -> list[bytes]:
    chunks = [chunk([{"text": t, "thought": True}]) for t in thoughts]
    pieces = [text[i:i + piece] for i in range(0, len(text), piece)] or [""]
    for i, p in enumerate(pieces):
        last = i == len(pieces) - 1
        chunks.append(chunk([{"text": p}], finish=finish if last else None,
                            usage=(usage or {"promptTokenCount": 7000, "candidatesTokenCount": 600,
                                             "thoughtsTokenCount": 1500}) if last else None))
    return chunks


def whole_response(chunks: list[bytes]) -> dict:
    """What generateContent answers for the same stream: one response with
    every part, the finish reason and the usage."""
    parts, finish, usage = [], None, None
    for raw in chunks:
        payload = json.loads(raw.decode().removeprefix("data: "))
        candidate = payload["candidates"][0]
        parts.extend(candidate["content"]["parts"])
        finish = candidate.get("finishReason") or finish
        usage = payload.get("usageMetadata") or usage
    response: dict[str, Any] = {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": finish}]}
    if usage:
        response["usageMetadata"] = usage
    return response


def labels_of(body: dict) -> list[str]:
    schema = body["generationConfig"]["responseFormat"]["text"]["schema"]
    key = next(iter(schema["properties"]))
    return schema["properties"][key]["items"]["properties"]["ref"]["enum"]


def phase_of(body: dict) -> str:
    schema = body["generationConfig"]["responseFormat"]["text"]["schema"]
    return "read" if "readings" in schema["properties"] else "sort"


def images_of(body: dict) -> list[str]:
    """The image ids a phase-1 request carries, in label order."""
    return [base64.b64decode(part["inline_data"]["data"]).decode()
            for part in body["contents"][0]["parts"] if "inline_data" in part]


def texts_of(body: dict) -> str:
    return "\n".join(part.get("text", "") for part in body["contents"][0]["parts"])


def reading(label: str, look: str = "Dither", fit: float = 0.82, *, second: tuple[str, float] | None = None,
            reason: str | None = None) -> dict[str, Any]:
    looks = [{"name": look, "fit": fit}] + ([{"name": second[0], "fit": second[1]}] if second else [])
    return {"ref": label, "medium": "photograph", "style": "halftone print", "light": "flat overcast",
            "motifs": ["dots", "clouds"], "looks": looks, "reason": reason or f"{look.lower()} study"}


Plan = dict[str, dict[str, Any]]  # image id -> {look, fit, second, reason}


class FakeGoogle:
    """Answers each request from ``plan`` unless ``script`` (call number ->
    reply function) says otherwise. A reply is (status, chunks[, delays])."""

    def __init__(self, plan: Plan | None = None, *, script: dict[int, Callable[[dict], Any]] | None = None,
                 delay: float = 0.0) -> None:
        self.plan = plan or {}
        self.script = script or {}
        self.delay = delay
        self.bodies: list[dict] = []
        self.urls: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0

    def readings_for(self, body: dict) -> list[dict[str, Any]]:
        out = []
        for label, image_id in zip(labels_of(body), images_of(body)):
            spec = self.plan.get(image_id, {})
            out.append(reading(label, spec.get("look", "Dither"), spec.get("fit", 0.82), second=spec.get("second"),
                               reason=spec.get("reason")))
        return out

    def sort_for(self, body: dict) -> list[dict[str, Any]]:
        items = []
        for line in texts_of(body).splitlines():
            if line.startswith("{"):
                entry = json.loads(line)
                items.append({"ref": entry["ref"], "looks": entry["looks"][:2]})
        return items

    def default(self, body: dict):
        if phase_of(body) == "read":
            return 200, sse(json.dumps({"readings": self.readings_for(body)}))
        return 200, sse(json.dumps({"sort": self.sort_for(body)}))

    async def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        self.urls.append(str(request.url))
        call = len(self.bodies)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            reply = (self.script.get(call) or self.default)(body)
        finally:
            self.in_flight -= 1
        status, chunks, *rest = reply
        if status != 200:
            return httpx.Response(status, json={"error": {"code": status, "message": "overloaded"}})
        if ":generateContent" in str(request.url):
            return httpx.Response(200, json=whole_response(chunks))
        return httpx.Response(200, stream=SlowStream(chunks, rest[0] if rest else None),
                              headers={"content-type": "text/event-stream"})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


def board(count: int, *, frames: list[dict] | None = None, notes: str = "", send_notes: bool = False,
          image_notes: dict[int, str] | None = None, private: dict[int, str] | None = None) -> dict[str, Any]:
    images = []
    for n in range(1, count + 1):
        images.append({"id": f"img{n:02d}", "url": f"/fake/img{n:02d}.png", "weight": 1.0,
                       "notes": (image_notes or {}).get(n, ""), "privateNote": (private or {}).get(n, ""),
                       "excluded": False})
    return {"id": "board1", "name": "Board", "images": images, "frames": frames or [], "notes": notes,
            "sendNotes": send_notes}


def fake_encode(path: Path) -> tuple[str, str]:
    return "image/jpeg", base64.b64encode(path.stem.encode()).decode()


def targets_of(b: dict) -> list[Target]:
    return reader.select_targets(b, resolve=lambda url: Path(url))


def run_read(b: dict, google: FakeGoogle, *, entry: dict | None = None, **kwargs) -> dict[str, Any]:
    async def go():
        async with google.client() as client:
            read = MoodboardRead(b, entry or ARGON, api_keys={"GOOGLE_API_KEY": "g-test"}, client=client,
                                 targets=targets_of(b), encode=fake_encode, today=TODAY, **kwargs)
            return await read.run()
    return asyncio.run(go())


def kinds(result: dict) -> list[tuple[str, tuple[int, ...]]]:
    return [(line["kind"], tuple(ref["number"] for ref in line["refs"])) for line in result["trace"]]


def lines(result: dict, kind: str) -> list[dict]:
    return [line for line in result["trace"] if line["kind"] == kind]


# -- the model file ----------------------------------------------------------------------------

def test_the_model_file_is_valid():
    assert reader.validate_models(reader.load_models()) == []


def test_argon_has_both_dated_prices_its_identity_and_unconfirmed_summaries():
    assert [(row["from"], row["until"], row["inputPerMTok"], row["outputPerMTok"]) for row in ARGON["prices"]] == [
        (None, "2026-11-30", 2.0, 10.0), ("2026-12-01", None, 4.0, 20.0)]
    assert ARGON["thoughtSummaries"] == "unconfirmed" and ARGON["streams"] is True
    assert reader.reader_identity(ARGON) == {"kind": "reader", "id": "reader:gemini-4-argon", "name": "Gemini 4 Argon",
                                             "model": "gemini-4-argon", "provider": "google", "color": "#B49CFF"}
    assert set(ARGON["thinking"]) == {"low", "medium", "high"}


def test_the_reader_colour_is_not_an_agent_colour():
    from services.agent_presence import _EXTERNAL_COLORS, _KNOWN_AGENTS

    colours = {c.casefold() for c in _EXTERNAL_COLORS} | {c.casefold() for _, c in _KNOWN_AGENTS.values()}
    for entry in reader.load_models()["models"].values():
        assert entry["color"].casefold() not in colours
        assert entry["color"].casefold() != "#e8825a"


@pytest.mark.parametrize("change, problem", [
    ({"thoughtSummaries": "maybe"}, "thoughtSummaries"),
    ({"thoughtSummaries": 1}, "thoughtSummaries"),
    ({"streams": "yes"}, "streams"),
    ({"prices": [{"from": None, "until": "2026-11-30", "inputPerMTok": 2, "outputPerMTok": 10},
                 {"from": "2026-12-02", "until": None, "inputPerMTok": 4, "outputPerMTok": 20}]}, "day after"),
    ({"thinking": {"low": {"thinkingTokens": 2048}, "minimal": {"thinkingTokens": 10}}}, "doesn't take"),
    ({"thinking": {"low": {"thinkingTokens": 70000}, "medium": {"thinkingTokens": 1}, "high": {"thinkingTokens": 1}}},
     "over"),
    ({"checked": "yesterday"}, "checked"),
    ({"sources": []}, "sources"),
])
def test_the_validator_catches_a_bad_entry(change, problem):
    data = reader.load_models()
    data["models"]["gemini-4-argon"].update(change)
    assert any(problem in line for line in reader.validate_models(data))


# -- estimate --------------------------------------------------------------------------------

def test_estimate_maths_for_seven_images():
    b = board(7)
    est = reader.estimate(b, ARGON, targets=targets_of(b), today=TODAY)
    assert (est["count"], est["batches"], est["thinkingLevel"]) == (7, 2, "medium")
    thinking = ARGON["thinking"]["medium"]["thinkingTokens"]
    answer = ARGON["answerTokens"]
    cap6 = thinking + answer["base"] + answer["perImage"] * 6
    cap1 = thinking + answer["base"] + answer["perImage"] * 1
    assert [line["maxOutputTokens"] for line in est["perBatch"]] == [cap6, cap1]

    def tokens(parts_targets, n):
        chars = reader._request_chars(reader.phase1_parts(b, parts_targets, None), reader.phase1_schema("ABCDEF"[:n]))
        return -(-chars // 4), -(-chars // 3)

    targets = targets_of(b)
    t_low, t_high = tokens(targets[:6], 6)
    batch1_low = (6 * 1120 + t_low) * 2 / 1e6 + cap6 * 10 / 1e6
    assert est["perBatch"][0]["low"] == pytest.approx(batch1_low, abs=1e-6)
    # The high adds one retry, split in two halves (3 + 3): both prompts, both caps.
    half_caps = 2 * (thinking + answer["base"] + answer["perImage"] * 3)
    h1, h2 = tokens(targets[:3], 3)[1], tokens(targets[3:6], 3)[1]
    retry = (6 * 1120 + h1 + h2) * 2 / 1e6 + half_caps * 10 / 1e6
    batch1_high = (6 * 1120 + t_high) * 2 / 1e6 + cap6 * 10 / 1e6 + retry
    assert est["perBatch"][0]["high"] == pytest.approx(batch1_high, abs=1e-6)
    # Phase 2: the readings as text and its cap, plus a retry at twice the cap.
    sort = ARGON["sortTokens"]
    sort_cap = thinking + sort["base"] + sort["perImage"] * 7
    assert est["phase2"]["maxOutputTokens"] == sort_cap and est["phase2"]["retryMaxOutputTokens"] == 2 * sort_cap
    total_low = sum(line["low"] for line in est["perBatch"]) + est["phase2"]["low"]
    total_high = sum(line["high"] for line in est["perBatch"]) + est["phase2"]["high"]
    assert est["low"] == pytest.approx(total_low, abs=1e-5) and est["high"] == pytest.approx(total_high, abs=1e-5)
    assert sum(est["shares"].values()) == pytest.approx(est["high"], abs=1e-5)
    assert set(est["shares"]) == {"batch:1", "retry:1", "batch:2", "retry:2", "sort", "sort-retry"}
    assert est["unconfirmed"] is False and est["unpriced"] is False and est["sources"]
    assert est["low"] < est["high"]


def test_the_high_estimate_uses_the_next_day_s_price_on_the_last_day_of_a_row():
    b = board(6)
    targets = targets_of(b)
    before = reader.estimate(b, ARGON, targets=targets, today=date(2026, 11, 29))
    last_day = reader.estimate(b, ARGON, targets=targets, today=date(2026, 11, 30))
    after = reader.estimate(b, ARGON, targets=targets, today=date(2026, 12, 1))
    assert before["low"] == last_day["low"]
    assert last_day["high"] == pytest.approx(after["high"], rel=1e-9)  # December's rates
    assert after["low"] == pytest.approx(2 * before["low"], rel=1e-9)  # every rate doubles
    assert before["high"] < last_day["high"]


def test_an_entry_without_a_price_is_unpriced():
    entry = {**ARGON, "prices": None}
    b = board(3)
    est = reader.estimate(b, entry, targets=targets_of(b), today=TODAY)
    assert est["unpriced"] is True and est["low"] is None and est["high"] is None and est["shares"] == {}


def test_unreadable_images_are_not_counted():
    b = board(4)
    targets = reader.select_targets(b, resolve=lambda url: None if url.endswith("02.png") else Path(url))
    est = reader.estimate(b, ARGON, targets=targets, today=TODAY)
    assert est["count"] == 3 and est["targets"] == 4 and est["unreadable"] == [2]


def test_unknown_models_levels_and_images_are_refused():
    with pytest.raises(reader.ReaderError, match="gemini-4-argon"):
        reader.reader_entry("gpt-vision")
    b = board(2)
    with pytest.raises(reader.ReaderError, match="thinking level"):
        reader.estimate(b, ARGON, targets=targets_of(b), level="minimal")
    with pytest.raises(reader.ReaderError, match="No image nope"):
        reader.select_targets(b, ["nope"], resolve=lambda url: Path(url))


# -- the spend gate ----------------------------------------------------------------------------

def _decide(est: dict, settings: dict) -> agent_spend.Decision:
    from services.node_registry import NodeRegistry

    items, pricing = reader.spend_check(ARGON, est)
    return agent_spend.decide(items, [], settings=settings, pricing=pricing, definitions=NodeRegistry().get_all(),
                              how_to_ask="Ask.")


def test_the_one_off_price_goes_through_decide_as_one_gemini_chat_run():
    b = board(6)
    est = reader.estimate(b, ARGON, targets=targets_of(b), today=TODAY)
    passed = _decide(est, {"runCostConfirmUsd": 50.0})
    assert passed.refusal is None and passed.charge == {"gemini-chat": pytest.approx(est["high"])}
    refused = _decide(est, {"runCostConfirmUsd": est["high"] / 2})
    assert refused.refusal and "could cost up to" in refused.refusal
    # The chat model's own per-run limit replaces the general one (Q11).
    capped = _decide(est, {"runCostConfirmUsd": 50.0,
                           "agentSpend": {"models": {"gemini-chat": {"perRunUsd": est["high"] / 2}}}})
    assert capped.refusal and "per-run limit for" in capped.refusal


def test_an_unpriced_read_is_refused_under_any_usd_limit():
    b = board(2)
    est = reader.estimate(b, {**ARGON, "prices": None}, targets=targets_of(b), today=TODAY)
    refused = _decide(est, {"runCostConfirmUsd": 100.0})
    assert refused.refusal and "no list price" in refused.refusal
    session_only = _decide(est, {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 5.0}})
    assert session_only.refusal and "no list price" in session_only.refusal
    assert _decide(est, {"runCostConfirmUsd": None, "agentSpend": {}}).refusal is None


# -- requests ------------------------------------------------------------------------------------

def test_more_than_13_images_go_in_batches_of_6_with_batch_labels_and_at_most_2_at_once():
    b = board(14)
    google = FakeGoogle(delay=0.02)
    result = run_read(b, google)

    reads = [body for body in google.bodies if phase_of(body) == "read"]
    assert [len(images_of(body)) for body in reads] == [6, 6, 2]
    assert [labels_of(body) for body in reads] == [list("ABCDEF"), list("ABCDEF"), ["A", "B"]]
    assert sorted(i for body in reads for i in images_of(body)) == [f"img{n:02d}" for n in range(1, 15)]
    assert google.max_in_flight == 2
    for body in reads:
        text = texts_of(body)
        assert "Image A" in text and not re.search(r"#\d", text)  # never board numbers
    assert result["summary"]["sorted"] == 14 and result["summary"]["couldntRead"] == 0
    assert all(url.endswith("gemini-4-argon:streamGenerateContent?alt=sse") for url in google.urls)


def test_the_request_schema_and_settings():
    b = board(3)
    google = FakeGoogle()
    run_read(b, google)
    body = google.bodies[0]
    config = body["generationConfig"]
    assert config["responseFormat"]["text"]["mimeType"] == "APPLICATION_JSON"
    props = config["responseFormat"]["text"]["schema"]["properties"]["readings"]["items"]["properties"]
    assert list(props)[0] == "ref" and list(props)[-1] == "reason"
    assert props["ref"] == {"type": "string", "enum": ["A", "B", "C"],
                            "description": "The image's label, as given before it."}
    assert "maxLength" not in json.dumps(config)
    assert "responseSchema" not in config and "responseMimeType" not in config and "responseJsonSchema" not in config
    assert "temperature" not in config and "topP" not in config
    assert config["thinkingConfig"] == {"thinkingLevel": "medium"}  # no includeThoughts: "unconfirmed"
    assert config["maxOutputTokens"] == reader.batch_cap(ARGON, "medium", 3)
    # Text label, then the image, for each.
    parts = body["contents"][0]["parts"]
    assert [p.get("text") for p in parts[1::2]] == ["Image A", "Image B", "Image C"]
    assert all("inline_data" in p for p in parts[2::2])


def test_lines_come_in_order_with_no_gaps_and_focus_before_reading():
    b = board(3, frames=[{"id": "f1", "name": "Dither", "kind": "look"}])
    result = run_read(b, FakeGoogle({"img02": {"look": "Glass", "fit": 0.7}}))

    assert [line["seq"] for line in result["trace"]] == list(range(1, len(result["trace"]) + 1))
    assert kinds(result)[:7] == [("batch", (1, 2, 3)), ("focus", (1,)), ("reading", (1,)), ("focus", (2,)),
                                 ("reading", (2,)), ("focus", (3,)), ("reading", (3,))]
    first = lines(result, "reading")[0]
    assert first["text"] == "dither study → Dither" and first["source"] == "reader" and first["fit"] == 0.82
    assert first["look"] == {"frameId": "f1", "name": "Dither"}
    assert first["refs"] == [{"imageId": "img01", "number": 1}]
    assert lines(result, "batch")[0]["text"] == "Reading #1–#3"
    assert lines(result, "done")[-1]["text"].startswith("Dry run: would sort 3 into 2 looks (1 new)")
    assert result["trace"][-1]["kind"] == "done"
    assert all(line["source"] == "nebula" for line in result["trace"] if line["kind"] not in ("reading", "thought"))


def test_wrong_and_duplicate_refs():
    def answer(body):
        items = [reading("A", reason="first a"), reading("D", reason="not in this batch"),
                 reading("A", reason="second a")]
        return 200, sse(json.dumps({"readings": items}))

    b = board(2)
    google = FakeGoogle(script={1: answer, 2: lambda body: (200, sse(json.dumps({"readings": []})))})
    result = run_read(b, google)

    skipped = lines(result, "skipped")
    assert len(skipped) == 1 and skipped[0]["refs"] == [] and "not in this batch" in skipped[0]["text"]
    assert [line["refs"][0]["number"] for line in lines(result, "focus")] == [1]  # no outline for D
    assert result["readings"]["img01"]["reason"] == "first a"  # the first wins
    # #2 never came back: one retry asking only for it, then "couldn't read".
    assert labels_of(google.bodies[1]) == ["A"] and images_of(google.bodies[1]) == ["img02"]
    retry = lines(result, "retry")
    assert len(retry) == 1 and retry[0]["refs"] == [{"imageId": "img02", "number": 2}]
    errors = lines(result, "error")
    assert [line["refs"][0]["number"] for line in errors] == [2] and "Couldn't read #2" in errors[0]["text"]
    assert {r["number"]: r["status"] for r in result["results"]} == {1: "sorted", 2: "couldntRead"}


def test_malformed_json_retries_only_the_missing_refs():
    def cut(body):
        text = json.dumps({"readings": [reading("A"), reading("B")]})[:-2] + ', {"ref": "C", "medi'
        return 200, sse(text, finish="STOP")

    b = board(6)
    google = FakeGoogle(script={1: cut})
    result = run_read(b, google)

    retry_body = google.bodies[1]
    assert images_of(retry_body) == ["img03", "img04", "img05", "img06"]
    assert labels_of(retry_body) == ["A", "B", "C", "D"]  # relabelled for the retry's own batch
    assert lines(result, "retry")[0]["text"] == "Answer wasn't valid JSON; asking again for #3–#6"
    assert lines(result, "retry")[0]["attempt"] == 2
    assert result["summary"]["couldntRead"] == 0 and len(result["readings"]) == 6
    # The readings that closed were kept and shown once.
    assert [line["refs"][0]["number"] for line in lines(result, "reading")] == [1, 2, 3, 4, 5, 6]


def test_after_max_tokens_the_retry_splits_in_two():
    def cut_off(body):
        return 200, sse(json.dumps({"readings": [reading("A")]})[:-2], finish="MAX_TOKENS")

    b = board(6)
    google = FakeGoogle(script={1: cut_off})
    result = run_read(b, google)

    reads = [body for body in google.bodies if phase_of(body) == "read"]
    assert [images_of(body) for body in reads[1:]] == [["img02", "img03", "img04"], ["img05", "img06"]]
    assert [body["generationConfig"]["maxOutputTokens"] for body in reads[1:]] == [
        reader.batch_cap(ARGON, "medium", 3), reader.batch_cap(ARGON, "medium", 2)]
    assert lines(result, "retry")[0]["text"] == "Answer cut off after #1; asking again for #2–#6 in two halves"
    assert result["sent"].count("retry:1") == 1
    assert result["summary"]["couldntRead"] == 0


def _cut_off_empty(body):
    return 200, sse('{"readings": [', finish="MAX_TOKENS")


def test_a_one_image_batch_cut_off_retries_at_a_raised_cap_not_the_same_request():
    # 7 images: batch 2 is #7 alone, and it can't be split.
    class SevenCutOnce(FakeGoogle):
        def default(self, body):
            if phase_of(body) == "read" and images_of(body) == ["img07"] and not self.cut:
                self.cut = True
                return _cut_off_empty(body)
            return super().default(body)

    b = board(7)
    google = SevenCutOnce()
    google.cut = False
    result = run_read(b, google)

    sevens = [body for body in google.bodies if phase_of(body) == "read" and images_of(body) == ["img07"]]
    cap1 = reader.batch_cap(ARGON, "medium", 1)
    assert len(sevens) == 2 and sevens[0] != sevens[1]
    assert [body["generationConfig"]["maxOutputTokens"] for body in sevens] == [cap1, 2 * cap1]
    assert result["sent"].count("retry:2") == 1 and result["summary"]["couldntRead"] == 0
    # The estimate's retry share for that batch is priced at the raised cap.
    est = reader.estimate(b, ARGON, targets=targets_of(b), today=TODAY)
    assert est["perBatch"][1]["retryTokens"]["output"] == 2 * cap1


def test_a_one_image_batch_already_at_the_model_limit_is_not_sent_again():
    limit = reader.GEMINI_CHAT_MAX_OUTPUT["gemini-4-argon"]
    entry = {**ARGON, "thinking": {**ARGON["thinking"], "medium": {"thinkingTokens": limit}}}
    google = FakeGoogle(script={1: _cut_off_empty, 2: _cut_off_empty})
    result = run_read(board(1), google, entry=entry)

    reads = [body for body in google.bodies if phase_of(body) == "read"]
    assert len(reads) == 1 and reads[0]["generationConfig"]["maxOutputTokens"] == limit
    assert "retry:1" not in result["sent"] and not lines(result, "retry")
    assert [line["text"] for line in lines(result, "error")] == ["Couldn't read #1: the answer hit its token cap"]
    assert result["summary"]["couldntRead"] == 1


def test_a_sort_cut_off_at_the_model_limit_is_not_sent_again():
    limit = reader.GEMINI_CHAT_MAX_OUTPUT["gemini-4-argon"]
    entry = {**ARGON, "thinking": {**ARGON["thinking"], "medium": {"thinkingTokens": limit}}}
    cut = lambda body: (200, sse('{"sort": [', finish="MAX_TOKENS"))  # noqa: E731
    result = run_read(board(1), FakeGoogle(script={2: cut}), entry=entry)
    assert result["sent"] == ["batch:1", "sort"]
    assert result["sortError"] == "the answer hit its token cap"


def test_a_failed_batch_retries_once_then_its_images_go_to_unsorted():
    class FirstBatchFails(FakeGoogle):
        def default(self, body):
            if phase_of(body) == "read" and int(images_of(body)[0][3:]) <= 6:
                return 503, []
            return super().default(body)

    google = FirstBatchFails()
    result = run_read(board(8), google)

    statuses = {r["number"]: r["status"] for r in result["results"]}
    assert statuses == {**{n: "couldntRead" for n in range(1, 7)}, 7: "sorted", 8: "sorted"}
    assert sum(1 for body in google.bodies if phase_of(body) == "read") == 3  # batch 1 twice, batch 2 once
    assert [line["text"] for line in lines(result, "error")] == [
        f"Couldn't read #{n}: Google returned 503" for n in range(1, 7)]
    for number in range(1, 7):
        assert any(f"#{number} Unsorted: couldn't read it" == line["text"] for line in lines(result, "result"))
    assert result["summary"]["couldntRead"] == 6 and result["summary"]["sorted"] == 2


def test_a_bad_key_is_not_retried():
    b = board(2)
    google = FakeGoogle(script={1: lambda body: (403, [])})
    result = run_read(b, google)
    assert len(google.bodies) == 1 and not lines(result, "retry")
    assert [line["text"] for line in lines(result, "error")] == ["Couldn't read #1: Google returned 403",
                                                                "Couldn't read #2: Google returned 403"]


def test_a_stream_quiet_past_its_bound_fails_the_batch_and_its_images_go_to_the_retry():
    entry = {**ARGON, "timeBounds": {level: {"firstByte": 0.3, "quiet": 0.1, "total": 5}
                                      for level in ARGON["thinking"]}}

    def stalls(body):
        chunks = sse(json.dumps({"readings": [reading(label) for label in labels_of(body)]}), piece=40)
        delays = [0.0] * len(chunks)
        delays[2] = 0.4  # past the quiet bound, after #1 closed
        return 200, chunks, delays

    b = board(3)
    google = FakeGoogle(script={1: stalls})
    result = run_read(b, google, entry=entry)

    retry = lines(result, "retry")
    assert retry and retry[0]["text"].startswith("Google went quiet for 0.1 s; asking again for")
    assert result["summary"]["couldntRead"] == 0 and len(result["readings"]) == 3


def test_no_first_byte_within_its_bound_fails_the_request():
    entry = {**ARGON, "timeBounds": {level: {"firstByte": 0.1, "quiet": 1, "total": 5} for level in ARGON["thinking"]}}

    def silent(body):
        chunks = sse(json.dumps({"readings": [reading(label) for label in labels_of(body)]}))
        return 200, chunks, [0.4] + [0.0] * (len(chunks) - 1)

    b = board(1)
    result = run_read(b, FakeGoogle(script={1: silent, 2: silent}), entry=entry)
    assert lines(result, "error")[0]["text"] == "Couldn't read #1: Google sent nothing for 0.1 s"


def test_a_reason_naming_another_image_or_a_number_is_shown_and_saved_without_it():
    long = "Soft grain over a long empty beach with a single figure walking toward the far headland in fog " * 2
    plan = {"img01": {"reason": "Clouds under a halftone screen, like Image B and #18"},
            "img02": {"reason": long}}
    result = run_read(board(2), FakeGoogle(plan))

    first, second = lines(result, "reading")
    assert first["text"] == "Clouds under a halftone screen, like → Dither"
    assert result["readings"]["img01"]["reason"] == "Clouds under a halftone screen, like"
    saved = result["readings"]["img02"]["reason"]
    assert len(saved) <= 120 and saved.endswith("…")  # trimmed, and the item kept
    assert second["text"] == saved + " → Dither"


def test_a_reader_that_cannot_stream_gives_the_same_line_set():
    b = board(8, frames=[{"id": "f1", "name": "Dither", "kind": "look"}])
    plan = {"img03": {"look": "Glass", "fit": 0.4}, "img05": {"look": "Glass", "fit": 0.9}}
    streamed = run_read(b, FakeGoogle(plan))
    google = FakeGoogle(plan)
    whole = run_read(b, google, entry={**ARGON, "streams": False})

    assert all(url.endswith(":generateContent") for url in google.urls)

    def line_set(result):
        return sorted((line["kind"], line["text"], json.dumps(line["refs"])) for line in result["trace"])
    assert line_set(streamed) == line_set(whole)
    # Within each batch, focus still comes before its reading.
    order = [(line["kind"], line["refs"][0]["number"]) for line in whole["trace"] if line["kind"] in ("focus", "reading")]
    for number in range(1, 9):
        assert order.index(("focus", number)) < order.index(("reading", number))


def test_two_batches_interleave_and_order_within_each_holds():
    def slow(body):
        chunks = sse(json.dumps({"readings": [reading(label) for label in labels_of(body)]}), piece=60)
        return 200, chunks, [0.01] * len(chunks)

    b = board(12)
    result = run_read(b, FakeGoogle(script={1: slow, 2: slow}))

    readings = [(line["batch"], line["refs"][0]["number"]) for line in lines(result, "reading")]
    batches = [batch for batch, _ in readings]
    assert batches != sorted(batches)  # they interleave
    for batch, numbers in ((1, list(range(1, 7))), (2, list(range(7, 13)))):
        assert [n for bt, n in readings if bt == batch] == numbers


# -- thoughts (Q29 c) ----------------------------------------------------------------------------

def _with_thoughts(body):
    return 200, sse(json.dumps({"readings": [reading(label) for label in labels_of(body)]}),
                    thoughts=["Image B and #18 share a halftone; ", "the rest read as glass."])


@pytest.mark.parametrize("summaries", [False, "unconfirmed"])
def test_a_model_without_confirmed_summaries_sends_no_include_thoughts_and_shows_none(summaries):
    google = FakeGoogle(script={1: _with_thoughts})
    result = run_read(board(2), google, entry={**ARGON, "thoughtSummaries": summaries})
    assert "includeThoughts" not in json.dumps(google.bodies)
    assert not lines(result, "thought")
    assert "halftone; " not in json.dumps(result["readings"])


def test_a_model_with_summaries_but_none_in_the_answer_gives_b_s_lines_exactly():
    b = board(3)
    plain = run_read(b, FakeGoogle())
    google = FakeGoogle()
    asked = run_read(b, google, entry={**ARGON, "thoughtSummaries": True})
    assert google.bodies[0]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "medium", "includeThoughts": True}
    assert [(l["kind"], l["text"], l["refs"]) for l in asked["trace"]] == [
        (l["kind"], l["text"], l["refs"]) for l in plain["trace"]]
    assert not lines(asked, "thought") and not lines(asked, "error")


def test_thought_text_is_shown_without_labels_or_numbers_and_outlines_nothing():
    clock = iter(i * 0.1 for i in range(10_000))
    google = FakeGoogle(script={1: _with_thoughts})
    result = run_read(board(2), google, entry={**ARGON, "thoughtSummaries": True}, clock=lambda: next(clock))

    thoughts = lines(result, "thought")
    assert thoughts and all(line["refs"] == [] and line["source"] == "reader" for line in thoughts)
    text = " ".join(line["text"] for line in thoughts)
    assert "Image B" not in text and "#18" not in text and "share a halftone" in text
    # Thoughts come before the batch's answer, and no outline follows from them.
    first_focus = next(i for i, line in enumerate(result["trace"]) if line["kind"] == "focus")
    assert all(result["trace"].index(line) < first_focus for line in thoughts)
    assert [line["refs"][0]["number"] for line in lines(result, "focus")] == [1, 2]
    assert "share a halftone" not in json.dumps(result["readings"])


def test_thought_chunks_merge_into_at_least_250_ms():
    now = [0.0]
    trace = reader.Trace(board_id="b", run_id="r", clock=lambda: now[0])
    for i in range(6):
        now[0] = i * 0.1
        trace.thought("k", f"part {i}. ", phase="reading", batch=1, attempt=1)
    trace.flush_thoughts("k")
    assert [line["text"] for line in trace.lines] == ["part 0. part 1. part 2. part 3.", "part 4. part 5."]


# -- notes (#18's opt-in) ------------------------------------------------------------------------

def _prompts(google: FakeGoogle) -> str:
    return "\n".join(texts_of(body) for body in google.bodies)


def test_reader_prompt_has_no_notes_unless_opted_in():
    def cut(body):  # so a retry runs too
        return 200, sse(json.dumps({"readings": [reading("A")]})[:-2], finish="MAX_TOKENS")

    notes = dict(notes="BOARD-NOTE-TEXT", image_notes={1: "IMAGE-NOTE-ONE", 3: "IMAGE-NOTE-THREE"})
    off = FakeGoogle(script={1: cut})
    run_read(board(3, **notes), off)
    assert {phase_of(body) for body in off.bodies} == {"read", "sort"} and len(off.bodies) == 4
    assert "NOTE" not in _prompts(off)

    on = FakeGoogle(script={1: cut})
    run_read(board(3, send_notes=True, **notes), on)
    first, retry_a, retry_b, sort = on.bodies
    assert "BOARD-NOTE-TEXT" in texts_of(first) and "IMAGE-NOTE-ONE" in texts_of(first)
    assert "IMAGE-NOTE-THREE" in texts_of(retry_b)  # the retry follows the opt-in too
    assert "BOARD-NOTE-TEXT" in texts_of(sort) and "IMAGE-NOTE-THREE" in texts_of(sort)


@pytest.mark.parametrize("send_notes", [False, True])
def test_reader_prompt_never_has_private_notes(send_notes):
    def cut(body):
        return 200, sse(json.dumps({"readings": [reading("A")]})[:-2], finish="MAX_TOKENS")

    google = FakeGoogle(script={1: cut})
    run_read(board(3, send_notes=send_notes, private={1: "PRIVATE-ONE", 2: "PRIVATE-TWO"}), google)
    assert len(google.bodies) == 4 and "PRIVATE" not in json.dumps(google.bodies)


# -- phase 2 and the rules -------------------------------------------------------------------

def test_the_sort_rules_unsorted_new_looks_suggestions_and_hybrids():
    frames = [{"id": "f1", "name": "Dither", "kind": "look"}, {"id": "u1", "name": "Unsorted", "kind": "unsorted"}]
    plan = {
        "img01": {"look": "dither", "fit": 0.9},                           # existing look, any case
        "img02": {"look": "Glass", "fit": 0.41},                           # below 0.5: Unsorted
        "img03": {"look": "Painterly", "fit": 0.8, "second": ("Dither", 0.6)},
        "img04": {"look": "Painterly", "fit": 0.7, "second": ("Dither", 0.55)},
        "img05": {"look": "Dither", "fit": 0.75, "second": ("Painterly", 0.5)},  # the same pair, reversed
        "img06": {"look": "Glass", "fit": 0.8, "second": ("Dither", 0.62)},
        "img08": {"look": "Glass", "fit": 0.6, "second": ("Painterly", 0.9)},  # the higher fit wins
        "img07": {"look": "Unsorted", "fit": 0.95},                        # never a look
    }
    result = run_read(board(8, frames=frames), FakeGoogle(plan))

    by_number = {r["number"]: r for r in result["results"]}
    assert (by_number[1]["look"], by_number[1]["frameId"], by_number[1]["newLook"]) == ("Dither", "f1", False)
    assert by_number[2]["status"] == "unsorted" and by_number[2]["why"] == "no look fits (0.41)"
    assert by_number[7]["status"] == "unsorted"
    assert by_number[3]["look"] == "Painterly" and by_number[3]["newLook"] is True
    assert by_number[8]["look"] == "Painterly"
    hybrids = [s for s in result["suggestions"] if s["kind"] == "hybrid"]
    also = [s for s in result["suggestions"] if s["kind"] == "alsoIn"]
    assert len(hybrids) == 1 and sorted(hybrids[0]["imageIds"]) == ["img03", "img04", "img05"]
    assert hybrids[0]["name"] == "Painterly × Dither"
    assert [(s["imageIds"], s["looks"]) for s in also] == [(["img06"], ["Glass", "Dither"]),
                                                           (["img08"], ["Painterly", "Glass"])]
    texts = [line["text"] for line in lines(result, "suggestion")]
    assert "Make a Painterly × Dither look for #3–#5?" in texts and "#6 could also go in Dither (0.62)" in texts
    results = [line["text"] for line in lines(result, "result")]
    assert "#1 → Dither" in results and "#2 Unsorted: no look fits (0.41)" in results
    assert "#3 → Painterly (new look)" in results
    assert result["summary"] == {"sorted": 6, "looks": 3, "unsorted": 2, "couldntRead": 0, "newLooks": 2,
                                 "suggestions": 3}


def test_at_most_eight_new_looks_and_the_rest_try_their_second():
    plan = {f"img{n:02d}": {"look": f"Look{n}", "fit": 0.9} for n in range(1, 12)}
    plan["img01"] = {"look": "Big", "fit": 0.9}
    plan["img02"] = {"look": "Big", "fit": 0.9}
    plan["img10"] = {"look": "Look10", "fit": 0.9, "second": ("Big", 0.7)}
    result = run_read(board(11), FakeGoogle(plan))

    # Big (two images) and the first seven one-image looks make the eight.
    assert result["newLooks"] == ["Big"] + [f"Look{n}" for n in range(3, 10)]
    by_number = {r["number"]: r for r in result["results"]}
    assert by_number[10]["look"] == "Big"  # Look10 didn't make it, so its second
    assert (by_number[11]["status"], by_number[11]["why"]) == ("unsorted", "already 8 new looks")


def test_if_the_sort_fails_each_reading_s_own_looks_give_the_draft():
    fail = lambda body: (503, [])  # noqa: E731
    result = run_read(board(2), FakeGoogle({"img02": {"look": "Glass", "fit": 0.7}}, script={2: fail, 3: fail}))
    assert result["sortError"] == "Google returned 503"
    assert "Couldn't sort: Google returned 503" in lines(result, "error")[0]["text"]
    assert [r["look"] for r in result["results"]] == ["Dither", "Glass"]
    assert result["sent"] == ["batch:1", "sort", "sort-retry"]


def test_usage_is_added_up_and_priced_at_today_s_row():
    result = run_read(board(7), FakeGoogle())
    spent = result["spent"]
    assert spent["requests"] == 3 and spent["inputTokens"] == 21000 and spent["thoughtsTokens"] == 4500
    assert spent["usd"] == pytest.approx(21000 * 2 / 1e6 + (1800 + 4500) * 10 / 1e6)


def test_a_missing_key_is_refused_before_any_request():
    with pytest.raises(reader.NoReaderKeyError):
        MoodboardRead(board(1), ARGON, api_keys={}, targets=targets_of(board(1)))
