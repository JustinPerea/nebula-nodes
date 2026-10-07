from pathlib import Path

import pytest

from services.file_access import ProtectedPathError, require_allowed_path


@pytest.fixture
def protected(tmp_path, monkeypatch):
    root = tmp_path / "private"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    return root


@pytest.mark.parametrize("alias", ["direct", "symlink", "hardlink", "uri", "future"])
def test_protected_aliases_denied(protected, tmp_path, alias):
    secret = protected / "reference.png"
    secret.write_bytes(b"private")
    candidate = secret
    if alias == "symlink":
        candidate = tmp_path / "public.png"
        candidate.symlink_to(secret)
    elif alias == "hardlink":
        candidate = tmp_path / "public.png"
        candidate.hardlink_to(secret)
    elif alias == "uri":
        candidate = secret.as_uri()
    elif alias == "future":
        candidate = protected / "new" / "graph.json"
    with pytest.raises(ProtectedPathError):
        require_allowed_path(candidate)
    assert secret.read_bytes() == b"private"


def test_configured_secret_and_symlinked_root_denied(tmp_path, monkeypatch):
    import services.settings as settings
    secret = tmp_path / "credentials.json"
    monkeypatch.setattr(settings, "SETTINGS_PATH", secret)
    with pytest.raises(ProtectedPathError):
        require_allowed_path(secret)
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(alias))
    with pytest.raises(ProtectedPathError):
        require_allowed_path(real / "future.png")


def test_ordinary_paths_and_symlinks_allowed(tmp_path, protected):
    image = tmp_path / "reference image.png"
    image.write_bytes(b"ordinary")
    alias = tmp_path / "alias.png"
    alias.symlink_to(image)
    assert require_allowed_path(alias) == image.resolve()
    assert require_allowed_path(image.as_uri()) == image.resolve()
    assert require_allowed_path(tmp_path / "export.json") == (tmp_path / "export.json").resolve()


@pytest.mark.parametrize("reader", ["image", "document", "data_uri", "import"])
def test_media_helpers_deny_before_read(protected, reader):
    image = protected / "reference.png"
    image.write_bytes(b"not an image")
    with pytest.raises(ProtectedPathError):
        if reader == "image":
            from services.image_input import load_local_image
            load_local_image(str(image))
        elif reader == "document":
            from services.document_extract import extract_text
            extract_text(image)
        elif reader == "data_uri":
            from services.output import image_to_data_uri
            image_to_data_uri(image)
        else:
            from main import _import_external_image_to_output_root
            _import_external_image_to_output_root(str(image))


@pytest.mark.asyncio
@pytest.mark.parametrize("definition", ["image-input", "video-input", "audio-input", "document-input", "custom-provider"])
async def test_engine_denies_before_handler_or_output(protected, definition):
    from execution.engine import execute_graph
    from models.graph import GraphNode
    called = []
    events = []
    async def handler(*args):
        called.append(True)
        return {}
    async def emit(event):
        events.append(event)
    await execute_graph(
        nodes=[GraphNode(id="private", definitionId=definition, params={"filePath": str(protected / "reference.png")})],
        edges=[], api_keys={}, handler_registry={"custom-provider": handler}, emit=emit,
    )
    assert not called
    assert any(event.type == "error" and "protected" in event.error.lower() for event in events)
    assert not any(event.type == "executed" for event in events)


def test_graph_update_rejected_before_memory_or_disk_change(protected):
    from fastapi.testclient import TestClient
    from main import app, cli_graph
    with TestClient(app) as client:
        response = client.post("/api/graph/node", json={"definitionId": "image-input", "params": {}})
        assert response.status_code == 200
        node_id = response.json()["id"]
        before = cli_graph.get_state()
        response = client.put(f"/api/graph/node/{node_id}", json={"params": {"filePath": str(protected / "bad.png")}})
        assert response.status_code == 400
        assert cli_graph.get_state() == before
        cli_graph.remove_node(node_id)


@pytest.mark.parametrize("filename", ["../outside.png", "/tmp/outside.png", "nested/output.png"])
def test_export_cannot_escape_folder(tmp_path, monkeypatch, filename):
    from fastapi.testclient import TestClient
    import main
    source = tmp_path / "source.png"
    source.write_bytes(b"image")
    monkeypatch.setattr(main, "_output_path_from_ref", lambda value: source)
    destination = tmp_path / "exports"
    monkeypatch.setattr(main, "load_settings", lambda: {"exportFolder": str(destination)})
    with TestClient(main.app) as client:
        response = client.post("/api/export", json={"url": "/api/outputs/source.png", "filename": filename})
    assert response.status_code == 400
    assert not destination.exists()


def test_nested_and_served_output_aliases(protected, tmp_path, monkeypatch):
    from services import output
    from services.file_access import validate_file_references
    secret = protected / "file.png"
    secret.write_bytes(b"private")
    alias = tmp_path / "file.png"
    alias.hardlink_to(secret)
    monkeypatch.setattr(output, "OUTPUT_ROOT", tmp_path)
    for value in (str(alias), "/api/outputs/file.png", "http://localhost:8000/api/outputs/file.png"):
        with pytest.raises(ProtectedPathError):
            validate_file_references({"arbitrary": {"references": [value]}})


@pytest.mark.asyncio
async def test_engine_rejects_cached_protected_output(protected):
    from execution.engine import execute_graph
    from models.graph import GraphNode
    from services.cache import ExecutionCache
    from unittest.mock import AsyncMock
    cache = ExecutionCache()
    cache.set(cache.get_key("cached-provider", {}, {}), {"image": {"type": "Image", "value": str(protected / "secret.png")}})
    events = []
    async def emit(event):
        events.append(event)
    handler = AsyncMock()
    await execute_graph(nodes=[GraphNode(id="cached", definitionId="cached-provider", params={})], edges=[], api_keys={}, handler_registry={"cached-provider": handler}, emit=emit, cache=cache)
    assert any(event.type == "error" and "protected" in event.error.lower() for event in events)
    assert not any(event.type == "executed" for event in events)
    handler.assert_not_awaited()


def test_import_rejects_protected_destination_before_copy(tmp_path, monkeypatch, protected):
    import main
    import base64
    source = tmp_path / "allowed.png"
    source.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlE0AAAAASUVORK5CYII="))
    monkeypatch.setattr(main, "CHAT_UPLOADS_DIR", protected)
    before = list(protected.iterdir())
    with pytest.raises(ProtectedPathError):
        main._import_external_image_to_output_root(str(source))
    assert list(protected.iterdir()) == before


def test_mesh_secondary_resource_policy(protected, tmp_path):
    from services.mesh_input import ProtectedFileResolver
    source = tmp_path / "public.obj"
    source.write_text("v 0 0 0")
    ordinary = tmp_path / "texture.png"
    ordinary.write_bytes(b"texture")
    secret = protected / "texture.png"
    secret.write_bytes(b"private")
    resolver = ProtectedFileResolver(source)
    assert resolver.get("texture.png") == b"texture"
    with pytest.raises(ProtectedPathError):
        resolver.get("private/texture.png")
    with pytest.raises(ProtectedPathError):
        resolver.namespaced("private/")


def test_mcp_upload_cannot_read_protected_file(protected, monkeypatch):
    import mcp_server
    from unittest.mock import Mock
    send = Mock(return_value={"enabled": True})
    monkeypatch.setattr(mcp_server, "_commons_call", send)
    source = protected / "source.png"
    source.write_bytes(b"private")
    with pytest.raises(ProtectedPathError):
        mcp_server._commons_add_impl(str(source), "collection", "test", "unknown", client_name="test")
    send.assert_called_once_with("GET", "/api/capabilities/commons", "test")


def test_cli_upload_cannot_read_protected_file(protected):
    from cli.commands.commons import run
    from types import SimpleNamespace
    from unittest.mock import Mock
    client = Mock()
    client.commons_enabled.return_value = True
    args = SimpleNamespace(commons_cmd="add", source=str(protected / "source.png"), collection="collection", why="test", made_by="unknown")
    with pytest.raises(ProtectedPathError):
        run(client, args)
    client.commons.assert_not_called()


@pytest.mark.parametrize("text", ["~5 seconds of cinematic footage", "~~~", "https://[a reference URL]", "x" * 5000])
def test_plain_text_does_not_become_a_file_error(text):
    from services.file_access import validate_file_references
    validate_file_references({"prompt": text})


@pytest.mark.parametrize("namespace", ["/dev/fd", "/DeV/fd", "/proc/self/fd", "/.vol"])
def test_file_descriptor_alias_denied(protected, namespace):
    secret = protected / "private.png"
    secret.write_bytes(b"private")
    with secret.open("rb") as handle:
        with pytest.raises(ProtectedPathError):
            require_allowed_path(f"{namespace}/{handle.fileno()}")


def test_mount_alias_is_checked_by_identity(tmp_path, protected, monkeypatch):
    # Model two distinct namespace entries for the same mounted directory.
    # No mount privileges or real store access are needed for this regression.
    alias = tmp_path / "mount-alias"
    alias.mkdir()
    original_stat = Path.stat
    def mounted_stat(path, *args, **kwargs):
        return original_stat(protected if path == alias else path, *args, **kwargs)
    monkeypatch.setattr(Path, "stat", mounted_stat)
    with pytest.raises(ProtectedPathError):
        require_allowed_path(alias / "future.png")


def test_graph_import_content_is_checked_before_clearing_graph(tmp_path, protected):
    import json
    from unittest.mock import Mock
    from cli.commands.graph import run_load
    from services.cli_graph import CLIGraph
    path = tmp_path / "ordinary-graph.json"
    path.write_text(json.dumps({"nodes": [{"id": "bad", "definitionId": "image-input", "params": {"filePath": str(protected / "private.png")}}], "edges": []}))
    client = Mock()
    with pytest.raises(SystemExit):
        run_load(client, str(path))
    client.clear_graph.assert_not_called()
    graph = CLIGraph()
    graph.add_node("text-input", {"value": "keep"})
    before = graph.get_state()
    with pytest.raises(ProtectedPathError):
        graph.load(path)
    assert graph.get_state() == before
