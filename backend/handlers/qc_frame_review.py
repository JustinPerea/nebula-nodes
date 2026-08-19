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
from services.qc_common import MAX_SAMPLE_FRAMES, clamp_score, evenly_spaced_points, extract_frames, open_rgb
from services.qc_metrics import detect_faces, frame_stability_metrics
from services.vision_llm import call_vision_llm


def _sample_rate(raw: Any) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 1.0
    return max(0.1, min(4.0, value))


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
        drift = {"identity_drift_score": 0.0, "expression_drift_score": 0.0}
        if mode == "opencv" and track_faces:
            detections, drift = detect_faces(frames)
        findings: dict[str, Any] = {
            "frames_sampled": len(frames),
            "face_detected_per_frame": [bool(boxes) for boxes in detections],
            **drift,
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
            for key in ("identity_drift_score", "expression_drift_score", "background_stability_score"):
                if key in advisory:
                    findings[key] = clamp_score(advisory[key], findings[key])
            face_flags = advisory.get("face_detected_per_frame")
            if isinstance(face_flags, list):
                findings["face_detected_per_frame"] = [bool(value) for value in face_flags[: len(frames)]]
                findings["face_detected_per_frame"] += [False] * (len(frames) - len(findings["face_detected_per_frame"]))
            findings["vision_provider"] = advisory.get("vision_provider")
            findings["vision_model"] = advisory.get("vision_model")
            findings["provider_json_valid"] = advisory.get("provider_json_valid", False)
        findings["pass_fail_summary"] = {
            "identity": findings["identity_drift_score"] <= 0.35,
            "expression": findings["expression_drift_score"] <= 0.45,
            "background": findings["background_stability_score"] >= 0.55,
        }

    boxes = {index: frame_boxes for index, frame_boxes in enumerate(detections) if frame_boxes}
    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Frame Review",
        labels=[f"Sample {index + 1} · {'face' if findings['face_detected_per_frame'][index] else 'no face'}" for index in range(len(frames))],
        boxes=boxes,
        footer=[
            f"Identity drift: {findings['identity_drift_score']:.3f} · Expression drift: {findings['expression_drift_score']:.3f}",
            f"Background stability: {findings['background_stability_score']:.3f} · Color drift: {findings['color_drift_score']:.3f}",
        ],
    )
