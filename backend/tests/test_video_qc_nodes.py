from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from models.graph import GraphNode, PortValueDict
from models.graph import GraphEdge
from models.events import ExecutedEvent, GraphCompleteEvent
from execution.engine import execute_graph
from services import output as output_service
from services.qc_metrics import (
    camera_geometry_metrics,
    compositing_metrics,
    frame_stability_metrics,
    loop_metrics,
)

QC_IDS = {
    "qc-loop-safety",
    "qc-frame-review",
    "qc-composited-look",
    "qc-camera-geometry",
}


@pytest.fixture(scope="module")
def qc_clip() -> Path:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is required for Video QC extraction tests")
    path = output_service.OUTPUT_ROOT / "qc-tests" / "synthetic.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=4",
            "-t", "1.25", "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
        timeout=30,
    )
    return path


def _node(definition_id: str, **params: object) -> GraphNode:
    return GraphNode(id=f"test-{definition_id}", definitionId=definition_id, params=params)


def _inputs(path: Path) -> dict[str, PortValueDict]:
    rel = path.relative_to(output_service.OUTPUT_ROOT)
    return {"video": PortValueDict(type="Video", value=f"/api/outputs/{rel}")}


def test_local_metrics_are_bounded_and_json_serializable() -> None:
    first = Image.new("RGB", (160, 90), "#224466")
    second = Image.new("RGB", (160, 90), "#335577")
    frames = [first, second, first]
    reports = [
        loop_metrics(frames, opencv=True),
        frame_stability_metrics(frames),
        compositing_metrics(frames, opencv=True),
        camera_geometry_metrics(frames, reference=first, opencv=True),
    ]
    json.dumps(reports, allow_nan=False)
    assert 0 <= reports[0]["seam_score"] <= 1
    assert 0 <= reports[1]["background_stability_score"] <= 1
    assert 0 <= reports[2]["overall_integration_score"] <= 1
    assert 0 <= reports[3]["geometry_confidence"] <= 1


def test_heuristic_metrics_do_not_require_optional_cv_packages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services import qc_metrics

    first = Image.new("RGB", (160, 90), "#224466")
    second = Image.new("RGB", (160, 90), "#335577")
    frames = [first, second, first]
    monkeypatch.setattr(qc_metrics, "cv2", None)
    monkeypatch.setattr(qc_metrics, "structural_similarity", None)

    reports = [
        qc_metrics.loop_metrics(frames, opencv=False),
        qc_metrics.frame_stability_metrics(frames),
        qc_metrics.compositing_metrics(frames, opencv=False),
        qc_metrics.camera_geometry_metrics(frames, reference=first, opencv=False),
    ]
    json.dumps(reports, allow_nan=False)
    assert all(0 <= report[key] <= 1 for report, key in [
        (reports[0], "seam_score"),
        (reports[1], "background_stability_score"),
        (reports[2], "overall_integration_score"),
        (reports[3], "geometry_confidence"),
    ])


def test_opencv_mode_fails_with_actionable_dependency_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from services import qc_metrics

    monkeypatch.setattr(qc_metrics, "cv2", None)
    frames = [Image.new("RGB", (64, 36), "black"), Image.new("RGB", (64, 36), "white")]
    with pytest.raises(RuntimeError, match="install backend/requirements.txt"):
        qc_metrics.loop_metrics(frames, opencv=True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("definition_id", "module_name", "handler_name", "expected_fields"),
    [
        ("qc-loop-safety", "handlers.qc_loop_safety", "handle_qc_loop_safety", {"seam_score", "loop_safe", "discontinuity_type", "frame_analysis"}),
        ("qc-frame-review", "handlers.qc_frame_review", "handle_qc_frame_review", {"identity_drift_score", "expression_drift_score", "background_stability_score", "pass_fail_summary"}),
        ("qc-composited-look", "handlers.qc_composited_look", "handle_qc_composited_look", {"compositing_artifacts", "overall_integration_score"}),
        ("qc-camera-geometry", "handlers.qc_camera_geometry", "handle_qc_camera_geometry", {"detected_camera_angle", "motion_estimate", "lens_distortion_estimate"}),
    ],
)
async def test_keyless_local_modes_emit_png_and_structured_report(
    qc_clip: Path,
    definition_id: str,
    module_name: str,
    handler_name: str,
    expected_fields: set[str],
) -> None:
    module = __import__(module_name, fromlist=[handler_name])
    handler = getattr(module, handler_name)
    result = await handler(_node(definition_id, mode="opencv"), _inputs(qc_clip), {}, emit=None)
    assert set(result) == {"frame", "text"}
    assert result["frame"]["type"] == "Image"
    assert result["frame"]["value"].startswith("/api/outputs/")
    frame_path = output_service.OUTPUT_ROOT / result["frame"]["value"].removeprefix("/api/outputs/")
    with Image.open(frame_path) as image:
        image.verify()
        assert image.format == "PNG"
    report = json.loads(result["text"]["value"])
    assert expected_fields <= report.keys()
    assert report["mode"] == "opencv"
    assert report["node_id"] == f"test-{definition_id}"


@pytest.mark.asyncio
@pytest.mark.parametrize("definition_id", sorted(QC_IDS))
async def test_qc_nodes_execute_through_real_engine_registry(
    qc_clip: Path,
    definition_id: str,
) -> None:
    from execution.sync_runner import get_handler_registry

    rel = qc_clip.relative_to(output_service.OUTPUT_ROOT)
    source = GraphNode(
        id="source",
        definitionId="video-input",
        params={"filePath": f"/api/outputs/{rel}"},
    )
    analyzer = _node(definition_id, mode="heuristic")
    edge = GraphEdge(
        id="edge",
        source="source",
        sourceHandle="video",
        target=analyzer.id,
        targetHandle="video",
    )
    events = []

    async def emit(event) -> None:
        events.append(event)

    await execute_graph(
        nodes=[source, analyzer],
        edges=[edge],
        api_keys={},
        handler_registry=get_handler_registry(emit=emit),
        emit=emit,
        run_id=f"engine-{definition_id}",
    )

    executed = [event for event in events if isinstance(event, ExecutedEvent) and event.node_id == analyzer.id]
    assert len(executed) == 1
    assert set(executed[0].outputs) == {"frame", "text"}
    assert isinstance(events[-1], GraphCompleteEvent)


@pytest.mark.asyncio
async def test_vision_advisory_is_coerced_and_provider_is_recorded(
    qc_clip: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from handlers import qc_loop_safety

    monkeypatch.setattr(
        qc_loop_safety,
        "call_vision_llm",
        AsyncMock(return_value={
            "seam_score": 7,
            "loop_safe": False,
            "discontinuity_type": "semantic jump",
            "provider_json_valid": True,
            "vision_provider": "anthropic",
            "vision_model": "mock",
        }),
    )
    result = await qc_loop_safety.handle_qc_loop_safety(
        _node("qc-loop-safety", mode="vision-llm"), _inputs(qc_clip), {}, emit=None
    )
    report = json.loads(result["text"]["value"])
    assert report["seam_score"] == 1.0
    assert report["vision_provider"] == "anthropic"
    assert report["provider_json_valid"] is True


def test_definitions_and_frontend_mirror_match_contract() -> None:
    repo = Path(__file__).resolve().parents[2]
    definitions = json.loads((repo / "backend/data/node_definitions.json").read_text())
    assert len(definitions) == 172
    frontend = (repo / "frontend/src/constants/nodeDefinitions.ts").read_text()
    for definition_id in QC_IDS:
        definition = definitions[definition_id]
        assert definition["category"] == "analyzer"
        assert definition["apiProvider"] == "utility"
        assert definition["envKeyName"] == []
        assert definition["executionPattern"] == "sync"
        assert definition["inputPorts"][0]["dataType"] == "Video"
        assert {port["dataType"] for port in definition["outputPorts"]} == {"Image", "Text"}
        mode = next(param for param in definition["params"] if param["key"] == "mode")
        assert {option["value"] for option in mode["options"]} == {"heuristic", "vision-llm", "opencv"}
        assert f"'{definition_id}':" in frontend


def test_sync_registry_contains_all_video_qc_handlers() -> None:
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    assert QC_IDS <= registry.keys()


def test_shared_frontend_renderer_is_wired() -> None:
    repo = Path(__file__).resolve().parents[2]
    canvas = (repo / "frontend/src/components/Canvas.tsx").read_text()
    store = (repo / "frontend/src/store/graphStore.ts").read_text()
    backend = (repo / "backend/main.py").read_text()
    assert "videoQcNode: VideoQcNode" in canvas
    assert "definitionId.startsWith('qc-')" in store
    assert 'else "videoQcNode"' in backend
