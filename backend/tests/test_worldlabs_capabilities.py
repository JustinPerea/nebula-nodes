from __future__ import annotations

import json
from pathlib import Path

import pytest
import respx
from fastapi.testclient import TestClient

from services.worldlabs_capabilities import (
    ATLAS_ANNOUNCED_CAPABILITY_IDS,
    PUBLIC_MARBLE_DEFINITION_IDS,
    PUBLIC_MARBLE_MODELS,
    AtlasAdapterInstallation,
    AtlasAdapterOperation,
    AtlasExecutionUnavailable,
    WorldLabsCapabilityGate,
    verify_atlas_entitlement,
)
from services.provider_operation_policy import (
    PROVIDER_OPERATION_POLICIES,
    ProviderOperationPolicy,
)


_ADAPTER_HASH = "sha256:" + ("a" * 64)
_OTHER_HASH = "sha256:" + ("b" * 64)
_EXPECTED_ATLAS_CAPABILITY_IDS = (
    "camera_conditioned_image",
    "camera_conditioned_video",
    "spatial_context_conditioning",
    "sparse_reconstruction",
    "depth",
    "point_cloud",
    "gaussian_splat",
    "multiview_reframing",
    "space_time_simulation",
    "robotics_rgbd",
    "standalone_image",
    "panorama_360",
)


def _announced_capability_payload() -> list[dict[str, object]]:
    return [
        {
            "id": capability_id,
            "availability": "announced_only",
            "executable": False,
        }
        for capability_id in _EXPECTED_ATLAS_CAPABILITY_IDS
    ]


async def _test_atlas_handler(*_args, **_kwargs):
    return {"value": {"type": "Text", "value": "test"}}


def _test_adapter(
    *, contract_hash: str = _ADAPTER_HASH
) -> AtlasAdapterInstallation:
    return AtlasAdapterInstallation(
        contract_version="test-contract-v1",
        contract_hash=contract_hash,
        operations=(
            AtlasAdapterOperation(
                definition_id="worldlabs-atlas-test",
                capability_ids=("camera_conditioned_image",),
                handler=_test_atlas_handler,
            ),
        ),
    )


def test_environment_and_marble_key_cannot_enable_atlas(monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_EXPERIMENTAL_ATLAS", "true")
    monkeypatch.setenv("VITE_NEBULA_EXPERIMENTAL_ATLAS", "true")
    monkeypatch.setenv("WORLDLABS_API_KEY", "configured-is-not-entitled")
    monkeypatch.setenv("WORLDLABS_ATLAS_ENTITLED", "true")

    gate = WorldLabsCapabilityGate()
    manifest = gate.manifest()
    atlas = manifest["atlas"]

    assert atlas == {
        "availability": "announced_only",
        "announcementStage": "early_access_select_partners",
        "adapterStatus": "absent",
        "entitlementStatus": "unverified",
        "executionStatus": "blocked",
        "executable": False,
        "blockReason": "versioned_adapter_not_installed",
        "announcedCapabilities": _announced_capability_payload(),
    }
    assert "adapter" not in atlas
    with pytest.raises(
        AtlasExecutionUnavailable,
        match="versioned_adapter_not_installed",
    ):
        gate.require_atlas_execution("worldlabs-atlas-test", _test_atlas_handler)


def test_atlas_requires_callable_adapter_verified_entitlement_and_policy(
    monkeypatch,
) -> None:
    adapter = _test_adapter()
    matching_entitlement = verify_atlas_entitlement(adapter, lambda installed: installed is adapter)

    adapter_only = WorldLabsCapabilityGate(atlas_adapter=adapter)
    assert adapter_only.manifest()["atlas"] == {
        "availability": "announced_only",
        "announcementStage": "early_access_select_partners",
        "adapterStatus": "installed",
        "entitlementStatus": "unverified",
        "executionStatus": "blocked",
        "executable": False,
        "blockReason": "entitlement_not_verified_for_adapter",
        "announcedCapabilities": _announced_capability_payload(),
        "adapter": {
            "contractVersion": "test-contract-v1",
            "contractHash": _ADAPTER_HASH,
        },
    }

    entitlement_only = WorldLabsCapabilityGate(atlas_entitlement=matching_entitlement)
    assert entitlement_only.manifest()["atlas"]["executable"] is False
    assert entitlement_only.manifest()["atlas"]["adapterStatus"] == "absent"
    assert "adapter" not in entitlement_only.manifest()["atlas"]

    other_adapter = _test_adapter(contract_hash=_OTHER_HASH)
    mismatched = WorldLabsCapabilityGate(
        atlas_adapter=adapter,
        atlas_entitlement=verify_atlas_entitlement(other_adapter, lambda _adapter: True),
    )
    assert mismatched.manifest()["atlas"]["executable"] is False
    assert mismatched.manifest()["atlas"]["entitlementStatus"] == "unverified"
    with pytest.raises(AtlasExecutionUnavailable):
        mismatched.require_atlas_execution("worldlabs-atlas-test", _test_atlas_handler)

    policy = ProviderOperationPolicy(
        provider="worldlabs",
        operation_group="worldlabs-atlas-test",
        may_start_billable_work=True,
        uses_durable_recovery=True,
        cache_policy="provider_recovery",
        allow_quick_execution=False,
        recovery_operation_param="resume_operation_id",
        recovery_resource_param=None,
        billable_start_condition=None,
    )
    monkeypatch.setitem(PROVIDER_OPERATION_POLICIES, "worldlabs-atlas-test", policy)

    missing_definition = WorldLabsCapabilityGate(
        atlas_adapter=adapter,
        atlas_entitlement=matching_entitlement,
        node_definitions={},
    )
    assert missing_definition.manifest()["atlas"]["blockReason"] == "adapter_node_definition_not_registered"
    with pytest.raises(AtlasExecutionUnavailable):
        missing_definition.require_atlas_execution("worldlabs-atlas-test", _test_atlas_handler)

    ready = WorldLabsCapabilityGate(
        atlas_adapter=adapter,
        atlas_entitlement=matching_entitlement,
        node_definitions={"worldlabs-atlas-test": {"id": "worldlabs-atlas-test", "apiProvider": "worldlabs"}},
    )
    assert ready.manifest()["atlas"]["executable"] is True
    assert ready.manifest()["atlas"]["executionStatus"] == "enabled"
    assert (
        ready.require_atlas_execution(
            "worldlabs-atlas-test", _test_atlas_handler
        ).handler
        is _test_atlas_handler
    )
    capabilities = {
        item["id"]: item for item in ready.manifest()["atlas"]["announcedCapabilities"]
    }
    assert capabilities["camera_conditioned_image"]["executable"] is True
    assert capabilities["depth"]["executable"] is False


def test_manifest_separates_public_marble_facts_from_atlas_placeholders() -> None:
    manifest = WorldLabsCapabilityGate().manifest()

    assert manifest["schemaVersion"] == 1
    assert manifest["provider"] == "worldlabs"
    assert manifest["marble"] == {
        "availability": "public_api",
        "executionStatus": "supported",
        "requiresCredential": True,
        "credentialName": "WORLDLABS_API_KEY",
        "models": list(PUBLIC_MARBLE_MODELS),
        "generationInputs": ["text", "image", "multi_image", "video"],
        "worldAssets": [
            "world",
            "panorama",
            "collider_mesh",
            "thumbnail",
            "caption",
        ],
        "exportFormats": ["ply", "glb"],
        "nodeDefinitionIds": [
            *PUBLIC_MARBLE_DEFINITION_IDS,
        ],
    }

    assert ATLAS_ANNOUNCED_CAPABILITY_IDS == _EXPECTED_ATLAS_CAPABILITY_IDS
    assert manifest["atlas"]["announcedCapabilities"] == (
        _announced_capability_payload()
    )
    assert all(
        capability["availability"] == "announced_only"
        and capability["executable"] is False
        for capability in manifest["atlas"]["announcedCapabilities"]
    )

    atlas_json = json.dumps(manifest["atlas"]).lower()
    assert "endpoint" not in atlas_json
    assert "model" not in atlas_json
    assert "/atlas" not in atlas_json
    assert "atlas-" not in atlas_json


def test_public_marble_model_facts_match_handler_and_node_definition() -> None:
    from handlers.worldlabs import WORLDLABS_MODELS

    definitions_path = (
        Path(__file__).resolve().parent.parent / "data" / "node_definitions.json"
    )
    definitions = json.loads(definitions_path.read_text(encoding="utf-8"))
    model_param = next(
        param
        for param in definitions["worldlabs-environment"]["params"]
        if param["key"] == "model"
    )
    definition_models = {option["value"] for option in model_param["options"]}

    assert set(PUBLIC_MARBLE_MODELS) == set(WORLDLABS_MODELS)
    assert set(PUBLIC_MARBLE_MODELS) == definition_models


@pytest.mark.asyncio
@respx.mock
async def test_atlas_model_label_is_rejected_before_provider_http(monkeypatch) -> None:
    from handlers.worldlabs import handle_worldlabs_environment
    from models.graph import GraphNode

    monkeypatch.setenv("NEBULA_EXPERIMENTAL_ATLAS", "true")
    monkeypatch.setenv("VITE_NEBULA_EXPERIMENTAL_ATLAS", "true")
    node = GraphNode(
        id="atlas-must-not-run",
        definitionId="worldlabs-environment",
        params={"model": "atlas"},
    )

    with pytest.raises(ValueError, match="Unknown World Labs model 'atlas'"):
        await handle_worldlabs_environment(
            node,
            {},
            {"WORLDLABS_API_KEY": "configured-is-not-entitled"},
        )

    assert len(respx.calls) == 0


@pytest.mark.parametrize(
    ("version", "contract_hash"),
    [
        ("", _ADAPTER_HASH),
        ("test-contract-v1", "not-a-contract-hash"),
        ("test-contract-v1", "sha256:" + ("A" * 64)),
    ],
)
def test_invalid_adapter_metadata_fails_closed(
    version: str,
    contract_hash: str,
) -> None:
    with pytest.raises(ValueError):
        AtlasAdapterInstallation(
            contract_version=version,
            contract_hash=contract_hash,
            operations=(
                AtlasAdapterOperation(
                    definition_id="worldlabs-atlas-test",
                    capability_ids=("camera_conditioned_image",),
                    handler=_test_atlas_handler,
                ),
            ),
        )


def test_plain_metadata_cannot_mint_a_verified_entitlement() -> None:
    from services.worldlabs_capabilities import VerifiedAtlasEntitlement

    with pytest.raises(TypeError, match="issued by verify_atlas_entitlement"):
        VerifiedAtlasEntitlement("test-contract-v1", _ADAPTER_HASH)


def test_public_registry_contains_only_policy_covered_marble_worldlabs_nodes() -> None:
    definitions_path = (
        Path(__file__).resolve().parent.parent / "data" / "node_definitions.json"
    )
    definitions = json.loads(definitions_path.read_text(encoding="utf-8"))
    worldlabs_ids = {
        definition_id
        for definition_id, definition in definitions.items()
        if definition.get("apiProvider") == "worldlabs"
    }
    assert worldlabs_ids == set(PUBLIC_MARBLE_DEFINITION_IDS)
    assert all(
        PROVIDER_OPERATION_POLICIES[definition_id].provider == "worldlabs"
        for definition_id in worldlabs_ids
    )


@pytest.mark.asyncio
async def test_engine_blocks_unregistered_worldlabs_handler_before_invocation(
    monkeypatch,
) -> None:
    from execution import engine
    from models.events import ErrorEvent
    from models.graph import GraphNode

    called = False

    async def unregistered_handler(*_args):
        nonlocal called
        called = True
        return {"value": {"type": "Text", "value": "must not run"}}

    monkeypatch.setattr(
        engine,
        "_REGISTRY_NODE_DEFS",
        {
            "worldlabs-atlas-unregistered": {
                "apiProvider": "worldlabs",
                "inputPorts": [],
                "outputPorts": [{"id": "value", "dataType": "Text"}],
                "envKeyName": [],
            }
        },
    )
    events = []

    async def emit(event):
        events.append(event)

    await engine.execute_graph(
        nodes=[
            GraphNode(
                id="blocked",
                definitionId="worldlabs-atlas-unregistered",
                params={},
            )
        ],
        edges=[],
        api_keys={},
        handler_registry={"worldlabs-atlas-unregistered": unregistered_handler},
        emit=emit,
    )

    assert called is False
    errors = [event for event in events if isinstance(event, ErrorEvent)]
    assert len(errors) == 1
    assert "versioned_adapter_not_installed" in errors[0].error


def test_read_only_api_uses_the_fail_closed_backend_gate(monkeypatch) -> None:
    monkeypatch.setenv("NEBULA_EXPERIMENTAL_ATLAS", "true")
    monkeypatch.setenv("VITE_NEBULA_EXPERIMENTAL_ATLAS", "true")
    monkeypatch.setenv("WORLDLABS_API_KEY", "configured-is-not-entitled")

    import main

    monkeypatch.setattr(
        main,
        "load_settings",
        lambda: {"apiKeys": {"WORLDLABS_API_KEY": "configured-in-settings"}},
    )
    response = TestClient(main.app).get("/api/capabilities/worldlabs")

    assert response.status_code == 200
    payload = response.json()
    assert payload["marble"]["availability"] == "public_api"
    assert payload["atlas"]["availability"] == "announced_only"
    assert payload["atlas"]["adapterStatus"] == "absent"
    assert payload["atlas"]["entitlementStatus"] == "unverified"
    assert payload["atlas"]["executionStatus"] == "blocked"
    assert payload["atlas"]["executable"] is False
    assert "adapter" not in payload["atlas"]
    assert all(
        capability["availability"] == "announced_only"
        and capability["executable"] is False
        for capability in payload["atlas"]["announcedCapabilities"]
    )
    atlas_json = json.dumps(payload["atlas"]).lower()
    assert "endpoint" not in atlas_json
    assert "model" not in atlas_json
