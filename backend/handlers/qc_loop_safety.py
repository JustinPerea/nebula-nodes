"""Loop-boundary safety analyzer."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from handlers.qc_base import qc_mode, qc_outputs, required_video
from services.qc_common import bounded_sample_count, evenly_spaced_points, extract_frames, open_rgb, clamp_score
from services import qc_jev
from services.qc_metrics import loop_metrics
from services.vision_llm import call_vision_llm

# Jev mode: one yes/no per thing a loop seam can break, each must pass. The
# value is the discontinuity_type a failure reports (the heuristic's names).
JEV_CHECKS = (
    (qc_jev.Check(
        "lighting", "noul",
        "Do `first_frame` and `last_frame` have the same lighting, exposure and colour?",
        pass_on="yes", no_means="The light, exposure or colour visibly shifts between the two frames"),
     "color_or_lighting"),
    (qc_jev.Check(
        "content", "noul",
        "Are the same people and objects in the same places and poses in `first_frame` and `last_frame`?",
        pass_on="yes", no_means="Something moved, appeared, disappeared or changed shape between the two frames"),
     "position_or_content"),
    (qc_jev.Check(
        "camera", "noul",
        "Is the camera in the same position, angle and zoom in `first_frame` and `last_frame`?",
        pass_on="yes", no_means="The framing shifted, rotated or zoomed between the two frames"),
     "motion"),
)


def _apply_jev(findings: dict[str, Any], run: qc_jev.JevRun) -> None:
    """Overwrite the loop verdict with Jev's. Unsure is never loop_safe."""
    lowest = run.min_pass_probability
    if lowest is not None:
        findings["seam_score"] = clamp_score(lowest)
    findings["loop_safe"] = run.verdict == qc_jev.PASS
    failed = run.failed()
    if failed:
        worst = min(failed, key=lambda item: item.pass_probability or 0.0)
        findings["discontinuity_type"] = dict((check.id, kind) for check, kind in JEV_CHECKS)[worst.check.id]
    else:
        findings["discontinuity_type"] = "none" if run.verdict == qc_jev.PASS else "unsure"
    findings["jev"] = run.report()
    findings.update(qc_jev.provenance_fields(run))


async def handle_qc_loop_safety(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    mode = qc_mode(node)
    jev = qc_jev.setup(node.params, api_keys) if mode == qc_jev.JEV_MODE else None
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
        if jev is not None:
            frames_sent = await qc_jev.prepare_frames(
                frames, indices=[0, len(frames) - 1], names=["first_frame", "last_frame"])
            run = await qc_jev.ask(jev, frames=frames_sent, checks=[check for check, _ in JEV_CHECKS])
            _apply_jev(findings, run)

    footer = [
        f"Seam score: {findings['seam_score']:.3f}",
        f"Loop safe: {'yes' if findings['loop_safe'] else 'no'} · {findings['discontinuity_type']}",
    ]
    if jev is not None:
        footer.append(run.footer())
    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=[frames[0], frames[-1]],
        title="Loop Safety",
        labels=["First frame", "Last frame"],
        footer=footer,
    )
