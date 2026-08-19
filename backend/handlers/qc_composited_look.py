"""Scene-integration and composited-look analyzer."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from handlers.qc_base import qc_mode, qc_outputs, required_video
from services.qc_common import as_string_list, bounded_sample_count, clamp_score, evenly_spaced_points, extract_frames, open_rgb
from services.qc_metrics import compositing_metrics
from services.vision_llm import call_vision_llm

ARTIFACT_TYPES = {"edge_spill", "light_mismatch", "depth_inconsistency", "cutout_appearance", "chroma_key"}


async def handle_qc_composited_look(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    mode = qc_mode(node)
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

    artifacts = findings["compositing_artifacts"]
    return qc_outputs(
        node,
        mode=mode,
        findings=findings,
        frames=frames,
        title="Composited Look",
        labels=[f"Sample {index + 1}" for index in range(len(frames))],
        footer=[
            f"Integration: {findings['overall_integration_score']:.3f} · Light match: {findings['light_match_score']:.3f}",
            f"Artifacts: {', '.join(artifacts) if artifacts else 'none detected'}",
        ],
    )
