"""Jev mode in the four Video QC nodes: one typed question per check.

httpx is mocked through typesafe_client._make_client; nothing reaches
TypeSafe. The mock answers each question by its id, so a test sets only the
answers it cares about and every other check gets a confident pass.
"""
from __future__ import annotations

import email
import io
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from PIL import Image

from execution.missing_credential import MissingCredentialError
from models.graph import GraphNode, PortValueDict
from services import model_pricing, node_readiness, qc_jev
from services import output as output_service
from services import typesafe_client as ts

KEYS = {"TYPESAFE_API_KEY": "ts-test-key"}
QC_IDS = ("qc-loop-safety", "qc-frame-review", "qc-composited-look", "qc-camera-geometry")
DEFINITIONS = json.loads((Path(__file__).resolve().parents[1] / "data" / "node_definitions.json").read_text())


def _clip(name: str, seconds: float) -> Path:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is required for Video QC extraction tests")
    path = output_service.OUTPUT_ROOT / "qc-jev-tests" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file():
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", "testsrc2=size=320x180:rate=8", "-t", str(seconds), "-pix_fmt", "yuv420p", str(path)],
            check=True, timeout=30)
    return path


@pytest.fixture(scope="module")
def short_clip() -> Path:
    return _clip("short.mp4", 1.25)


@pytest.fixture(scope="module")
def long_clip() -> Path:
    return _clip("long.mp4", 3.0)


def _inputs(path: Path, **extra: PortValueDict) -> dict[str, PortValueDict]:
    rel = path.relative_to(output_service.OUTPUT_ROOT)
    return {"video": PortValueDict(type="Video", value=f"/api/outputs/{rel}"), **extra}


def _node(definition_id: str, **params) -> GraphNode:
    return GraphNode(id=f"jev-{definition_id}", definitionId=definition_id, params={"mode": "jev", **params})


def _passing(question: dict) -> dict:
    """A confident answer that passes the check (or the first option)."""
    kind = question["type"]
    if kind == "noul":
        return {"type": "noul", "noul": 0.95}
    if kind == "choice":
        keys = list(question["criteria"])
        return {"type": "choice", "choice": keys[0],
                "probabilities": {key: (0.9 if index == 0 else 0.1 / (len(keys) - 1)) for index, key in enumerate(keys)},
                "confidence": 0.85}
    levels = len(question["criteria"])
    return {"type": "score", "score": 0.0, "probabilities": {str(i): (0.9 if i == 0 else 0.1 / (levels - 1))
                                                           for i in range(levels)}, "confidence": 0.8}


def _json_body(request: httpx.Request) -> dict:
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    first = email.message_from_bytes(raw).get_payload()[0]
    return json.loads(first.get_payload(decode=True))


def _image_parts(request: httpx.Request) -> list[Image.Image]:
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    parts = email.message_from_bytes(raw).get_payload()[1:]
    return [Image.open(io.BytesIO(part.get_payload(decode=True))) for part in parts]


def _install(monkeypatch, answers: dict | None = None, *, pass_on_no: tuple[str, ...] = ()):
    """Answer every question: ``answers[id]`` if given, else a confident pass.
    ``pass_on_no`` lists Noul ids whose passing answer is "no"."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        questions = _json_body(request)["questions"]
        body = {}
        for qid, question in questions.items():
            if answers and qid in answers:
                body[qid] = answers[qid]
            elif qid in pass_on_no:
                body[qid] = {"type": "noul", "noul": 0.04}
            else:
                body[qid] = _passing(question)
        return httpx.Response(200, json={"model": "jev-1.14.0", "answers": body,
                                         "usage": {"input_tokens": 4321, "output_tokens": 9}},
                              headers={ts.REQUEST_ID_HEADER: "req-qc-1"})

    monkeypatch.setattr(ts, "_make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(ts, "_sleep", no_sleep)
    return calls


def _report(outputs: dict) -> dict:
    assert set(outputs) == {"frame", "text"}
    assert outputs["frame"]["type"] == "Image" and outputs["frame"]["value"].startswith("/api/outputs/")
    return json.loads(outputs["text"]["value"])


def _assert_request_shape(request: httpx.Request, *, images: int) -> dict:
    body = _json_body(request)
    assert request.headers[ts.IMAGES_HEADER] == "true"
    assert ts.LONG_CONTEXT_HEADER.lower() not in request.headers
    assert body["model"] == "jev-1.14.0"
    assert len(body["assets"]) == images
    # Each frame is in the state exactly once, and questions only name it.
    state_values = list(body["state"].values())
    assert sorted(state_values) == sorted(body["assets"])
    questions = json.dumps(body["questions"])
    assert not any(placeholder in questions for placeholder in body["assets"])
    for image in _image_parts(request):
        assert max(image.size) <= qc_jev.FRAME_LONG_SIDE
    return body


# -- the shared helpers --------------------------------------------------------


def test_pick_frames_keeps_both_ends_and_caps():
    assert qc_jev.pick_frames(5) == [0, 1, 2, 3, 4]
    picked = qc_jev.pick_frames(12)
    assert len(picked) == qc_jev.MAX_FRAMES and picked[0] == 0 and picked[-1] == 11
    assert picked == sorted(set(picked))


def test_the_frame_budget_fits_eight_frames_and_a_reference_inside_one_question():
    # A square frame is the worst case at a fixed long side.
    worst = qc_jev.estimated_tokens(qc_jev.FRAME_LONG_SIDE, qc_jev.FRAME_LONG_SIDE) * (qc_jev.MAX_FRAMES + 1)
    assert worst <= qc_jev.FRAME_TOKEN_BUDGET < 32_000


def test_setup_needs_the_key_and_reads_model_and_confidence():
    with pytest.raises(MissingCredentialError):
        qc_jev.setup({}, {})
    assert qc_jev.setup({}, KEYS) == qc_jev.Setup("ts-test-key", "jev-1.14.0", 0.5)
    assert qc_jev.setup({"model": "jev-1.13.0", "min_confidence": "0.7"}, KEYS).min_confidence == 0.7
    for bad in ("2", "nan", "x"):
        with pytest.raises(ValueError):
            qc_jev.setup({"min_confidence": bad}, KEYS)


def _run(results: dict[str, tuple[qc_jev.Check, dict]], min_confidence: float = 0.5) -> qc_jev.JevRun:
    result = ts.parse_response({"model": "jev-1.14.0", "answers": {key: answer for key, (_, answer) in results.items()}},
                               requested_model="jev-1.14.0")
    frames = qc_jev.Frames(names=("frame_1",), prepared=(), sampled=1, sent=(1,), estimated_tokens=0)
    return qc_jev.JevRun(results={key: qc_jev._read(check, result, min_confidence) for key, (check, _) in results.items()},
                         result=result, frames=frames, min_confidence=min_confidence)


def test_the_gate_is_the_minimum_and_unsure_is_never_a_pass():
    yes = qc_jev.Check("a", "noul", "?", pass_on="yes")
    no = qc_jev.Check("b", "noul", "?", pass_on="no")
    described = qc_jev.Check("c", "noul", "?", must_pass=False)
    run = _run({"a": (yes, {"type": "noul", "noul": 0.9}), "b": (no, {"type": "noul", "noul": 0.1}),
                "c": (described, {"type": "noul", "noul": 0.5})})
    assert run.verdict == qc_jev.PASS and run.min_pass_probability == pytest.approx(0.9)
    assert run["c"].verdict is None and not run["c"].confident
    # 0.65 passes on probability but is only 0.3 confident: unsure, and the run too.
    run = _run({"a": (yes, {"type": "noul", "noul": 0.65}), "b": (no, {"type": "noul", "noul": 0.1})})
    assert run["a"].verdict == qc_jev.UNSURE and run.verdict == qc_jev.UNSURE and run.unsure() == ["a"]
    # Any confident failure fails the run, however well the rest did.
    run = _run({"a": (yes, {"type": "noul", "noul": 0.99}), "b": (no, {"type": "noul", "noul": 0.97})})
    assert run.verdict == qc_jev.FAIL and [item.check.id for item in run.failed()] == ["b"]
    assert run.min_pass_probability == pytest.approx(0.03)


def test_choice_and_score_checks_read_pass_probability_and_not_applicable():
    choice = qc_jev.Check("who", "choice", "?", options=(("same", "Same"), ("other", "Other"), ("none", "None")),
                          passing=("same",), not_applicable=("none",))
    score = qc_jev.Check("drift", "score", "?", levels=("0", "1", "2", "3"), pass_at_most=0.45)
    run = _run({
        "who": (choice, {"type": "choice", "choice": "c", "probabilities": {"a": 0.05, "b": 0.05, "c": 0.9},
                         "confidence": 0.85}),
        "drift": (score, {"type": "score", "score": 2.0, "probabilities": {"0": 0.1, "1": 0.1, "2": 0.6, "3": 0.2},
                          "confidence": 0.7}),
    })
    assert run["who"].verdict == qc_jev.NOT_APPLICABLE and run["who"].answer == "none"
    assert run["drift"].verdict == qc_jev.FAIL
    assert run["drift"].pass_probability == pytest.approx(0.2)  # levels 0 and 1 pass at <= 0.45
    assert run.verdict == qc_jev.FAIL
    run.set_not_applicable("drift", "no face")
    assert run.verdict is None


# -- the handlers --------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id", QC_IDS)
async def test_jev_mode_without_a_key_stops_before_any_work(definition_id):
    from unittest.mock import AsyncMock

    from execution.sync_runner import get_handler_registry

    handler = get_handler_registry(emit=AsyncMock())[definition_id]
    with pytest.raises(MissingCredentialError):
        await handler(_node(definition_id), {}, {"OPENAI_API_KEY": "sk-not-this-one"})


@pytest.mark.asyncio
async def test_loop_safety_asks_three_yes_nos_about_two_frames(short_clip, monkeypatch):
    from handlers.qc_loop_safety import handle_qc_loop_safety

    calls = _install(monkeypatch)
    report = _report(await handle_qc_loop_safety(_node("qc-loop-safety"), _inputs(short_clip), KEYS))
    assert len(calls) == 1
    body = _assert_request_shape(calls[0], images=2)
    assert set(body["state"]) == {"first_frame", "last_frame"}
    assert {qid: q["type"] for qid, q in body["questions"].items()} == {
        "lighting": "noul", "content": "noul", "camera": "noul"}
    assert all("`first_frame`" in q["instructions"] and "`last_frame`" in q["instructions"]
               for q in body["questions"].values())
    assert report["mode"] == "jev" and report["loop_safe"] is True and report["discontinuity_type"] == "none"
    assert report["seam_score"] == pytest.approx(0.95)
    jev = report["jev"]
    assert jev["verdict"] == "true" and jev["model"] == "jev-1.14.0" and jev["input_tokens"] == 4321
    assert jev["request_id"] == "req-qc-1" and jev["images"] == "experimental"
    assert jev["checks"]["camera"]["probabilities"] == {"yes": 0.95, "no": 0.05}
    assert jev["checks"]["camera"]["confidence"] == pytest.approx(0.9)
    assert report["vision_provider"] == "typesafe" and report["vision_model"] == "jev-1.14.0"
    # The heuristic baseline is still there.
    assert set(report["frame_analysis"]) >= {"pixel_similarity", "ssim"}


@pytest.mark.asyncio
async def test_loop_safety_reports_the_worst_failure_and_never_passes_unsure(short_clip, monkeypatch):
    from handlers.qc_loop_safety import handle_qc_loop_safety

    _install(monkeypatch, {"lighting": {"type": "noul", "noul": 0.1}, "camera": {"type": "noul", "noul": 0.02}})
    report = _report(await handle_qc_loop_safety(_node("qc-loop-safety"), _inputs(short_clip), KEYS))
    assert report["loop_safe"] is False and report["discontinuity_type"] == "motion"
    assert report["seam_score"] == pytest.approx(0.02) and report["jev"]["verdict"] == "false"

    _install(monkeypatch, {"content": {"type": "noul", "noul": 0.6}})
    report = _report(await handle_qc_loop_safety(_node("qc-loop-safety"), _inputs(short_clip), KEYS))
    assert report["loop_safe"] is False and report["discontinuity_type"] == "unsure"
    assert report["jev"]["verdict"] == "unsure" and report["jev"]["unsure"] == ["content"]


@pytest.mark.asyncio
async def test_frame_review_caps_frames_and_asks_one_face_check_per_frame(long_clip, monkeypatch):
    from handlers.qc_frame_review import handle_qc_frame_review

    calls = _install(monkeypatch)
    report = _report(await handle_qc_frame_review(_node("qc-frame-review", sample_rate=4), _inputs(long_clip), KEYS))
    body = _assert_request_shape(calls[0], images=qc_jev.MAX_FRAMES)
    assert report["frames_sampled"] == 12
    sent = report["jev"]["frames"]["sent"]
    assert len(sent) == qc_jev.MAX_FRAMES and sent[0] == 1 and sent[-1] == 12
    assert set(body["state"]) == {f"frame_{n}" for n in sent}
    assert any("Sent 8 of 12 sampled frames" in note for note in report["jev"]["notes"])
    kinds = {qid: q["type"] for qid, q in body["questions"].items()}
    assert kinds["identity"] == "choice" and kinds["expression"] == "score" and kinds["background"] == "noul"
    assert sorted(qid for qid in kinds if qid.startswith("face_")) == sorted(f"face_frame_{n}" for n in sent)
    # Identity's options go out under neutral keys.
    assert list(body["questions"]["identity"]["criteria"]) == ["a", "b", "c"]
    assert report["pass_fail_summary"] == {"identity": True, "expression": True, "background": True}
    assert report["identity_drift_score"] == pytest.approx(0.05 / 0.95, abs=1e-3)
    assert report["expression_drift_score"] == 0.0
    assert report["assessment_provenance"]["identity"] == {"kind": "advisory", "reason": "jev_confident"}
    flags = report["face_detected_per_frame"]
    assert [flags[n - 1] for n in sent] == [True] * len(sent)
    assert [flag for index, flag in enumerate(flags) if index + 1 not in sent] == [None] * (12 - len(sent))
    assert report["jev"]["verdict"] == "true"


@pytest.mark.asyncio
async def test_frame_review_without_a_face_leaves_identity_and_expression_unmeasured(long_clip, monkeypatch):
    from handlers.qc_frame_review import handle_qc_frame_review

    no_face = {"type": "choice", "choice": "c", "probabilities": {"a": 0.03, "b": 0.02, "c": 0.95}, "confidence": 0.93}
    _install(monkeypatch, {"identity": no_face, "background": {"type": "noul", "noul": 0.62}})
    report = _report(await handle_qc_frame_review(_node("qc-frame-review", track_faces=False), _inputs(long_clip), KEYS))
    assert report["identity_drift_score"] is None and report["expression_drift_score"] is None
    assert report["assessment_provenance"]["identity"]["reason"] == "jev_no_face_seen"
    # Background passes on probability but isn't confident: None, never True.
    assert report["pass_fail_summary"] == {"identity": None, "expression": None, "background": None}
    jev = report["jev"]
    assert jev["checks"]["identity"]["verdict"] == "n/a" and jev["checks"]["expression"]["verdict"] == "n/a"
    assert jev["verdict"] == "unsure" and jev["unsure"] == ["background"]
    assert not any(qid.startswith("face_") for qid in jev["checks"])


@pytest.mark.asyncio
async def test_composited_look_gates_on_the_lowest_check(short_clip, monkeypatch):
    from handlers.qc_composited_look import handle_qc_composited_look

    no_flaws = ("edge_spill", "cutout", "chroma_key")
    calls = _install(monkeypatch, pass_on_no=no_flaws)
    report = _report(await handle_qc_composited_look(_node("qc-composited-look", sample_density=3),
                                                     _inputs(short_clip), KEYS))
    body = _assert_request_shape(calls[0], images=3)
    assert set(body["questions"]) == {"edge_spill", "light_match", "depth", "cutout", "chroma_key"}
    assert all("`frame_1`, `frame_2` and `frame_3`" in q["instructions"] for q in body["questions"].values())
    assert report["compositing_artifacts"] == [] and report["chroma_key_detected"] is False
    assert report["edge_spill_score"] == pytest.approx(0.04) and report["light_match_score"] == pytest.approx(0.95)
    assert report["overall_integration_score"] == pytest.approx(0.95)
    assert report["jev"]["verdict"] == "true"

    _install(monkeypatch, {"edge_spill": {"type": "noul", "noul": 0.9}, "chroma_key": {"type": "noul", "noul": 0.45}},
             pass_on_no=no_flaws)
    report = _report(await handle_qc_composited_look(_node("qc-composited-look", sample_density=3),
                                                     _inputs(short_clip), KEYS))
    assert report["compositing_artifacts"] == ["edge_spill"]
    assert report["chroma_key_detected"] is None  # unsure, not "no chroma key"
    assert report["overall_integration_score"] == pytest.approx(0.1)
    assert report["jev"]["verdict"] == "false" and report["jev"]["unsure"] == ["chroma_key"]


def _reference_png() -> str:
    path = output_service.OUTPUT_ROOT / "qc-jev-tests" / "reference.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (640, 360), "#335577").save(path)
    return f"/api/outputs/{path.relative_to(output_service.OUTPUT_ROOT)}"


@pytest.mark.asyncio
async def test_camera_geometry_sends_the_reference_once_and_gates_only_what_was_set(short_clip, monkeypatch):
    from handlers.qc_camera_geometry import handle_qc_camera_geometry

    reference = PortValueDict(type="Image", value=_reference_png())
    calls = _install(monkeypatch, {
        "reference_match": {"type": "score", "score": 2.6, "probabilities": {"0": 0.02, "1": 0.08, "2": 0.2, "3": 0.7},
                            "confidence": 0.75},
        "pan": {"type": "choice", "choice": "c", "probabilities": {"a": 0.05, "b": 0.1, "c": 0.85}, "confidence": 0.8},
    })
    report = _report(await handle_qc_camera_geometry(
        _node("qc-camera-geometry", expected_angle="low-angle push-in"), _inputs(short_clip, reference=reference), KEYS))
    body = _assert_request_shape(calls[0], images=6)
    assert "reference" in body["state"] and len(body["state"]) == 6
    kinds = {qid: q["type"] for qid, q in body["questions"].items()}
    assert kinds == {"angle": "choice", "pan": "choice", "tilt": "choice", "zoom": "choice",
                     "expected_angle": "noul", "reference_match": "score"}
    assert "low-angle push-in" in body["questions"]["expected_angle"]["instructions"]
    assert "`reference`" not in body["questions"]["angle"]["instructions"]
    assert report["detected_camera_angle"] == "low-angle"
    assert report["motion_direction"] == {"pan": "right", "tilt": "up", "zoom": "in"}
    assert report["expected_angle_match"] == "true"
    assert report["reference_match_score"] == pytest.approx(0.8667, abs=1e-3)
    assert report["jev"]["checks"]["reference_match"]["pass_probability"] == pytest.approx(0.9)
    assert report["jev"]["verdict"] == "true"
    # Measured numbers stay the local metrics.
    assert set(report["motion_estimate"]) == {"pan", "tilt", "zoom"}


@pytest.mark.asyncio
async def test_camera_geometry_without_expectations_has_no_verdict(short_clip, monkeypatch):
    from handlers.qc_camera_geometry import handle_qc_camera_geometry

    unsure_angle = {"type": "choice", "choice": "b", "probabilities": {"a": 0.3, "b": 0.4, "c": 0.3}, "confidence": 0.1}
    calls = _install(monkeypatch, {"angle": unsure_angle})
    report = _report(await handle_qc_camera_geometry(_node("qc-camera-geometry"), _inputs(short_clip), KEYS))
    assert set(_json_body(calls[0])["questions"]) == {"angle", "pan", "tilt", "zoom"}
    assert report["detected_camera_angle"] == "undetermined" and report["expected_angle_match"] is None
    assert report["jev"]["verdict"] is None
    assert any("No must-pass checks" in note for note in report["jev"]["notes"])
    assert any("first option" in note for note in report["jev"]["notes"])


# -- definitions, readiness and price ------------------------------------------


@pytest.mark.parametrize("definition_id", QC_IDS)
def test_definitions_offer_jev_with_a_pinned_model_only_in_jev_mode(definition_id):
    definition = DEFINITIONS[definition_id]
    params = {param["key"]: param for param in definition["params"]}
    assert "jev" in [option["value"] for option in params["mode"]["options"]]
    assert params["mode"]["default"] == "heuristic"
    assert [option["value"] for option in params["model"]["options"]] == list(ts.MODELS)
    assert params["model"]["default"] == ts.DEFAULT_MODEL
    for key in ("model", "min_confidence"):
        assert params[key]["visibleWhen"] == {"mode": ["jev"]}
    assert definition["providerVia"]["byValue"] == {"jev": {"anyKey": [ts.CREDENTIAL], "provider": "typesafe"}}


def test_readiness_names_the_typesafe_key_for_jev_mode_only():
    definition = DEFINITIONS["qc-composited-look"]
    jev = node_readiness.keys_needed(definition, {"mode": "jev"}, DEFINITIONS)
    assert jev == [{"id": "qc-composited-look", "apiProvider": "typesafe", "envKeyName": ["TYPESAFE_API_KEY"]}]
    vision = node_readiness.keys_needed(definition, {"mode": "vision-llm"}, DEFINITIONS)
    assert vision[0]["envKeyName"] == ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]
    assert node_readiness.keys_needed(definition, {}, DEFINITIONS) == []
    detail = node_readiness.detail(definition, {"TYPESAFE_API_KEY"}, False, DEFINITIONS)
    assert detail["options"] == {"heuristic": "free", "vision-llm": None, "opencv": "free", "jev": "key"}
    assert detail["missing"] == {"vision-llm": "needs ANTHROPIC_API_KEY or OPENAI_API_KEY or GOOGLE_API_KEY "
                                               "in Settings > Providers"}
    assert "mode=jev calls typesafe with TYPESAFE_API_KEY" in detail["note"]
    keyless = node_readiness.detail(definition, set(), False, DEFINITIONS)
    assert keyless["missing"]["jev"] == "needs TYPESAFE_API_KEY in Settings > Providers"


def test_jev_mode_is_priced_per_request_and_the_other_modes_are_not():
    pricing = model_pricing.load_pricing()
    assert model_pricing.validate_pricing(pricing, DEFINITIONS) == []
    items = [{"id": mode, "definitionId": "qc-loop-safety", "params": {"mode": mode}}
             for mode in ("jev", "vision-llm", "heuristic")]
    estimate = model_pricing.estimate_run(items, pricing, DEFINITIONS, {})
    assert estimate["priced"] == {"jev": {"low": 0.00001, "high": 0.0027, "model": "qc-loop-safety"}}
    assert estimate["unpriced"] == ["vision-llm"] and estimate["plus"] == ["input images"]


def test_a_utility_price_row_must_match_a_paid_mode():
    pricing = model_pricing.load_pricing()
    entry = dict(pricing["nodes"]["qc-loop-safety"])
    for rows in ([{"match": {}, "price": 0.001}], [{"match": {"mode": "heuristic"}, "price": 0.001}]):
        broken = {**pricing, "nodes": {"qc-loop-safety": {**entry, "rows": rows}}}
        problems = model_pricing.validate_pricing(broken, DEFINITIONS)
        assert problems == ["qc-loop-safety: row 0 must match a mode value that calls a provider"]
    plain = {**pricing, "nodes": {"text-input": {**entry, "rows": [{"match": {}, "price": 0.001}]}}}
    assert "text-input: local utility nodes are free and must not be priced" in model_pricing.validate_pricing(
        plain, DEFINITIONS)
