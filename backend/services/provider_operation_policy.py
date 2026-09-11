"""Explicit execution policy for provider operations with side effects.

Node definitions describe UI and transport metadata; they are not trusted to
grant billable execution privileges. This backend-only registry is the single
place where a provider operation joins recovery, cache, and quick-run safety.
Unknown IDs fail to ordinary deterministic defaults and never become paid just
because a graph or frontend claims they are.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping


CachePolicy = Literal["deterministic", "provider_recovery"]


@dataclass(frozen=True, slots=True)
class ProviderOperationPolicy:
    provider: str
    operation_group: str
    may_start_billable_work: bool
    uses_durable_recovery: bool
    cache_policy: CachePolicy
    allow_quick_execution: bool
    recovery_operation_param: str | None
    recovery_resource_param: str | None
    billable_start_condition: tuple[str, str] | None


# Registration here is necessary but not sufficient to execute: the node still
# needs a node definition, handler, provider credential, and all handler-level
# validation. Atlas is intentionally absent until a real adapter is installed.
PROVIDER_OPERATION_POLICIES: dict[str, ProviderOperationPolicy] = {
    "worldlabs-environment": ProviderOperationPolicy(
        provider="worldlabs",
        operation_group="worldlabs",
        may_start_billable_work=True,
        uses_durable_recovery=True,
        cache_policy="provider_recovery",
        allow_quick_execution=False,
        recovery_operation_param="resume_operation_id",
        recovery_resource_param="existing_world_id",
        billable_start_condition=None,
    ),
    "worldlabs-world-export": ProviderOperationPolicy(
        provider="worldlabs",
        operation_group="worldlabs",
        # The handler decides whether a specific export is billable (HQ GLB)
        # or free (PLY). The operation kind must still join the guard registry.
        may_start_billable_work=True,
        uses_durable_recovery=True,
        cache_policy="provider_recovery",
        allow_quick_execution=False,
        recovery_operation_param="resume_operation_id",
        recovery_resource_param=None,
        billable_start_condition=("format", "glb"),
    ),
}


def operation_policy(definition_id: str) -> ProviderOperationPolicy | None:
    return PROVIDER_OPERATION_POLICIES.get(definition_id)


def is_paid_start_guard_kind(
    definition_id: str,
    *,
    provider: str | None = None,
) -> bool:
    """Return whether the *current* registry admits this paid operation kind.

    This deliberately performs a live lookup.  Future provider adapters are
    installed after module import in long-running backends, so a module-level
    snapshot would omit their safety policy and silently bypass the start
    fence.
    """

    policy = operation_policy(definition_id)
    return bool(
        policy is not None
        and policy.may_start_billable_work
        and (provider is None or policy.provider == provider)
    )


def bypasses_output_cache(definition_id: str) -> bool:
    """Return whether provider recovery, rather than memoization, owns replay."""

    policy = operation_policy(definition_id)
    return bool(policy is not None and policy.cache_policy == "provider_recovery")


def quick_execution_allowed(definition_id: str) -> bool:
    """Return the current policy's quick-run decision (ordinary nodes default on)."""

    policy = operation_policy(definition_id)
    return policy is None or policy.allow_quick_execution


def uses_durable_recovery(
    definition_id: str,
    *,
    provider: str | None = None,
) -> bool:
    """Return whether the current operation policy owns a recovery journal."""

    policy = operation_policy(definition_id)
    return bool(
        policy is not None
        and policy.uses_durable_recovery
        and (provider is None or policy.provider == provider)
    )


def _nonblank_param(params: Mapping[str, Any], key: str | None) -> str | None:
    if key is None:
        return None
    value = params.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def recovery_identifiers(
    definition_id: str,
    params: Mapping[str, Any],
) -> tuple[str | None, str | None]:
    """Return policy-declared operation/resource recovery identifiers."""

    policy = operation_policy(definition_id)
    if policy is None or not policy.uses_durable_recovery:
        return None, None
    return (
        _nonblank_param(params, policy.recovery_operation_param),
        _nonblank_param(params, policy.recovery_resource_param),
    )


def recovery_param_names(definition_id: str) -> tuple[str, ...]:
    """Return recovery fields in stable policy declaration order."""

    policy = operation_policy(definition_id)
    if policy is None or not policy.uses_durable_recovery:
        return ()
    return tuple(
        key
        for key in (
            policy.recovery_operation_param,
            policy.recovery_resource_param,
        )
        if key is not None
    )


def has_recovery_identity(definition_id: str, params: Mapping[str, Any]) -> bool:
    return any(recovery_identifiers(definition_id, params))


def requires_fresh_paid_start(
    definition_id: str,
    params: Mapping[str, Any],
) -> bool:
    """Classify a fresh billable start solely from backend policy data."""

    policy = operation_policy(definition_id)
    if policy is None or not policy.may_start_billable_work:
        return False
    if has_recovery_identity(definition_id, params):
        return False
    condition = policy.billable_start_condition
    if condition is None:
        return True
    key, expected = condition
    value = params.get(key)
    return isinstance(value, str) and value.strip().lower() == expected.lower()


def _validate_registry() -> None:
    for definition_id, policy in PROVIDER_OPERATION_POLICIES.items():
        if not definition_id or definition_id != definition_id.strip():
            raise RuntimeError("provider operation IDs must be trimmed and non-empty")
        recovery_fields = (
            policy.recovery_operation_param,
            policy.recovery_resource_param,
        )
        if policy.uses_durable_recovery and not any(recovery_fields):
            raise RuntimeError(
                f"{definition_id} enables durable recovery without a recovery field"
            )
        if not policy.uses_durable_recovery and any(recovery_fields):
            raise RuntimeError(
                f"{definition_id} declares recovery fields without durable recovery"
            )
        if (
            policy.billable_start_condition is not None
            and not policy.may_start_billable_work
        ):
            raise RuntimeError(
                f"{definition_id} has a billing condition but cannot start billable work"
            )


_validate_registry()


def operation_ids(*, provider: str | None = None) -> frozenset[str]:
    """Return a point-in-time inventory for diagnostics only.

    Execution admission must use the predicate helpers above so registrations
    made after import cannot bypass cache, quick-run, recovery, or start-guard
    policy.
    """

    return frozenset(
        definition_id
        for definition_id, policy in PROVIDER_OPERATION_POLICIES.items()
        if provider is None or policy.provider == provider
    )
