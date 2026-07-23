"""Golden JSON fixtures for FAL handler request bodies.

Loads from contracts/fixtures/handlers/fal/*.json and asserts handlers emit
matching upstream JSON for pinned node params + inputs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from execution.sync_runner import get_handler_registry
from handlers.fal_universal import handle_fal_universal
from models.graph import GraphNode, PortValueDict

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "fixtures" / "handlers" / "fal"


def _load_fixture(name: str) -> dict[str, Any]:
    data = json.loads((FIXTURES / name).read_text())
    data.pop("_comment", None)
    return data


def _make_poll_mocks(result_payload: dict) -> tuple[MagicMock, MagicMock, MagicMock]:
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-test"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = result_payload

    return mock_submit, mock_status, mock_result


async def _capture_registry_poll_body(
    *,
    definition_id: str,
    params: dict[str, Any],
    inputs: dict[str, PortValueDict],
) -> dict[str, Any]:
    """Capture one fixed FAL wrapper through the real registry and body builder."""
    registry = get_handler_registry(emit=AsyncMock())
    handler = registry[definition_id]
    mock_submit, mock_status, mock_result = _make_poll_mocks(
        {"model_glb": {"url": "https://fal.ai/out.glb"}}
    )
    node = GraphNode(
        id=f"fixture-{definition_id}",
        definitionId=definition_id,
        params=params,
    )
    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client
        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            await handler(node, inputs, {"FAL_KEY": "fal_test"})

    # Fixed wrappers must not persist their internal routing field on the source node.
    assert "endpoint_id" not in node.params
    return mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")


async def _capture_fal_body(fixture_name: str) -> dict[str, Any]:
    if fixture_name == "hunyuan3d-text-to-3d-request.json":
        return await _capture_registry_poll_body(
            definition_id="hunyuan3d-text-to-3d",
            params={
                "generate_type": "Normal",
                "face_count": 500000,
                "enable_pbr": False,
                "polygon_type": "triangle",
            },
            inputs={
                "prompt": PortValueDict(type="Text", value="a ceramic teapot"),
            },
        )

    if fixture_name == "hunyuan3d-image-to-3d-request.json":
        return await _capture_registry_poll_body(
            definition_id="hunyuan3d-image-to-3d",
            params={
                "generate_type": "LowPoly",
                "face_count": 120000,
                "enable_pbr": True,
                "polygon_type": "quadrilateral",
            },
            inputs={
                "front_image": PortValueDict(type="Image", value="https://example.com/front.png"),
                "back_image": PortValueDict(type="Image", value="https://example.com/back.png"),
                "left_image": PortValueDict(type="Image", value="https://example.com/left.png"),
                "right_image": PortValueDict(type="Image", value="https://example.com/right.png"),
            },
        )

    if fixture_name == "nano-banana-fal-generate-request.json":
        registry = get_handler_registry(emit=AsyncMock())
        handler = registry["nano-banana-fal"]
        mock_submit, mock_status, mock_result = _make_poll_mocks(
            {"images": [{"url": "https://fal.ai/out.png"}]}
        )
        node = GraphNode(
            id="fixture-nb-fal-gen",
            definitionId="nano-banana-fal",
            params={
                "model": "nano-banana-2",
                "aspect_ratio": "16:9",
                "resolution": "2K",
                "num_images": 2,
                "output_format": "png",
            },
        )
        with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.post.return_value = mock_submit
            mock_client.get.side_effect = [mock_status, mock_result]
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client
            with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
                await handler(
                    node,
                    {"prompt": PortValueDict(type="Text", value="a red apple")},
                    {"FAL_KEY": "fal_test"},
                )
            return mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")

    if fixture_name == "nano-banana-fal-edit-request.json":
        registry = get_handler_registry(emit=AsyncMock())
        handler = registry["nano-banana-fal-edit"]
        mock_submit, mock_status, mock_result = _make_poll_mocks(
            {"images": [{"url": "https://fal.ai/out.png"}]}
        )
        node = GraphNode(
            id="fixture-nb-fal-edit",
            definitionId="nano-banana-fal-edit",
            params={"model": "nano-banana-pro", "resolution": "2K", "aspect_ratio": "9:16"},
        )
        with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.post.return_value = mock_submit
            mock_client.get.side_effect = [mock_status, mock_result]
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client
            with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
                await handler(
                    node,
                    {
                        "prompt": PortValueDict(type="Text", value="change shirt to blue"),
                        "images": PortValueDict(
                            type="Image",
                            value=["https://example.com/ref1.png", "https://example.com/ref2.png"],
                        ),
                    },
                    {"FAL_KEY": "fal_test"},
                )
            return mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")

    if fixture_name == "gpt-image-2-fal-generate-request.json":
        node = GraphNode(
            id="fixture-gpt2-fal-gen",
            definitionId="gpt-image-2-fal-generate",
            params={
                "endpoint_id": "openai/gpt-image-2",
                "image_size": "square_hd",
                "quality": "high",
                "num_images": 2,
                "output_format": "jpeg",
            },
        )
        with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "https://fal.ai/out.png"
            await handle_fal_universal(
                node,
                {"prompt": PortValueDict(type="Text", value="test")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )
            return mock_stream.call_args.kwargs["request_body"]

    if fixture_name == "gpt-image-2-fal-edit-request.json":
        node = GraphNode(
            id="fixture-gpt2-fal-edit",
            definitionId="gpt-image-2-fal-edit",
            params={"endpoint_id": "openai/gpt-image-2/edit", "image_size": "auto"},
        )
        with patch("execution.stream_runner.stream_execute_image", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "https://fal.ai/out.png"
            await handle_fal_universal(
                node,
                {
                    "prompt": PortValueDict(type="Text", value="make it night"),
                    "images": PortValueDict(
                        type="Image",
                        value=["https://example.com/img1.png", "https://example.com/img2.png"],
                    ),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )
            return mock_stream.call_args.kwargs["request_body"]

    if fixture_name == "gpt-image-1-5-generate-request.json":
        registry = get_handler_registry(emit=AsyncMock())
        handler = registry["gpt-image-1-5"]
        mock_submit, mock_status, mock_result = _make_poll_mocks(
            {"images": [{"url": "https://fal.ai/out.png"}]}
        )
        node = GraphNode(
            id="fixture-gpt15-gen",
            definitionId="gpt-image-1-5",
            params={
                "image_size": "1024x1024",
                "quality": "medium",
                "background": "transparent",
                "num_images": 3,
                "output_format": "webp",
            },
        )
        with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.post.return_value = mock_submit
            mock_client.get.side_effect = [mock_status, mock_result]
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client
            with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
                await handler(
                    node,
                    {"prompt": PortValueDict(type="Text", value="a ceramic mug")},
                    {"FAL_KEY": "fal_test"},
                )
            return mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")

    if fixture_name == "gpt-image-1-5-edit-request.json":
        registry = get_handler_registry(emit=AsyncMock())
        handler = registry["gpt-image-1-5-edit"]
        mock_submit, mock_status, mock_result = _make_poll_mocks(
            {"images": [{"url": "https://fal.ai/out.png"}]}
        )
        node = GraphNode(
            id="fixture-gpt15-edit",
            definitionId="gpt-image-1-5-edit",
            params={"input_fidelity": "high"},
        )
        with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.post.return_value = mock_submit
            mock_client.get.side_effect = [mock_status, mock_result]
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client
            with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
                await handler(
                    node,
                    {
                        "prompt": PortValueDict(type="Text", value="make it winter"),
                        "images": PortValueDict(
                            type="Image",
                            value=["https://example.com/a.png", "https://example.com/b.png"],
                        ),
                    },
                    {"FAL_KEY": "fal_test"},
                )
            return mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")

    raise AssertionError(f"Unknown fixture scenario: {fixture_name}")


FIXTURE_NAMES = sorted(p.name for p in FIXTURES.glob("*.json"))


@pytest.mark.parametrize("fixture_name", FIXTURE_NAMES)
@pytest.mark.asyncio
async def test_fal_request_body_matches_fixture(fixture_name: str) -> None:
    expected = _load_fixture(fixture_name)
    actual = await _capture_fal_body(fixture_name)
    assert actual == expected
