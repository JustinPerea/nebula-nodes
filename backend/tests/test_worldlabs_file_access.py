"""World Labs' URL-to-file rewrite must retain the local file boundary."""
from unittest.mock import AsyncMock

import pytest

from handlers.worldlabs import _content_reference, _upload_local_media
from services.file_access import ProtectedPathError


@pytest.fixture
def protected_media(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    root.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(root))
    media = root / "private.png"
    media.write_bytes(b"private image fixture")
    return media


@pytest.mark.asyncio
async def test_upload_rejects_protected_media_before_provider_request(protected_media):
    client = AsyncMock()

    with pytest.raises(ProtectedPathError):
        await _upload_local_media(client, protected_media, "image", {})

    assert client.mock_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reference", ["localhost-url", "whitespace-path"])
async def test_rewritten_media_reference_cannot_bypass_protected_path(
    reference, protected_media, tmp_path, monkeypatch
):
    from services import output

    if reference == "localhost-url":
        root = tmp_path / "output"
        root.mkdir()
        alias = root / "alias.png"
        alias.hardlink_to(protected_media)
        monkeypatch.setattr(output, "OUTPUT_ROOT", root)
        value = "http://127.0.0.1:8000/api/outputs/alias.png"
    else:
        value = f"  {protected_media}  "
    client = AsyncMock()

    with pytest.raises(ProtectedPathError):
        await _content_reference(client, value, "image", {})

    assert client.mock_calls == []
