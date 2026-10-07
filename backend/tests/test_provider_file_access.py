"""Provider adapters recheck the final local file, after their own normalization."""
from __future__ import annotations

import importlib
import inspect
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from models.graph import GraphNode, PortValueDict
from services.file_access import ProtectedPathError


@pytest.fixture
def private_media(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    path = root / "reference.png"
    path.write_bytes(b"synthetic protected media")
    return path


@pytest.mark.asyncio
@pytest.mark.parametrize("reference", ["padded", "relative-hardlink"])
async def test_krea_checks_normalized_file_before_upload(
    private_media, tmp_path, monkeypatch, reference
):
    from handlers import krea

    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.setattr(krea, "OUTPUT_ROOT", output)
    if reference == "padded":
        value = f"  {private_media}  "
    else:
        (output / "alias.png").hardlink_to(private_media)
        value = "alias.png"
    client = AsyncMock()
    read = Mock(side_effect=AssertionError("protected bytes must not be read"))
    monkeypatch.setattr(Path, "read_bytes", read)

    with pytest.raises(ProtectedPathError):
        await krea._upload_asset(client, "fake-key", value)

    read.assert_not_called()
    client.post.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("module_name, helper_name", [
    ("ideogram", "_load_binary"),
    ("openai_image_edit", "_resolve_image_bytes"),
    ("gemini_omni", "_load_bytes"),
    ("veo", "_image_to_veo_payload"),
    ("fal_universal", "_to_fal_url"),
    ("nous_portal", "_image_to_content_block"),
    ("quiver", "_to_quiver_image_arg"),
    ("quiver", "_ref_to_quiver_item"),
])
async def test_provider_local_helpers_reject_before_bytes(
    private_media, monkeypatch, module_name, helper_name
):
    module = importlib.import_module(f"handlers.{module_name}")
    helper = getattr(module, helper_name)
    read = Mock(side_effect=AssertionError("protected bytes must not be read"))
    monkeypatch.setattr(Path, "read_bytes", read)

    with pytest.raises(ProtectedPathError):
        result = helper(str(private_media))
        if inspect.isawaitable(result):
            await result

    read.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("module_name, handler_name, key", [
    ("openai_audio", "handle_openai_stt", "OPENAI_API_KEY"),
    ("openai_audio", "handle_openai_translate", "OPENAI_API_KEY"),
    ("elevenlabs", "handle_elevenlabs_sts", "ELEVENLABS_API_KEY"),
    ("elevenlabs", "handle_elevenlabs_isolation", "ELEVENLABS_API_KEY"),
    ("elevenlabs", "handle_elevenlabs_dubbing", "ELEVENLABS_API_KEY"),
    ("elevenlabs", "handle_elevenlabs_stt", "ELEVENLABS_API_KEY"),
    ("runway", "handle_runway_aleph", "RUNWAY_API_KEY"),
])
async def test_audio_video_provider_handlers_reject_before_upload(
    private_media, monkeypatch, module_name, handler_name, key
):
    module = importlib.import_module(f"handlers.{module_name}")
    handler = getattr(module, handler_name)
    read = Mock(side_effect=AssertionError("protected bytes must not be read"))
    network = Mock(side_effect=AssertionError("provider must not be contacted"))
    monkeypatch.setattr(Path, "read_bytes", read)
    monkeypatch.setattr(module.httpx, "AsyncClient", network)
    node = GraphNode(id="test", definitionId="test", params={})
    inputs = {
        "audio": PortValueDict(type="Audio", value=str(private_media)),
        "video": PortValueDict(type="Video", value=str(private_media)),
        "prompt": PortValueDict(type="Text", value="test prompt"),
    }

    with pytest.raises(ProtectedPathError):
        await handler(node, inputs, {key: "fake-key"})

    read.assert_not_called()
    network.assert_not_called()


@pytest.mark.asyncio
async def test_style_description_rejects_before_provider(private_media, monkeypatch):
    from handlers import style_reference

    network = Mock(side_effect=AssertionError("provider must not be contacted"))
    monkeypatch.setattr(style_reference.httpx, "AsyncClient", network)
    with pytest.raises(ProtectedPathError):
        await style_reference._describe_style("fake-key", private_media, "test")
    network.assert_not_called()


@pytest.mark.asyncio
async def test_cinema_base_output_rejects_before_decode(private_media, monkeypatch):
    from handlers import cinema_scene

    decode = Mock(side_effect=AssertionError("protected bytes must not be decoded"))
    monkeypatch.setattr(cinema_scene.Image, "open", decode)
    with pytest.raises(ProtectedPathError):
        await cinema_scene._load_image(str(private_media))
    decode.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["images", "mask"])
async def test_image_edit_checks_both_image_and_mask_before_provider(
    private_media, tmp_path, monkeypatch, target
):
    from handlers import openai_image_v2

    ordinary = tmp_path / "ordinary.png"
    ordinary.write_bytes(b"ordinary fixture")
    inputs = {
        "images": PortValueDict(type="Image", value=[str(private_media if target == "images" else ordinary)]),
        "mask": PortValueDict(type="Image", value=str(private_media)),
        "prompt": PortValueDict(type="Text", value="test prompt"),
    }
    # httpx is imported inside the adapter; patch its shared class without
    # constructing a real provider client.
    import httpx
    network = Mock(side_effect=AssertionError("provider must not be contacted"))
    monkeypatch.setattr(httpx, "AsyncClient", network)
    with pytest.raises(ProtectedPathError):
        await openai_image_v2.handle_gpt_image_2_edit(
            GraphNode(id="test", definitionId="gpt-image-2-edit", params={}),
            inputs, {"OPENAI_API_KEY": "fake-key"}, None, run_dir=tmp_path,
        )
    network.assert_not_called()
