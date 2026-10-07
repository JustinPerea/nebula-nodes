"""Frame-review verdicts must distinguish evidence from unmeasured checks."""

from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest
from PIL import Image

from handlers import qc_frame_review
from models.graph import GraphNode, PortValueDict
from services import qc_metrics


@pytest.fixture
def sampled_review(monkeypatch: pytest.MonkeyPatch):
    """Use synthetic frames; exercise real verdict/JSON/annotation plumbing."""
    frames = [Image.new("RGB", (64, 64), "gray") for _ in range(3)]
    monkeypatch.setattr(qc_frame_review, "required_video", lambda _: Path("synthetic.mp4"))
    monkeypatch.setattr(
        qc_frame_review, "ffprobe_video", AsyncMock(return_value=SimpleNamespace(duration=1.0))
    )
    monkeypatch.setattr(
        qc_frame_review, "extract_frames", AsyncMock(return_value=[Path(str(i)) for i in range(3)])
    )
    monkeypatch.setattr(qc_frame_review, "open_rgb", lambda path: frames[int(path.name)])
    captures = []

    def capture_output(node, **kwargs):
        # Retain real annotations without writing media into application state.
        from services.qc_common import create_annotated_frame, format_report

        image = create_annotated_frame(
            kwargs["frames"], title=kwargs["title"], labels=kwargs.get("labels"),
            boxes=kwargs.get("boxes"), footer=kwargs.get("footer"),
        )
        png = io.BytesIO()
        image.save(png, format="PNG")
        captures.append({**kwargs, "image": image, "png": png.getvalue()})
        return {"text": {"value": format_report(kwargs["findings"], node_id=node.id, mode=kwargs["mode"])}}

    monkeypatch.setattr(qc_frame_review, "qc_outputs", capture_output)

    async def review(**params):
        result = await qc_frame_review.handle_qc_frame_review(
            GraphNode(id="synthetic-review", definitionId="qc-frame-review", params=params),
            {"video": PortValueDict(type="Video", value="synthetic.mp4")}, {},
        )
        return json.loads(result["text"]["value"])

    return review, captures


def assert_unmeasured(report, *checks):
    for check in checks:
        assert report[f"{check}_drift_score"] is None
        assert report["pass_fail_summary"][check] is None
        assert report["assessment_provenance"][check]["kind"] == "unavailable"


@pytest.mark.asyncio
async def test_default_heuristic_does_not_pass_unmeasured_identity(sampled_review):
    review, captures = sampled_review
    report = await review()
    assert_unmeasured(report, "identity", "expression")
    assert report["pass_fail_summary"]["background"] is True
    assert report["face_detection_coverage"] is None
    assert report["face_detected_per_frame"] == [None, None, None]
    assert "unmeasured" in captures[0]["footer"][0].lower()
    with Image.open(io.BytesIO(captures[0]["png"])) as image:
        image.verify()
        assert image.format == "PNG"


@pytest.mark.asyncio
async def test_opencv_face_tracking_disabled_remains_unmeasured(sampled_review, monkeypatch):
    review, _ = sampled_review
    detect = AsyncMock(side_effect=AssertionError("disabled detection must not run"))
    monkeypatch.setattr(qc_frame_review, "detect_faces", detect)
    report = await review(mode="opencv", track_faces=False)
    assert_unmeasured(report, "identity", "expression")
    assert report["assessment_provenance"]["identity"]["reason"] == "face_tracking_disabled"
    assert report["face_detection_coverage"] is None
    detect.assert_not_called()


def install_face_detections(monkeypatch, boxes):
    """Keep real proxy math, substitute only detector results on synthetic faces."""
    class Cascade:
        def detectMultiScale(self, *_args, **_kwargs):
            return next(detections)

    detections = iter(boxes)
    fake_cv = SimpleNamespace(
        data=SimpleNamespace(haarcascades="synthetic/"),
        CascadeClassifier=lambda _: Cascade(), COLOR_RGB2GRAY=0,
        cvtColor=lambda rgb, _: rgb[..., 0],
        Canny=lambda crop, *_: np.zeros_like(crop),
    )
    monkeypatch.setattr(qc_metrics, "cv2", fake_cv)


@pytest.mark.asyncio
@pytest.mark.parametrize("boxes", [[[], [], []], [[(5, 5, 24, 24)], [], []]])
async def test_no_or_single_detection_cannot_produce_a_drift_proxy(
    sampled_review, monkeypatch, boxes,
):
    review, _ = sampled_review
    install_face_detections(monkeypatch, boxes)
    report = await review(mode="opencv")
    assert_unmeasured(report, "identity", "expression")
    assert report["face_geometry_drift_score"] is None
    assert report["face_edge_drift_score"] is None
    assert report["assessment_provenance"]["face_geometry"]["kind"] == "unavailable"
    assert report["face_detection_coverage"]["detected_frames"] == sum(bool(v) for v in boxes)


@pytest.mark.asyncio
@pytest.mark.parametrize("boxes", [
    [[(5, 5, 24, 24)], [], [(5, 5, 24, 24)]],
    [[(5, 5, 24, 24)], [(5, 5, 24, 24)], [(5, 5, 24, 24)]],
])
async def test_partial_and_full_face_coverage_are_only_geometry_proxies(
    sampled_review, monkeypatch, boxes,
):
    review, captures = sampled_review
    install_face_detections(monkeypatch, boxes)
    report = await review(mode="opencv")
    assert_unmeasured(report, "identity", "expression")
    assert report["face_geometry_drift_score"] == 0.0
    assert report["face_edge_drift_score"] == 0.0
    assert report["assessment_provenance"]["face_geometry"]["kind"] == "proxy"
    assert report["assessment_provenance"]["face_edges"]["kind"] == "proxy"
    assert report["face_detected_per_frame"] == [bool(v) for v in boxes]
    assert report["face_detection_coverage"] == {
        "detected_frames": sum(bool(v) for v in boxes), "sampled_frames": 3,
        "fraction": round(sum(bool(v) for v in boxes) / 3, 4),
    }
    assert any("proxy" in line.lower() for line in captures[0]["footer"])


@pytest.mark.asyncio
async def test_moving_face_and_changed_crop_edges_still_do_not_measure_identity(sampled_review, monkeypatch):
    review, _ = sampled_review
    install_face_detections(monkeypatch, [[(5, 5, 24, 24)], [], [(20, 10, 32, 32)]])
    edge_values = iter([0, 255])
    monkeypatch.setattr(qc_metrics.cv2, "Canny", lambda crop, *_: np.full_like(crop, next(edge_values)))
    report = await review(mode="opencv")
    assert_unmeasured(report, "identity", "expression")
    for key in ("face_geometry_drift_score", "face_edge_drift_score"):
        assert 0 < report[key] <= 1
    assert report["face_detection_coverage"]["detected_frames"] == 2
    assert report["assessment_provenance"]["face_geometry"]["kind"] == "proxy"
    assert report["assessment_provenance"]["face_edges"]["kind"] == "proxy"


@pytest.mark.asyncio
@pytest.mark.parametrize("metric", [None, "0.0", "bad", {}, [], True, False, float("nan"), float("inf"), float("-inf"), 10**400, -0.1, 1.1])
async def test_invalid_vision_numbers_do_not_turn_into_passes(sampled_review, monkeypatch, metric):
    review, _ = sampled_review
    monkeypatch.setattr(qc_frame_review, "call_vision_llm", AsyncMock(return_value={
        "identity_drift_score": metric, "expression_drift_score": metric,
        "provider_json_valid": True,
    }))
    report = await review(mode="vision-llm")
    assert_unmeasured(report, "identity", "expression")
    json.dumps(report, allow_nan=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("advisory", [{}, {"provider_json_valid": False, "identity_drift_score": 0.0, "expression_drift_score": 0.0}])
async def test_missing_or_invalid_vision_json_remains_unmeasured(sampled_review, monkeypatch, advisory):
    review, _ = sampled_review
    monkeypatch.setattr(qc_frame_review, "call_vision_llm", AsyncMock(return_value=advisory))
    assert_unmeasured(await review(mode="vision-llm"), "identity", "expression")


@pytest.mark.asyncio
@pytest.mark.parametrize("valid,flags,expected", [
    (True, [False], [False, None, None]),
    (True, [True, 0, "false", False], [True, None, None]),
    (False, [False, False, False], [None, None, None]),
])
async def test_advisory_face_flags_distinguish_missing_or_invalid_from_measured_absence(
    sampled_review, monkeypatch, valid, flags, expected,
):
    review, captures = sampled_review
    monkeypatch.setattr(qc_frame_review, "call_vision_llm", AsyncMock(return_value={
        "face_detected_per_frame": flags, "provider_json_valid": valid,
    }))
    report = await review(mode="vision-llm")
    assert report["face_detected_per_frame"] == expected
    assert len(captures[0]["labels"]) == report["frames_sampled"]
    assert any("unavailable" in label for label in captures[0]["labels"])
    if valid and expected[0] is False:
        assert "no face" in captures[0]["labels"][0]
    assert_unmeasured(report, "identity", "expression")


@pytest.mark.asyncio
async def test_valid_vision_assessments_are_independent_and_explicitly_advisory(sampled_review, monkeypatch):
    review, captures = sampled_review
    monkeypatch.setattr(qc_frame_review, "call_vision_llm", AsyncMock(return_value={
        "identity_drift_score": 0.2, "expression_drift_score": 0.8,
        "face_detected_per_frame": [True, False, "false"],
        "provider_json_valid": True, "vision_provider": "synthetic", "vision_model": "mock",
    }))
    report = await review(mode="vision-llm")
    assert report["identity_drift_score"] == 0.2
    assert report["expression_drift_score"] == 0.8
    assert report["pass_fail_summary"]["identity"] is True
    assert report["pass_fail_summary"]["expression"] is False
    assert report["face_detected_per_frame"] == [True, False, None]
    assert all(report["assessment_provenance"][k]["kind"] == "advisory" for k in ("identity", "expression"))
    assert "advisory" in captures[0]["footer"][0].lower()
    assert report["vision_provider"] == "synthetic"


@pytest.mark.asyncio
async def test_missing_expression_does_not_inherit_valid_identity_assessment(sampled_review, monkeypatch):
    review, _ = sampled_review
    monkeypatch.setattr(qc_frame_review, "call_vision_llm", AsyncMock(return_value={
        "identity_drift_score": 0.2, "provider_json_valid": True,
    }))
    report = await review(mode="vision-llm")
    assert report["pass_fail_summary"]["identity"] is True
    assert_unmeasured(report, "expression")


@pytest.mark.asyncio
@pytest.mark.parametrize("metric,verdict", [(0, True), (1, False)])
async def test_valid_vision_score_boundaries_remain_advisory(
    sampled_review, monkeypatch, metric, verdict,
):
    review, _ = sampled_review
    monkeypatch.setattr(qc_frame_review, "call_vision_llm", AsyncMock(return_value={
        "identity_drift_score": metric, "expression_drift_score": metric,
        "provider_json_valid": True,
    }))
    report = await review(mode="vision-llm")
    for check in ("identity", "expression"):
        assert report[f"{check}_drift_score"] == metric
        assert report["pass_fail_summary"][check] is verdict
        assert report["assessment_provenance"][check]["kind"] == "advisory"
