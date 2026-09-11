"""Backend-authoritative World Labs capability discovery and Atlas gate.

Marble is the currently implemented public API integration. Atlas is only an
announced product capability until backend code installs a versioned adapter
and supplies an entitlement that was verified for that exact adapter contract.

This module deliberately does not read environment variables or settings. A
frontend feature flag, ``WORLDLABS_API_KEY``, or any other configuration value
therefore cannot turn Atlas execution on accidentally.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import partial
from typing import Any, Callable, Mapping

from services.provider_operation_policy import operation_policy


WORLDLABS_CAPABILITY_SCHEMA_VERSION = 1

PUBLIC_MARBLE_MODELS = (
    "marble-1.0-draft",
    "marble-1.0",
    "marble-1.1",
    "marble-1.1-plus",
)
PUBLIC_MARBLE_DEFINITION_IDS = (
    "worldlabs-environment",
    "worldlabs-world-export",
)

# Publicly announced Atlas capability families are discovery metadata, not an
# executable API contract. Keep each entry fail-closed until a real adapter
# contract explicitly describes what it implements.
ATLAS_ANNOUNCED_CAPABILITY_IDS = (
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

_CONTRACT_HASH_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
_NODE_DEFINITION_UNSET = object()


def _unwrapped_handler(handler: Callable[..., Any]) -> Callable[..., Any]:
    """Return the callable implementation beneath event-binding partials."""

    current = handler
    while isinstance(current, partial):
        current = current.func
    return current


def _handlers_match(
    actual: Callable[..., Any] | None,
    registered: Callable[..., Any],
) -> bool:
    return bool(
        actual is not None
        and _unwrapped_handler(actual) is _unwrapped_handler(registered)
    )


def _public_marble_handlers() -> Mapping[str, Callable[..., Any]]:
    # Keep this import lazy: the provider handler imports execution event types,
    # while capability discovery itself must remain lightweight and read-only.
    from handlers.worldlabs import (
        handle_worldlabs_environment,
        handle_worldlabs_export,
    )

    return {
        "worldlabs-environment": handle_worldlabs_environment,
        "worldlabs-world-export": handle_worldlabs_export,
    }


def _default_node_definitions() -> Mapping[str, Mapping[str, Any]]:
    from services.node_registry import NodeRegistry

    return NodeRegistry().get_all()


@dataclass(frozen=True, slots=True)
class AtlasAdapterOperation:
    """One concrete Atlas node-to-callable registration."""

    definition_id: str
    capability_ids: tuple[str, ...]
    handler: Callable[..., Any]

    def __post_init__(self) -> None:
        if not self.definition_id or self.definition_id != self.definition_id.strip():
            raise ValueError("Atlas operation definition_id must be trimmed and non-empty")
        if self.definition_id in PUBLIC_MARBLE_DEFINITION_IDS:
            raise ValueError("Atlas operations cannot replace public Marble handlers")
        if not self.capability_ids or len(set(self.capability_ids)) != len(
            self.capability_ids
        ):
            raise ValueError("Atlas operation capability_ids must be non-empty and unique")
        unknown = set(self.capability_ids) - set(ATLAS_ANNOUNCED_CAPABILITY_IDS)
        if unknown:
            raise ValueError(f"unknown Atlas capability ids: {sorted(unknown)}")
        if not callable(self.handler):
            raise ValueError("Atlas operation handler must be callable")


@dataclass(frozen=True, slots=True)
class AtlasAdapterInstallation:
    """Versioned contract plus the actual handlers installed in the backend."""

    contract_version: str
    contract_hash: str
    operations: tuple[AtlasAdapterOperation, ...]

    def __post_init__(self) -> None:
        if not self.contract_version.strip():
            raise ValueError("Atlas adapter contract_version must not be blank")
        if not _CONTRACT_HASH_PATTERN.fullmatch(self.contract_hash):
            raise ValueError(
                "Atlas adapter contract_hash must be a lowercase sha256 digest"
            )
        if not self.operations:
            raise ValueError("Atlas adapter must install at least one callable operation")
        definition_ids = [operation.definition_id for operation in self.operations]
        if len(definition_ids) != len(set(definition_ids)):
            raise ValueError("Atlas adapter operation definition_ids must be unique")


_VERIFIED_ENTITLEMENT_ISSUER = object()


@dataclass(frozen=True, slots=True, init=False)
class VerifiedAtlasEntitlement:
    """Entitlement issued only after a backend verifier accepts the adapter."""

    contract_version: str
    contract_hash: str

    def __init__(
        self,
        contract_version: str,
        contract_hash: str,
        *,
        _issuer: object | None = None,
    ) -> None:
        if _issuer is not _VERIFIED_ENTITLEMENT_ISSUER:
            raise TypeError(
                "VerifiedAtlasEntitlement must be issued by verify_atlas_entitlement"
            )
        object.__setattr__(self, "contract_version", contract_version)
        object.__setattr__(self, "contract_hash", contract_hash)


def verify_atlas_entitlement(
    adapter: AtlasAdapterInstallation,
    verifier: Callable[[AtlasAdapterInstallation], bool],
) -> VerifiedAtlasEntitlement:
    """Issue a contract-bound entitlement after an installed backend check.

    No verifier exists in this build because World Labs has not published a
    public Atlas entitlement contract. A future adapter must supply one; plain
    metadata, environment flags, and a Marble API key cannot mint this value.
    """

    if not callable(verifier) or verifier(adapter) is not True:
        raise AtlasExecutionUnavailable(
            "Atlas entitlement verification did not authorize this adapter"
        )
    return VerifiedAtlasEntitlement(
        adapter.contract_version,
        adapter.contract_hash,
        _issuer=_VERIFIED_ENTITLEMENT_ISSUER,
    )


class AtlasExecutionUnavailable(RuntimeError):
    """Raised when code attempts Atlas execution before the gate is ready."""


class WorldLabsCapabilityGate:
    """Build the public manifest and guard any future Atlas execution path."""

    def __init__(
        self,
        *,
        atlas_adapter: AtlasAdapterInstallation | None = None,
        atlas_entitlement: VerifiedAtlasEntitlement | None = None,
        node_definitions: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        self._atlas_adapter = atlas_adapter
        self._atlas_entitlement = atlas_entitlement
        self._node_definitions = node_definitions

    def _definitions(self) -> Mapping[str, Mapping[str, Any]]:
        if self._node_definitions is None:
            self._node_definitions = _default_node_definitions()
        return self._node_definitions

    def _resolve_definition(
        self,
        definition_id: str,
        supplied: Mapping[str, Any] | None | object = _NODE_DEFINITION_UNSET,
    ) -> Mapping[str, Any] | None:
        if supplied is not _NODE_DEFINITION_UNSET:
            return supplied if isinstance(supplied, Mapping) else None
        definition = self._definitions().get(definition_id)
        return definition if isinstance(definition, Mapping) else None

    @staticmethod
    def _definition_is_worldlabs(
        definition_id: str,
        definition: Mapping[str, Any] | None,
    ) -> bool:
        if definition is None or definition.get("apiProvider") != "worldlabs":
            return False
        declared_id = definition.get("id")
        return declared_id is None or declared_id == definition_id

    @staticmethod
    def _operation_policy_is_safe(definition_id: str) -> bool:
        policy = operation_policy(definition_id)
        return bool(
            policy is not None
            and policy.provider == "worldlabs"
            and bool(policy.operation_group.strip())
            and policy.may_start_billable_work
            and policy.uses_durable_recovery
            and policy.cache_policy == "provider_recovery"
            and not policy.allow_quick_execution
            and (
                policy.recovery_operation_param is not None
                or policy.recovery_resource_param is not None
            )
        )

    def _atlas_operations(self) -> Mapping[str, AtlasAdapterOperation]:
        adapter = self._atlas_adapter
        if adapter is None:
            return {}
        return {operation.definition_id: operation for operation in adapter.operations}

    def _atlas_entitlement_is_verified(self) -> bool:
        adapter = self._atlas_adapter
        entitlement = self._atlas_entitlement
        return bool(
            adapter is not None
            and entitlement is not None
            and entitlement.contract_version == adapter.contract_version
            and entitlement.contract_hash == adapter.contract_hash
        )

    def _atlas_policy_is_complete(self) -> bool:
        operations = self._atlas_operations()
        if not operations:
            return False
        return all(
            self._operation_policy_is_safe(definition_id)
            for definition_id in operations
        )

    def _atlas_definitions_are_complete(self) -> bool:
        operations = self._atlas_operations()
        if not operations:
            return False
        definitions = self._definitions()
        return all(
            self._definition_is_worldlabs(
                definition_id,
                definitions.get(definition_id),
            )
            for definition_id in operations
        )

    def _atlas_block_reason(self) -> str | None:
        if self._atlas_adapter is None:
            return "versioned_adapter_not_installed"
        if not self._atlas_entitlement_is_verified():
            return "entitlement_not_verified_for_adapter"
        if not self._atlas_policy_is_complete():
            return "adapter_operation_policy_not_registered"
        if not self._atlas_definitions_are_complete():
            return "adapter_node_definition_not_registered"
        return None

    def manifest(self) -> dict[str, Any]:
        """Return capability facts without probing credentials or providers."""
        adapter = self._atlas_adapter
        entitlement_verified = self._atlas_entitlement_is_verified()
        block_reason = self._atlas_block_reason()
        enabled_capabilities = {
            capability_id
            for operation in self._atlas_operations().values()
            for capability_id in operation.capability_ids
        }

        atlas: dict[str, Any] = {
            "availability": "announced_only" if block_reason else "adapter_ready",
            "announcementStage": "early_access_select_partners",
            "adapterStatus": "installed" if adapter is not None else "absent",
            "entitlementStatus": ("verified" if entitlement_verified else "unverified"),
            "executionStatus": "enabled" if block_reason is None else "blocked",
            "executable": block_reason is None,
            "blockReason": block_reason,
            "announcedCapabilities": [
                {
                    "id": capability_id,
                    "availability": (
                        "adapter_ready"
                        if block_reason is None and capability_id in enabled_capabilities
                        else "announced_only"
                    ),
                    "executable": bool(
                        block_reason is None and capability_id in enabled_capabilities
                    ),
                }
                for capability_id in ATLAS_ANNOUNCED_CAPABILITY_IDS
            ],
        }
        if adapter is not None:
            atlas["adapter"] = {
                "contractVersion": adapter.contract_version,
                "contractHash": adapter.contract_hash,
            }

        return {
            "schemaVersion": WORLDLABS_CAPABILITY_SCHEMA_VERSION,
            "provider": "worldlabs",
            "marble": {
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
            },
            "atlas": atlas,
        }

    def require_atlas_execution(
        self,
        definition_id: str,
        handler: Callable[..., Any] | None,
        *,
        node_definition: Mapping[str, Any] | None | object = _NODE_DEFINITION_UNSET,
    ) -> AtlasAdapterOperation:
        """Authorize one exact registered handler or fail before submission."""
        reason = self._atlas_block_reason()
        if reason is not None or self._atlas_adapter is None:
            raise AtlasExecutionUnavailable(
                f"Atlas execution is blocked: {reason or 'capability_not_ready'}"
            )
        operation = self._atlas_operations().get(definition_id)
        if operation is None:
            raise AtlasExecutionUnavailable(
                "Atlas execution is blocked: operation_not_registered_by_adapter"
            )
        definition = self._resolve_definition(definition_id, node_definition)
        if not self._definition_is_worldlabs(definition_id, definition):
            raise AtlasExecutionUnavailable(
                "Atlas execution is blocked: node_definition_provider_mismatch"
            )
        if not self._operation_policy_is_safe(definition_id):
            raise AtlasExecutionUnavailable(
                "Atlas execution is blocked: operation_policy_mismatch"
            )
        if not _handlers_match(handler, operation.handler):
            raise AtlasExecutionUnavailable(
                "Atlas execution is blocked: handler_not_registered_by_adapter"
            )
        return operation

    def require_worldlabs_execution(
        self,
        definition_id: str,
        handler: Callable[..., Any] | None,
        *,
        node_definition: Mapping[str, Any] | None | object = _NODE_DEFINITION_UNSET,
    ) -> None:
        """Enforce the World Labs provider boundary for every execution path."""

        definition = self._resolve_definition(definition_id, node_definition)
        if definition is None:
            raise AtlasExecutionUnavailable(
                "World Labs execution is blocked: node_definition_not_registered"
            )
        if not self._definition_is_worldlabs(definition_id, definition):
            raise AtlasExecutionUnavailable(
                "World Labs execution is blocked: node_definition_provider_mismatch"
            )

        if definition_id in PUBLIC_MARBLE_DEFINITION_IDS:
            expected_handler = _public_marble_handlers()[definition_id]
            if not self._operation_policy_is_safe(definition_id):
                raise AtlasExecutionUnavailable(
                    "World Labs execution is blocked: Marble operation policy is incomplete"
                )
            if not _handlers_match(handler, expected_handler):
                raise AtlasExecutionUnavailable(
                    "World Labs execution is blocked: Marble handler identity mismatch"
                )
            return
        self.require_atlas_execution(
            definition_id,
            handler,
            node_definition=definition,
        )


# No Atlas adapter or entitlement is installed in this build. Future support
# must use explicit backend registration, not an environment variable,
# frontend flag, or Marble credential.
worldlabs_capability_gate = WorldLabsCapabilityGate()
