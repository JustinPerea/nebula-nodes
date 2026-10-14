"""jev-pick-best: request mapping, the candidate cap, the downscale retry and
the shared fixture.

httpx is mocked through typesafe_client._make_client; nothing reaches
TypeSafe. The pickBest samples in backend/tests/fixtures/jev_outputs.json are
this handler's real outputs; frontend/tests/lib/jev.test.ts parses the same
file. To refresh them after a deliberate format change, run this file with
JEV_FIXTURE_WRITE=1, review the diff and update each sample's `parsed` by hand.
"""
from __future__ import annotations

import base64
import email
import io
import json
import os
from pathlib import Path

import httpx
import pytest
from PIL import Image

from execution.missing_credential import MissingCredentialError
from handlers.jev_pick_best import MAX_CANDIDATES, NO_BRIEF, RETRY_SIDE, handle_jev_pick_best
from models.graph import GraphNode, PortValueDict
from services import jev_outputs
from services import typesafe_client as ts
from services.output import OUTPUT_ROOT

FIXTURE = Path(__file__).parent / "fixtures" / "jev_outputs.json"
KEYS = {"TYPESAFE_API_KEY": "ts-test-key"}


def _node(**params) -> GraphNode:
    return GraphNode(id="pb1", definitionId="jev-pick-best", params=params)


def _inputs(candidates: list[str], brief: str | None = None) -> dict[str, PortValueDict]:
    inputs = {"candidates": PortValueDict(type="Image", value=candidates)}
    if brief is not None:
        inputs["brief"] = PortValueDict(type="Text", value=brief)
    return inputs


def _response(choice: str, probabilities: dict[str, float], confidence: float, *, tokens: int = 2810) -> dict:
    return {"model": "jev-1.14.0",
            "answers": {"pick": {"type": "choice", "choice": choice, "probabilities": probabilities,
                                 "confidence": confidence}},
            "usage": {"input_tokens": tokens, "output_tokens": 20}}


def _install(monkeypatch, *replies: tuple[int, dict]):
    """Answer each request with the next (status, body); the last one repeats."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        status, body = replies[min(len(calls), len(replies)) - 1]
        return httpx.Response(status, json=body)

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(ts, "_sleep", no_sleep)
    return calls


def _parts(request: httpx.Request) -> list:
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    return email.message_from_bytes(raw).get_payload()


def _json_body(request: httpx.Request) -> dict:
    return json.loads(_parts(request)[0].get_payload(decode=True))


def _sent_sizes(request: httpx.Request) -> list[tuple[int, int]]:
    return [Image.open(io.BytesIO(part.get_payload(decode=True))).size for part in _parts(request)[1:]]


def _png(size=(320, 320), color="white") -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def _output_file(name: str, size: tuple[int, int], color: str = "white") -> str:
    """A candidate saved under OUTPUT_ROOT, referenced the way the canvas does."""
    path = OUTPUT_ROOT / "jev-fixture" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", tuple(size), color).save(path, format="PNG")
    return f"/api/outputs/jev-fixture/{name}"


async def _run(monkeypatch, params: dict, candidates: list[str], *replies: tuple[int, dict],
               brief: str | None = "A red mug on white."):
    calls = _install(monkeypatch, *replies)
    outputs = await handle_jev_pick_best(_node(**params), _inputs(candidates, brief), KEYS)
    assert jev_outputs.validate_outputs("jev-pick-best", outputs) == []
    return outputs, calls


# -- request mapping -------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_choice_over_the_candidates_with_neutral_keys(monkeypatch):
    candidates = [_png(color="red"), _png(color="green"), _png(color="blue")]
    _, calls = await _run(monkeypatch, {}, candidates,
                          (200, _response("b", {"a": 0.1, "b": 0.8, "c": 0.1}, 0.7)))
    assert len(calls) == 1
    request = calls[0]
    assert request.headers[ts.IMAGES_HEADER] == "true"
    assert ts.LONG_CONTEXT_HEADER.lower() not in request.headers
    body = _json_body(request)
    assert body["model"] == "jev-1.14.0"
    assert body["state"] == "A red mug on white."
    question = body["questions"]["pick"]
    assert list(body["questions"]) == ["pick"]
    assert question["type"] == "choice" and question["instructions"] == "Which image best matches the brief?"
    # Neutral keys whose descriptions are just the image placeholders, in order.
    assert list(question["criteria"]) == ["a", "b", "c"]
    placeholders = list(question["criteria"].values())
    assert set(placeholders) == set(body["assets"])
    assert [body["assets"][p]["part"] for p in placeholders] == ["image-1", "image-2", "image-3"]
    # Each image is referenced exactly once in the whole request.
    text = json.dumps(body)
    for placeholder in placeholders:
        assert text.count(placeholder) == 2  # once in the question, once as its asset key
    assert len(_parts(request)) == 4


@pytest.mark.asyncio
async def test_without_a_brief_the_state_still_says_what_to_do(monkeypatch):
    outputs, calls = await _run(monkeypatch, {"question": "Which is sharpest?", "model": "jev-1.13.0"},
                                [_png(), _png()], (200, _response("a", {"a": 0.9, "b": 0.1}, 0.8)), brief=None)
    body = _json_body(calls[0])
    assert body["state"] == NO_BRIEF and body["model"] == "jev-1.13.0"
    assert body["questions"]["pick"]["instructions"] == "Which is sharpest?"
    assert "Brief:" not in outputs["report"]["value"]


# -- outputs ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_winner_is_the_original_value_not_the_sent_copy(monkeypatch):
    big = _output_file("big-candidate.png", (2400, 1200), "red")
    small = _png(size=(100, 100), color="blue")
    outputs, calls = await _run(monkeypatch, {}, [small, big],
                                (200, _response("b", {"a": 0.12, "b": 0.88}, 0.76)))
    assert _sent_sizes(calls[0]) == [(280, 280), (1568, 784)]
    assert outputs["winner"] == {"type": "Image", "value": big}
    assert outputs["index"]["value"] == "1"
    assert json.loads(outputs["probabilities"]["value"]) == {"0": 0.12, "1": 0.88}
    assert outputs["confidence"]["value"] == "0.76"
    report = outputs["report"]["value"]
    assert "Winner: 1" in report and "Images: 2 (experimental)" in report
    assert "Note: Candidate at index 0: PNG 100x100 -> PNG 280x280 (padded)." in report


@pytest.mark.asyncio
async def test_low_confidence_says_the_candidates_are_close(monkeypatch):
    outputs, _ = await _run(monkeypatch, {"min_confidence": 0.3}, [_png(), _png(), _png()],
                            (200, _response("a", {"a": 0.36, "b": 0.33, "c": 0.31}, 0.04)))
    report = outputs["report"]["value"]
    assert "the candidates are close, so any would do" in report
    assert "lean toward the first option" in report
    confident, _ = await _run(monkeypatch, {"min_confidence": 0.3}, [_png(), _png()],
                              (200, _response("a", {"a": 0.9, "b": 0.1}, 0.8)))
    assert "Note:" not in confident["report"]["value"]


# -- limits and retries ----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("count", "message"), [
    (MAX_CANDIDATES + 1, f"at most {MAX_CANDIDATES} candidates, got {MAX_CANDIDATES + 1}"),
    (1, "at least two candidate images, got 1"),
])
async def test_candidate_count_is_checked_before_any_request(monkeypatch, count, message):
    calls = _install(monkeypatch, (200, _response("a", {"a": 1.0}, 1.0)))
    with pytest.raises(ValueError, match=message):
        await handle_jev_pick_best(_node(), _inputs([_png()] * count), KEYS)
    assert calls == []


@pytest.mark.asyncio
async def test_ten_candidates_fit(monkeypatch):
    probabilities = {key: 0.1 for key in ts.neutral_keys(MAX_CANDIDATES)}
    outputs, calls = await _run(monkeypatch, {}, [_png()] * MAX_CANDIDATES,
                                (200, _response("j", probabilities, 0.0)))
    assert len(_json_body(calls[0])["questions"]["pick"]["criteria"]) == MAX_CANDIDATES
    assert outputs["index"]["value"] == "9"


@pytest.mark.asyncio
async def test_over_the_context_it_retries_once_with_smaller_candidates(monkeypatch):
    over = (400, {"error": {"code": "max_tokens_exceeded", "message": "too many tokens"}})
    ok = (200, _response("a", {"a": 0.7, "b": 0.3}, 0.4))
    outputs, calls = await _run(monkeypatch, {}, [_png((1200, 900)), _png((900, 1200))], over, ok)
    assert len(calls) == 2
    assert _sent_sizes(calls[0]) == [(1200, 900), (900, 1200)]
    assert _sent_sizes(calls[1]) == [(RETRY_SIDE, 576), (576, RETRY_SIDE)]
    first, second = _json_body(calls[0]), _json_body(calls[1])
    assert set(first["assets"]).isdisjoint(second["assets"])  # fresh placeholders for the new copies
    assert set(second["questions"]["pick"]["criteria"].values()) == set(second["assets"])
    assert f"sent again at {RETRY_SIDE} px" in outputs["report"]["value"]


@pytest.mark.asyncio
async def test_still_over_the_context_after_the_retry_says_to_split(monkeypatch):
    over = (400, {"error": {"message": "max_tokens_exceeded: 70000 > 65536"}})
    calls = _install(monkeypatch, over)
    with pytest.raises(ts.TypeSafeError, match="Split them across two Pick Best nodes"):
        await handle_jev_pick_best(_node(), _inputs([_png(), _png()]), KEYS)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_other_errors_are_not_retried(monkeypatch):
    calls = _install(monkeypatch, (401, {"error": {"message": "bad key"}}))
    with pytest.raises(ts.TypeSafeError, match="401"):
        await handle_jev_pick_best(_node(), _inputs([_png(), _png()]), KEYS)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_missing_key_fails_before_any_request(monkeypatch):
    calls = _install(monkeypatch, (200, _response("a", {"a": 1.0}, 1.0)))
    with pytest.raises(MissingCredentialError, match="TYPESAFE_API_KEY is required"):
        await handle_jev_pick_best(_node(), _inputs([_png(), _png()]), {})
    assert calls == []


def test_pick_best_is_registered_as_a_sync_handler():
    from execution.sync_runner import SYNC_HANDLERS

    assert SYNC_HANDLERS["jev-pick-best"] is handle_jev_pick_best


# -- the shared fixture ----------------------------------------------------------


@pytest.mark.asyncio
async def test_pick_best_outputs_match_the_shared_fixture(monkeypatch):
    fixture = json.loads(FIXTURE.read_text())
    produced = []
    for case in fixture["pickBest"]:
        candidates = [_output_file(f"candidate-{index}.png", size) for index, size in enumerate(case["candidates"])]
        outputs, _ = await _run(monkeypatch, case["params"], candidates, (200, case["response"]),
                                brief=case["brief"])
        produced.append({**case, "outputs": outputs})
    if os.environ.get("JEV_FIXTURE_WRITE") == "1":
        fixture["pickBest"] = produced
        FIXTURE.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    for case, made in zip(fixture["pickBest"], produced):
        assert made["outputs"] == case["outputs"], case["name"]
