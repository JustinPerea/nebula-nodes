"""Commons opt-in is checked before any persistent or background allocation."""
from __future__ import annotations

import asyncio
import inspect
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from commons import activation, runtime
from routes.commons import router, store_dep


@pytest.fixture(autouse=True)
def inactive(monkeypatch, tmp_path):
    monkeypatch.delenv("NEBULA_COMMONS_ENABLED", raising=False)
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "never-created"))
    runtime.reset_for_tests()
    yield
    runtime.reset_for_tests()


@pytest.mark.parametrize("value", [None, "", "0", "true", "yes", " 1", "1 ", "2"])
def test_only_exact_one_enables_commons(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("NEBULA_COMMONS_ENABLED", raising=False)
    else:
        monkeypatch.setenv("NEBULA_COMMONS_ENABLED", value)
    assert activation.is_enabled() is False
    with pytest.raises(activation.CommonsDisabledError):
        activation.require_enabled()
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    assert activation.is_enabled() is True
    activation.require_enabled()


@pytest.mark.parametrize("factory", [runtime.get_store, runtime.get_worker, runtime.get_downloader])
def test_inactive_runtime_rejects_before_paths_or_factories(monkeypatch, tmp_path, factory):
    unexpected = Mock(side_effect=AssertionError("inactive Commons allocated state"))
    for name in ("db_path", "blobs_dir", "CommonsDB", "CommonsStore", "DatalessDownloader"):
        monkeypatch.setattr(runtime, name, unexpected)
    with pytest.raises(activation.CommonsDisabledError):
        factory()
    unexpected.assert_not_called()
    assert not (tmp_path / "never-created").exists()


def test_inactive_runtime_rejects_existing_singletons(monkeypatch):
    monkeypatch.setattr(runtime, "_store", Mock())
    monkeypatch.setattr(runtime, "_worker", Mock())
    monkeypatch.setattr(runtime, "_downloader", Mock())
    for factory in (runtime.get_store, runtime.get_worker, runtime.get_downloader):
        with pytest.raises(activation.CommonsDisabledError):
            factory()


def test_inactive_spawn_closes_coroutine_without_scheduling(monkeypatch):
    async def work():
        pytest.fail("inactive task ran")
    coroutine = work()
    no_loop = Mock(side_effect=AssertionError("inactive Commons asked for a loop"))
    monkeypatch.setattr(asyncio, "get_running_loop", no_loop)
    with pytest.raises(activation.CommonsDisabledError):
        runtime.spawn(coroutine)
    assert inspect.getcoroutinestate(coroutine) == inspect.CORO_CLOSED
    no_loop.assert_not_called()
    assert not runtime._tasks


@pytest.mark.parametrize("method,path,kwargs", [
    ("GET", "/status", {}),
    ("GET", "/collections", {}),
    ("POST", "/search", {"json": {"query": "grid"}}),
    ("POST", "/collections", {"json": {"name": "x"}}),
    ("POST", "/worker/start", {"json": {}}),
    ("GET", "/blobs/" + "a" * 64 + ".png", {}),
])
def test_inactive_router_rejects_before_overridden_store(method, path, kwargs, tmp_path):
    app = FastAPI()
    app.include_router(router)
    store = Mock(side_effect=AssertionError("inactive route reached the store"))
    app.dependency_overrides[store_dep] = store
    response = TestClient(app).request(method, "/api/commons" + path, **kwargs)
    assert response.status_code == 404
    store.assert_not_called()
    assert not (tmp_path / "never-created").exists()


def test_enabled_router_preserves_human_authority_and_does_not_start_worker(monkeypatch, tmp_path):
    import secrets
    from commons import actors
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    monkeypatch.setattr(actors, "ui_session", actors.UISession())
    token = secrets.token_urlsafe(32)
    actors.ui_session.set(token)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    assert client.post("/api/commons/collections", json={"name": "x"}).status_code == 403
    created = client.post("/api/commons/collections", json={"name": "x"},
                          headers={"Authorization": f"Bearer {token}"})
    assert created.status_code == 200
    status = client.get("/api/commons/status")
    assert status.status_code == 200 and status.json()["worker"]["running"] is False
    assert (tmp_path / "never-created" / "commons.db").is_file()
    assert not runtime._tasks
