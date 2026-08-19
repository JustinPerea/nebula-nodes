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
from services.qc_metrics import camera_geometry_metrics
from services.vision_llm import call_vision_llm


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

    horizon = findings["horizon_line"]
    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Camera Geometry",
        labels=[f"Sample {index + 1}" for index in range(len(frames))],
        footer=[
            f"Detected: {findings['detected_camera_angle']} · Expected: {expected_angle or 'unspecified'}",
            f"Horizon: {horizon['y']:.3f} ({horizon['confidence']:.2f})" if horizon else "Horizon: not detected",
            f"Motion p/t/z: {findings['motion_estimate']['pan']:.3f} / {findings['motion_estimate']['tilt']:.3f} / {findings['motion_estimate']['zoom']:.3f}",
        ],
    )
