from __future__ import annotations

import json
import logging
import os
import fcntl
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any, Iterable
from uuid import uuid4


logger = logging.getLogger(__name__)

RECOVERY_STORE_VERSION = 1
MAX_RECOVERY_RECORDS = 256
MAX_RECOVERY_FILE_BYTES = 2 * 1024 * 1024
MAX_NODE_ID_CHARS = 4096
MAX_RUN_ID_CHARS = 128
MAX_PROVIDER_ID_CHARS = 256


class ProviderRecoveryPersistenceError(RuntimeError):
    """A paid-operation checkpoint could not be committed to local storage."""


class ProviderRecoveryCapacityError(ProviderRecoveryPersistenceError):
    """Unresolved checkpoints have exhausted the bounded safety journal."""


class ProviderRecoveryConflictError(RuntimeError):
    """A conditional delete targeted a stale recovery identity."""


def _bounded_identifier(value: Any, *, label: str, max_chars: int) -> str:
    if not isinstance(value, str) or not value or len(value) > max_chars:
        raise ValueError(f"{label} must be a bounded non-empty string")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f"{label} contains control characters")
    return value


class ProviderRecoveryStore:
    """Small durable journal for paid provider checkpoints.

    Records are keyed by ``(runId, nodeId)`` instead of being inserted into
    ``cli_graph``. This preserves frontend UUID identity and lets run-history
    hydration patch the exact originating snapshot without duplicating nodes.
    """

    def __init__(self, path: Path | None, *, max_records: int = MAX_RECOVERY_RECORDS):
        self._path = path
        self._max_records = max(1, max_records)
        self._lock = RLock()
        self._records: dict[tuple[str, str], dict[str, str | None]] = {}
        self._reservations: dict[tuple[str, str], str] = {}
        self._storage_error: str | None = None
        self._load()

    def reserve(self, *, run_id: str, node_ids: list[str]) -> None:
        """Atomically reserve journal capacity before non-idempotent POSTs."""
        run_id = _bounded_identifier(
            run_id, label="runId", max_chars=MAX_RUN_ID_CHARS
        )
        keys = list(
            dict.fromkeys(
                (
                    run_id,
                    _bounded_identifier(
                        node_id, label="nodeId", max_chars=MAX_NODE_ID_CHARS
                    ),
                )
                for node_id in node_ids
            )
        )
        with self._lock:
            if self._storage_error is not None:
                raise ProviderRecoveryPersistenceError(
                    "provider recovery storage is unhealthy: " + self._storage_error
                )
            with self._journal_lock():
                self._reload_locked()
                new_keys = [
                    key
                    for key in keys
                    if key not in self._records and key not in self._reservations
                ]
                if (
                    len(self._records) + len(self._reservations) + len(new_keys)
                    > self._max_records
                ):
                    raise ProviderRecoveryCapacityError(
                        "provider recovery journal is at capacity; resolve an "
                        "existing checkpoint before starting more paid work"
                    )
                for key in new_keys:
                    self._reservations[key] = run_id

    def reserve_checkpoints(
        self,
        *,
        run_id: str,
        checkpoints: Iterable[tuple[str, str | None, str | None]],
    ) -> None:
        """Reserve only recovery identities not already durably journaled.

        Re-polling the same operation is safe and must remain possible even
        when the journal is otherwise full. The first record is retained so a
        fresh paid-start run keeps its original history-hydration identity.
        """
        validated: list[
            tuple[tuple[str, str], dict[str, str | None]]
        ] = []
        for node_id, resume_operation_id, existing_world_id in checkpoints:
            validated.append(
                self._validated_record(
                    run_id=run_id,
                    node_id=node_id,
                    resume_operation_id=resume_operation_id,
                    existing_world_id=existing_world_id,
                )
            )
        if not validated:
            return
        with self._lock:
            if self._storage_error is not None:
                raise ProviderRecoveryPersistenceError(
                    "provider recovery storage is unhealthy: " + self._storage_error
                )
            with self._journal_lock():
                self._reload_locked()
                new_keys: list[tuple[str, str]] = []
                for key, record in validated:
                    duplicate_identity = any(
                        current.get("nodeId") == record["nodeId"]
                        and current.get("resumeOperationId")
                        == record["resumeOperationId"]
                        and current.get("existingWorldId")
                        == record["existingWorldId"]
                        for current in self._records.values()
                    )
                    if (
                        not duplicate_identity
                        and key not in self._records
                        and key not in self._reservations
                        and key not in new_keys
                    ):
                        new_keys.append(key)
                if (
                    len(self._records) + len(self._reservations) + len(new_keys)
                    > self._max_records
                ):
                    raise ProviderRecoveryCapacityError(
                        "provider recovery journal is at capacity; resolve an "
                        "existing checkpoint before starting more paid work"
                    )
                for key in new_keys:
                    self._reservations[key] = run_id

    def release_reservations(self, run_id: str) -> None:
        with self._lock:
            for key, reserved_run in list(self._reservations.items()):
                if reserved_run == run_id:
                    self._reservations.pop(key, None)

    def set(
        self,
        *,
        run_id: str,
        node_id: str,
        resume_operation_id: str | None,
        existing_world_id: str | None,
    ) -> None:
        key, record = self._validated_record(
            run_id=run_id,
            node_id=node_id,
            resume_operation_id=resume_operation_id,
            existing_world_id=existing_world_id,
        )
        with self._lock:
            if self._storage_error is not None:
                raise ProviderRecoveryPersistenceError(
                    "provider recovery storage is unhealthy: " + self._storage_error
                )
            with self._journal_lock():
                self._reload_locked()
                duplicate_identity = any(
                    current.get("nodeId") == record["nodeId"]
                    and current.get("resumeOperationId")
                    == record["resumeOperationId"]
                    and current.get("existingWorldId")
                    == record["existingWorldId"]
                    for current in self._records.values()
                )
                if duplicate_identity:
                    # A recovery/poll rerun must not consume one safety record
                    # per run forever. Keep the original checkpoint (normally
                    # the fresh blank-start run used for history hydration) and
                    # release this run's ephemeral capacity reservation.
                    self._reservations.pop(key, None)
                    return
                reserved = key in self._reservations
                occupied_without_key = (
                    len(self._records)
                    + len(self._reservations)
                    - int(key in self._records)
                    - int(reserved)
                )
                if (
                    key not in self._records
                    and occupied_without_key >= self._max_records
                ):
                    raise ProviderRecoveryCapacityError(
                        "provider recovery journal is at capacity; resolve an "
                        "existing checkpoint before starting more paid work"
                    )
                previous = dict(self._records)
                previous_reservations = dict(self._reservations)
                self._records.pop(key, None)
                self._records[key] = record
                self._reservations.pop(key, None)
                try:
                    self._persist()
                except ProviderRecoveryPersistenceError as exc:
                    self._records = previous
                    self._reservations = previous_reservations
                    self._storage_error = str(exc)
                    raise

    def ensure_many(
        self,
        *,
        run_id: str,
        checkpoints: Iterable[tuple[str, str | None, str | None]],
    ) -> list[dict[str, str | None]]:
        """Durably seed graph-carried checkpoints in one atomic journal write.

        Graph import/create/update can introduce a trustworthy World Labs
        recovery ID without executing a handler. Every backend worker must see
        that control-plane state before the graph commit becomes visible;
        otherwise a stale worker could accept a blank paid start for the same
        node. Existing records with the same node/provider identity are reused
        so restarts and repeated imports do not consume journal capacity.
        """
        validated: list[
            tuple[tuple[str, str], dict[str, str | None]]
        ] = []
        seen_nodes: dict[str, tuple[str | None, str | None]] = {}
        for node_id, resume_operation_id, existing_world_id in checkpoints:
            key, record = self._validated_record(
                run_id=run_id,
                node_id=node_id,
                resume_operation_id=resume_operation_id,
                existing_world_id=existing_world_id,
            )
            identity = (resume_operation_id, existing_world_id)
            prior_identity = seen_nodes.get(key[1])
            if prior_identity is not None and prior_identity != identity:
                raise ValueError(
                    "graph contains conflicting recovery checkpoints for node "
                    f"'{key[1]}'"
                )
            if prior_identity is None:
                seen_nodes[key[1]] = identity
                validated.append((key, record))
        if not validated:
            return []

        with self._lock:
            if self._storage_error is not None:
                raise ProviderRecoveryPersistenceError(
                    "provider recovery storage is unhealthy: " + self._storage_error
                )
            with self._journal_lock():
                self._reload_locked()
                additions: list[
                    tuple[tuple[str, str], dict[str, str | None]]
                ] = []
                current_records = list(self._records.values())
                for key, record in validated:
                    already_known = any(
                        current.get("nodeId") == record["nodeId"]
                        and current.get("resumeOperationId")
                        == record["resumeOperationId"]
                        and current.get("existingWorldId")
                        == record["existingWorldId"]
                        for current in current_records
                    )
                    if already_known:
                        continue
                    current_for_key = self._records.get(key)
                    if current_for_key is not None and current_for_key != record:
                        raise ProviderRecoveryConflictError(
                            "World Labs recovery checkpoint changed; use a new "
                            "graph mutation identity"
                        )
                    additions.append((key, record))
                    current_records.append(record)

                new_keys = [key for key, _record in additions]
                reserved_new_keys = [
                    key for key in new_keys if key in self._reservations
                ]
                occupied = (
                    len(self._records)
                    + len(self._reservations)
                    + len(new_keys)
                    - len(reserved_new_keys)
                )
                if occupied > self._max_records:
                    raise ProviderRecoveryCapacityError(
                        "provider recovery journal is at capacity; resolve an "
                        "existing checkpoint before importing more paid state"
                    )
                if not additions:
                    return []

                previous = dict(self._records)
                previous_reservations = dict(self._reservations)
                for key, record in additions:
                    self._records[key] = record
                    self._reservations.pop(key, None)
                try:
                    self._persist()
                except ProviderRecoveryPersistenceError as exc:
                    self._records = previous
                    self._reservations = previous_reservations
                    self._storage_error = str(exc)
                    raise
                return [dict(record) for _key, record in additions]

    @staticmethod
    def _validated_record(
        *,
        run_id: Any,
        node_id: Any,
        resume_operation_id: Any,
        existing_world_id: Any,
    ) -> tuple[tuple[str, str], dict[str, str | None]]:
        run_id = _bounded_identifier(
            run_id, label="runId", max_chars=MAX_RUN_ID_CHARS
        )
        node_id = _bounded_identifier(
            node_id, label="nodeId", max_chars=MAX_NODE_ID_CHARS
        )
        if resume_operation_id is not None:
            resume_operation_id = _bounded_identifier(
                resume_operation_id,
                label="resumeOperationId",
                max_chars=MAX_PROVIDER_ID_CHARS,
            )
        if existing_world_id is not None:
            existing_world_id = _bounded_identifier(
                existing_world_id,
                label="existingWorldId",
                max_chars=MAX_PROVIDER_ID_CHARS,
            )
        if (resume_operation_id is None) == (existing_world_id is None):
            raise ValueError("recovery checkpoint must contain exactly one provider ID")
        return (run_id, node_id), {
            "runId": run_id,
            "nodeId": node_id,
            "resumeOperationId": resume_operation_id,
            "existingWorldId": existing_world_id,
        }

    def list(self) -> list[dict[str, str | None]]:
        with self._lock:
            if self._storage_error is None:
                try:
                    with self._journal_lock():
                        self._reload_locked()
                except ProviderRecoveryPersistenceError as exc:
                    self._storage_error = str(exc)
            return [dict(record) for record in self._records.values()]

    def is_healthy(self) -> bool:
        with self._lock:
            return self._storage_error is None

    def delete(
        self,
        *,
        run_id: str,
        node_id: str,
        resume_operation_id: str | None,
        existing_world_id: str | None,
    ) -> bool:
        """Remove one exact run/node checkpoint, returning whether it existed."""
        key, expected = self._validated_record(
            run_id=run_id,
            node_id=node_id,
            resume_operation_id=resume_operation_id,
            existing_world_id=existing_world_id,
        )
        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                current = self._records.get(key)
                if current is not None and current != expected:
                    raise ProviderRecoveryConflictError(
                        "World Labs recovery checkpoint changed; refresh before "
                        "deleting the newer checkpoint"
                    )
                previous = dict(self._records)
                removed = self._records.pop(key, None) is not None
                if removed:
                    try:
                        self._persist()
                    except ProviderRecoveryPersistenceError:
                        self._records = previous
                        raise
                return removed

    def delete_many_exact(
        self,
        records: Iterable[dict[str, str | None]],
    ) -> int:
        """Atomically remove an exact set of records.

        Graph mutation routes use this only to roll back records returned by a
        preceding ``ensure_many`` call when the graph's atomic file commit
        fails. Conditional identity checks prevent a rollback from deleting a
        checkpoint that another process replaced in the meantime.
        """
        validated: list[tuple[tuple[str, str], dict[str, str | None]]] = []
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("recovery rollback record must be an object")
            validated.append(
                self._validated_record(
                    run_id=record.get("runId"),
                    node_id=record.get("nodeId"),
                    resume_operation_id=record.get("resumeOperationId"),
                    existing_world_id=record.get("existingWorldId"),
                )
            )
        if not validated:
            return 0

        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                for key, expected in validated:
                    current = self._records.get(key)
                    if current is not None and current != expected:
                        raise ProviderRecoveryConflictError(
                            "World Labs recovery checkpoint changed during graph rollback"
                        )
                previous = dict(self._records)
                removed = 0
                for key, _expected in validated:
                    removed += int(self._records.pop(key, None) is not None)
                if removed:
                    try:
                        self._persist()
                    except ProviderRecoveryPersistenceError:
                        self._records = previous
                        raise
                return removed

    def clear(self) -> None:
        with self._lock:
            with self._journal_lock():
                self._reload_locked()
                previous = dict(self._records)
                self._records.clear()
                try:
                    self._persist()
                except ProviderRecoveryPersistenceError:
                    self._records = previous
                    raise

    def _load(self) -> None:
        path = self._path
        if path is None:
            self._storage_error = "provider recovery persistence is unavailable"
            return
        try:
            with self._journal_lock():
                self._reload_locked()
        except (ProviderRecoveryPersistenceError, UnicodeError, ValueError) as exc:
            self._storage_error = str(exc)
            logger.warning(
                "Provider recovery journal %s is invalid; new paid starts are blocked: %s",
                path,
                exc,
            )

    def _reload_locked(self) -> None:
        path = self._path
        if path is None:
            raise ProviderRecoveryPersistenceError(
                "provider recovery persistence is unavailable"
            )
        if not path.is_file():
            self._records = {}
            self._storage_error = None
            return
        try:
            if path.stat().st_size > MAX_RECOVERY_FILE_BYTES:
                raise ValueError("recovery journal is too large")
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("version") != RECOVERY_STORE_VERSION:
                raise ValueError("unsupported recovery journal")
            records = payload.get("records")
            if not isinstance(records, list):
                raise ValueError("recovery journal records must be an array")
            if len(records) > self._max_records:
                raise ValueError("recovery journal exceeds its record limit")
            loaded: dict[tuple[str, str], dict[str, str | None]] = {}
            for raw in records:
                if not isinstance(raw, dict):
                    raise ValueError("recovery journal record must be an object")
                key, record = self._validated_record(
                    run_id=raw.get("runId"),
                    node_id=raw.get("nodeId"),
                    resume_operation_id=raw.get("resumeOperationId"),
                    existing_world_id=raw.get("existingWorldId"),
                )
                if key in loaded:
                    raise ValueError("recovery journal contains duplicate records")
                loaded[key] = record
            self._records = loaded
            self._storage_error = None
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise ProviderRecoveryPersistenceError(
                f"provider recovery journal is invalid: {exc}"
            ) from exc

    @contextmanager
    def _journal_lock(self):
        path = self._path
        if path is None:
            raise ProviderRecoveryPersistenceError(
                "provider recovery persistence is unavailable"
            )
        lock_path = path.with_name(f".{path.name}.lock")
        fd: int | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        except ProviderRecoveryPersistenceError:
            raise
        except OSError as exc:
            raise ProviderRecoveryPersistenceError(
                "provider recovery journal write failed: lock unavailable"
            ) from exc
        finally:
            if fd is not None:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
                os.close(fd)

    def _persist(self) -> None:
        path = self._path
        if path is None:
            raise ProviderRecoveryPersistenceError(
                "provider recovery persistence is unavailable"
            )
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": RECOVERY_STORE_VERSION,
                "records": [dict(record) for record in self._records.values()],
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
            self._storage_error = None
        except OSError as exc:
            logger.warning("Could not persist provider recovery journal %s: %s", path, exc)
            raise ProviderRecoveryPersistenceError(
                "provider recovery journal write failed"
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
