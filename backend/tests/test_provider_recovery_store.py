from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.provider_recovery import (
    ProviderRecoveryCapacityError,
    ProviderRecoveryConflictError,
    ProviderRecoveryPersistenceError,
    ProviderRecoveryStore,
)


def test_provider_recovery_store_round_trips_and_refuses_silent_eviction(tmp_path: Path) -> None:
    path = tmp_path / "provider-recoveries.json"
    store = ProviderRecoveryStore(path, max_records=2)
    store.set(
        run_id="run-1",
        node_id="uuid-node",
        resume_operation_id="operation-1",
        existing_world_id=None,
    )
    store.set(
        run_id="run-2",
        node_id="uuid-node",
        resume_operation_id=None,
        existing_world_id="world-2",
    )

    reloaded = ProviderRecoveryStore(path, max_records=2)
    assert reloaded.list() == [
        {
            "runId": "run-1",
            "nodeId": "uuid-node",
            "resumeOperationId": "operation-1",
            "existingWorldId": None,
        },
        {
            "runId": "run-2",
            "nodeId": "uuid-node",
            "resumeOperationId": None,
            "existingWorldId": "world-2",
        },
    ]

    with pytest.raises(ProviderRecoveryPersistenceError, match="at capacity"):
        reloaded.set(
            run_id="run-3",
            node_id="other-node",
            resume_operation_id="operation-3",
            existing_world_id=None,
        )
    records = ProviderRecoveryStore(path, max_records=2).list()
    assert [record["runId"] for record in records] == ["run-1", "run-2"]
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 1


@pytest.mark.parametrize(
    ("resume_operation_id", "existing_world_id"),
    [(None, None), ("operation", "world")],
)
def test_provider_recovery_store_requires_exactly_one_checkpoint(
    tmp_path: Path,
    resume_operation_id: str | None,
    existing_world_id: str | None,
) -> None:
    store = ProviderRecoveryStore(tmp_path / "recoveries.json")
    with pytest.raises(ValueError, match="exactly one"):
        store.set(
            run_id="run",
            node_id="node",
            resume_operation_id=resume_operation_id,
            existing_world_id=existing_world_id,
        )


def test_provider_recovery_store_deletes_only_exact_run_node_pair(
    tmp_path: Path,
) -> None:
    path = tmp_path / "recoveries.json"
    store = ProviderRecoveryStore(path)
    for run_id, node_id in (("run-1", "node-a"), ("run-1", "node-b"), ("run-2", "node-a")):
        store.set(
            run_id=run_id,
            node_id=node_id,
            resume_operation_id=f"operation-{run_id}-{node_id}",
            existing_world_id=None,
        )

    assert store.delete(
        run_id="run-1",
        node_id="node-a",
        resume_operation_id="operation-run-1-node-a",
        existing_world_id=None,
    ) is True
    assert store.delete(
        run_id="run-1",
        node_id="node-a",
        resume_operation_id="operation-run-1-node-a",
        existing_world_id=None,
    ) is False
    assert {(item["runId"], item["nodeId"]) for item in store.list()} == {
        ("run-1", "node-b"),
        ("run-2", "node-a"),
    }
    assert ProviderRecoveryStore(path).list() == store.list()


def test_stale_delete_cannot_remove_reused_run_node_checkpoint(
    tmp_path: Path,
) -> None:
    store = ProviderRecoveryStore(tmp_path / "recoveries.json")
    store.set(
        run_id="reused-run",
        node_id="same-node",
        resume_operation_id="new-operation",
        existing_world_id=None,
    )

    with pytest.raises(ProviderRecoveryConflictError, match="changed"):
        store.delete(
            run_id="reused-run",
            node_id="same-node",
            resume_operation_id="old-operation",
            existing_world_id=None,
        )

    assert store.list()[0]["resumeOperationId"] == "new-operation"


def test_provider_recovery_store_reports_write_failure_without_false_record(
    tmp_path: Path,
) -> None:
    not_a_directory = tmp_path / "blocked"
    not_a_directory.write_text("file", encoding="utf-8")
    store = ProviderRecoveryStore(not_a_directory / "recoveries.json")

    with pytest.raises(ProviderRecoveryPersistenceError, match="write failed"):
        store.set(
            run_id="paid-run",
            node_id="uuid-node",
            resume_operation_id="paid-operation",
            existing_world_id=None,
        )

    assert store.list() == []


@pytest.mark.parametrize(
    "payload",
    [
        {"version": 1, "records": ["malformed"]},
        {
            "version": 1,
            "records": [
                {
                    "runId": "one",
                    "nodeId": "one",
                    "resumeOperationId": "operation-one",
                    "existingWorldId": None,
                },
                {
                    "runId": "two",
                    "nodeId": "two",
                    "resumeOperationId": "operation-two",
                    "existingWorldId": None,
                },
            ],
        },
    ],
)
def test_invalid_or_over_capacity_recovery_journal_is_unhealthy(
    tmp_path: Path, payload: dict
) -> None:
    path = tmp_path / "recoveries.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    store = ProviderRecoveryStore(path, max_records=1)

    assert store.is_healthy() is False
    assert store.list() == []
    with pytest.raises(ProviderRecoveryPersistenceError, match="unhealthy"):
        store.set(
            run_id="new",
            node_id="new",
            resume_operation_id="new-operation",
            existing_world_id=None,
        )


def test_recovery_capacity_is_reserved_before_provider_acceptance(
    tmp_path: Path,
) -> None:
    store = ProviderRecoveryStore(tmp_path / "recoveries.json", max_records=1)
    store.reserve(run_id="first", node_ids=["first-node"])

    with pytest.raises(ProviderRecoveryCapacityError, match="at capacity"):
        store.reserve(run_id="second", node_ids=["second-node"])

    store.set(
        run_id="first",
        node_id="first-node",
        resume_operation_id="first-operation",
        existing_world_id=None,
    )
    assert store.list()[0]["nodeId"] == "first-node"


def test_recovery_replays_reuse_original_checkpoint_without_capacity_growth(
    tmp_path: Path,
) -> None:
    path = tmp_path / "recoveries.json"
    store = ProviderRecoveryStore(path, max_records=1)
    store.set(
        run_id="fresh-paid-start",
        node_id="world-node",
        resume_operation_id="accepted-operation",
        existing_world_id=None,
    )

    for index in range(300):
        replay_run = f"safe-replay-{index}"
        store.reserve_checkpoints(
            run_id=replay_run,
            checkpoints=[("world-node", "accepted-operation", None)],
        )
        store.set(
            run_id=replay_run,
            node_id="world-node",
            resume_operation_id="accepted-operation",
            existing_world_id=None,
        )

    assert ProviderRecoveryStore(path, max_records=1).list() == [
        {
            "runId": "fresh-paid-start",
            "nodeId": "world-node",
            "resumeOperationId": "accepted-operation",
            "existingWorldId": None,
        }
    ]
    with pytest.raises(ProviderRecoveryCapacityError, match="at capacity"):
        store.reserve(run_id="new-paid-start", node_ids=["different-node"])


def test_graph_checkpoint_batch_is_shared_and_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "recoveries.json"
    importing_backend = ProviderRecoveryStore(path, max_records=2)
    executing_backend = ProviderRecoveryStore(path, max_records=2)

    added = importing_backend.ensure_many(
        run_id="graph-import",
        checkpoints=[
            ("world-node", "accepted-operation", None),
            ("export-node", "accepted-export", None),
        ],
    )
    assert len(added) == 2
    assert {record["nodeId"] for record in executing_backend.list()} == {
        "world-node",
        "export-node",
    }

    # A restart or repeated import carrying the same provider identities does
    # not create duplicate safety records under a new synthetic run ID.
    assert executing_backend.ensure_many(
        run_id="graph-import-again",
        checkpoints=[("world-node", "accepted-operation", None)],
    ) == []
    assert len(importing_backend.list()) == 2


def test_delete_many_exact_is_atomic_and_preserves_unrelated_records(
    tmp_path: Path,
) -> None:
    path = tmp_path / "recoveries.json"
    store = ProviderRecoveryStore(path)
    added = store.ensure_many(
        run_id="candidate",
        checkpoints=[
            ("node-a", "operation-a", None),
            ("node-b", None, "world-b"),
        ],
    )
    store.set(
        run_id="unrelated",
        node_id="node-c",
        resume_operation_id="operation-c",
        existing_world_id=None,
    )

    assert store.delete_many_exact(added) == 2
    assert ProviderRecoveryStore(path).list() == [
        {
            "runId": "unrelated",
            "nodeId": "node-c",
            "resumeOperationId": "operation-c",
            "existingWorldId": None,
        }
    ]
