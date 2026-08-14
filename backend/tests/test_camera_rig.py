"""camera-rig utility node tests.

Local utility node (no external API): packs its numeric slider params into a
CameraRigBundle and emits it on the `camera_rig` output port, following the
same typed-bundle pattern as the character node. Downstream generation/edit
nodes can then consume camera geometry as a typed, inspectable value instead
of prompt prose.

Output contract:
  {"camera_rig": {"type": "CameraRig", "value": {height, pitch, yaw, roll,
   focalLength, subjectDistance, focusDistance, subjectScreenX, subjectScreenY}}}
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from models.graph import GraphNode

# field -> (min, max, default, step) — must mirror the node definition 1:1.
FIELDS: dict[str, tuple[float, float, float, float]] = {
    "height": (0.1, 10.0, 1.7, 0.1),
    "pitch": (-90.0, 90.0, 0.0, 1.0),
    "yaw": (0.0, 360.0, 0.0, 1.0),
    "roll": (-45.0, 45.0, 0.0, 1.0),
    "focalLength": (10.0, 200.0, 35.0, 1.0),
    "subjectDistance": (0.5, 50.0, 3.0, 0.1),
    "focusDistance": (0.5, 100.0, 3.0, 0.1),
    "subjectScreenX": (0.0, 1.0, 0.5, 0.01),
    "subjectScreenY": (0.0, 1.0, 0.5, 0.01),
}


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="cam1", definitionId="camera-rig", params=params or {})


# ── handler behavior ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_emits_bundle_with_all_fields_populated() -> None:
    """A fully-configured node emits every bundle field with the param values."""
    from handlers.camera_rig import handle_camera_rig

    params = {
        "height": 2.5,
        "pitch": -15.0,
        "yaw": 45.0,
        "roll": 5.0,
        "focalLength": 85.0,
        "subjectDistance": 4.2,
        "focusDistance": 4.0,
        "subjectScreenX": 0.33,
        "subjectScreenY": 0.62,
    }
    result = await handle_camera_rig(_node(params), inputs={}, api_keys={}, emit=None)

    assert set(result.keys()) == {"camera_rig"}
    port = result["camera_rig"]
    assert port["type"] == "CameraRig"

    bundle = port["value"]
    assert set(bundle.keys()) == set(FIELDS.keys())
    for key, value in params.items():
        assert bundle[key] == pytest.approx(value)
        assert isinstance(bundle[key], (int, float))


@pytest.mark.asyncio
async def test_defaults_when_params_missing() -> None:
    """An untouched node (no params) emits the definition defaults."""
    from handlers.camera_rig import handle_camera_rig

    result = await handle_camera_rig(_node(), inputs={}, api_keys={}, emit=None)

    bundle = result["camera_rig"]["value"]
    assert set(bundle.keys()) == set(FIELDS.keys())
    for key, (_min, _max, default, _step) in FIELDS.items():
        assert bundle[key] == pytest.approx(default)


@pytest.mark.asyncio
async def test_string_params_coerced_to_numbers() -> None:
    """Params arriving as strings (e.g. from a CLI/JSON graph) parse to floats."""
    from handlers.camera_rig import handle_camera_rig

    result = await handle_camera_rig(
        _node({"height": "2.0", "focalLength": "50", "subjectScreenX": "0.25"}),
        inputs={},
        api_keys={},
        emit=None,
    )

    bundle = result["camera_rig"]["value"]
    assert bundle["height"] == pytest.approx(2.0)
    assert bundle["focalLength"] == pytest.approx(50.0)
    assert bundle["subjectScreenX"] == pytest.approx(0.25)


@pytest.mark.asyncio
async def test_unparseable_params_fall_back_to_defaults() -> None:
    """Garbage param values degrade to the default rather than raising — a
    malformed slider value should not break graph execution."""
    from handlers.camera_rig import handle_camera_rig

    result = await handle_camera_rig(
        _node({"height": "not-a-number", "pitch": None, "yaw": ""}),
        inputs={},
        api_keys={},
        emit=None,
    )

    bundle = result["camera_rig"]["value"]
    assert bundle["height"] == pytest.approx(FIELDS["height"][2])
    assert bundle["pitch"] == pytest.approx(FIELDS["pitch"][2])
    assert bundle["yaw"] == pytest.approx(FIELDS["yaw"][2])


@pytest.mark.asyncio
async def test_output_is_json_serializable() -> None:
    """The bundle rides through PortValueDict / websocket events as plain JSON."""
    from handlers.camera_rig import handle_camera_rig

    result = await handle_camera_rig(
        _node({"height": 1.8, "focalLength": 24.0}), inputs={}, api_keys={}, emit=None
    )
    encoded = json.dumps(result)
    decoded = json.loads(encoded)
    assert decoded["camera_rig"]["type"] == "CameraRig"
    assert decoded["camera_rig"]["value"]["height"] == pytest.approx(1.8)


# ── registry + node definition ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handler_registered_in_sync_runner_registry() -> None:
    """The node is reachable through get_handler_registry like every other node."""
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    assert "camera-rig" in registry

    result = await registry["camera-rig"](_node({"yaw": 180.0}), {}, {})
    assert result["camera_rig"]["type"] == "CameraRig"
    assert result["camera_rig"]["value"]["yaw"] == pytest.approx(180.0)


def test_node_definition_shape() -> None:
    """node_definitions.json entry: utility category, local execution, CameraRig
    output port, and one numeric param per bundle field with min/max/default/step."""
    defs = json.loads(
        (Path(__file__).resolve().parents[2] / "backend" / "data" / "node_definitions.json").read_text()
    )
    ndef = defs["camera-rig"]

    assert ndef["id"] == "camera-rig"
    assert ndef["category"] == "utility"
    # Local execution — no external provider, no API key required.
    assert ndef["apiProvider"] == "utility"
    assert ndef["envKeyName"] == []
    assert ndef["executionPattern"] == "sync"

    # No input ports — every value is a numeric slider param.
    assert ndef["inputPorts"] == []

    outputs = {p["id"]: p for p in ndef["outputPorts"]}
    assert set(outputs.keys()) == {"camera_rig"}
    assert outputs["camera_rig"]["dataType"] == "CameraRig"

    params = {p["key"]: p for p in ndef["params"]}
    assert set(params.keys()) == set(FIELDS.keys())
    for key, (min_v, max_v, default, step) in FIELDS.items():
        param = params[key]
        assert param["type"] == "float", f"{key} must be a float param"
        assert param["required"] is False
        assert param["min"] == pytest.approx(min_v), f"{key}.min"
        assert param["max"] == pytest.approx(max_v), f"{key}.max"
        assert param["default"] == pytest.approx(default), f"{key}.default"
        assert param["step"] == pytest.approx(step), f"{key}.step"


def test_frontend_mirror_has_camera_rig_entry() -> None:
    """The TS mirror declares the node with the same ports and params."""
    source = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "constants"
        / "nodeDefinitions.ts"
    ).read_text()

    assert "'camera-rig': {" in source
    assert "dataType: 'CameraRig'" in source
    for key in FIELDS:
        assert f"key: '{key}'" in source
