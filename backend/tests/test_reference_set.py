"""reference-set utility node tests.

Local utility node (no external API): packs the images connected to its seven
role-labeled input ports (style, identity, composition, pose, lighting,
subject, background) into a ReferenceSetBundle and emits it on the
``reference_set`` output port. Each item pairs an image URL with the port's
semantic role and that role's weight param (default 1.0, clamped to 0..1).
Items are sorted by weight descending (stable for ties) so downstream handlers
can read precedence directly. Same typed-bundle pattern as camera-rig.

Output contract:
  {"reference_set": {"type": "ReferenceSet",
                     "value": {"items": [{"url", "role", "weight"}, ...]}}}
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from models.graph import GraphNode, PortValueDict

# The 7 semantic reference roles in declaration order — must mirror
# frontend/src/lib/referenceRoles.ts (REFERENCE_ROLE_IDS) and the node's
# input ports / weight params in backend/data/node_definitions.json.
ROLES: tuple[str, ...] = (
    "style",
    "identity",
    "composition",
    "pose",
    "lighting",
    "subject",
    "background",
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="refset1", definitionId="reference-set", params=params or {})


def _image(value) -> PortValueDict:
    return PortValueDict(type="Image", value=value)


# ── handler behavior ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_packs_connected_images_into_bundle() -> None:
    """Connected role ports produce bundle items tagged with role and weight."""
    from handlers.reference_set import handle_reference_set

    inputs = {
        "style": _image("https://example.com/style.png"),
        "identity": _image("https://example.com/identity.png"),
    }
    result = await handle_reference_set(
        _node({"style_weight": 0.8, "identity_weight": 0.4}), inputs, api_keys={}, emit=None
    )

    assert set(result.keys()) == {"reference_set"}
    port = result["reference_set"]
    assert port["type"] == "ReferenceSet"

    items = port["value"]["items"]
    assert len(items) == 2
    by_role = {item["role"]: item for item in items}
    assert by_role["style"] == {
        "url": "https://example.com/style.png",
        "role": "style",
        "weight": pytest.approx(0.8),
    }
    assert by_role["identity"] == {
        "url": "https://example.com/identity.png",
        "role": "identity",
        "weight": pytest.approx(0.4),
    }


@pytest.mark.asyncio
async def test_sorts_items_by_weight_descending() -> None:
    """Items are sorted by weight descending; ties keep port declaration order
    (stable sort)."""
    from handlers.reference_set import handle_reference_set

    inputs = {
        "background": _image("bg.png"),
        "pose": _image("pose.png"),
        "style": _image("style.png"),
        "subject": _image("subject.png"),
    }
    params = {
        "background_weight": 0.9,
        "pose_weight": 0.3,
        "style_weight": 0.9,  # tie with background — background declared later
        "subject_weight": 0.6,
    }
    result = await handle_reference_set(_node(params), inputs, api_keys={}, emit=None)

    items = result["reference_set"]["value"]["items"]
    assert [item["role"] for item in items] == ["style", "background", "subject", "pose"]
    assert [item["weight"] for item in items] == [
        pytest.approx(0.9),
        pytest.approx(0.9),
        pytest.approx(0.6),
        pytest.approx(0.3),
    ]


@pytest.mark.asyncio
async def test_skips_empty_ports() -> None:
    """Ports with no input, None, or empty-string values produce no items."""
    from handlers.reference_set import handle_reference_set

    inputs = {
        "style": _image("style.png"),
        "identity": _image(None),
        "composition": _image(""),
        # pose / lighting / subject / background: not connected at all
    }
    result = await handle_reference_set(_node(), inputs, api_keys={}, emit=None)

    items = result["reference_set"]["value"]["items"]
    assert [item["role"] for item in items] == ["style"]


@pytest.mark.asyncio
async def test_empty_bundle_when_no_inputs() -> None:
    """No connected ports → {"items": []} (not an error)."""
    from handlers.reference_set import handle_reference_set

    result = await handle_reference_set(_node(), inputs={}, api_keys={}, emit=None)

    assert result == {"reference_set": {"type": "ReferenceSet", "value": {"items": []}}}


@pytest.mark.asyncio
async def test_handles_list_values() -> None:
    """A port carrying a list of URLs (multi-connection) creates one item per
    URL, all sharing that port's role and weight."""
    from handlers.reference_set import handle_reference_set

    inputs = {"identity": _image(["face-a.png", "face-b.png", "face-c.png"])}
    result = await handle_reference_set(
        _node({"identity_weight": 0.7}), inputs, api_keys={}, emit=None
    )

    items = result["reference_set"]["value"]["items"]
    assert items == [
        {"url": "face-a.png", "role": "identity", "weight": pytest.approx(0.7)},
        {"url": "face-b.png", "role": "identity", "weight": pytest.approx(0.7)},
        {"url": "face-c.png", "role": "identity", "weight": pytest.approx(0.7)},
    ]


@pytest.mark.asyncio
async def test_handles_scalar_values() -> None:
    """A port carrying a single scalar URL string creates exactly one item."""
    from handlers.reference_set import handle_reference_set

    inputs = {"lighting": _image("lighting-ref.png")}
    result = await handle_reference_set(_node(), inputs, api_keys={}, emit=None)

    items = result["reference_set"]["value"]["items"]
    assert items == [
        {"url": "lighting-ref.png", "role": "lighting", "weight": pytest.approx(1.0)}
    ]


@pytest.mark.asyncio
async def test_list_values_skip_empty_entries() -> None:
    """Empty strings inside a list value are skipped, not packed."""
    from handlers.reference_set import handle_reference_set

    inputs = {"style": _image(["a.png", "", None, "b.png"])}
    result = await handle_reference_set(_node(), inputs, api_keys={}, emit=None)

    items = result["reference_set"]["value"]["items"]
    assert [item["url"] for item in items] == ["a.png", "b.png"]


@pytest.mark.asyncio
async def test_default_weight_1_0() -> None:
    """A missing weight param behaves as weight 1.0."""
    from handlers.reference_set import handle_reference_set

    inputs = {"subject": _image("subject.png")}
    result = await handle_reference_set(_node(), inputs, api_keys={}, emit=None)

    item = result["reference_set"]["value"]["items"][0]
    assert item["weight"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_weight_clamped_to_0_1() -> None:
    """Out-of-range weight params are clamped to the slider's [0, 1] bounds."""
    from handlers.reference_set import handle_reference_set

    inputs = {"style": _image("a.png"), "pose": _image("b.png")}
    params = {"style_weight": 1.7, "pose_weight": -0.4}
    result = await handle_reference_set(_node(params), inputs, api_keys={}, emit=None)

    by_role = {item["role"]: item for item in result["reference_set"]["value"]["items"]}
    assert by_role["style"]["weight"] == pytest.approx(1.0)
    assert by_role["pose"]["weight"] == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_unparseable_weight_falls_back_to_default() -> None:
    """Garbage weight params degrade to 1.0 rather than raising — a malformed
    slider value should not break graph execution."""
    from handlers.reference_set import handle_reference_set

    inputs = {"style": _image("a.png"), "identity": _image("b.png"), "pose": _image("c.png")}
    params = {"style_weight": "not-a-number", "identity_weight": None, "pose_weight": ""}
    result = await handle_reference_set(_node(params), inputs, api_keys={}, emit=None)

    items = result["reference_set"]["value"]["items"]
    assert all(item["weight"] == pytest.approx(1.0) for item in items)


@pytest.mark.asyncio
async def test_string_weight_params_coerced_to_numbers() -> None:
    """Weights arriving as strings (e.g. from a CLI/JSON graph) parse to floats."""
    from handlers.reference_set import handle_reference_set

    inputs = {"composition": _image("comp.png")}
    result = await handle_reference_set(
        _node({"composition_weight": "0.65"}), inputs, api_keys={}, emit=None
    )

    item = result["reference_set"]["value"]["items"][0]
    assert item["weight"] == pytest.approx(0.65)


@pytest.mark.asyncio
async def test_works_with_empty_api_keys() -> None:
    """The handler is fully local — an empty api_keys dict is fine."""
    from handlers.reference_set import handle_reference_set

    inputs = {"background": _image("bg.png")}
    result = await handle_reference_set(_node(), inputs, api_keys={}, emit=None)
    assert result["reference_set"]["value"]["items"][0]["url"] == "bg.png"


@pytest.mark.asyncio
async def test_output_is_json_serializable() -> None:
    """The bundle rides through PortValueDict / websocket events as plain JSON."""
    from handlers.reference_set import handle_reference_set

    inputs = {"style": _image("a.png"), "pose": _image(["b.png", "c.png"])}
    result = await handle_reference_set(
        _node({"pose_weight": 0.5}), inputs, api_keys={}, emit=None
    )
    decoded = json.loads(json.dumps(result))
    assert decoded["reference_set"]["type"] == "ReferenceSet"
    assert [item["role"] for item in decoded["reference_set"]["value"]["items"]] == [
        "style",
        "pose",
        "pose",
    ]


# ── registry + node definition ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handler_registered_in_sync_runner_registry() -> None:
    """The node is reachable through get_handler_registry like every other node."""
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    assert "reference-set" in registry

    result = await registry["reference-set"](
        _node({"style_weight": 0.25}), {"style": _image("s.png")}, {}
    )
    assert result["reference_set"]["type"] == "ReferenceSet"
    assert result["reference_set"]["value"]["items"] == [
        {"url": "s.png", "role": "style", "weight": pytest.approx(0.25)}
    ]


def test_node_definition_shape() -> None:
    """node_definitions.json entry: utility category, local sync execution, 7
    role-based Image input ports, 1 ReferenceSet output port, and 7 weight
    params (float, 0..1, default 1.0, step 0.05)."""
    defs = json.loads((REPO_ROOT / "backend" / "data" / "node_definitions.json").read_text())
    ndef = defs["reference-set"]

    assert ndef["id"] == "reference-set"
    assert ndef["displayName"] == "Reference Set"
    assert ndef["category"] == "utility"
    # Local execution — no external provider, no API key required.
    assert ndef["apiProvider"] == "utility"
    assert ndef["apiEndpoint"] == ""
    assert ndef["envKeyName"] == []
    assert ndef["executionPattern"] == "sync"

    inputs = {p["id"]: p for p in ndef["inputPorts"]}
    assert set(inputs.keys()) == set(ROLES)
    assert [p["id"] for p in ndef["inputPorts"]] == list(ROLES)
    for role in ROLES:
        port = inputs[role]
        assert port["dataType"] == "Image", f"{role} port must be Image"
        assert port["required"] is False, f"{role} port must be optional"
        assert isinstance(port["label"], str) and port["label"], f"{role} needs a label"

    outputs = {p["id"]: p for p in ndef["outputPorts"]}
    assert set(outputs.keys()) == {"reference_set"}
    assert outputs["reference_set"]["dataType"] == "ReferenceSet"

    params = {p["key"]: p for p in ndef["params"]}
    assert set(params.keys()) == {f"{role}_weight" for role in ROLES}
    for role in ROLES:
        param = params[f"{role}_weight"]
        assert param["type"] == "float", f"{role}_weight must be a float param"
        assert param["required"] is False
        assert param["min"] == pytest.approx(0.0)
        assert param["max"] == pytest.approx(1.0)
        assert param["default"] == pytest.approx(1.0)
        assert param["step"] == pytest.approx(0.05)


def test_reference_set_in_valid_port_types() -> None:
    """The contract-test port type whitelist accepts the ReferenceSet type."""
    from tests.test_node_contracts import VALID_PORT_TYPES

    assert "ReferenceSet" in VALID_PORT_TYPES


def test_utility_manifest_includes_reference_set() -> None:
    """docs/utility-node-test-manifest.json must cover every utility node."""
    manifest = json.loads((REPO_ROOT / "docs" / "utility-node-test-manifest.json").read_text())
    entry = next((n for n in manifest["nodes"] if n["id"] == "reference-set"), None)
    assert entry is not None, "reference-set missing from utility-node-test-manifest.json"
    assert entry["backend"] == "mocked-handler"
    assert entry["browser"] == "mocked-event"


def test_frontend_mirror_has_reference_set_entry() -> None:
    """The TS mirror declares the node with the same ports and params."""
    source = (REPO_ROOT / "frontend" / "src" / "constants" / "nodeDefinitions.ts").read_text()

    assert "'reference-set': {" in source
    assert "dataType: 'ReferenceSet'" in source
    for role in ROLES:
        assert f"id: '{role}'" in source, f"frontend mirror missing {role} input port"
        assert f"key: '{role}_weight'" in source, f"frontend mirror missing {role}_weight param"


def test_frontend_component_structure() -> None:
    """ReferenceSetNode.tsx renders the contract surface: 7 role-labeled input
    handles (Position.Left, colored from referenceRoles), 7 weight sliders
    (range 0..1 step 0.05), a live weight-ordered preview, role badges, and a
    ReferenceSet source handle on the right.

    DOM render tests are not possible in this environment (jsdom broken), so
    this is a structural source check per the mission testing strategy.
    """
    source = (
        REPO_ROOT / "frontend" / "src" / "components" / "nodes" / "ReferenceSetNode.tsx"
    ).read_text()

    # 7 input handles rendered from the role list, colored per role.
    assert "REFERENCE_ROLE_IDS.map" in source
    assert "Position.Left" in source
    assert "type=\"target\"" in source
    # Output handle on the right with the ReferenceSet port color.
    assert "Position.Right" in source
    assert "type=\"source\"" in source
    assert "PORT_COLORS.ReferenceSet" in source
    assert "id=\"reference_set\"" in source
    # Weight sliders: range inputs with the shared weight contract constants.
    assert "type=\"range\"" in source
    assert "REFERENCE_WEIGHT_MIN" in source
    assert "REFERENCE_WEIGHT_MAX" in source
    assert "REFERENCE_WEIGHT_STEP" in source
    # Role badges colored from referenceRoles.ts + live ordered preview.
    assert "REFERENCE_ROLES" in source
    assert re.search(r"sort\(", source), "preview must sort items by weight"
    # Slider edits write back through the graph store (same path as Inspector).
    assert "updateNodeData" in source
    assert "nodrag" in source


def test_frontend_registrations() -> None:
    """Canvas nodeTypes + graphStore addNode fallback + main.py cli→RF mapping."""
    canvas = (REPO_ROOT / "frontend" / "src" / "components" / "Canvas.tsx").read_text()
    assert "referenceSetNode: ReferenceSetNode" in canvas
    assert "import { ReferenceSetNode }" in canvas

    store = (REPO_ROOT / "frontend" / "src" / "store" / "graphStore.ts").read_text()
    assert "'reference-set'" in store
    assert "'referenceSetNode'" in store

    main_py = (REPO_ROOT / "backend" / "main.py").read_text()
    assert '"referenceSetNode"' in main_py
    assert '"reference-set"' in main_py
