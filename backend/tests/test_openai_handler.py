from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.openai_image import handle_openai_image_generate
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)


def _make_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="test-node-1",
        definitionId="gpt-image-1-generate",
        params=params or {"model": "gpt-image-1", "size": "1024x1024", "quality": "auto", "n": 1},
    )


def _mock_response(b64_data: str) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "created": 1234567890,
        "data": [{"b64_json": b64_data}],
    }
    return resp


@pytest.fixture(autouse=True)
def cleanup_output():
    yield
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)


@pytest.mark.asyncio
async def test_generates_image_and_saves_file() -> None:
    mock_resp = _mock_response(RED_PIXEL_B64)

    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="a red pixel")}
        api_keys = {"OPENAI_API_KEY": "sk-test-key"}

        result = await handle_openai_image_generate(node, inputs, api_keys)

    assert "image" in result
    assert result["image"]["type"] == "Image"
    file_path = Path(result["image"]["value"])
    assert file_path.suffix == ".png"

    call_kwargs = mock_client_instance.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["model"] == "gpt-image-1"
    assert body["prompt"] == "a red pixel"
    assert body["response_format"] == "b64_json"


@pytest.mark.asyncio
async def test_missing_prompt_raises() -> None:
    node = _make_node()
    inputs: dict[str, PortValueDict] = {}
    api_keys = {"OPENAI_API_KEY": "sk-test-key"}

    with pytest.raises(ValueError, match="[Pp]rompt"):
        await handle_openai_image_generate(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_api_error_propagates() -> None:
    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.side_effect = RuntimeError("API connection failed")
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        api_keys = {"OPENAI_API_KEY": "sk-test-key"}

        with pytest.raises(RuntimeError, match="API connection failed"):
            await handle_openai_image_generate(node, inputs, api_keys)
