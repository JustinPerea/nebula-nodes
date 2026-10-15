"""Scene-integration and composited-look analyzer."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from handlers.qc_base import qc_mode, qc_outputs, required_video
from services.qc_common import as_string_list, bounded_sample_count, clamp_score, evenly_spaced_points, extract_frames, open_rgb
from services import qc_jev
from services.qc_metrics import compositing_metrics
from services.vision_llm import call_vision_llm

ARTIFACT_TYPES = {"edge_spill", "light_mismatch", "depth_inconsistency", "cutout_appearance", "chroma_key"}


JEV_ARTIFACTS = {"edge_spill": "edge_spill", "light_match": "light_mismatch", "depth": "depth_inconsistency",
                 "cutout": "cutout_appearance", "chroma_key": "chroma_key"}


def _jev_checks(frames: str) -> list[qc_jev.Check]:
    """One must-pass yes/no per artifact type, over every frame sent.

    A failed check adds its JEV_ARTIFACTS type to compositing_artifacts. Some
    are asked as "is the flaw there?" (pass on no) because that is how a
    person checks for it; the pass rule says which answer passes."""
    return [
        qc_jev.Check(
            "edge_spill", "noul",
            f"In any of {frames}, is there a visible halo, fringe or colour spill along the edge of a "
            "foreground subject?", pass_on="no"),
        qc_jev.Check(
            "light_match", "noul",
            f"In every one of {frames}, does the light on the foreground subject (direction, colour and "
            "brightness) match the light in the rest of the scene?", pass_on="yes"),
        qc_jev.Check(
            "depth", "noul",
            f"In every one of {frames}, does the foreground subject sit believably in the scene's depth "
            "(its scale, focus, shadows and contact with the ground)?", pass_on="yes"),
        qc_jev.Check(
            "cutout", "noul",
            f"In any of {frames}, does a foreground subject look cut out and pasted onto the background?",
            pass_on="no"),
        qc_jev.Check(
            "chroma_key", "noul",
            f"In any of {frames}, is green-screen or blue-screen colour visible?", pass_on="no"),
    ]


def _apply_jev(findings: dict[str, Any], run: qc_jev.JevRun) -> None:
    """Scores are each check's probability of the flaw (or of the match);
    overall integration is the lowest pass probability, so one failed check
    can't be averaged away. An unsure check is listed in jev.unsure, not as
    an artifact, and never as clean."""
    findings["edge_spill_score"] = clamp_score(run["edge_spill"].value)
    findings["light_match_score"] = clamp_score(run["light_match"].value)
    findings["depth_consistency_score"] = clamp_score(run["depth"].value)
    findings["cutout_appearance_score"] = clamp_score(run["cutout"].value)
    lowest = run.min_pass_probability
    findings["overall_integration_score"] = clamp_score(lowest if lowest is not None else 0.0)
    findings["compositing_artifacts"] = [JEV_ARTIFACTS[item.check.id] for item in run.failed()]
    chroma = run["chroma_key"].verdict
    findings["chroma_key_detected"] = None if chroma == qc_jev.UNSURE else chroma == qc_jev.FAIL
    findings["jev"] = run.report()
    findings.update(qc_jev.provenance_fields(run))


async def handle_qc_composited_look(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    mode = qc_mode(node)
    jev = qc_jev.setup(node.params, api_keys) if mode == qc_jev.JEV_MODE else None
    source = required_video(inputs)
    count = bounded_sample_count(node.params.get("sample_density"), default=5)
    with tempfile.TemporaryDirectory(prefix="nebula-qc-composite-") as temp:
        paths = await extract_frames(source, evenly_spaced_points(count), Path(temp))
        frames = [open_rgb(path) for path in paths]
        findings = compositing_metrics(frames, opencv=mode == "opencv")
        if mode == "vision-llm":
            advisory = await call_vision_llm(
                api_keys,
                system_prompt="You detect compositing artifacts across video frames and return conservative JSON quality scores.",
                images=paths,
                user_prompt=(
                    "Return compositing_artifacts and 0..1 edge_spill_score, "
                    "light_match_score, depth_consistency_score, "
                    "cutout_appearance_score, and overall_integration_score."
                ),
            )
            findings["compositing_artifacts"] = as_string_list(advisory.get("compositing_artifacts"), allowed=ARTIFACT_TYPES)
            for key in ("edge_spill_score", "light_match_score", "depth_consistency_score", "cutout_appearance_score", "overall_integration_score"):
                if key in advisory:
                    findings[key] = clamp_score(advisory[key], findings[key])
            findings["vision_provider"] = advisory.get("vision_provider")
            findings["vision_model"] = advisory.get("vision_model")
            findings["provider_json_valid"] = advisory.get("provider_json_valid", False)
        sent: tuple[int, ...] = ()
        if jev is not None:
            frames_sent = await qc_jev.prepare_frames(frames)
            sent = frames_sent.sent
            run = await qc_jev.ask(jev, frames=frames_sent,
                                   checks=_jev_checks(qc_jev.frame_list(frames_sent.names)))
            _apply_jev(findings, run)

    artifacts = findings["compositing_artifacts"]
    footer = [
        f"Integration: {findings['overall_integration_score']:.3f} · Light match: {findings['light_match_score']:.3f}",
        f"Artifacts: {', '.join(artifacts) if artifacts else 'none detected'}",
    ]
    if jev is not None:
        unsure = run.unsure()
        if unsure:
            footer.append(f"Unsure: {', '.join(unsure)}")
        footer.append(run.footer())
    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Composited Look",
        labels=[f"Sample {index + 1}{' · sent to Jev' if index + 1 in sent else ''}" for index in range(len(frames))],
        footer=footer,
    )
