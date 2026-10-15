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
from services import qc_jev
from services.qc_metrics import detect_faces, frame_stability_metrics
from services.vision_llm import call_vision_llm

# The same pass lines as the other modes (pass_fail_summary below).
IDENTITY_DRIFT_MAX, EXPRESSION_DRIFT_MAX, BACKGROUND_STABILITY_MIN = 0.35, 0.45, 0.55
SAME_PERSON, CHANGED_PERSON, NO_FACE = "same person", "different person", "no face"


def _jev_checks(names: tuple[str, ...], track_faces: bool) -> list[qc_jev.Check]:
    """Identity, expression and background as one question each, plus a
    yes/no face check per frame when face tracking is on.

    Identity is a Choice with a "no face" option, so a clip without people
    reads as not applicable instead of passing or failing. Expression drift
    is a Score, because some change is natural and the other modes grade it."""
    frames = qc_jev.frame_list(names)
    checks = [
        qc_jev.Check(
            "identity", "choice",
            f"Across {frames}, is the main person the same person throughout?",
            options=(
                (SAME_PERSON, "The same person in every frame where a face is visible"),
                (CHANGED_PERSON, "The face changes into a different person, or morphs, between frames"),
                (NO_FACE, "No person's face is visible in any of the frames"),
            ),
            passing=(SAME_PERSON,), not_applicable=(NO_FACE,)),
        qc_jev.Check(
            "expression", "score",
            f"Across {frames}, how much does the main person's facial expression change without a reason "
            "in the action?",
            levels=(
                "The expression is steady or changes naturally with the action",
                "Small changes that the action doesn't explain",
                "Clear changes that the action doesn't explain",
                "The face warps, or the expression jumps between frames",
            ),
            pass_at_most=EXPRESSION_DRIFT_MAX),
        qc_jev.Check(
            "background", "noul",
            f"Does the background stay the same across {frames}, with no warping, flicker, or objects "
            "appearing or disappearing?",
            pass_on="yes", no_means="The background warps, flickers, or something in it appears, vanishes or "
                                    "changes shape"),
    ]
    if track_faces:
        checks += [
            qc_jev.Check(f"face_{name}", "noul", f"Is a human face visible in `{name}`?", must_pass=False)
            for name in names
        ]
    return checks


def _apply_jev(findings: dict[str, Any], run: qc_jev.JevRun, provenance: dict[str, Any],
               names: tuple[str, ...], sent: tuple[int, ...], track_faces: bool) -> None:
    """Jev's drift scores and per-check verdicts. pass_fail_summary keeps its
    True/False/None shape; an unsure check is None there (never a pass) and
    "unsure" in jev.checks."""
    identity, expression, background = run["identity"], run["expression"], run["background"]
    summary: dict[str, Any] = {}
    if identity.verdict == qc_jev.NOT_APPLICABLE:
        run.set_not_applicable("expression", "Jev saw no face in the frames")
        for check in ("identity", "expression"):
            findings[f"{check}_drift_score"] = None
            provenance[check] = _provenance("unavailable", "jev_no_face_seen")
            summary[check] = None
    else:
        same, changed = identity.probability(SAME_PERSON), identity.probability(CHANGED_PERSON)
        findings["identity_drift_score"] = round(changed / (same + changed), 4) if same + changed > 0 else None
        findings["expression_drift_score"] = round(expression.value, 4)
        for check, item in (("identity", identity), ("expression", expression)):
            provenance[check] = _provenance("advisory", "jev_" + ("confident" if item.confident else "unsure"))
            summary[check] = None if item.verdict == qc_jev.UNSURE else item.verdict == qc_jev.PASS
    findings["background_stability_score"] = round(background.value, 4)
    summary["background"] = None if background.verdict == qc_jev.UNSURE else background.verdict == qc_jev.PASS
    findings["pass_fail_summary"] = summary
    if track_faces:
        flags: list[bool | None] = [None] * findings["frames_sampled"]
        for name, sample in zip(names, sent):
            item = run[f"face_{name}"]
            flags[sample - 1] = (item.answer == "yes") if item.confident else None
        findings["face_detected_per_frame"] = flags
    findings["jev"] = run.report()
    findings.update(qc_jev.provenance_fields(run))


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
    jev = qc_jev.setup(node.params, api_keys) if mode == qc_jev.JEV_MODE else None
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
            else "invalid_or_missing_advisory_metric" if mode in ("vision-llm", qc_jev.JEV_MODE)
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
            for check, threshold in (("identity", IDENTITY_DRIFT_MAX), ("expression", EXPRESSION_DRIFT_MAX))
        }
        findings["pass_fail_summary"].update({
            "background": findings["background_stability_score"] >= BACKGROUND_STABILITY_MIN,
        })
        sent: tuple[int, ...] = ()
        if jev is not None:
            frames_sent = await qc_jev.prepare_frames(frames)
            sent = frames_sent.sent
            run = await qc_jev.ask(jev, frames=frames_sent, checks=_jev_checks(frames_sent.names, track_faces))
            _apply_jev(findings, run, provenance, frames_sent.names, sent, track_faces)

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
    if jev is not None:
        footer.append(run.footer())

    def face_label(flag: bool | None) -> str:
        return "face detection unavailable" if flag is None else "face" if flag else "no face"

    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Frame Review",
        labels=[f"Sample {index + 1} · {face_label(flag)}{' · Jev' if index + 1 in sent else ''}"
                for index, flag in enumerate(findings["face_detected_per_frame"])],
        boxes=boxes,
        footer=footer,
    )
