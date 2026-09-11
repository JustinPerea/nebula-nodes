from __future__ import annotations

from services.provider_operation_policy import (
    PROVIDER_OPERATION_POLICIES,
    ProviderOperationPolicy,
    bypasses_output_cache,
    has_recovery_identity,
    is_paid_start_guard_kind,
    operation_policy,
    operation_ids,
    quick_execution_allowed,
    recovery_identifiers,
    recovery_param_names,
    requires_fresh_paid_start,
    uses_durable_recovery,
)


MARBLE_NODE_IDS = {"worldlabs-environment", "worldlabs-world-export"}


def test_marble_operations_share_one_backend_authoritative_policy() -> None:
    assert set(PROVIDER_OPERATION_POLICIES) == MARBLE_NODE_IDS
    assert set(operation_ids(provider="worldlabs")) == MARBLE_NODE_IDS
    assert all(is_paid_start_guard_kind(item, provider="worldlabs") for item in MARBLE_NODE_IDS)
    assert all(bypasses_output_cache(item) for item in MARBLE_NODE_IDS)
    assert all(not quick_execution_allowed(item) for item in MARBLE_NODE_IDS)
    assert all(uses_durable_recovery(item, provider="worldlabs") for item in MARBLE_NODE_IDS)
    assert all(policy.provider == "worldlabs" for policy in PROVIDER_OPERATION_POLICIES.values())
    assert all(policy.uses_durable_recovery for policy in PROVIDER_OPERATION_POLICIES.values())


def test_unknown_or_claimed_atlas_ids_do_not_gain_paid_policy() -> None:
    assert operation_policy("atlas") is None
    assert operation_policy("worldlabs-atlas") is None
    assert operation_policy("atlas-camera-video") is None
    assert all("atlas" not in definition_id for definition_id in PROVIDER_OPERATION_POLICIES)


def test_paid_start_and_recovery_classification_comes_from_policy() -> None:
    assert requires_fresh_paid_start("worldlabs-environment", {}) is True
    assert requires_fresh_paid_start(
        "worldlabs-environment", {"resume_operation_id": " operation-1 "}
    ) is False
    assert requires_fresh_paid_start(
        "worldlabs-environment", {"existing_world_id": " world-1 "}
    ) is False

    assert requires_fresh_paid_start("worldlabs-world-export", {"format": "ply"}) is False
    assert requires_fresh_paid_start("worldlabs-world-export", {"format": " GLB "}) is True
    assert requires_fresh_paid_start(
        "worldlabs-world-export",
        {"format": "glb", "resume_operation_id": "export-1"},
    ) is False

    assert recovery_identifiers(
        "worldlabs-environment",
        {"resume_operation_id": " op ", "existing_world_id": " world "},
    ) == ("op", "world")
    assert recovery_param_names("worldlabs-environment") == (
        "resume_operation_id",
        "existing_world_id",
    )
    assert has_recovery_identity("worldlabs-world-export", {"format": "glb"}) is False
    assert recovery_identifiers("worldlabs-atlas", {"resume_operation_id": "fake"}) == (
        None,
        None,
    )
    assert requires_fresh_paid_start("worldlabs-atlas", {"format": "glb"}) is False


def test_every_registered_paid_operation_has_an_explicit_start_classifier() -> None:
    for definition_id, policy in PROVIDER_OPERATION_POLICIES.items():
        assert policy.may_start_billable_work
        assert policy.uses_durable_recovery
        assert recovery_param_names(definition_id)
        if policy.billable_start_condition is None:
            assert requires_fresh_paid_start(definition_id, {}) is True
        else:
            key, expected = policy.billable_start_condition
            assert requires_fresh_paid_start(definition_id, {key: expected}) is True


def test_late_registration_is_visible_to_every_execution_policy_predicate(
    monkeypatch,
) -> None:
    definition_id = "worldlabs-future-adapter-test"
    monkeypatch.setitem(
        PROVIDER_OPERATION_POLICIES,
        definition_id,
        ProviderOperationPolicy(
            provider="worldlabs",
            operation_group="worldlabs-future-test",
            may_start_billable_work=True,
            uses_durable_recovery=True,
            cache_policy="provider_recovery",
            allow_quick_execution=False,
            recovery_operation_param="resume_operation_id",
            recovery_resource_param=None,
            billable_start_condition=None,
        ),
    )

    assert is_paid_start_guard_kind(definition_id, provider="worldlabs") is True
    assert bypasses_output_cache(definition_id) is True
    assert quick_execution_allowed(definition_id) is False
    assert uses_durable_recovery(definition_id, provider="worldlabs") is True
    assert recovery_param_names(definition_id) == ("resume_operation_id",)
    assert requires_fresh_paid_start(definition_id, {}) is True
