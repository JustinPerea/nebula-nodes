from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock

from fastapi.testclient import TestClient

import main as main_module
import services.output as output_module
import services.zoom_manifest as zoom_module
from main import app
from services.settings import DEFAULT_SETTINGS


def test_zoom_telemetry_defaults_off() -> None:
    assert DEFAULT_SETTINGS["zoomTelemetryEnabled"] is False


def test_disabled_routes_do_not_initialize_or_append(monkeypatch) -> None:
    init = Mock()
    append = Mock()
    monkeypatch.setattr(main_module, "load_settings", lambda: {"zoomTelemetryEnabled": False})
    monkeypatch.setattr(main_module, "init_manifest", init)
    monkeypatch.setattr(main_module, "append_entry", append)
    client = TestClient(app)

    assert client.post("/api/zoom-manifest/init").status_code == 403
    assert client.post("/api/zoom-manifest/entry", json={"node_id": "n1"}).status_code == 403
    init.assert_not_called()
    append.assert_not_called()


def test_enabled_route_uses_configured_writer(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "load_settings", lambda: {"zoomTelemetryEnabled": True})
    monkeypatch.setattr(
        main_module,
        "init_manifest",
        lambda: {"session_id": "session", "started_at": 1.0, "path": "/configured/path"},
    )
    client = TestClient(app)

    response = client.post("/api/zoom-manifest/init")
    assert response.status_code == 200
    assert response.json()["path"] == "/configured/path"


def test_manifest_paths_are_unique_and_under_output_root(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(output_module, "OUTPUT_ROOT", tmp_path)

    first = zoom_module.init_manifest()
    second = zoom_module.init_manifest()

    first_path = Path(first["path"])
    second_path = Path(second["path"])
    assert first_path != second_path
    assert first_path.parent.parent == tmp_path
    assert second_path.parent.parent == tmp_path
    assert first_path.name == "zoom-manifest.json"
    assert json.loads(first_path.read_text(encoding="utf-8"))["entries"] == []


def test_new_collision_proof_output_directory_is_archive_eligible() -> None:
    assert main_module._OUTPUT_DIR_PATTERN.fullmatch(
        "2026-08-18_12-34-56_123456-run-with-id-deadbeef"
    )
