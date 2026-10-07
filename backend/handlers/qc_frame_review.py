"""Sampled-frame stability and face-drift analyzer."""

from __future__ import annotations

import math
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from handlers.qc_base import qc_mode, qc_outputs, required_video
from services.ffmpeg import ffprobe_video
from services.qc_common import MAX_SAMPLE_FRAMES, evenly_spaced_points, extract_frames, open_rgb
from services.qc_metrics import detect_faces, frame_stability_metrics
from services.vision_llm import call_vision_llm


def _sample_rate(raw: Any) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 1.0
    return max(0.1, min(4.0, value))


def _advisory_score(raw: Any) -> float | None:
    """Accept a bounded JSON number, never coerce missing evidence to zero."""
    if type(raw) not in (int, float):  # JSON booleans are not scores.
        return None
    try:
        value = float(raw)
    except OverflowError:
        return None
    return value if math.isfinite(value) and 0.0 <= value <= 1.0 else None


def _provenance(kind: str, reason: str) -> dict[str, str]:
    return {"kind": kind, "reason": reason}


def _drift_label(findings: dict[str, Any], check: str) -> str:
    value = findings[f"{check}_drift_score"]
    return "unmeasured" if value is None else f"{value:.3f} (advisory)"


async def handle_qc_frame_review(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    mode = qc_mode(node)
    source = required_video(inputs)
    probe = await ffprobe_video(source)
    count = max(3, min(MAX_SAMPLE_FRAMES, int(math.ceil(probe.duration * _sample_rate(node.params.get("sample_rate")))) + 1))
    track_faces = bool(node.params.get("track_faces", True))
    with tempfile.TemporaryDirectory(prefix="nebula-qc-frame-") as temp:
        paths = await extract_frames(source, evenly_spaced_points(count), Path(temp))
        frames = [open_rgb(path) for path in paths]
        stability = frame_stability_metrics(frames)
        detections: list[list[tuple[int, int, int, int]]] = [[] for _ in frames]
        unavailable_reason = (
            "face_tracking_disabled" if mode == "opencv" and not track_faces
            else "opencv_proxy_only" if mode == "opencv"
            else "invalid_or_missing_advisory_metric" if mode == "vision-llm"
            else "heuristic_not_supported"
        )
        provenance = {
            check: _provenance("unavailable", unavailable_reason)
            for check in ("identity", "expression")
        }
        for check in ("face_geometry", "face_edges"):
            reason = "face_tracking_disabled" if mode == "opencv" and not track_faces else "opencv_not_selected"
            provenance[check] = _provenance("unavailable", reason)
        face_flags: list[bool | None] = [None for _ in frames]
        coverage = None
        proxies: dict[str, float | None] = {
            "face_geometry_drift_score": None, "face_edge_drift_score": None,
        }
        if mode == "opencv" and track_faces:
            detections, proxies = detect_faces(frames)
            face_flags = [bool(boxes) for boxes in detections]
            detected_frames = sum(face_flags)
            coverage = {
                "detected_frames": detected_frames, "sampled_frames": len(frames),
                "fraction": round(detected_frames / len(frames), 4),
            }
            for check, key, reason in (
                ("face_geometry", "face_geometry_drift_score", "face_box_position_and_size"),
                ("face_edges", "face_edge_drift_score", "face_crop_edge_density"),
            ):
                provenance[check] = (
                    _provenance("proxy", reason) if proxies[key] is not None
                    else _provenance("unavailable", "insufficient_face_detections")
                )
        findings: dict[str, Any] = {
            "frames_sampled": len(frames),
            "face_detected_per_frame": face_flags,
            "face_detection_coverage": coverage,
            "identity_drift_score": None,
            "expression_drift_score": None,
            "assessment_provenance": provenance,
            **proxies,
            **stability,
        }
        if mode == "vision-llm":
            advisory = await call_vision_llm(
                api_keys,
                system_prompt="You review sampled video frames for identity, expression, and background consistency and return JSON.",
                images=paths,
                user_prompt=(
                    "Return identity_drift_score, expression_drift_score, and "
                    "background_stability_score as 0..1 numbers plus "
                    "face_detected_per_frame as booleans. Higher drift is worse; "
                    "higher stability is better."
                ),
            )
            if advisory.get("provider_json_valid") is True:
                for check in ("identity", "expression"):
                    key = f"{check}_drift_score"
                    score = _advisory_score(advisory.get(key))
                    if score is not None:
                        findings[key] = score
                        provenance[check] = _provenance("advisory", "vision_llm_assessment")
                background_score = _advisory_score(advisory.get("background_stability_score"))
                if background_score is not None:
                    findings["background_stability_score"] = background_score
                advisory_flags = advisory.get("face_detected_per_frame")
                if isinstance(advisory_flags, list):
                    flags = [value if type(value) is bool else None for value in advisory_flags[: len(frames)]]
                    findings["face_detected_per_frame"] = flags + [None] * (len(frames) - len(flags))
            findings["vision_provider"] = advisory.get("vision_provider")
            findings["vision_model"] = advisory.get("vision_model")
            findings["provider_json_valid"] = advisory.get("provider_json_valid", False)
        findings["pass_fail_summary"] = {
            check: None if findings[f"{check}_drift_score"] is None else findings[f"{check}_drift_score"] <= threshold
            for check, threshold in (("identity", 0.35), ("expression", 0.45))
        }
        findings["pass_fail_summary"].update({
            "background": findings["background_stability_score"] >= 0.55,
        })

    boxes = {index: frame_boxes for index, frame_boxes in enumerate(detections) if frame_boxes}
    footer = [
        f"Identity drift: {_drift_label(findings, 'identity')} · Expression drift: {_drift_label(findings, 'expression')}",
        f"Background stability: {findings['background_stability_score']:.3f} · Color drift: {findings['color_drift_score']:.3f}",
    ]
    if findings["face_geometry_drift_score"] is not None:
        footer.append(
            f"Face geometry proxy: {findings['face_geometry_drift_score']:.3f} · Face edge proxy: {findings['face_edge_drift_score']:.3f}"
        )
    if coverage is not None:
        footer.append(f"Face detections: {coverage['detected_frames']}/{coverage['sampled_frames']} sampled frames")

    def face_label(flag: bool | None) -> str:
        return "face detection unavailable" if flag is None else "face" if flag else "no face"

    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Frame Review",
        labels=[f"Sample {index + 1} · {face_label(flag)}" for index, flag in enumerate(findings["face_detected_per_frame"])],
        boxes=boxes,
        footer=footer,
    )
