"""Loop-boundary safety analyzer."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from handlers.qc_base import qc_mode, qc_outputs, required_video
from services.qc_common import bounded_sample_count, evenly_spaced_points, extract_frames, open_rgb, clamp_score
from services.qc_metrics import loop_metrics
from services.vision_llm import call_vision_llm


async def handle_qc_loop_safety(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    mode = qc_mode(node)
    source = required_video(inputs)
    count = bounded_sample_count(node.params.get("sample_density"), default=5)
    with tempfile.TemporaryDirectory(prefix="nebula-qc-loop-") as temp:
        paths = await extract_frames(source, evenly_spaced_points(count), Path(temp))
        frames = [open_rgb(path) for path in paths]
        findings = loop_metrics(frames, opencv=mode == "opencv")
        if mode == "vision-llm":
            advisory = await call_vision_llm(
                api_keys,
                system_prompt="You inspect video loop boundaries and return conservative quality-control JSON.",
                images=[paths[0], paths[-1]],
                user_prompt=(
                    "Compare the first and last frame for loop continuity. Return keys "
                    "seam_score (0..1), loop_safe (boolean), discontinuity_type, and "
                    "frame_analysis (object)."
                ),
            )
            if "seam_score" in advisory:
                findings["seam_score"] = clamp_score(advisory["seam_score"], findings["seam_score"])
            if isinstance(advisory.get("loop_safe"), bool):
                findings["loop_safe"] = advisory["loop_safe"]
            if isinstance(advisory.get("discontinuity_type"), str):
                findings["discontinuity_type"] = advisory["discontinuity_type"][:80]
            findings["vision_provider"] = advisory.get("vision_provider")
            findings["vision_model"] = advisory.get("vision_model")
            findings["provider_json_valid"] = advisory.get("provider_json_valid", False)

    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=[frames[0], frames[-1]],
        title="Loop Safety",
        labels=["First frame", "Last frame"],
        footer=[
            f"Seam score: {findings['seam_score']:.3f}",
            f"Loop safe: {'yes' if findings['loop_safe'] else 'no'} · {findings['discontinuity_type']}",
        ],
    )
