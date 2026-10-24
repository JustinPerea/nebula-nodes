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
    sent: list[tuple[str, str, dict]] = []

    def answer(method, route, **kwargs):
        sent.append((method, route, kwargs.get("json")))
        if route == "/api/projects":
            return {"activeProjectId": None, "projects": []}
        return {"nodeCount": 2, "edgeCount": 1, "warnings": [], "idMap": {}}

    client.api.request.side_effect = answer
    run_load(client, str(path))
    # One atomic import of the file as saved (graph_file_client.py, the
    # module MCP load_graph_file shares); no clear-then-recreate.
    imports = [body for method, route, body in sent if route == "/api/graph/import"]
    assert imports == [graph.get_state()]
    client.clear_graph.assert_not_called()
    client.create_node.assert_not_called()
    assert list(tmp_path.iterdir()) == [path]


def test_cli_load_of_a_bundle_restores_it_through_the_backend(tmp_path, capsys):
    # #184 refused a .nebula.zip here and sent the person to Load graph. Since
    # Q123 a (Justin: "Yes: `nebula load` and an MCP tool open a bundle,
    # restoring its files, as Load graph does.") it goes to the restore, with
    # rewriteLinks; a refusal there prints as one error line, no traceback.
    import io
    import zipfile

    from nebula_api import NebulaAPIError

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr("graph.json", json.dumps({"nodes": [], "edges": []}))
    path = tmp_path / "Big campaign.nebula.zip"
    path.write_bytes(buffer.getvalue())
    client = Mock()
    client.api.request.side_effect = NebulaAPIError("Unsupported .nebula file version", status=400)

    with pytest.raises(SystemExit) as exc:
        run_load(client, str(path))

    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith("error: ") and "Unsupported .nebula file version" in err and "Traceback" not in err
    (method, route), kwargs = client.api.request.call_args
    assert (method, route) == ("POST", "/api/outputs/restore") and kwargs["params"] == {"rewriteLinks": "true"}
    assert kwargs["headers"]["Content-Type"] == "application/zip"


def test_cli_export_failure_preserves_existing_file_and_cleans_temporary(
    tmp_path, monkeypatch
):
    target = tmp_path / "export.json"
    # An earlier export: run_save replaces only a saved graph (any other
    # existing file is refused, tests/test_input_size_security.py).
    existing = json.dumps({"nodes": [{"id": "n1"}], "edges": []})
    target.write_text(existing)
    client = Mock()
    client.get_graph.return_value = {"nodes": [], "edges": []}

    def fail_replace(self, target):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated disk failure"):
        run_save(client, str(target))

    assert target.read_text() == existing
    assert list(tmp_path.iterdir()) == [target]
