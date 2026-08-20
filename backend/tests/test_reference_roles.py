"""Contract tests for semantic reference roles on existing node ports.

Covers VAL-NODES-001 through VAL-NODES-004 (and the additive-only rule from
VAL-ROLE-005 applied to this feature's edits):

- Specific role assignments on the required nodes (nano-banana, flux-kontext,
  cinema-scene, runway-video, ideogram-edit).
- Only Image dataType ports carry a role; every role value is one of the 7
  standard roles.
- Mask ports never get a role.
- Role additions are purely additive vs. the pre-roles baseline commit: no
  existing node/port field (id, label, dataType, required, multiple,
  maxConnections, params, apiEndpoint, handler routing) may change.
- Frontend nodeDefinitions.ts mirrors the backend role metadata exactly.
- ModelNode.tsx renders an accessible colored badge for role ports and leaves
  role-less ports untouched.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DEFS_PATH = REPO_ROOT / "backend" / "data" / "node_definitions.json"
FRONTEND_DEFS_PATH = REPO_ROOT / "frontend" / "src" / "constants" / "nodeDefinitions.ts"
MODEL_NODE_PATH = REPO_ROOT / "frontend" / "src" / "components" / "nodes" / "ModelNode.tsx"
NODES_CSS_PATH = REPO_ROOT / "frontend" / "src" / "styles" / "nodes.css"
REFERENCE_ROLES_PATH = REPO_ROOT / "frontend" / "src" / "lib" / "referenceRoles.ts"
BASELINE_FINGERPRINTS_PATH = (
    Path(__file__).resolve().parent / "fixtures" / "reference_roles_baseline_sha256.json"
)

# Intentional post-baseline contract repairs. Fingerprinting rewrites only these
# exact current values back to their historical values before comparing against
# c708400, so the role feature still rejects every unapproved mutation.
APPROVED_EXECUTION_PATTERN_CHANGES = {
    "flux-schnell": ("sync", "async-poll"),
    "fast-sdxl": ("sync", "async-poll"),
    "ideogram-transparent": ("async-poll", "sync"),
    "ideogram-edit-prompt": ("async-poll", "sync"),
}

# The 7 standard roles — mirrors REFERENCE_ROLE_IDS in referenceRoles.ts.
STANDARD_ROLES = {
    "style",
    "identity",
    "composition",
    "pose",
    "lighting",
    "subject",
    "background",
}

# Complete role assignment map for this feature. Conventions:
# - character/face-consistency reference ports -> "identity"
# - style-reference ports (incl. Ideogram "Style Refs", Krea style images) -> "style"
# - i2v first-frame / source-image ports (what to generate) -> "subject"
# - end-frame / last-frame / tail ports are trajectory constraints, NOT
#   references, and intentionally get no role.
EXPECTED_ROLES: dict[str, dict[str, str]] = {
    # --- Required assignments (VAL-NODES-001) ---
    "nano-banana": {"images": "identity"},
    "flux-kontext": {"image": "subject"},
    "cinema-scene": {"character_refs": "identity"},
    "runway-video": {"image": "style"},
    "ideogram-edit": {"image": "subject", "images": "style"},
    # --- Identity references ---
    "nano-banana-fal-edit": {"images": "identity"},
    "runway-act-two": {"character_image": "identity"},
    "minimax-s2v": {"subject_reference": "identity"},
    "ideogram-character": {"reference_images": "identity", "images": "style"},
    "kling-motion": {"image": "identity"},
    "identity-edit": {"image": "identity"},
    "wan-animate-move": {"image": "identity"},
    "wan-animate-replace": {"image": "identity"},
    "seedance-2-r2v": {"images": "identity"},
    "kling-o3-ref": {"image": "subject", "images": "identity"},
    # --- Style references ---
    "ideogram-remix": {"image": "subject", "images": "style"},
    "ideogram-reframe": {"image": "subject", "images": "style"},
    "ideogram-replace-background": {"image": "subject", "images": "style"},
    "krea-2-generate": {"style_images": "style"},
    "krea-image-style-reference": {"image": "style"},
    "luma-ray2-flash-modify": {"image": "style"},
    "runway-image": {"images": "subject"},
    # --- Subject references (i2v first frame / source image) ---
    "veo-3": {"image": "subject"},
    "veo-3-flf": {"image": "subject"},
    "kling-v2-1": {"image": "subject"},
    "kling-v3": {"image": "subject"},
    "kling-pro": {"image": "subject"},
    "kling-o3": {"image": "subject"},
    "minimax-i2v": {"first_frame_image": "subject"},
    "seedance-v1-5": {"image": "subject"},
    "seedance-2-i2v": {"image": "subject"},
    "sora-2-i2v": {"image": "subject"},
}

# Mask ports (and any other non-reference ports) must never receive a role.
NO_ROLE_PORTS = [
    ("ideogram-edit", "mask"),
    ("flux-fill-inpaint", "mask"),
]


@pytest.fixture(scope="module")
def definitions() -> dict[str, dict[str, Any]]:
    return json.loads(BACKEND_DEFS_PATH.read_text())


def _without_role_additions(node_id: str, node: dict[str, Any]) -> dict[str, Any]:
    """Return a node normalized only for explicitly approved additive changes."""
    normalized = dict(node)
    for section in ("inputPorts", "outputPorts"):
        normalized[section] = [
            {key: value for key, value in port.items() if key not in {"role", "weight"}}
            for port in node.get(section, [])
        ]
    approved = APPROVED_EXECUTION_PATTERN_CHANGES.get(node_id)
    if approved is not None:
        baseline_value, current_value = approved
        assert normalized.get("executionPattern") == current_value, (
            f"{node_id}.executionPattern must remain {current_value!r} after its "
            "approved lifecycle repair"
        )
        normalized["executionPattern"] = baseline_value
    return normalized


def _node_fingerprint(node_id: str, node: dict[str, Any]) -> str:
    canonical = json.dumps(
        _without_role_additions(node_id, node),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _baseline_fingerprints() -> dict[str, str]:
    payload = json.loads(BASELINE_FINGERPRINTS_PATH.read_text())
    assert payload["baselineCommit"] == "c708400"
    return payload["nodes"]


def _role_map(defs: dict[str, dict[str, Any]]) -> dict[str, dict[str, str]]:
    """Map of node id -> {port id: role} for every port carrying a role."""
    out: dict[str, dict[str, str]] = {}
    for node_id, node in defs.items():
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                if "role" in port:
                    out.setdefault(node_id, {})[port["id"]] = port["role"]
    return out


def _frontend_role_map() -> dict[str, dict[str, str]]:
    """Extract node id -> {port id: role} from the TS mirror.

    Port objects in nodeDefinitions.ts are single-line literals
    (`{ id: 'images', ..., role: 'identity' },`), so a line-based scan with
    node-block tracking is sufficient.
    """
    source = FRONTEND_DEFS_PATH.read_text()
    node_re = re.compile(r"^  '([^']+)': \{$")
    port_re = re.compile(r"^\s*\{ id: '([^']+)'.*\},?$")
    role_re = re.compile(r"role: '([^']+)'")
    roles: dict[str, dict[str, str]] = {}
    current_node: str | None = None
    for line in source.splitlines():
        node_match = node_re.match(line)
        if node_match:
            current_node = node_match.group(1)
            continue
        if current_node is None:
            continue
        port_match = port_re.match(line)
        if port_match:
            role_match = role_re.search(line)
            if role_match:
                roles.setdefault(current_node, {})[port_match.group(1)] = role_match.group(1)
    return roles


# ---------------------------------------------------------------------------
# VAL-NODES-001: specific assignments + minimum coverage
# ---------------------------------------------------------------------------


def test_required_role_assignments(definitions: dict[str, dict[str, Any]]) -> None:
    actual = _role_map(definitions)
    for node_id, ports in EXPECTED_ROLES.items():
        assert node_id in definitions, f"{node_id} missing from node definitions"
        for port_id, role in ports.items():
            assert actual.get(node_id, {}).get(port_id) == role, (
                f"{node_id}.{port_id} should have role {role!r}, "
                f"got {actual.get(node_id, {}).get(port_id)!r}"
            )


def test_at_least_five_nodes_have_roles(definitions: dict[str, dict[str, Any]]) -> None:
    nodes_with_roles = _role_map(definitions)
    assert len(nodes_with_roles) >= 5, (
        f"expected at least 5 nodes with role metadata, found {len(nodes_with_roles)}"
    )


# ---------------------------------------------------------------------------
# VAL-NODES-002: only Image ports, valid standard roles only
# ---------------------------------------------------------------------------


def test_only_image_ports_have_roles(definitions: dict[str, dict[str, Any]]) -> None:
    offenders: list[str] = []
    for node_id, node in definitions.items():
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                if "role" in port and port.get("dataType") != "Image":
                    offenders.append(
                        f"{node_id}.{section}.{port.get('id')} "
                        f"(dataType={port.get('dataType')!r})"
                    )
    assert offenders == [], f"non-Image ports with role: {offenders}"


def test_all_role_values_are_valid_standard_roles(
    definitions: dict[str, dict[str, Any]],
) -> None:
    invalid: list[str] = []
    for node_id, ports in _role_map(definitions).items():
        for port_id, role in ports.items():
            if role not in STANDARD_ROLES:
                invalid.append(f"{node_id}.{port_id}={role!r}")
    assert invalid == [], f"invalid role values: {invalid}"


def test_mask_ports_have_no_role(definitions: dict[str, dict[str, Any]]) -> None:
    for node_id, port_id in NO_ROLE_PORTS:
        node = definitions[node_id]
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                if port["id"] == port_id:
                    assert "role" not in port, (
                        f"{node_id}.{port_id} is a mask port and must not have a role"
                    )


# ---------------------------------------------------------------------------
# VAL-ROLE-005 / feature rule 3: role additions are additive only
# ---------------------------------------------------------------------------


def test_role_additions_are_additive_only(
    definitions: dict[str, dict[str, Any]],
) -> None:
    baseline = _baseline_fingerprints()

    # This feature contract protects every node that existed at its baseline;
    # later first-class nodes are allowed as long as none of the baseline nodes
    # disappear or mutate outside role/weight additions.
    assert set(baseline) <= set(definitions), (
        f"baseline nodes removed: {sorted(set(baseline) - set(definitions))}"
    )

    mismatches = sorted(
        node_id
        for node_id, expected_fingerprint in baseline.items()
        if _node_fingerprint(node_id, definitions[node_id]) != expected_fingerprint
    )
    assert mismatches == [], (
        "baseline nodes changed outside additive port role/weight metadata: "
        f"{mismatches}"
    )


# ---------------------------------------------------------------------------
# VAL-NODES-004: frontend/backend mirror parity for role metadata
# ---------------------------------------------------------------------------


def test_frontend_mirrors_backend_roles(definitions: dict[str, dict[str, Any]]) -> None:
    backend_roles = _role_map(definitions)
    frontend_roles = _frontend_role_map()
    assert frontend_roles == backend_roles, (
        f"role metadata mismatch:\n"
        f"backend-only: { {k: v for k, v in backend_roles.items() if frontend_roles.get(k) != v} }\n"
        f"frontend-only: { {k: v for k, v in frontend_roles.items() if backend_roles.get(k) != v} }"
    )


# ---------------------------------------------------------------------------
# VAL-NODES-003: ModelNode renders an accessible role badge
# ---------------------------------------------------------------------------


def test_model_node_renders_role_badge() -> None:
    source = MODEL_NODE_PATH.read_text()

    # Badge data comes from referenceRoles.ts via the lookup helper.
    assert "getReferenceRole" in source, (
        "ModelNode.tsx must resolve role metadata via getReferenceRole"
    )
    roles_source = REFERENCE_ROLES_PATH.read_text()
    assert "export function getReferenceRole" in roles_source, (
        "referenceRoles.ts must export getReferenceRole"
    )

    # Badge element: colored dot/pill with an accessible name.
    assert "model-node__role-badge" in source, "ModelNode.tsx must render a role badge element"
    badge_block_start = source.index("model-node__role-badge")
    badge_block = source[max(0, badge_block_start - 600) : badge_block_start + 600]
    assert "aria-label" in badge_block, "role badge must have an aria-label"
    assert "backgroundColor: roleDef.color" in badge_block, (
        "role badge color must come from referenceRoles.ts"
    )

    # Badge is conditional on the port having a role — role-less ports render
    # exactly as before.
    assert "port.role" in source, "badge rendering must be gated on port.role"

    # The badge belongs to the input-port rows only; the output-port block
    # renders unchanged.
    output_block = source.split("definition.outputPorts.map", 1)[1]
    assert "model-node__role-badge" not in output_block, (
        "output ports must not render role badges"
    )

    # Badge styling exists.
    css = NODES_CSS_PATH.read_text()
    assert ".model-node__role-badge" in css, (
        "nodes.css must define the .model-node__role-badge style"
    )


# ---------------------------------------------------------------------------
# VAL-CROSS-004: role metadata stays optional (legacy graphs unaffected)
# ---------------------------------------------------------------------------


def test_role_metadata_remains_optional(definitions: dict[str, dict[str, Any]]) -> None:
    """Ports without role/weight must still dominate the registry — role is
    opt-in metadata, so legacy graphs (serialized before roles existed) load,
    validate, and execute identically."""
    total_ports = 0
    ports_with_role = 0
    for node in definitions.values():
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                total_ports += 1
                if "role" in port:
                    ports_with_role += 1
    assert ports_with_role > 0
    assert ports_with_role < total_ports, "every port has a role — role is no longer optional"
    # reference-set node itself keeps its role-slot ports free of `role`
    # metadata (the slot id already IS the role).
    refset = definitions["reference-set"]
    for port in refset["inputPorts"]:
        assert "role" not in port, "reference-set role slots must not carry role metadata"
