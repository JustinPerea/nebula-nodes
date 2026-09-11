from __future__ import annotations

import json
import logging
import os
import errno
import fcntl
import hashlib
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any, Callable, Iterable
from uuid import uuid4

from services.provider_operation_policy import is_paid_start_guard_kind


logger = logging.getLogger(__name__)

START_GUARD_VERSION = 1
MAX_AMBIGUITIES = 256
MAX_GUARD_FILE_BYTES = 2 * 1024 * 1024
MAX_NODE_ID_CHARS = 4096
MAX_RUN_ID_CHARS = 128
CANCEL_FILTER_BITS = 1_048_576
CANCEL_FILTER_HASHES = 7
CANCEL_FILTER_BYTES = CANCEL_FILTER_BITS // 8
AMBIGUITY_MESSAGE = (
    "World Labs may have accepted a paid start without returning a recovery ID. "
    "Check Marble before unlocking; do not rerun blindly."
)


class ProviderStartConflictError(RuntimeError):
    """A fresh paid start is already active or held for acknowledgement."""


class ProviderStartPersistenceError(RuntimeError):
    """The ambiguity hold could not be committed to local storage."""


class ProviderStartCancelledError(ProviderStartConflictError):
    """A durable Stop intent arrived before paid-start admission."""


class ProviderStartCancellationCapacityError(RuntimeError):
    """Durable pre-admission Stop intents exhausted bounded capacity."""


def _identifier(value: Any, *, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{label} must be a bounded non-empty string")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f"{label} contains control characters")
    return value


def _key(kind: Any, node_id: Any) -> tuple[str, str]:
    kind = _identifier(kind, label="kind", maximum=64)
    if not is_paid_start_guard_kind(kind, provider="worldlabs"):
        raise ValueError("kind is not a supported paid World Labs operation")
    node_id = _identifier(node_id, label="nodeId", maximum=MAX_NODE_ID_CHARS)
    return kind, node_id


class ProviderStartGuard:
    """Atomic active leases plus durable holds for ambiguous paid starts."""

    def __init__(self, path: Path | None, *, max_records: int = MAX_AMBIGUITIES):
        self._path = path
        self._max_records = max(1, max_records)
        self._lock = RLock()
        self._active: dict[tuple[str, str], str] = {}
        self._recovering: dict[tuple[str, str], str] = {}
        self._pending: dict[tuple[str, str], dict[str, str]] = {}
        self._ambiguities: dict[tuple[str, str], dict[str, Any]] = {}
        self._nondurable_holds: dict[tuple[str, str], dict[str, Any]] = {}
        self._cancelled_runs: dict[str, None] = {}
        self._cancelled_run_filter = bytearray(CANCEL_FILTER_BYTES)
        self._storage_error: str | None = None
        self._lifecycle_fd: int | None = None
        self._lifecycle_run_id: str | None = None
        self._load()
        self._promote_abandoned_pending()

    def claim(
        self,
        *,
        run_id: str,
        claims: Iterable[tuple[str, str]],
        recovery_claims: Iterable[tuple[str, str]] = (),
        pre_commit: Callable[[], None] | None = None,
    ) -> None:
        """Atomically reserve all fresh paid nodes for one execution run."""
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        keys = list(dict.fromkeys(_key(kind, node_id) for kind, node_id in claims))
        recovery_keys = list(
            dict.fromkeys(
                _key(kind, node_id) for kind, node_id in recovery_claims
            )
        )
        if not keys and not recovery_keys:
            return
        with self._lock:
            if self._storage_error is not None:
                raise ProviderStartPersistenceError(
                    "provider start safety storage is unhealthy; clear or repair its "
                    "journal before starting new paid work: " + self._storage_error
                )
            active_leases = {**self._active, **self._recovering}
            if active_leases:
                held_key, active_run = next(iter(active_leases.items()))
                raise ProviderStartConflictError(
                    f"Fresh paid {held_key[0]} start is already active for node "
                    f"'{held_key[1]}' in run '{active_run}'"
                )
            try:
                self._acquire_lifecycle(run_id)
                with self._journal_lock():
                    self._reload_locked()
                    self._assert_run_admissible_locked(run_id)
                    if pre_commit is not None:
                        pre_commit()
                    # Holding the process-wide lifecycle lock proves that any
                    # pending intent on disk no longer has a live owner. Make
                    # that uncertainty explicit before considering this claim.
                    promoted = self._promote_pending_locked()
                    for key in keys:
                        blocking_hold = next(
                            (
                                record
                                for held_key, record in self._ambiguities.items()
                                if held_key[0] == key[0]
                            ),
                            None,
                        )
                        if blocking_hold is not None:
                            if promoted:
                                self._persist()
                            raise ProviderStartConflictError(
                                f"Fresh paid {key[0]} start is safety-locked after an "
                                "ambiguous provider response for node "
                                f"'{blocking_hold['nodeId']}'; check Marble and "
                                "explicitly unlock that hold"
                            )
                    occupied = set(self._ambiguities) | set(self._pending)
                    if len(occupied | set(keys)) > self._max_records:
                        if promoted:
                            self._persist()
                        raise ProviderStartConflictError(
                            "World Labs paid-start safety journal is at capacity; "
                            "resolve an existing recovery or ambiguity before "
                            "starting more paid work"
                        )

                    # Commit a pre-POST intent before provider traffic. If this
                    # process dies before a trustworthy recovery ID is journaled,
                    # another process promotes it after acquiring the lifecycle
                    # lock. The lock is intentionally global across the two paid
                    # kinds so separate backends cannot overbook the shared
                    # recovery journal between reserve and provider acceptance.
                    previous_pending = dict(self._pending)
                    for key in keys:
                        self._pending[key] = {
                            "runId": run_id,
                            "nodeId": key[1],
                            "kind": key[0],
                        }
                    try:
                        self._persist()
                    except ProviderStartPersistenceError as exc:
                        self._pending = previous_pending
                        self._storage_error = str(exc)
                        raise
                    for key in keys:
                        self._active[key] = run_id
                    for key in recovery_keys:
                        self._recovering[key] = run_id
            except Exception:
                if not any(
                    active_run == run_id
                    for active_run in (
                        list(self._active.values()) + list(self._recovering.values())
                    )
                ):
                    self._release_lifecycle(run_id)
                raise

    def record_cancel_intent(self, run_id: str) -> None:
        """Durably record a Stop that won the cross-process admission race."""
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        with self._lock:
            if self._storage_error is not None:
                raise ProviderStartPersistenceError(
                    "provider start safety storage is unhealthy: "
                    + self._storage_error
                )
            with self._journal_lock():
                self._reload_locked()
                if (
                    run_id in self._cancelled_runs
                    or self._cancel_filter_contains(run_id)
                ):
                    return
                if len(self._cancelled_runs) >= self._max_records:
                    raise ProviderStartCancellationCapacityError(
                        "durable pre-admission Stop capacity is exhausted; existing "
                        "Stop intents were preserved"
                    )
                previous = dict(self._cancelled_runs)
                self._cancelled_runs[run_id] = None
                try:
                    self._persist()
                except ProviderStartPersistenceError as exc:
                    self._cancelled_runs = previous
                    self._storage_error = str(exc)
                    raise

    def assert_run_admissible(self, run_id: str) -> None:
        """Reload shared Stop state and fail closed before any graph admission."""
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        with self._lock:
            if self._storage_error is not None:
                raise ProviderStartPersistenceError(
                    "provider start safety storage is unhealthy: "
                    + self._storage_error
                )
            with self._journal_lock():
                self._reload_locked()
                self._assert_run_admissible_locked(run_id)

    def is_run_cancelled(self, run_id: str) -> bool:
        """Cross-process poll used by the active task owner."""
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        with self._lock:
            if self._storage_error is not None:
                return True
            try:
                with self._journal_lock():
                    self._reload_locked()
            except ProviderStartPersistenceError as exc:
                self._storage_error = str(exc)
                return True
            return (
                run_id in self._cancelled_runs
                or self._cancel_filter_contains(run_id)
            )

    def list_cancel_intents(self) -> list[str]:
        with self._lock:
            self._refresh_for_read()
            return list(self._cancelled_runs)

    def acknowledge_cancel_intent(self, run_id: str) -> bool:
        """Compact one Stop tombstone without ever admitting that run ID again.

        Exact tombstones are bounded so operators can inspect unresolved Stop
        requests.  Compaction moves the run ID into a fixed-size durable Bloom
        filter: false positives can conservatively reject a new ID, but there
        are no false negatives and a delayed request using the compacted ID can
        never cross admission after the user frees exact-journal capacity.
        """
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        cleanup_run = f"cancel-cleanup-{uuid4().hex}"
        with self._lock:
            try:
                self._acquire_lifecycle(cleanup_run)
                with self._journal_lock():
                    self._reload_locked()
                    previous = dict(self._cancelled_runs)
                    previous_filter = bytearray(self._cancelled_run_filter)
                    removed = run_id in self._cancelled_runs
                    self._cancelled_runs.pop(run_id, None)
                    if removed:
                        self._cancel_filter_add(run_id)
                        try:
                            self._persist()
                        except ProviderStartPersistenceError:
                            self._cancelled_runs = previous
                            self._cancelled_run_filter = previous_filter
                            raise
                    return removed
            finally:
                self._release_lifecycle(cleanup_run)

    def _assert_run_admissible_locked(self, run_id: str) -> None:
        if run_id in self._cancelled_runs or self._cancel_filter_contains(run_id):
            raise ProviderStartCancelledError(
                f"run '{run_id}' was cancelled before it started"
            )
        if len(self._cancelled_runs) >= self._max_records:
            raise ProviderStartCancellationCapacityError(
                "durable pre-admission Stop capacity is exhausted; explicitly "
                "compact a terminal Stop intent before starting more work"
            )

    @staticmethod
    def _cancel_filter_positions(run_id: str) -> list[int]:
        digest = hashlib.sha256(
            f"nebula-cancel-v1\0{run_id}".encode("utf-8")
        ).digest()
        return [
            int.from_bytes(digest[index * 4 : index * 4 + 4], "big")
            % CANCEL_FILTER_BITS
            for index in range(CANCEL_FILTER_HASHES)
        ]

    def _cancel_filter_contains(self, run_id: str) -> bool:
        return all(
            self._cancelled_run_filter[position // 8]
            & (1 << (position % 8))
            for position in self._cancel_filter_positions(run_id)
        )

    def _cancel_filter_add(self, run_id: str) -> None:
        for position in self._cancel_filter_positions(run_id):
            self._cancelled_run_filter[position // 8] |= 1 << (position % 8)

    def release_run(self, run_id: str) -> list[dict[str, Any]]:
        """Release terminal leases and remove their durable pre-POST intents.

        If that removal cannot be persisted, convert each affected intent to
        an in-process ambiguity hold. The old pending intent remains on disk,
        so a restart also fails closed.
        """
        fallback_holds: list[dict[str, Any]] = []
        with self._lock:
            paid_keys = [
                key for key, active_run in self._active.items()
                if active_run == run_id
            ]
            recovery_keys = [
                key for key, active_run in self._recovering.items()
                if active_run == run_id
            ]
            keys = paid_keys + recovery_keys
            if not keys:
                self._release_lifecycle(run_id)
                return fallback_holds
            try:
                with self._journal_lock():
                    self._reload_locked()
                    previous_pending = dict(self._pending)
                    for key in keys:
                        self._active.pop(key, None)
                        self._recovering.pop(key, None)
                        self._pending.pop(key, None)
                    try:
                        self._persist()
                    except ProviderStartPersistenceError as exc:
                        self._storage_error = str(exc)
                        for key in paid_keys:
                            pending = previous_pending.get(key)
                            if pending is None:
                                continue
                            record: dict[str, Any] = {
                                **pending,
                                "message": AMBIGUITY_MESSAGE,
                                "durable": False,
                            }
                            self._ambiguities[key] = record
                            self._nondurable_holds[key] = record
                            fallback_holds.append(dict(record))
            except ProviderStartPersistenceError as exc:
                self._storage_error = str(exc)
                for key in keys:
                    self._active.pop(key, None)
                    self._recovering.pop(key, None)
                for key in paid_keys:
                    pending = self._pending.get(key) or {
                        "runId": run_id,
                        "nodeId": key[1],
                        "kind": key[0],
                    }
                    record = {
                        **pending,
                        "message": AMBIGUITY_MESSAGE,
                        "durable": False,
                    }
                    self._ambiguities[key] = record
                    self._nondurable_holds[key] = record
                    fallback_holds.append(dict(record))
            finally:
                self._release_lifecycle(run_id)
            return fallback_holds

    def mark_ambiguous(
        self, *, run_id: str, node_id: str, kind: str
    ) -> dict[str, Any]:
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        key = _key(kind, node_id)
        record: dict[str, Any] = {
            "runId": run_id,
            "nodeId": key[1],
            "kind": key[0],
            "message": AMBIGUITY_MESSAGE,
            "durable": True,
        }
        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                if key in self._pending and self._active.get(key) != run_id:
                    raise ProviderStartConflictError(
                        "Cannot replace a paid-start intent owned by another backend"
                    )
                if (
                    key not in self._pending
                    and key not in self._ambiguities
                    and len(set(self._pending) | set(self._ambiguities))
                    >= self._max_records
                ):
                    raise ProviderStartConflictError(
                        "World Labs paid-start safety journal is at capacity"
                    )
                self._pending.pop(key, None)
                self._ambiguities.pop(key, None)
                self._ambiguities[key] = record
                try:
                    self._persist()
                    for persisted in self._ambiguities.values():
                        persisted["durable"] = True
                except ProviderStartPersistenceError as exc:
                    # Keep the in-process hold fail-closed even though it cannot
                    # survive restart, and tell the frontend not to claim durability.
                    self._storage_error = str(exc)
                    record["durable"] = False
                    self._nondurable_holds[key] = record
            return dict(record)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            self._promote_abandoned_pending()
            self._refresh_for_read()
            return [dict(record) for record in self._ambiguities.values()]

    def has_active(self) -> bool:
        with self._lock:
            self._promote_abandoned_pending()
            self._refresh_for_read()
            return bool(self._active or self._recovering or self._pending)

    def has_active_node(self, node_id: str) -> bool:
        node_id = _identifier(
            node_id, label="nodeId", maximum=MAX_NODE_ID_CHARS
        )
        with self._lock:
            self._promote_abandoned_pending()
            self._refresh_for_read()
            return any(
                key[1] == node_id
                for key in set(self._active) | set(self._recovering) | set(self._pending)
            )

    def hold_nondurable_recovery(
        self, *, run_id: str, node_id: str
    ) -> dict[str, Any] | None:
        """Block stale fresh payloads when a captured recovery ID was not saved.

        The live recovery event still carries the trustworthy provider ID, but
        a different tab or a reload could otherwise submit the old blank node
        after the active lease is released.
        """
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        node_id = _identifier(
            node_id, label="nodeId", maximum=MAX_NODE_ID_CHARS
        )
        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                key = next(
                    (
                        candidate
                        for candidate, active_run in self._active.items()
                        if active_run == run_id and candidate[1] == node_id
                    ),
                    None,
                )
                if key is None:
                    return None
                record: dict[str, Any] = {
                    "runId": run_id,
                    "nodeId": node_id,
                    "kind": key[0],
                    "message": (
                        "World Labs returned a recovery ID, but Nebula could not "
                        "save that ID durably. Use the live ID; do not submit a "
                        "fresh paid start from a stale tab."
                    ),
                    "durable": True,
                }
                self._pending.pop(key, None)
                self._ambiguities[key] = record
                try:
                    self._persist()
                    for persisted in self._ambiguities.values():
                        persisted["durable"] = True
                except ProviderStartPersistenceError as exc:
                    self._storage_error = str(exc)
                    record["durable"] = False
                    self._nondurable_holds[key] = record
            return dict(record)

    def acknowledge(self, *, kind: str, node_id: str, run_id: str) -> bool:
        key = _key(kind, node_id)
        run_id = _identifier(run_id, label="runId", maximum=MAX_RUN_ID_CHARS)
        with self._lock:
            if key in self._active:
                raise ProviderStartConflictError(
                    "Cannot acknowledge a World Labs paid-start ambiguity while "
                    "that provider handshake is still active"
                )
            acknowledgement_run = f"ack-{uuid4().hex}"
            try:
                self._acquire_lifecycle(acknowledgement_run)
                with self._journal_lock():
                    self._reload_locked()
                    self._promote_pending_locked()
                    current = self._ambiguities.get(key)
                    if current is not None and current.get("runId") != run_id:
                        raise ProviderStartConflictError(
                            "World Labs paid-start ambiguity changed; refresh before "
                            "acknowledging the newer hold"
                        )
                    previous = dict(self._ambiguities)
                    removed = self._ambiguities.pop(key, None) is not None
                    if removed:
                        try:
                            self._persist()
                        except ProviderStartPersistenceError:
                            self._ambiguities = previous
                            raise
                    return removed
            finally:
                self._release_lifecycle(acknowledgement_run)

    def clear(self) -> None:
        """Durably clear ambiguity holds without touching active leases."""
        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                previous = dict(self._ambiguities)
                self._ambiguities.clear()
                try:
                    self._persist()
                except ProviderStartPersistenceError:
                    self._ambiguities = previous
                    raise

    def restore(self, records: Iterable[dict[str, Any]]) -> None:
        """Restore a clear snapshot; retain it in memory if rollback I/O fails."""
        restored: dict[tuple[str, str], dict[str, Any]] = {}
        for raw in records:
            if not isinstance(raw, dict):
                raise ValueError("provider start ambiguity must be an object")
            run_id = _identifier(
                raw.get("runId"), label="runId", maximum=MAX_RUN_ID_CHARS
            )
            key = _key(raw.get("kind"), raw.get("nodeId"))
            restored[key] = {
                "runId": run_id,
                "nodeId": key[1],
                "kind": key[0],
                "message": AMBIGUITY_MESSAGE,
                "durable": bool(raw.get("durable", True)),
            }
        if len(restored) > self._max_records:
            raise ValueError("too many provider start ambiguities")
        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                self._ambiguities = restored
                try:
                    self._persist()
                    for record in self._ambiguities.values():
                        record["durable"] = True
                except ProviderStartPersistenceError as exc:
                    self._storage_error = str(exc)
                    for record in self._ambiguities.values():
                        record["durable"] = False
                    raise

    @contextmanager
    def exclusive_lifecycle(self):
        """Fence a destructive graph mutation against every backend process."""
        mutation_run = f"mutation-{uuid4().hex}"
        with self._lock:
            if self._storage_error is not None:
                raise ProviderStartPersistenceError(
                    "provider start safety storage is unhealthy: "
                    + self._storage_error
                )
            try:
                self._acquire_lifecycle(mutation_run)
                with self._journal_lock():
                    self._reload_locked()
                    if self._promote_pending_locked():
                        self._persist()
                yield
            finally:
                self._release_lifecycle(mutation_run)

    def _load(self) -> None:
        path = self._path
        if path is None:
            self._storage_error = "provider start safety persistence is unavailable"
            return
        try:
            with self._journal_lock():
                self._reload_locked()
        except (ProviderStartPersistenceError, UnicodeError, ValueError) as exc:
            self._storage_error = str(exc)
            logger.warning(
                "Provider start guard %s is invalid; new paid starts are blocked: %s",
                path,
                exc,
            )

    def _reload_locked(self) -> None:
        """Reload the complete journal while the OS journal lock is held."""
        path = self._path
        if path is None:
            raise ProviderStartPersistenceError(
                "provider start safety persistence is unavailable"
            )
        if not path.is_file():
            self._ambiguities = {}
            self._pending = {}
            self._cancelled_runs = {}
            self._cancelled_run_filter = bytearray(CANCEL_FILTER_BYTES)
            self._merge_nondurable_holds_locked()
            self._storage_error = None
            return
        try:
            if path.stat().st_size > MAX_GUARD_FILE_BYTES:
                raise ValueError("provider start guard is too large")
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("version") != START_GUARD_VERSION:
                raise ValueError("unsupported provider start guard")
            records = payload.get("ambiguities")
            if not isinstance(records, list):
                raise ValueError("provider start ambiguities must be an array")
            pending_records = payload.get("pending", [])
            if not isinstance(pending_records, list):
                raise ValueError("provider start pending intents must be an array")
            cancelled_runs = payload.get("cancelledRuns", [])
            if not isinstance(cancelled_runs, list):
                raise ValueError("provider start cancelled runs must be an array")
            cancelled_run_filter = payload.get(
                "cancelledRunFilter",
                "00" * CANCEL_FILTER_BYTES,
            )
            if (
                not isinstance(cancelled_run_filter, str)
                or len(cancelled_run_filter) != CANCEL_FILTER_BYTES * 2
            ):
                raise ValueError(
                    "provider start cancelled run filter has an invalid size"
                )
            try:
                validated_cancelled_filter = bytearray.fromhex(
                    cancelled_run_filter
                )
            except ValueError as exc:
                raise ValueError(
                    "provider start cancelled run filter is invalid"
                ) from exc
            if len(validated_cancelled_filter) != CANCEL_FILTER_BYTES:
                raise ValueError(
                    "provider start cancelled run filter has an invalid size"
                )
            if len(cancelled_runs) > self._max_records:
                raise ValueError("provider start cancelled runs exceed their limit")
            if len(records) + len(pending_records) > self._max_records:
                raise ValueError("provider start guard exceeds its record limit")
            loaded: dict[tuple[str, str], dict[str, Any]] = {}
            pending: dict[tuple[str, str], dict[str, str]] = {}
            for raw in records:
                if not isinstance(raw, dict):
                    raise ValueError("provider start ambiguity must be an object")
                run_id = _identifier(
                    raw.get("runId"), label="runId", maximum=MAX_RUN_ID_CHARS
                )
                key = _key(raw.get("kind"), raw.get("nodeId"))
                if key in loaded:
                    raise ValueError("provider start guard contains duplicate records")
                raw_message = raw.get("message")
                message = (
                    raw_message
                    if isinstance(raw_message, str)
                    and 0 < len(raw_message) <= 2048
                    else AMBIGUITY_MESSAGE
                )
                loaded[key] = {
                    "runId": run_id,
                    "nodeId": key[1],
                    "kind": key[0],
                    "message": message,
                    "durable": True,
                }
            for raw in pending_records:
                if not isinstance(raw, dict):
                    raise ValueError("provider start pending intent must be an object")
                run_id = _identifier(
                    raw.get("runId"), label="runId", maximum=MAX_RUN_ID_CHARS
                )
                key = _key(raw.get("kind"), raw.get("nodeId"))
                if key in loaded or key in pending:
                    raise ValueError("provider start guard contains colliding records")
                pending[key] = {
                    "runId": run_id,
                    "nodeId": key[1],
                    "kind": key[0],
                }
            self._ambiguities = loaded
            self._pending = pending
            validated_cancelled: dict[str, None] = {}
            for raw_run_id in cancelled_runs:
                cancelled_run_id = _identifier(
                    raw_run_id,
                    label="cancelled runId",
                    maximum=MAX_RUN_ID_CHARS,
                )
                if cancelled_run_id in validated_cancelled:
                    raise ValueError("provider start guard contains duplicate Stop intents")
                validated_cancelled[cancelled_run_id] = None
            self._cancelled_runs = validated_cancelled
            self._cancelled_run_filter = validated_cancelled_filter
            self._merge_nondurable_holds_locked()
            self._storage_error = None
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise ProviderStartPersistenceError(
                f"provider start guard is invalid: {exc}"
            ) from exc

    def _merge_nondurable_holds_locked(self) -> None:
        for key, record in self._nondurable_holds.items():
            self._pending.pop(key, None)
            self._ambiguities[key] = record

    def _refresh_for_read(self) -> None:
        if self._storage_error is not None:
            return
        try:
            with self._journal_lock():
                self._reload_locked()
        except ProviderStartPersistenceError as exc:
            self._storage_error = str(exc)

    def _promote_pending_locked(self) -> bool:
        if not self._pending:
            return False
        for key, pending in self._pending.items():
            self._ambiguities[key] = {
                **pending,
                "message": AMBIGUITY_MESSAGE,
                "durable": True,
            }
        self._pending.clear()
        return True

    def _promote_abandoned_pending(self) -> None:
        """Promote crash leftovers only after proving no backend owns them."""
        if self._storage_error is not None:
            return
        try:
            with self._journal_lock():
                self._reload_locked()
                has_pending = bool(self._pending)
        except ProviderStartPersistenceError as exc:
            self._storage_error = str(exc)
            return
        if not has_pending or self._lifecycle_fd is not None:
            return
        recovery_run = f"recover-{uuid4().hex}"
        try:
            self._acquire_lifecycle(recovery_run)
        except ProviderStartConflictError:
            return
        try:
            with self._journal_lock():
                self._reload_locked()
                if self._promote_pending_locked():
                    self._persist()
        except ProviderStartPersistenceError as exc:
            self._storage_error = str(exc)
        finally:
            self._release_lifecycle(recovery_run)

    @contextmanager
    def _journal_lock(self):
        path = self._path
        if path is None:
            raise ProviderStartPersistenceError(
                "provider start safety persistence is unavailable"
            )
        lock_path = path.with_name(f".{path.name}.lock")
        fd: int | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        except ProviderStartPersistenceError:
            raise
        except OSError as exc:
            raise ProviderStartPersistenceError(
                "provider start guard write failed: journal lock unavailable"
            ) from exc
        finally:
            if fd is not None:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
                os.close(fd)

    def _acquire_lifecycle(self, run_id: str) -> None:
        if self._lifecycle_fd is not None:
            held_run = self._lifecycle_run_id or "unknown"
            raise ProviderStartConflictError(
                f"Fresh paid World Labs start is already active in run '{held_run}'"
            )
        path = self._path
        if path is None:
            raise ProviderStartPersistenceError(
                "provider start safety persistence is unavailable"
            )
        lock_path = path.with_name(f".{path.name}.paid-active.lock")
        fd: int | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if fd is not None:
                os.close(fd)
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK}:
                raise ProviderStartConflictError(
                    "Fresh paid World Labs start is already active in another "
                    "Nebula backend process"
                ) from exc
            raise ProviderStartPersistenceError(
                "provider start guard write failed: lifecycle lock unavailable"
            ) from exc
        self._lifecycle_fd = fd
        self._lifecycle_run_id = run_id

    def _release_lifecycle(self, run_id: str) -> None:
        if self._lifecycle_fd is None or self._lifecycle_run_id != run_id:
            return
        fd = self._lifecycle_fd
        self._lifecycle_fd = None
        self._lifecycle_run_id = None
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)

    def close(self) -> None:
        """Release process locks without clearing crash-detection intents."""
        with self._lock:
            if self._lifecycle_fd is None:
                return
            fd = self._lifecycle_fd
            self._lifecycle_fd = None
            self._lifecycle_run_id = None
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(fd)

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _persist(self) -> None:
        path = self._path
        if path is None:
            raise ProviderStartPersistenceError(
                "provider start safety persistence is unavailable"
            )
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": START_GUARD_VERSION,
                "ambiguities": [
                    {key: value for key, value in record.items() if key != "durable"}
                    for record in self._ambiguities.values()
                ],
                "pending": list(self._pending.values()),
                "cancelledRuns": list(self._cancelled_runs),
                "cancelledRunFilter": self._cancelled_run_filter.hex(),
            }
            with temporary.open("w", encoding="utf-8") as output:
                output.write(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                )
                output.flush()
                os.fsync(output.fileno())
            temporary.chmod(0o600)
            temporary.replace(path)
            directory_fd = os.open(
                path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            for key in list(self._nondurable_holds):
                if key in self._ambiguities:
                    self._ambiguities[key]["durable"] = True
                    self._nondurable_holds.pop(key, None)
            self._storage_error = None
        except OSError as exc:
            logger.warning("Could not persist provider start guard %s: %s", path, exc)
            raise ProviderStartPersistenceError(
                "provider start guard write failed"
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
