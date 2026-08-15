"""video-duration-check analyzer node tests.

Local analyzer node: probes the incoming video with ffprobe (mocked here — no
real subprocess, no live API calls) and compares the landed duration against
the requested duration from the `requested_duration` input port (Text) or,
when unconnected, the `requested_duration` float param.

Outputs:
  - text: JSON report {requested_duration, landed_duration, match, delta_seconds}
  - match: "true" / "false" (0.5s tolerance)
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from models.graph import GraphNode, PortValueDict
from services.ffmpeg import ProbeResult


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="n1", definitionId="video-duration-check", params=params or {})


def _probe(duration: float) -> ProbeResult:
    return ProbeResult(duration=duration, fps=30.0, is_vfr=False)


def _make_video(tmp_path: Path, name: str = "clip.mp4") -> Path:
    src = tmp_path / name
    src.write_bytes(b"fake-video")
    return src


# ── handler behavior ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reports_landed_duration_and_match_true_within_tolerance(tmp_path: Path) -> None:
    """Landed 7.4s vs requested 7.0s is within 0.5s tolerance → match 'true'."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    node = _node({"requested_duration": 7.0})
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(7.4)),
    ) as mock_probe:
        result = await handle_duration_check(node, inputs, {}, emit=None)

    mock_probe.assert_awaited_once()
    assert result["match"] == {"type": "Text", "value": "true"}
    assert result["text"]["type"] == "Text"

    report = json.loads(result["text"]["value"])
    assert report["requested_duration"] == 7.0
    assert report["landed_duration"] == pytest.approx(7.4)
    assert report["match"] is True
    assert report["delta_seconds"] == pytest.approx(0.4)


@pytest.mark.asyncio
async def test_mismatch_reports_false_and_delta(tmp_path: Path) -> None:
    """The friction-doc case: 7s requested, 15.06s landed → match 'false' + delta."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    node = _node({"requested_duration": 7.0})
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(15.06)),
    ):
        result = await handle_duration_check(node, inputs, {}, emit=None)

    assert result["match"] == {"type": "Text", "value": "false"}
    report = json.loads(result["text"]["value"])
    assert report["requested_duration"] == 7.0
    assert report["landed_duration"] == pytest.approx(15.06)
    assert report["match"] is False
    assert report["delta_seconds"] == pytest.approx(8.06)


@pytest.mark.asyncio
async def test_tolerance_boundary_is_inclusive(tmp_path: Path) -> None:
    """Exactly 0.5s off still matches; 0.51s off does not."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(7.5)),
    ):
        result = await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )
    assert result["match"]["value"] == "true"

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(7.51)),
    ):
        result = await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )
    assert result["match"]["value"] == "false"
    report = json.loads(result["text"]["value"])
    assert report["delta_seconds"] == pytest.approx(0.51)


@pytest.mark.asyncio
async def test_unrounded_boundary_value_matches(tmp_path: Path) -> None:
    """Boundary case from the scrutiny fix: requested 5.0s, landed 5.49s.

    The unrounded delta is 0.49s < 0.5s → match 'true'. Display rounding of
    the landed value (e.g. to 5.5) must not leak into the match decision.
    """
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(5.49)),
    ):
        result = await handle_duration_check(
            _node({"requested_duration": 5.0}), inputs, {}, emit=None
        )

    assert result["match"] == {"type": "Text", "value": "true"}
    report = json.loads(result["text"]["value"])
    assert report["match"] is True
    assert report["landed_duration"] == pytest.approx(5.49)
    assert report["delta_seconds"] == pytest.approx(0.49)


@pytest.mark.asyncio
async def test_match_decision_uses_unrounded_duration(tmp_path: Path) -> None:
    """Regression test: rounding the landed duration must not flip the match.

    Landed 5.5004s vs requested 5.0s — the raw delta (0.5004s) exceeds the
    0.5s tolerance, so match must be 'false'. Rounding the landed duration to
    milliseconds first (5.5) would shrink the delta to 0.5 and falsely match.
    The text report still shows the rounded values for readability.
    """
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(5.5004)),
    ):
        result = await handle_duration_check(
            _node({"requested_duration": 5.0}), inputs, {}, emit=None
        )

    assert result["match"] == {"type": "Text", "value": "false"}
    report = json.loads(result["text"]["value"])
    assert report["match"] is False
    # Report values are still rounded to milliseconds for readability.
    assert report["landed_duration"] == pytest.approx(5.5)
    assert report["delta_seconds"] == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_requested_duration_input_port_overrides_param(tmp_path: Path) -> None:
    """A connected requested_duration port wins over the node param."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    node = _node({"requested_duration": 7.0})  # param disagrees with port
    inputs = {
        "video": PortValueDict(type="Video", value=str(src)),
        "requested_duration": PortValueDict(type="Text", value="5"),
    }

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(5.1)),
    ):
        result = await handle_duration_check(node, inputs, {}, emit=None)

    report = json.loads(result["text"]["value"])
    assert report["requested_duration"] == 5.0
    assert result["match"]["value"] == "true"


@pytest.mark.asyncio
async def test_requested_duration_param_fallback_when_no_input(tmp_path: Path) -> None:
    """No port connection → requested duration comes from the float param."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    node = _node({"requested_duration": 6.0})
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(6.0)),
    ):
        result = await handle_duration_check(node, inputs, {}, emit=None)

    report = json.loads(result["text"]["value"])
    assert report["requested_duration"] == 6.0
    assert report["delta_seconds"] == pytest.approx(0.0)
    assert result["match"]["value"] == "true"


@pytest.mark.asyncio
async def test_missing_requested_duration_raises(tmp_path: Path) -> None:
    """Neither port nor param → clear error (a check node needs a target)."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with pytest.raises(ValueError, match="requested_duration"):
        await handle_duration_check(_node(), inputs, {}, emit=None)


@pytest.mark.asyncio
async def test_non_numeric_requested_duration_port_raises(tmp_path: Path) -> None:
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    inputs = {
        "video": PortValueDict(type="Video", value=str(src)),
        "requested_duration": PortValueDict(type="Text", value="abc"),
    }

    with pytest.raises(ValueError, match="requested_duration"):
        await handle_duration_check(_node(), inputs, {}, emit=None)


@pytest.mark.asyncio
async def test_missing_video_input_raises() -> None:
    from handlers.duration_check import handle_duration_check

    with pytest.raises(ValueError, match="video"):
        await handle_duration_check(
            _node({"requested_duration": 7.0}), {}, {}, emit=None
        )


@pytest.mark.asyncio
async def test_unresolvable_local_path_raises() -> None:
    from handlers.duration_check import handle_duration_check

    inputs = {
        "video": PortValueDict(type="Video", value="/nonexistent/definitely-not-here.mp4")
    }

    with pytest.raises(FileNotFoundError, match="Source video not found"):
        await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )


@pytest.mark.asyncio
async def test_api_outputs_url_resolved_under_output_root(tmp_path: Path) -> None:
    """'/api/outputs/<rel>' served URLs map back to the on-disk path for ffprobe."""
    import services.output as output_mod
    from handlers.duration_check import handle_duration_check

    out_root = Path(output_mod.OUTPUT_ROOT)
    rel = Path("run-1") / "clip.mp4"
    (out_root / rel).parent.mkdir(parents=True, exist_ok=True)
    (out_root / rel).write_bytes(b"fake-video")

    inputs = {"video": PortValueDict(type="Video", value=f"/api/outputs/{rel}")}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(7.0)),
    ) as mock_probe:
        result = await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )

    probed = mock_probe.call_args.args[0]
    # resolve_output_ref resolves symlinks (macOS /var → /private/var).
    assert probed == str((out_root / rel).resolve())
    assert result["match"]["value"] == "true"


@pytest.mark.asyncio
async def test_plain_http_url_rejected_as_ssrf() -> None:
    """A plain http:// URL must NOT be passed to ffprobe (SSRF vector)."""
    from handlers.duration_check import handle_duration_check

    inputs = {"video": PortValueDict(type="Video", value="http://example.com/video.mp4")}

    with pytest.raises(ValueError, match="Remote URLs are not supported"):
        await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )


@pytest.mark.asyncio
async def test_https_url_rejected_as_ssrf() -> None:
    """A plain https:// URL must NOT be passed to ffprobe (SSRF vector)."""
    from handlers.duration_check import handle_duration_check

    inputs = {"video": PortValueDict(type="Video", value="https://example.com/video.mp4")}

    with pytest.raises(ValueError, match="Remote URLs are not supported"):
        await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )


@pytest.mark.asyncio
async def test_metadata_endpoint_url_rejected_as_ssrf() -> None:
    """The canonical SSRF attack: pointing at the cloud metadata endpoint."""
    from handlers.duration_check import handle_duration_check

    inputs = {
        "video": PortValueDict(
            type="Video", value="http://169.254.169.254/latest/meta-data/"
        )
    }

    with pytest.raises(ValueError, match="Remote URLs are not supported"):
        await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )


@pytest.mark.asyncio
async def test_local_path_still_works(tmp_path: Path) -> None:
    """Local filesystem paths are unaffected by the SSRF fix."""
    from handlers.duration_check import handle_duration_check

    src = _make_video(tmp_path)
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(7.0)),
    ) as mock_probe:
        result = await handle_duration_check(
            _node({"requested_duration": 7.0}), inputs, {}, emit=None
        )

    assert mock_probe.call_args.args[0] == str(src)
    assert result["match"]["value"] == "true"


# ── registry + node definition ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handler_registered_in_sync_runner_registry(tmp_path: Path) -> None:
    """The node is reachable through get_handler_registry like every other node."""
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    assert "video-duration-check" in registry

    src = _make_video(tmp_path)
    node = _node({"requested_duration": 7.0})
    inputs = {"video": PortValueDict(type="Video", value=str(src))}

    with patch(
        "handlers.duration_check.ffprobe_video",
        AsyncMock(return_value=_probe(7.2)),
    ):
        result = await registry["video-duration-check"](node, inputs, {})

    assert result["match"]["value"] == "true"
    report = json.loads(result["text"]["value"])
    assert report["landed_duration"] == pytest.approx(7.2)


def test_node_definition_shape() -> None:
    """node_definitions.json entry: analyzer category, local execution, typed ports."""
    defs = json.loads(
        (Path(__file__).resolve().parents[2] / "backend" / "data" / "node_definitions.json").read_text()
    )
    ndef = defs["video-duration-check"]

    assert ndef["id"] == "video-duration-check"
    assert ndef["category"] == "analyzer"
    # Local execution — no external provider, no API key required.
    assert ndef["apiProvider"] == "utility"
    assert ndef["envKeyName"] == []
    assert ndef["executionPattern"] == "sync"

    inputs = {p["id"]: p for p in ndef["inputPorts"]}
    assert inputs["video"]["dataType"] == "Video"
    assert inputs["video"]["required"] is True
    assert inputs["requested_duration"]["dataType"] == "Text"
    assert inputs["requested_duration"]["required"] is False

    outputs = {p["id"]: p for p in ndef["outputPorts"]}
    assert outputs["text"]["dataType"] == "Text"
    assert outputs["match"]["dataType"] == "Text"

    params = {p["key"]: p for p in ndef["params"]}
    assert params["requested_duration"]["type"] == "float"
    assert params["requested_duration"]["required"] is False


# ── ffprobe DoS: subprocess timeout ───────────────────────────────────────────


def _make_hanging_proc():
    """A fake asyncio subprocess whose communicate() never completes."""
    proc = AsyncMock()
    proc.returncode = None

    async def _communicate():
        # Simulate a tarpit: never produce output, never exit.
        await asyncio.sleep(3600)
        return b"", b""

    proc.communicate = _communicate
    proc.kill = MagicMock()
    proc.terminate = MagicMock()
    proc.wait = AsyncMock(return_value=None)
    return proc


@pytest.mark.asyncio
async def test_ffprobe_timeout_raises_runtime_error() -> None:
    """A ffprobe subprocess that never completes must time out and raise."""
    from services.ffmpeg import ffprobe_video

    async def _spawn(*args, **kwargs):
        return _make_hanging_proc()

    with patch("services.ffmpeg._spawn_subprocess", side_effect=_spawn), \
         patch("services.ffmpeg.FFPROBE_TIMEOUT_SECONDS", 0.05):
        with pytest.raises(RuntimeError, match="timed out"):
            await ffprobe_video("/tmp/whatever.mp4")


@pytest.mark.asyncio
async def test_ffprobe_timeout_kills_process() -> None:
    """On timeout, the hung subprocess must be killed to free resources."""
    from services.ffmpeg import ffprobe_video

    proc = _make_hanging_proc()

    async def _spawn(*args, **kwargs):
        return proc

    with patch("services.ffmpeg._spawn_subprocess", side_effect=_spawn), \
         patch("services.ffmpeg.FFPROBE_TIMEOUT_SECONDS", 0.05):
        with pytest.raises(RuntimeError):
            await ffprobe_video("/tmp/whatever.mp4")

    proc.kill.assert_called_once(), "proc.kill() must be called on timeout"


@pytest.mark.asyncio
async def test_ffprobe_timeout_message_mentions_duration() -> None:
    """The timeout error message must mention the timeout duration (30s)."""
    from services.ffmpeg import ffprobe_video

    # Patch asyncio.wait_for to fire immediately while keeping the real 30s
    # constant so the message references the production timeout value.
    async def _instant_timeout(coro, timeout):
        coro.close()  # avoid un-awaited-coroutine warnings
        raise asyncio.TimeoutError

    async def _spawn(*args, **kwargs):
        return _make_hanging_proc()

    with patch("services.ffmpeg._spawn_subprocess", side_effect=_spawn), \
         patch("asyncio.wait_for", side_effect=_instant_timeout):
        with pytest.raises(RuntimeError, match="30"):
            await ffprobe_video("/tmp/whatever.mp4")
