"""Camera-angle, motion, and perspective verification analyzer."""

from __future__ import annotations

import math
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from handlers.qc_base import optional_reference, qc_mode, qc_outputs, required_video
from services.qc_common import clamp_score, evenly_spaced_points, extract_frames, open_rgb
from services import qc_jev
from services.qc_metrics import camera_geometry_metrics
from services.vision_llm import call_vision_llm

# Jev mode answers the camera's angle and motion direction as Choices. The
# measured numbers (motion magnitudes, horizon, vanishing points, distortion,
# homographies) aren't typed answers, so they stay the local metrics.
MOTION_QUESTIONS = {"pan": "turn left or right", "tilt": "tilt up or down", "zoom": "zoom or move in or out"}
MOTION_AXES = {
    "pan": (("left", "The camera turns to its left (the scene slides right in frame)"),
            ("none", "The camera doesn't turn left or right"),
            ("right", "The camera turns to its right (the scene slides left in frame)")),
    "tilt": (("up", "The camera tilts up (the scene slides down in frame)"),
             ("none", "The camera doesn't tilt up or down"),
             ("down", "The camera tilts down (the scene slides up in frame)")),
    "zoom": (("in", "The camera zooms or pushes in (the subject grows in frame)"),
             ("none", "The camera doesn't zoom or move closer or further away"),
             ("out", "The camera zooms or pulls out (the subject shrinks in frame)")),
}


def _jev_checks(names: tuple[str, ...], expected_angle: str, has_reference: bool) -> list[qc_jev.Check]:
    """Angle and motion describe the shot and never gate. The expected-angle
    and reference checks are must-pass, and only asked when set."""
    frames = qc_jev.frame_list([name for name in names if name != "reference"])
    checks = [
        qc_jev.Check(
            "angle", "choice", f"Across {frames}, where is the camera relative to the main subject?",
            must_pass=False,
            options=(("low-angle", "Below the subject, looking up at it"),
                     ("eye-level", "Level with the subject"),
                     ("high-angle", "Above the subject, looking down on it"))),
    ]
    checks += [
        qc_jev.Check(axis, "choice",
                     f"From the first to the last of {frames}, does the camera {MOTION_QUESTIONS[axis]}?",
                     must_pass=False, options=options)
        for axis, options in MOTION_AXES.items()
    ]
    if expected_angle:
        checks.append(qc_jev.Check(
            "expected_angle", "noul",
            f"Does the camera angle and movement in {frames} match this description: \"{expected_angle}\"?",
            pass_on="yes"))
    if has_reference:
        checks.append(qc_jev.Check(
            "reference_match", "score", f"How closely does the framing in {frames} match `reference`?",
            levels=("A different shot", "The same subject, clearly different framing",
                    "Close to the same framing", "The same framing"),
            pass_at_least=0.5))
    return checks


def _apply_jev(findings: dict[str, Any], run: qc_jev.JevRun) -> None:
    angle = run["angle"]
    findings["detected_camera_angle"] = angle.answer if angle.confident else "undetermined"
    findings["geometry_confidence"] = clamp_score(angle.confidence)
    findings["motion_direction"] = {axis: run[axis].answer if run[axis].confident else "unsure"
                                    for axis in MOTION_AXES}
    expected = run.get("expected_angle")
    findings["expected_angle_match"] = None if expected is None else expected.verdict
    reference = run.get("reference_match")
    if reference is not None:
        findings["reference_match_score"] = clamp_score(reference.value)
    findings["jev"] = run.report()
    if run.verdict is None:
        findings["jev"]["notes"].append(
            "No must-pass checks: set Expected Angle or connect a Reference Frame to get a pass verdict.")
    findings.update(qc_jev.provenance_fields(run))


def _motion(value: Any, fallback: dict[str, float]) -> dict[str, float]:
    if not isinstance(value, dict):
        return fallback
    result: dict[str, float] = {}
    for key in ("pan", "tilt", "zoom"):
        try:
            number = float(value.get(key, fallback[key]))
        except (TypeError, ValueError):
            number = fallback[key]
        result[key] = round(number if math.isfinite(number) else fallback[key], 4)
    return result


async def handle_qc_camera_geometry(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    mode = qc_mode(node)
    jev = qc_jev.setup(node.params, api_keys) if mode == qc_jev.JEV_MODE else None
    source = required_video(inputs)
    reference_path = optional_reference(inputs)
    expected_angle = str(node.params.get("expected_angle", "") or "").strip()[:120]
    with tempfile.TemporaryDirectory(prefix="nebula-qc-camera-") as temp:
        paths = await extract_frames(source, evenly_spaced_points(5), Path(temp))
        frames = [open_rgb(path) for path in paths]
        reference = open_rgb(reference_path) if reference_path else None
        findings = camera_geometry_metrics(frames, reference=reference, opencv=mode == "opencv")
        findings["expected_angle"] = expected_angle or None
        if mode == "vision-llm":
            vision_images = list(paths)
            if reference_path:
                vision_images.append(reference_path)
            advisory = await call_vision_llm(
                api_keys,
                system_prompt="You verify camera angle, perspective, and motion from sampled video frames and return JSON.",
                images=vision_images,
                user_prompt=(
                    f"Expected angle: {expected_angle or 'unspecified'}. "
                    f"A final image is {'a reference frame' if reference_path else 'not provided'}. "
                    "Return detected_camera_angle, motion_estimate with pan/tilt/zoom, "
                    "reference_match_score or null, and geometry_confidence (0..1)."
                ),
            )
            if isinstance(advisory.get("detected_camera_angle"), str):
                findings["detected_camera_angle"] = advisory["detected_camera_angle"][:120]
            findings["motion_estimate"] = _motion(advisory.get("motion_estimate"), findings["motion_estimate"])
            if reference_path and advisory.get("reference_match_score") is not None:
                findings["reference_match_score"] = clamp_score(advisory["reference_match_score"], findings["reference_match_score"] or 0.0)
            findings["geometry_confidence"] = clamp_score(advisory.get("geometry_confidence"), findings["geometry_confidence"])
            findings["vision_provider"] = advisory.get("vision_provider")
            findings["vision_model"] = advisory.get("vision_model")
            findings["provider_json_valid"] = advisory.get("provider_json_valid", False)
        if jev is not None:
            extras = [("reference", reference)] if reference is not None else []
            frames_sent = await qc_jev.prepare_frames(frames, extras=extras)
            run = await qc_jev.ask(jev, frames=frames_sent,
                                   checks=_jev_checks(frames_sent.names, expected_angle, reference is not None))
            _apply_jev(findings, run)

    horizon = findings["horizon_line"]
    footer = [
        f"Detected: {findings['detected_camera_angle']} · Expected: {expected_angle or 'unspecified'}",
        f"Horizon: {horizon['y']:.3f} ({horizon['confidence']:.2f})" if horizon else "Horizon: not detected",
        f"Motion p/t/z: {findings['motion_estimate']['pan']:.3f} / {findings['motion_estimate']['tilt']:.3f} / {findings['motion_estimate']['zoom']:.3f}",
    ]
    if jev is not None:
        direction = findings["motion_direction"]
        footer.append(f"Jev motion: pan {direction['pan']} · tilt {direction['tilt']} · zoom {direction['zoom']}")
        footer.append(run.footer())
    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Camera Geometry",
        labels=[f"Sample {index + 1}" for index in range(len(frames))],
        footer=footer,
    )
