from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path

import pytest

from services.provider_start_guard import (
    ProviderStartCancellationCapacityError,
    ProviderStartCancelledError,
    ProviderStartConflictError,
    ProviderStartGuard,
    ProviderStartPersistenceError,
)


ENVIRONMENT = "worldlabs-environment"
EXPORT = "worldlabs-world-export"


def test_pending_paid_intent_becomes_ambiguity_after_restart(tmp_path: Path) -> None:
    path = tmp_path / "provider-starts.json"
    guard = ProviderStartGuard(path)
    guard.claim(run_id="run-before-crash", claims=[(ENVIRONMENT, "world-node")])
    guard.close()  # Simulate process exit: durable intent remains, OS lock does not.

    restarted = ProviderStartGuard(path)

    assert restarted.list() == [
        {
            "runId": "run-before-crash",
            "nodeId": "world-node",
            "kind": ENVIRONMENT,
            "message": (
                "World Labs may have accepted a paid start without returning a "
                "recovery ID. Check Marble before unlocking; do not rerun blindly."
            ),
            "durable": True,
        }
    ]
    with pytest.raises(ProviderStartConflictError, match="safety-locked"):
        restarted.claim(
            run_id="run-after-crash",
            claims=[(ENVIRONMENT, "world-node")],
        )


def test_two_backend_instances_cannot_claim_same_paid_boundary(
    tmp_path: Path,
) -> None:
    path = tmp_path / "provider-starts.json"
    first = ProviderStartGuard(path)
    second = ProviderStartGuard(path)

    first.claim(run_id="backend-one", claims=[(ENVIRONMENT, "first-node")])

    with pytest.raises(ProviderStartConflictError, match="another Nebula backend"):
        second.claim(
            run_id="backend-two",
            claims=[(ENVIRONMENT, "different-node")],
        )
    assert second.has_active() is True

    first.release_run("backend-one")
    second.claim(run_id="backend-two", claims=[(ENVIRONMENT, "different-node")])


def test_cross_backend_durable_stop_wins_paid_admission(tmp_path: Path) -> None:
    path = tmp_path / "provider-starts.json"
    cancelling_backend = ProviderStartGuard(path)
    executing_backend = ProviderStartGuard(path)

    cancelling_backend.record_cancel_intent("delayed-paid-run")

    with pytest.raises(ProviderStartCancelledError, match="cancelled"):
        executing_backend.assert_run_admissible("delayed-paid-run")
    with pytest.raises(ProviderStartCancelledError, match="cancelled"):
        executing_backend.claim(
            run_id="delayed-paid-run",
            claims=[(ENVIRONMENT, "world-node")],
        )
    assert executing_backend.has_active() is False


def test_durable_stop_capacity_never_evicts_existing_intent(tmp_path: Path) -> None:
    path = tmp_path / "provider-starts.json"
    guard = ProviderStartGuard(path, max_records=1)
    guard.record_cancel_intent("victim")

    with pytest.raises(ProviderStartCancellationCapacityError, match="capacity"):
        guard.record_cancel_intent("overflow")
    restarted = ProviderStartGuard(path, max_records=1)
    with pytest.raises(ProviderStartCancelledError, match="victim"):
        restarted.claim(
            run_id="victim",
            claims=[(ENVIRONMENT, "world-node")],
        )
    with pytest.raises(ProviderStartCancellationCapacityError, match="capacity"):
        restarted.claim(
            run_id="unrelated",
            claims=[(ENVIRONMENT, "other-node")],
        )
    assert restarted.acknowledge_cancel_intent("victim") is True
    with pytest.raises(ProviderStartCancelledError, match="victim"):
        restarted.assert_run_admissible("victim")
    restarted.claim(
        run_id="unrelated",
        claims=[(ENVIRONMENT, "other-node")],
    )
    restarted.release_run("unrelated")

    after_compaction = ProviderStartGuard(path, max_records=1)
    with pytest.raises(ProviderStartCancelledError, match="victim"):
        after_compaction.assert_run_admissible("victim")
    after_compaction.assert_run_admissible("another-unrelated-run")


def test_concurrent_claim_is_atomic_and_terminal_release_unlocks(tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")

    def claim(run_id: str) -> str:
        try:
            guard.claim(run_id=run_id, claims=[(ENVIRONMENT, "same-node")])
        except ProviderStartConflictError:
            return "conflict"
        return "claimed"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(claim, ("run-a", "run-b")))

    assert sorted(outcomes) == ["claimed", "conflict"]
    winner = "run-a" if outcomes[0] == "claimed" else "run-b"
    assert guard.release_run(winner) == []
    guard.claim(run_id="run-c", claims=[(ENVIRONMENT, "same-node")])


def test_clear_removes_holds_but_never_active_lease(tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    guard.claim(run_id="active", claims=[(ENVIRONMENT, "active-node")])
    guard.mark_ambiguous(
        run_id="older", node_id="held-node", kind=ENVIRONMENT
    )

    guard.clear()

    assert guard.list() == []
    assert guard.has_active() is True
    with pytest.raises(ProviderStartConflictError, match="already active"):
        guard.claim(
            run_id="duplicate", claims=[(ENVIRONMENT, "active-node")]
        )


def test_acknowledge_failure_retains_hold(monkeypatch, tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    expected = guard.mark_ambiguous(
        run_id="ambiguous", node_id="held-node", kind=EXPORT
    )

    def fail_persist() -> None:
        raise ProviderStartPersistenceError("disk full")

    monkeypatch.setattr(guard, "_persist", fail_persist)
    with pytest.raises(ProviderStartPersistenceError, match="disk full"):
        guard.acknowledge(kind=EXPORT, node_id="held-node", run_id="ambiguous")

    assert guard.list() == [expected]


def test_acknowledge_waits_for_active_handshake_to_finish(tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    guard.claim(run_id="active", claims=[(ENVIRONMENT, "held-node")])
    guard.mark_ambiguous(
        run_id="active", node_id="held-node", kind=ENVIRONMENT
    )

    with pytest.raises(ProviderStartConflictError, match="still active"):
        guard.acknowledge(kind=ENVIRONMENT, node_id="held-node", run_id="active")
    assert guard.list()

    guard.release_run("active")
    assert guard.acknowledge(
        kind=ENVIRONMENT,
        node_id="held-node",
        run_id="active",
    ) is True
    assert guard.list() == []


def test_stale_ack_cannot_delete_newer_same_node_ambiguity(tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    guard.mark_ambiguous(
        run_id="old-run", node_id="same-node", kind=ENVIRONMENT
    )
    assert guard.acknowledge(
        kind=ENVIRONMENT,
        node_id="same-node",
        run_id="old-run",
    ) is True
    guard.mark_ambiguous(
        run_id="new-run", node_id="same-node", kind=ENVIRONMENT
    )

    with pytest.raises(ProviderStartConflictError, match="changed"):
        guard.acknowledge(
            kind=ENVIRONMENT,
            node_id="same-node",
            run_id="old-run",
        )

    assert guard.list()[0]["runId"] == "new-run"


def test_clear_failure_retains_all_holds(monkeypatch, tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    first = guard.mark_ambiguous(
        run_id="one", node_id="one", kind=ENVIRONMENT
    )
    second = guard.mark_ambiguous(
        run_id="two", node_id="two", kind=EXPORT
    )

    def fail_persist() -> None:
        raise ProviderStartPersistenceError("read-only")

    monkeypatch.setattr(guard, "_persist", fail_persist)
    with pytest.raises(ProviderStartPersistenceError, match="read-only"):
        guard.clear()

    assert guard.list() == [first, second]


def test_failed_preflight_blocks_before_active_claim(tmp_path: Path) -> None:
    not_a_directory = tmp_path / "file"
    not_a_directory.write_text("occupied", encoding="utf-8")
    guard = ProviderStartGuard(not_a_directory / "provider-starts.json")

    with pytest.raises(ProviderStartPersistenceError, match="write failed"):
        guard.claim(run_id="paid", claims=[(ENVIRONMENT, "world")])

    assert guard.has_active() is False
    assert guard.list() == []


def test_ambiguity_write_failure_is_visible_and_fail_closed(
    monkeypatch, tmp_path: Path
) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    guard.claim(run_id="paid", claims=[(ENVIRONMENT, "world")])

    def fail_persist() -> None:
        raise ProviderStartPersistenceError("disk full")

    monkeypatch.setattr(guard, "_persist", fail_persist)
    record = guard.mark_ambiguous(
        run_id="paid", node_id="world", kind=ENVIRONMENT
    )

    assert record["durable"] is False
    assert guard.list()[0]["durable"] is False
    with pytest.raises(ProviderStartPersistenceError, match="storage is unhealthy"):
        guard.claim(run_id="other", claims=[(ENVIRONMENT, "other-world")])


def test_nondurable_recovery_converts_pending_intent_to_hold(tmp_path: Path) -> None:
    path = tmp_path / "provider-starts.json"
    guard = ProviderStartGuard(path)
    guard.claim(run_id="paid", claims=[(ENVIRONMENT, "world")])

    record = guard.hold_nondurable_recovery(run_id="paid", node_id="world")

    assert record is not None
    assert record["durable"] is True
    assert "recovery ID" in record["message"]
    assert guard.release_run("paid") == []
    with pytest.raises(ProviderStartConflictError, match="safety-locked"):
        guard.claim(run_id="stale", claims=[(ENVIRONMENT, "world")])


def test_nondurable_recovery_hold_survives_terminal_reload_and_restart(
    monkeypatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "provider-starts.json"
    guard = ProviderStartGuard(path)
    guard.claim(run_id="paid", claims=[(ENVIRONMENT, "world")])
    original_persist = guard._persist
    calls = 0

    def fail_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ProviderStartPersistenceError("transient disk failure")
        original_persist()

    monkeypatch.setattr(guard, "_persist", fail_once)
    hold = guard.hold_nondurable_recovery(run_id="paid", node_id="world")
    assert hold is not None and hold["durable"] is False

    assert guard.release_run("paid") == []
    restarted = ProviderStartGuard(path)
    assert restarted.list()[0]["nodeId"] == "world"
    assert restarted.list()[0]["durable"] is True
    with pytest.raises(ProviderStartConflictError, match="safety-locked"):
        restarted.claim(run_id="stale", claims=[(ENVIRONMENT, "world")])


def test_capacity_never_evicts_unresolved_hold(tmp_path: Path) -> None:
    guard = ProviderStartGuard(
        tmp_path / "provider-starts.json", max_records=1
    )
    first = guard.mark_ambiguous(
        run_id="first", node_id="first-node", kind=ENVIRONMENT
    )

    with pytest.raises(ProviderStartConflictError, match="at capacity"):
        guard.claim(
            run_id="second", claims=[(EXPORT, "second-node")]
        )

    assert guard.list() == [first]
    with pytest.raises(ProviderStartConflictError, match="safety-locked"):
        guard.claim(
            run_id="retry-first", claims=[(ENVIRONMENT, "first-node")]
        )


def test_ambiguity_blocks_new_node_ids_of_same_paid_kind(tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    guard.mark_ambiguous(
        run_id="uncertain", node_id="old-node", kind=ENVIRONMENT
    )

    with pytest.raises(ProviderStartConflictError, match="old-node"):
        guard.claim(
            run_id="duplicate", claims=[(ENVIRONMENT, "brand-new-node")]
        )

    # The environment hold does not block a separately-scoped HQ export kind.
    guard.claim(run_id="export", claims=[(EXPORT, "export-node")])


def test_active_lease_blocks_other_node_ids_of_same_paid_kind(tmp_path: Path) -> None:
    guard = ProviderStartGuard(tmp_path / "provider-starts.json")
    guard.claim(run_id="first", claims=[(ENVIRONMENT, "first-node")])

    with pytest.raises(ProviderStartConflictError, match="first-node"):
        guard.claim(
            run_id="second", claims=[(ENVIRONMENT, "different-node")]
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"version": 1, "ambiguities": ["malformed"], "pending": []},
        {
            "version": 1,
            "ambiguities": [
                {
                    "runId": "one",
                    "nodeId": "one",
                    "kind": ENVIRONMENT,
                    "message": "one",
                },
                {
                    "runId": "two",
                    "nodeId": "two",
                    "kind": ENVIRONMENT,
                    "message": "two",
                },
            ],
            "pending": [],
        },
        {
            "version": 1,
            "ambiguities": [],
            "pending": [],
            "cancelledRunFilter": "invalid",
        },
    ],
)
def test_invalid_or_over_capacity_guard_blocks_all_new_paid_starts(
    tmp_path: Path, payload: dict
) -> None:
    path = tmp_path / "provider-starts.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    guard = ProviderStartGuard(path, max_records=1)

    with pytest.raises(ProviderStartPersistenceError, match="storage is unhealthy"):
        guard.claim(run_id="new", claims=[(ENVIRONMENT, "new-node")])


def test_pre_post_claim_requires_parent_directory_fsync(
    monkeypatch, tmp_path: Path
) -> None:
    path = tmp_path / "provider-starts.json"
    guard = ProviderStartGuard(path)
    real_fsync = os.fsync
    calls = 0

    def fail_directory_fsync(fd: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("directory fsync failed")
        real_fsync(fd)

    monkeypatch.setattr("services.provider_start_guard.os.fsync", fail_directory_fsync)

    with pytest.raises(ProviderStartPersistenceError, match="write failed"):
        guard.claim(run_id="paid", claims=[(ENVIRONMENT, "world")])

    assert guard.has_active() is False
    # replace may already have reached the filesystem. If so, restart treats
    # the intent as ambiguous; it never opens a duplicate-spend window.
    monkeypatch.setattr("services.provider_start_guard.os.fsync", real_fsync)
    assert ProviderStartGuard(path).list()[0]["nodeId"] == "world"
