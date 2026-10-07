"""Process-wide singletons for the commons (store, registries, worker, downloader)."""
from __future__ import annotations

import asyncio
import inspect
import threading

from commons.activation import CommonsDisabledError, require_enabled
from commons.db import CommonsDB
from commons.icloud import DatalessDownloader
from commons.paths import blobs_dir, db_path
from commons.store import CommonsStore

_lock = threading.Lock()
_store: CommonsStore | None = None
_downloader: DatalessDownloader | None = None
_worker = None
_tasks: set[asyncio.Task] = set()


def get_store() -> CommonsStore:
    require_enabled()
    global _store
    with _lock:
        if _store is None:
            _store = CommonsStore(CommonsDB(db_path()), blobs_dir())
        return _store


def get_downloader() -> DatalessDownloader:
    require_enabled()
    global _downloader
    with _lock:
        if _downloader is None:
            _downloader = DatalessDownloader()
        return _downloader


def spawn(coro) -> asyncio.Task:
    """Keep a reference so background tasks aren't garbage-collected."""
    try:
        require_enabled()
    except CommonsDisabledError:
        # Callers pass an already-created coroutine. Dispose it on rejection so
        # no unawaited coroutine or deferred work escapes the activation gate.
        if inspect.iscoroutine(coro):
            coro.close()
        raise
    task = asyncio.get_running_loop().create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


def get_worker():
    """The in-process analysis worker (one per process, started from the UI)."""
    require_enabled()
    global _worker
    if _worker is None:
        from commons.worker import AnalysisWorker

        _worker = AnalysisWorker(get_store())
    return _worker


def reset_for_tests() -> None:
    global _store, _downloader, _worker
    with _lock:
        if _worker is not None:
            _worker._stopping = True  # tests never start the loop; the task cancel below covers the rest
        _worker = None
        _downloader = None
        for task in list(_tasks):
            try:  # tasks live on the app's loop, which may be another thread's or closed
                task.get_loop().call_soon_threadsafe(task.cancel)
            except RuntimeError:
                pass
        _tasks.clear()
        if _store is not None:
            _store.db.close()
        _store = None
