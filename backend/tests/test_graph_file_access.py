"""Graph imports/exports must not become a route into protected local data."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from cli.commands.graph import run_load, run_save
from services.cli_graph import CLIGraph
from services.file_access import ProtectedPathError


@pytest.fixture(params=["commons", "settings"])
def protected_graph(request, tmp_path, monkeypatch):
    root = tmp_path / request.param
    root.mkdir()
    target = root / "private.json"
    if request.param == "commons":
        monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    else:
        monkeypatch.setattr("services.settings.SETTINGS_PATH", target)
    target.write_text(json.dumps({"nodes": [], "edges": []}))
    return target


@pytest.fixture(params=["direct", "file_symlink", "directory_symlink", "hardlink", "file_uri"])
def protected_alias(request, tmp_path, protected_graph):
    if request.param == "direct":
        return protected_graph
    if request.param == "file_symlink":
        alias = tmp_path / "graph.json"
        alias.symlink_to(protected_graph)
        return alias
    if request.param == "hardlink":
        alias = tmp_path / "graph.json"
        alias.hardlink_to(protected_graph)
        return alias
    if request.param == "file_uri":
        return protected_graph.as_uri()
    alias = tmp_path / "linked"
    alias.symlink_to(protected_graph.parent, target_is_directory=True)
    return alias / protected_graph.name


@pytest.mark.parametrize("command", [run_save, run_load])
def test_cli_protected_paths_fail_before_backend_access(
    command, protected_alias, protected_graph, capsys
):
    before = protected_graph.read_bytes()
    client = Mock()
    client.get_graph.return_value = {"nodes": [], "edges": []}

    with pytest.raises(SystemExit) as exc:
        command(client, str(protected_alias))

    assert exc.value.code == 1
    assert capsys.readouterr().err.startswith("error: ")
    assert client.mock_calls == []
    assert protected_graph.read_bytes() == before
    assert list(protected_graph.parent.iterdir()) == [protected_graph]


@pytest.mark.parametrize("operation", ["save", "load"])
def test_service_protected_paths_preserve_memory_and_disk(
    operation, protected_alias, protected_graph
):
    graph = CLIGraph()
    graph.add_node("node-original", {"value": "keep"})
    state = graph.get_state()
    before = protected_graph.read_bytes()

    with pytest.raises(ProtectedPathError):
        getattr(graph, operation)(protected_alias)

    assert graph.get_state() == state
    assert protected_graph.read_bytes() == before
    assert list(protected_graph.parent.iterdir()) == [protected_graph]


def test_service_protected_persistence_rejects_replace_before_memory_changes(
    protected_graph,
):
    graph = CLIGraph(persist_path=protected_graph)
    candidate = CLIGraph()
    candidate.add_node("new-node", {})
    before = protected_graph.read_bytes()

    with pytest.raises(ProtectedPathError):
        graph.replace_with(candidate)

    assert graph.get_state() == {"nodes": [], "edges": []}
    assert protected_graph.read_bytes() == before


def test_cli_ordinary_export_and_import_roundtrip(tmp_path):
    graph = CLIGraph()
    graph.add_node("image-input", {"filePath": str(tmp_path / "photo.png")})
    graph.add_node("image-output", {})
    graph.connect("n1", "image", "n2", "image")
    client = Mock()
    client.get_graph.return_value = graph.get_state()
    path = tmp_path / "export.json"

    run_save(client, str(path))

    assert json.loads(path.read_text()) == graph.get_state()
    client.reset_mock()
    client.create_node.side_effect = [{"id": "n3"}, {"id": "n4"}]
    run_load(client, str(path))
    client.clear_graph.assert_called_once_with()
    assert client.create_node.call_count == 2
    client.connect.assert_called_once_with("n3", "image", "n4", "image")
    assert list(tmp_path.iterdir()) == [path]


def test_cli_export_failure_preserves_existing_file_and_cleans_temporary(
    tmp_path, monkeypatch
):
    target = tmp_path / "export.json"
    target.write_text("existing export")
    client = Mock()
    client.get_graph.return_value = {"nodes": [], "edges": []}

    def fail_replace(self, target):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated disk failure"):
        run_save(client, str(target))

    assert target.read_text() == "existing export"
    assert list(tmp_path.iterdir()) == [target]
