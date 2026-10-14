"""Tests for backend/handlers/meshy.py.

Focused on the params introduced in the 2026-06-03 audit follow-up:
- nano-banana-2 / gpt-image-2 ai_model values forwarded by text-to-image and
  image-to-image handlers.
- hd_texture, image_enhancement, remove_lighting forwarded by multi-image-to-3d
  (generic spread) and by text-to-3d (REFINE_KEYS list).
- symmetry_mode still forwarded by multi-image-to-3d despite being deprecated
  (no-op on the API side; kept for graph backwards-compatibility).

Patching note: meshy.py imports get_run_dir / save_mesh_from_url / save_base64_image
lazily inside each handler function via `from services.output import ...`. We must
patch at `services.output.<name>` (the source), not on the meshy module.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
import respx
from httpx import Response

from handlers.meshy import (
    _poll_meshy_task,
    handle_meshy_image_to_3d,
    handle_meshy_image_to_image,
    handle_meshy_multi_image_to_3d,
    handle_meshy_text_to_3d,
    handle_meshy_text_to_image,
)
from models.graph import GraphNode, PortValueDict


# ---------- helpers ----------


def _node(definition_id: str, params: dict[str, Any] | None = None) -> GraphNode:
    return GraphNode(id="n1", definitionId=definition_id, params=params or {})


def _port(value: Any) -> PortValueDict:
    return PortValueDict(type="Text", value=value)


def _image_list_port(values: list[str]) -> PortValueDict:
    return PortValueDict(type="Image", value=values)


FAKE_API_KEY = {"MESHY_API_KEY": "test-key-123"}

# A minimal PNG data-URI (base64 of a 1×1 white PNG)
_TINY_PNG_DATA_URI = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

# Fake Meshy API responses
_SUBMIT_RESP = {"result": "task-abc-123"}
_POLL_SUCCEEDED_IMAGE = {
    "status": "SUCCEEDED",
    "image_urls": ["https://cdn.meshy.ai/img/result.png"],
}
_POLL_SUCCEEDED_MESH = {
    "status": "SUCCEEDED",
    "model_urls": {"glb": "https://cdn.meshy.ai/models/result.glb"},
}


# ---------- text-to-image: ai_model forwarding ----------


@pytest.mark.asyncio
@respx.mock
async def test_text_to_image_nano_banana_2(tmp_path):
    """nano-banana-2 ai_model value is forwarded to the Meshy API."""
    captured: dict[str, Any] = {}

    def _capture_request(request, *args, **kwargs):
        captured["body"] = json.loads(request.content)
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/text-to-image").mock(
        side_effect=_capture_request
    )
    respx.get("https://api.meshy.ai/openapi/v1/text-to-image/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_IMAGE)
    )
    respx.get("https://cdn.meshy.ai/img/result.png").mock(
        return_value=Response(200, content=b"\x89PNG\r\n")
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch("services.output.save_base64_image", return_value=tmp_path / "out.png"),
    ):
        await handle_meshy_text_to_image(
            node=_node("meshy-text-to-image", {"ai_model": "nano-banana-2"}),
            inputs={"prompt": _port("a dragon")},
            api_keys=FAKE_API_KEY,
        )

    assert captured["body"]["ai_model"] == "nano-banana-2"


@pytest.mark.asyncio
@respx.mock
async def test_text_to_image_gpt_image_2(tmp_path):
    """gpt-image-2 ai_model value is forwarded to the Meshy API."""
    captured: dict[str, Any] = {}

    def _capture_request(request, *args, **kwargs):
        captured["body"] = json.loads(request.content)
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/text-to-image").mock(
        side_effect=_capture_request
    )
    respx.get("https://api.meshy.ai/openapi/v1/text-to-image/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_IMAGE)
    )
    respx.get("https://cdn.meshy.ai/img/result.png").mock(
        return_value=Response(200, content=b"\x89PNG\r\n")
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch("services.output.save_base64_image", return_value=tmp_path / "out.png"),
    ):
        await handle_meshy_text_to_image(
            node=_node("meshy-text-to-image", {"ai_model": "gpt-image-2"}),
            inputs={"prompt": _port("a castle")},
            api_keys=FAKE_API_KEY,
        )

    assert captured["body"]["ai_model"] == "gpt-image-2"


# ---------- image-to-image: ai_model forwarding ----------


@pytest.mark.asyncio
@respx.mock
async def test_image_to_image_nano_banana_2(tmp_path):
    """nano-banana-2 ai_model value is forwarded by handle_meshy_image_to_image."""
    captured: dict[str, Any] = {}

    def _capture_request(request, *args, **kwargs):
        captured["body"] = json.loads(request.content)
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/image-to-image").mock(
        side_effect=_capture_request
    )
    respx.get("https://api.meshy.ai/openapi/v1/image-to-image/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_IMAGE)
    )
    respx.get("https://cdn.meshy.ai/img/result.png").mock(
        return_value=Response(200, content=b"\x89PNG\r\n")
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch("services.output.save_base64_image", return_value=tmp_path / "out.png"),
    ):
        await handle_meshy_image_to_image(
            node=_node("meshy-image-to-image", {"ai_model": "nano-banana-2"}),
            inputs={
                "prompt": _port("a dragon"),
                "images": _image_list_port([_TINY_PNG_DATA_URI]),
            },
            api_keys=FAKE_API_KEY,
        )

    assert captured["body"]["ai_model"] == "nano-banana-2"


@pytest.mark.asyncio
@respx.mock
async def test_image_to_image_gpt_image_2(tmp_path):
    """gpt-image-2 ai_model value is forwarded by handle_meshy_image_to_image."""
    captured: dict[str, Any] = {}

    def _capture_request(request, *args, **kwargs):
        captured["body"] = json.loads(request.content)
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/image-to-image").mock(
        side_effect=_capture_request
    )
    respx.get("https://api.meshy.ai/openapi/v1/image-to-image/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_IMAGE)
    )
    respx.get("https://cdn.meshy.ai/img/result.png").mock(
        return_value=Response(200, content=b"\x89PNG\r\n")
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch("services.output.save_base64_image", return_value=tmp_path / "out.png"),
    ):
        await handle_meshy_image_to_image(
            node=_node("meshy-image-to-image", {"ai_model": "gpt-image-2"}),
            inputs={
                "prompt": _port("a castle"),
                "images": _image_list_port([_TINY_PNG_DATA_URI]),
            },
            api_keys=FAKE_API_KEY,
        )

    assert captured["body"]["ai_model"] == "gpt-image-2"


# ---------- multi-image-to-3d: meshy-6 params forwarded via generic spread ----------


@pytest.mark.asyncio
@respx.mock
async def test_multi_image_to_3d_meshy6_params_forwarded(tmp_path):
    """hd_texture, image_enhancement, remove_lighting all appear in the request body."""
    captured: dict[str, Any] = {}

    def _capture_request(request, *args, **kwargs):
        captured["body"] = json.loads(request.content)
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/multi-image-to-3d").mock(
        side_effect=_capture_request
    )
    respx.get("https://api.meshy.ai/openapi/v1/multi-image-to-3d/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_MESH)
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch(
            "services.output.save_mesh_from_url",
            new_callable=AsyncMock,
            return_value=tmp_path / "result.glb",
        ),
    ):
        await handle_meshy_multi_image_to_3d(
            node=_node(
                "meshy-multi-image-to-3d",
                {
                    "ai_model": "meshy-6",
                    "hd_texture": True,
                    "image_enhancement": True,
                    "remove_lighting": False,
                },
            ),
            inputs={"images": _image_list_port([_TINY_PNG_DATA_URI])},
            api_keys=FAKE_API_KEY,
        )

    body = captured["body"]
    assert body["hd_texture"] is True, "hd_texture must be forwarded"
    assert body["image_enhancement"] is True, "image_enhancement must be forwarded"
    assert body["remove_lighting"] is False, "remove_lighting must be forwarded"
    assert body["ai_model"] == "meshy-6"


@pytest.mark.asyncio
@respx.mock
async def test_multi_image_to_3d_symmetry_mode_still_forwarded(tmp_path):
    """symmetry_mode is deprecated (no-op) but still forwarded for backwards-compatibility."""
    captured: dict[str, Any] = {}

    def _capture_request(request, *args, **kwargs):
        captured["body"] = json.loads(request.content)
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/multi-image-to-3d").mock(
        side_effect=_capture_request
    )
    respx.get("https://api.meshy.ai/openapi/v1/multi-image-to-3d/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_MESH)
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch(
            "services.output.save_mesh_from_url",
            new_callable=AsyncMock,
            return_value=tmp_path / "result.glb",
        ),
    ):
        await handle_meshy_multi_image_to_3d(
            node=_node(
                "meshy-multi-image-to-3d",
                {"symmetry_mode": "on"},
            ),
            inputs={"images": _image_list_port([_TINY_PNG_DATA_URI])},
            api_keys=FAKE_API_KEY,
        )

    # symmetry_mode is deprecated but still forwarded (no-op on Meshy side)
    assert captured["body"].get("symmetry_mode") == "on"


# ---------- text-to-3d: hd_texture in REFINE_KEYS ----------


@pytest.mark.asyncio
@respx.mock
async def test_text_to_3d_hd_texture_in_refine_body(tmp_path):
    """hd_texture appears in the refine task body but not the preview body when mode=full."""
    preview_submit_body: dict[str, Any] = {}
    refine_submit_body: dict[str, Any] = {}
    call_count = 0

    def _capture_submit(request, *args, **kwargs):
        nonlocal call_count
        body = json.loads(request.content)
        if call_count == 0:
            preview_submit_body.update(body)
            call_count += 1
            return Response(202, json={"result": "preview-task-id"})
        else:
            refine_submit_body.update(body)
            call_count += 1
            return Response(202, json={"result": "refine-task-id"})

    respx.post("https://api.meshy.ai/openapi/v2/text-to-3d").mock(
        side_effect=_capture_submit
    )
    respx.get("https://api.meshy.ai/openapi/v2/text-to-3d/preview-task-id").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_MESH)
    )
    respx.get("https://api.meshy.ai/openapi/v2/text-to-3d/refine-task-id").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_MESH)
    )

    with (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch(
            "services.output.save_mesh_from_url",
            new_callable=AsyncMock,
            return_value=tmp_path / "result.glb",
        ),
    ):
        await handle_meshy_text_to_3d(
            node=_node(
                "meshy-text-to-3d",
                {
                    "mode": "full",
                    "hd_texture": True,
                    "remove_lighting": True,
                    "ai_model": "meshy-6",
                },
            ),
            inputs={"prompt": _port("a knight")},
            api_keys=FAKE_API_KEY,
        )

    # hd_texture must NOT appear in the preview body (not in PREVIEW_KEYS)
    assert "hd_texture" not in preview_submit_body, (
        "hd_texture must not be sent in the preview request"
    )
    # hd_texture MUST appear in the refine body (added to REFINE_KEYS)
    assert refine_submit_body.get("hd_texture") is True, (
        "hd_texture must be forwarded in the refine request"
    )
    assert refine_submit_body.get("remove_lighting") is True


@pytest.mark.asyncio
async def test_poll_meshy_task_propagates_cancel_to_provider() -> None:
    """When the poll is cancelled, the in-flight Meshy task is DELETE'd upstream (so it
    stops on Meshy instead of running to completion), then CancelledError re-raises."""
    poll_url = "https://api.meshy.ai/openapi/v2/text-to-3d/task-abc"

    mock_client = AsyncMock()

    with patch("handlers.meshy.schedule_detached_cancel") as mock_sched, \
         patch("handlers.meshy.asyncio.sleep", new=AsyncMock(side_effect=asyncio.CancelledError())):
        with pytest.raises(asyncio.CancelledError):
            await _poll_meshy_task(mock_client, "meshy-key", poll_url, AsyncMock(), "node-1")

    mock_sched.assert_called_once()


@pytest.mark.asyncio
@respx.mock
async def test_image_to_3d_uses_cancel_aware_poll_path() -> None:
    """The single-image handler must share the same provider-cancel contract as
    every other Meshy task instead of polling in an unprotected duplicate loop."""
    respx.post("https://api.meshy.ai/openapi/v1/image-to-3d").mock(
        return_value=Response(202, json=_SUBMIT_RESP)
    )

    with (
        patch("handlers.meshy.schedule_detached_cancel") as mock_sched,
        patch(
            "handlers.meshy.asyncio.sleep",
            new=AsyncMock(side_effect=asyncio.CancelledError()),
        ),
    ):
        with pytest.raises(asyncio.CancelledError):
            await handle_meshy_image_to_3d(
                node=_node("meshy-image-to-3d"),
                inputs={"image": _port(_TINY_PNG_DATA_URI)},
                api_keys=FAKE_API_KEY,
            )

    mock_sched.assert_called_once()


@pytest.mark.asyncio
async def test_poll_meshy_task_treats_canceled_as_terminal_failure() -> None:
    mock_client = AsyncMock()
    mock_client.get.return_value = Response(
        200,
        json={"status": "CANCELED", "task_error": {"message": "stopped"}},
    )

    with patch("handlers.meshy.asyncio.sleep", new=AsyncMock()):
        with pytest.raises(RuntimeError, match="Meshy task canceled: stopped"):
            await _poll_meshy_task(
                mock_client,
                "meshy-key",
                "https://api.meshy.ai/openapi/v1/image-to-3d/task-abc",
                AsyncMock(),
                "node-1",
            )

    mock_client.get.assert_awaited_once()


# ---------- smart topology (Meshy T2), the replacement for lowpoly ----------


def _mesh_patches(tmp_path):
    return (
        patch("services.output.get_run_dir", return_value=tmp_path),
        patch("services.output.save_mesh_from_url", new_callable=AsyncMock, return_value=tmp_path / "r.glb"),
        patch("handlers.meshy.asyncio.sleep", new_callable=AsyncMock),
    )


@pytest.mark.asyncio
@respx.mock
async def test_text_to_3d_smart_topology_sends_meshy_t2_and_refine_inherits_it(tmp_path):
    bodies: list[dict[str, Any]] = []

    def _submit(request, *args, **kwargs):
        bodies.append(json.loads(request.content))
        return Response(202, json={"result": f"task-{len(bodies)}"})

    respx.post("https://api.meshy.ai/openapi/v2/text-to-3d").mock(side_effect=_submit)
    respx.get(url__regex=r"https://api.meshy.ai/openapi/v2/text-to-3d/task-\d").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_MESH)
    )
    run_dir, save, sleep = _mesh_patches(tmp_path)
    with run_dir, save, sleep:
        await handle_meshy_text_to_3d(
            node=_node("meshy-text-to-3d", {
                "mode": "full", "model_type": "smart-topology", "ai_model": "latest",
                "topology": "triangle", "target_polycount": 8000,
            }),
            inputs={"prompt": _port("a crate")},
            api_keys=FAKE_API_KEY,
        )

    preview, refine = bodies
    assert preview["model_type"] == "smart-topology"
    assert preview["ai_model"] == "meshy-t2"
    assert preview["target_polycount"] == 8000
    assert refine["mode"] == "refine"
    assert "ai_model" not in refine


@pytest.mark.asyncio
@respx.mock
async def test_image_to_3d_smart_topology_drops_unsupported_image_flags(tmp_path):
    captured: dict[str, Any] = {}

    def _submit(request, *args, **kwargs):
        captured.update(json.loads(request.content))
        return Response(202, json=_SUBMIT_RESP)

    respx.post("https://api.meshy.ai/openapi/v1/image-to-3d").mock(side_effect=_submit)
    respx.get("https://api.meshy.ai/openapi/v1/image-to-3d/task-abc-123").mock(
        return_value=Response(200, json=_POLL_SUCCEEDED_MESH)
    )
    run_dir, save, sleep = _mesh_patches(tmp_path)
    with run_dir, save, sleep:
        await handle_meshy_image_to_3d(
            node=_node("meshy-image-to-3d", {
                "model_type": "smart-topology", "ai_model": "meshy-6",
                "image_enhancement": True, "remove_lighting": True, "target_polycount": 15000,
            }),
            inputs={"image": PortValueDict(type="Image", value=_TINY_PNG_DATA_URI)},
            api_keys=FAKE_API_KEY,
        )

    assert captured["ai_model"] == "meshy-t2"
    assert "image_enhancement" not in captured
    assert "remove_lighting" not in captured


@pytest.mark.asyncio
@pytest.mark.parametrize("params, message", [
    ({"topology": "quad"}, "triangles only"),
    ({"target_polycount": 30000}, "at most 15,000"),
])
@respx.mock
async def test_smart_topology_rejects_what_meshy_t2_cannot_make(params, message):
    route = respx.post("https://api.meshy.ai/openapi/v1/image-to-3d")
    with pytest.raises(ValueError, match=message):
        await handle_meshy_image_to_3d(
            node=_node("meshy-image-to-3d", {"model_type": "smart-topology", **params}),
            inputs={"image": PortValueDict(type="Image", value=_TINY_PNG_DATA_URI)},
            api_keys=FAKE_API_KEY,
        )
    assert not route.called
