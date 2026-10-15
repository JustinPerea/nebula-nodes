"""jev-decide: request mapping, output contract and the shared fixture.

httpx is mocked through typesafe_client._make_client; nothing reaches TypeSafe.
backend/tests/fixtures/jev_outputs.json holds the Decide outputs this handler
must produce byte for byte; frontend/tests/lib/jev.test.ts parses the same
file. To refresh it after a deliberate format change, run this file with
JEV_FIXTURE_WRITE=1 and review the diff.
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
from handlers.jev_decide import handle_jev_decide
from models.graph import GraphNode, PortValueDict
from services import jev_outputs
from services import typesafe_client as ts

FIXTURE = Path(__file__).parent / "fixtures" / "jev_outputs.json"
KEYS = {"TYPESAFE_API_KEY": "ts-test-key"}


def _node(**params) -> GraphNode:
    return GraphNode(id="d1", definitionId="jev-decide", params=params)


def _inputs(context: str | None = None, images: list[str] | None = None) -> dict[str, PortValueDict]:
    inputs = {}
    if context is not None:
        inputs["state"] = PortValueDict(type="Text", value=context)
    if images is not None:
        inputs["images"] = PortValueDict(type="Image", value=images)
    return inputs


def _response(answer: dict, *, model: str = "jev-1.14.0", tokens: int = 312) -> dict:
    return {"model": model, "answers": {"decide": answer}, "usage": {"input_tokens": tokens, "output_tokens": 20}}


def _install(monkeypatch, body: dict, status: int = 200):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json=body)

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(ts, "_sleep", no_sleep)
    return calls


def _json_body(request: httpx.Request) -> dict:
    if request.headers["content-type"].startswith("multipart/"):
        raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
        first = email.message_from_bytes(raw).get_payload()[0]
        return json.loads(first.get_payload(decode=True))
    return json.loads(request.content)


def _png(size=(320, 320), color="white") -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


async def _run(monkeypatch, params: dict, response: dict, *, context: str | None = "A mug.",
               images: list[str] | None = None):
    calls = _install(monkeypatch, response)
    outputs = await handle_jev_decide(_node(**params), _inputs(context, images), KEYS)
    assert jev_outputs.validate_outputs("jev-decide", outputs) == []
    return outputs, calls


def _values(outputs: dict) -> dict[str, str]:
    return {port: entry["value"] for port, entry in outputs.items()}


# -- request mapping -------------------------------------------------------------


@pytest.mark.asyncio
async def test_yes_no_sends_a_noul_with_only_the_criteria_given(monkeypatch):
    _, calls = await _run(monkeypatch, {"question": "Is it on white?", "yes_means": "Plain white backdrop"},
                          _response({"type": "noul", "noul": 0.9}), context="A mug on white.")
    body = _json_body(calls[0])
    assert body == {"model": "jev-1.14.0", "state": "A mug on white.", "questions": {"decide": {
        "instructions": "Is it on white?", "type": "noul", "criteria": {"true": "Plain white backdrop"}}}}
    assert ts.IMAGES_HEADER.lower() not in calls[0].headers


@pytest.mark.asyncio
async def test_choice_sends_neutral_keys_and_maps_the_answer_back(monkeypatch):
    outputs, calls = await _run(
        monkeypatch,
        {"question": "What kind of shot?", "answer_type": "choice", "options": "Product\n Lifestyle \n\nIllustration",
         "pass_when": "Product"},
        _response({"type": "choice", "choice": "b", "probabilities": {"a": 0.1, "b": 0.85, "c": 0.05},
                   "confidence": 0.78}))
    question = _json_body(calls[0])["questions"]["decide"]
    assert question["type"] == "choice"
    assert question["criteria"] == {"a": "Product", "b": "Lifestyle", "c": "Illustration"}
    values = _values(outputs)
    assert values["answer"] == "Lifestyle" and values["pass"] == "false"
    assert values["probability"] == "0.85" and values["confidence"] == "0.78"
    assert json.loads(values["probabilities"]) == {"Product": 0.1, "Lifestyle": 0.85, "Illustration": 0.05}


@pytest.mark.asyncio
async def test_score_sends_levels_as_criteria_and_normalises_the_score(monkeypatch):
    outputs, calls = await _run(
        monkeypatch,
        {"question": "How on brief?", "answer_type": "score", "levels": "Off\nPartly\nOn", "threshold": 0.6,
         "min_confidence": 0.3},
        _response({"type": "score", "score": 1.5, "legend": {"0": "Off", "1": "Partly", "2": "On"},
                   "probabilities": {"0": 0.0, "1": 0.5, "2": 0.5}, "confidence": 0.4}))
    assert _json_body(calls[0])["questions"]["decide"]["criteria"] == ["Off", "Partly", "On"]
    values = _values(outputs)
    assert values["probability"] == "0.75" and values["pass"] == "true"
    assert values["answer"] == "Partly"  # ties go to the lower level
    assert "Score: 1.5 on 0..2" in values["report"]


@pytest.mark.asyncio
async def test_images_go_in_the_state_once_with_the_images_header(monkeypatch):
    _, calls = await _run(monkeypatch, {"question": "Same product?"}, _response({"type": "noul", "noul": 0.2}),
                          context="Brief: red mug", images=[_png(), _png(color="red")])
    request = calls[0]
    assert request.headers[ts.IMAGES_HEADER] == "true"
    body = _json_body(request)
    assert body["state"]["context"] == "Brief: red mug"
    assert len(body["state"]["images"]) == 2 and set(body["state"]["images"]) == set(body["assets"])

    _, calls = await _run(monkeypatch, {"question": "On white?"}, _response({"type": "noul", "noul": 0.2}),
                          context=None, images=[_png()])
    body = _json_body(calls[0])
    assert list(body["state"]) == ["image"] and body["state"]["image"] in body["assets"]


@pytest.mark.asyncio
async def test_long_context_and_model_are_passed_through(monkeypatch):
    outputs, calls = await _run(monkeypatch, {"question": "?", "model": "jev-latest", "long_context": True},
                                _response({"type": "noul", "noul": 0.95}, model="jev-1.13.0"))
    assert calls[0].headers[ts.LONG_CONTEXT_HEADER] == "true"
    assert _json_body(calls[0])["model"] == "jev-latest"
    assert "Model: jev-1.13.0 (asked for jev-latest)" in outputs["report"]["value"]


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", [True, "true", "yes", "1", 1, "on", "TRUE", False, None])
async def test_long_context_turns_on_exactly_when_it_is_priced_as_long_context(monkeypatch, raw):
    from services import model_pricing
    from services.node_registry import NodeRegistry

    definition = NodeRegistry().get_all()["jev-decide"]
    entry = model_pricing.load_pricing()["nodes"]["jev-decide"]
    priced = model_pricing.estimate_node(entry, definition, {"long_context": raw})
    _, calls = await _run(monkeypatch, {"question": "?", "long_context": raw},
                          _response({"type": "noul", "noul": 0.95}))
    sent_long = calls[0].headers.get(ts.LONG_CONTEXT_HEADER) == "true"
    assert sent_long == (priced["high"] == 0.011)


@pytest.mark.asyncio
async def test_padded_images_are_noted_in_the_report(monkeypatch):
    outputs, _ = await _run(monkeypatch, {"question": "?"}, _response({"type": "noul", "noul": 0.95}),
                            images=[_png(size=(100, 100))])
    report = outputs["report"]["value"]
    assert "Images: 1 (experimental)" in report
    assert "Note: Image 1: PNG 100x100 -> PNG 280x280 (padded)." in report


# -- verdicts --------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(("noul", "threshold", "expected"), [
    (0.93, 0.5, "true"), (0.05, 0.5, "false"), (0.6, 0.5, "unsure"), (0.8, 0.9, "false"),
])
async def test_yes_no_pass_follows_threshold_and_minimum_confidence(monkeypatch, noul, threshold, expected):
    outputs, _ = await _run(monkeypatch, {"question": "?", "threshold": threshold},
                            _response({"type": "noul", "noul": noul}))
    assert outputs["pass"]["value"] == expected
    assert outputs["confidence"]["value"] == jev_outputs.format_number(abs(2 * noul - 1))


@pytest.mark.asyncio
async def test_choice_without_passing_options_passes_when_confident(monkeypatch):
    params = {"question": "?", "answer_type": "choice", "options": "A\nB"}
    confident = _response({"type": "choice", "choice": "a", "probabilities": {"a": 0.9, "b": 0.1}, "confidence": 0.8})
    outputs, _ = await _run(monkeypatch, params, confident)
    assert outputs["pass"]["value"] == "true"
    shaky = _response({"type": "choice", "choice": "a", "probabilities": {"a": 0.6, "b": 0.4}, "confidence": 0.2})
    outputs, _ = await _run(monkeypatch, params, shaky)
    assert outputs["pass"]["value"] == "unsure"
    assert "lean toward the first option" in outputs["report"]["value"]


# -- failures --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_key_fails_before_any_request(monkeypatch):
    calls = _install(monkeypatch, _response({"type": "noul", "noul": 0.9}))
    with pytest.raises(MissingCredentialError, match="TYPESAFE_API_KEY is required"):
        await handle_jev_decide(_node(question="?"), _inputs("x"), {})
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("params", "context", "message"), [
    ({}, "x", "needs a question"),
    ({"question": "?", "answer_type": "rank"}, "x", "answer_type must be one of"),
    ({"question": "?", "answer_type": "choice", "options": "Only one"}, "x", "at least two options"),
    ({"question": "?", "answer_type": "choice", "options": "A\nB", "pass_when": "C"}, "x", "isn't one of the options"),
    ({"question": "?", "answer_type": "score", "levels": "\n".join(str(i) for i in range(11))}, "x", "2 to 10 levels"),
    ({"question": "?", "threshold": 2}, "x", "threshold must be from 0 to 1"),
    ({"question": "?"}, None, "needs something to judge"),
])
async def test_bad_settings_fail_before_any_request(monkeypatch, params, context, message):
    calls = _install(monkeypatch, _response({"type": "noul", "noul": 0.9}))
    with pytest.raises(ValueError, match=message):
        await handle_jev_decide(_node(**params), _inputs(context), KEYS)
    assert calls == []


@pytest.mark.asyncio
async def test_provider_errors_surface_with_the_fix(monkeypatch):
    _install(monkeypatch, {"error": {"code": "max_tokens_exceeded"}}, status=400)
    with pytest.raises(ts.TypeSafeError, match="turn on Long context"):
        await handle_jev_decide(_node(question="?"), _inputs("x"), KEYS)


def test_decide_is_registered_as_a_sync_handler():
    from execution.sync_runner import SYNC_HANDLERS

    assert SYNC_HANDLERS["jev-decide"] is handle_jev_decide


# -- the shared fixture ----------------------------------------------------------


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text())


@pytest.mark.asyncio
async def test_decide_outputs_match_the_shared_fixture(monkeypatch):
    fixture = _fixture()
    produced = []
    for case in fixture["decide"]:
        outputs, _ = await _run(monkeypatch, case["params"], case["response"], context=case["context"])
        produced.append({**case, "outputs": outputs})
    if os.environ.get("JEV_FIXTURE_WRITE") == "1":
        fixture["decide"] = produced
        FIXTURE.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    for case, made in zip(fixture["decide"], produced):
        assert made["outputs"] == case["outputs"], case["name"]


@pytest.mark.parametrize("group", ["decide", "pickBest", "box"])
def test_every_fixture_sample_keeps_the_contract(group):
    definition_id = {"decide": "jev-decide", "pickBest": "jev-pick-best", "box": "jev-box"}[group]
    for case in _fixture()[group]:
        assert jev_outputs.validate_outputs(definition_id, case["outputs"]) == [], case["name"]


def test_malformed_fixture_samples_break_the_contract():
    for case in _fixture()["malformed"]:
        assert jev_outputs.validate_outputs(case["definitionId"], case["outputs"]), case["name"]
