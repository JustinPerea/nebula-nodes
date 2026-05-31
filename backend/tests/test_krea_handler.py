from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from handlers.krea import (
    KREA_BASE_URL,
    handle_krea_generate,
    handle_krea_image_style_reference,
    handle_krea_moodboard,
    handle_krea_style,
    handle_krea_style_search,
    handle_krea_style_train,
)
from models.graph import GraphNode, PortValueDict


def _node(definition_id: str, params: dict | None = None) -> GraphNode:
    return GraphNode(id="krea-test", definitionId=definition_id, params=params or {})


@pytest.mark.asyncio
async def test_generate_builds_full_krea_body_and_uploads_local_style_image(tmp_path) -> None:
    image_path = tmp_path / "style.png"
    image_path.write_bytes(b"fake-png")
    captured: dict[str, object] = {}

    def capture_generate(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={"job_id": "job-1", "status": "queued", "created_at": "2026-05-30T00:00:00Z", "completed_at": None, "result": None},
        )

    with respx.mock:
        respx.post(f"{KREA_BASE_URL}/assets").mock(
            return_value=httpx.Response(200, json={"id": "asset-1", "image_url": "https://krea.assets/style.png", "uploaded_at": "now", "width": None, "height": None, "size_bytes": 8, "mime_type": "image/png"})
        )
        respx.post(f"{KREA_BASE_URL}/generate/image/krea/krea-2/large").mock(side_effect=capture_generate)
        respx.get(f"{KREA_BASE_URL}/jobs/job-1").mock(
            return_value=httpx.Response(
                200,
                json={
                    "job_id": "job-1",
                    "status": "completed",
                    "created_at": "2026-05-30T00:00:00Z",
                    "completed_at": "2026-05-30T00:00:02Z",
                    "result": {"urls": ["https://cdn.krea.ai/out.png"]},
                },
            )
        )
        respx.get("https://cdn.krea.ai/out.png").mock(
            return_value=httpx.Response(200, content=b"image-bytes", headers={"Content-Type": "image/png"})
        )

        with patch("handlers.krea.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_krea_generate(
                _node(
                    "krea-2-generate",
                    {
                        "variant": "large",
                        "aspect_ratio": "16:9",
                        "resolution": "1K",
                        "creativity": "high",
                        "seed": 42,
                        "style_reference_strength": 0.7,
                    },
                ),
                {
                    "prompt": PortValueDict(type="Text", value="A glass house in fog"),
                    "style_images": PortValueDict(type="Image", value=str(image_path)),
                    "styles": PortValueDict(type="Any", value={"kind": "krea_style", "id": "style-1", "strength": 1.2}),
                    "moodboard": PortValueDict(type="Any", value={"kind": "krea_moodboard", "id": "11111111-1111-1111-1111-111111111111", "strength": 0.4}),
                },
                {"KREA_API_TOKEN": "krea-token"},
                emit=AsyncMock(),
            )

    body = captured["body"]
    assert body == {
        "prompt": "A glass house in fog",
        "aspect_ratio": "16:9",
        "resolution": "1K",
        "creativity": "high",
        "seed": 42,
        "image_style_references": [{"url": "https://krea.assets/style.png", "strength": 0.7}],
        "styles": [{"id": "style-1", "strength": 1.2}],
        "moodboards": [{"id": "11111111-1111-1111-1111-111111111111", "strength": 0.4}],
    }
    assert result["image"]["type"] == "Image"
    assert result["image"]["value"].endswith(".png")


@pytest.mark.asyncio
async def test_generate_supports_manual_style_and_moodboard_params() -> None:
    captured: dict[str, object] = {}

    def capture_generate(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={
                "job_id": "job-2",
                "status": "completed",
                "created_at": "2026-05-30T00:00:00Z",
                "completed_at": "2026-05-30T00:00:02Z",
                "result": {"urls": ["https://cdn.krea.ai/manual.jpg"]},
            },
        )

    with respx.mock:
        respx.post(f"{KREA_BASE_URL}/generate/image/krea/krea-2/medium").mock(side_effect=capture_generate)
        respx.get("https://cdn.krea.ai/manual.jpg").mock(
            return_value=httpx.Response(200, content=b"jpg", headers={"Content-Type": "image/jpeg"})
        )

        await handle_krea_generate(
            _node(
                "krea-2-generate",
                {
                    "variant": "medium",
                    "aspect_ratio": "1:1",
                    "resolution": "1K",
                    "creativity": "raw",
                    "style_id": "style-manual",
                    "style_strength": -0.5,
                    "moodboard_id": "22222222-2222-2222-2222-222222222222",
                    "moodboard_strength": 0.8,
                },
            ),
            {"prompt": PortValueDict(type="Text", value="manual resources")},
            {"KREA_API_TOKEN": "krea-token"},
        )

    body = captured["body"]
    assert body["styles"] == [{"id": "style-manual", "strength": -0.5}]
    assert body["moodboards"] == [{"id": "22222222-2222-2222-2222-222222222222", "strength": 0.8}]


@pytest.mark.asyncio
async def test_generate_rejects_more_than_ten_image_style_references() -> None:
    refs = [f"https://example.com/{i}.png" for i in range(11)]
    with pytest.raises(ValueError, match="at most 10"):
        await handle_krea_generate(
            _node("krea-2-generate"),
            {
                "prompt": PortValueDict(type="Text", value="too many refs"),
                "style_images": PortValueDict(type="Image", value=refs),
            },
            {"KREA_API_TOKEN": "krea-token"},
        )


@pytest.mark.asyncio
async def test_krea_resource_wrapper_nodes_emit_typed_any_values() -> None:
    image_ref = await handle_krea_image_style_reference(
        _node("krea-image-style-reference", {"strength": 0.6}),
        {"image": PortValueDict(type="Image", value="/tmp/ref.png")},
        {},
    )
    style = await handle_krea_style(_node("krea-style", {"style_id": "style-1", "strength": 1.5}), {}, {})
    moodboard = await handle_krea_moodboard(
        _node("krea-moodboard", {"moodboard_id": "mood-1", "strength": 0.2}),
        {},
        {},
    )

    assert image_ref["image_style_reference"]["value"] == {
        "kind": "krea_image_style_reference",
        "image": "/tmp/ref.png",
        "strength": 0.6,
    }
    assert style["style"]["value"] == {"kind": "krea_style", "id": "style-1", "strength": 1.5}
    assert moodboard["moodboard"]["value"] == {"kind": "krea_moodboard", "id": "mood-1", "strength": 0.2}


@pytest.mark.asyncio
async def test_style_search_outputs_array_and_summary() -> None:
    with respx.mock:
        route = respx.get(f"{KREA_BASE_URL}/styles").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {"id": "style-1", "title": "Editorial Ink", "models": ["flux_dev"], "urls": [], "public": True, "prompt": "", "owner": None, "like_count": 0, "created_at": "now"}
                    ],
                    "next_cursor": None,
                },
            )
        )

        result = await handle_krea_style_search(
            _node("krea-style-search", {"filter": "shared", "model": "flux_dev", "limit": 10}),
            {},
            {"KREA_API_TOKEN": "krea-token"},
        )

    assert route.calls.last.request.url.params["filter"] == "shared"
    assert route.calls.last.request.url.params["model"] == "flux_dev"
    assert result["styles"]["value"][0]["id"] == "style-1"
    assert "Editorial Ink" in result["text"]["value"]


@pytest.mark.asyncio
async def test_style_train_uploads_images_polls_and_emits_style(tmp_path) -> None:
    image_path = tmp_path / "train.png"
    image_path.write_bytes(b"train")
    captured: dict[str, object] = {}

    def capture_train(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={"job_id": "train-1", "status": "queued", "created_at": "2026-05-30T00:00:00Z", "completed_at": None, "result": None},
        )

    with respx.mock:
        respx.post(f"{KREA_BASE_URL}/assets").mock(
            return_value=httpx.Response(200, json={"id": "asset-2", "image_url": "https://krea.assets/train.png", "uploaded_at": "now", "width": None, "height": None, "size_bytes": 5, "mime_type": "image/png"})
        )
        respx.post(f"{KREA_BASE_URL}/styles/train").mock(side_effect=capture_train)
        respx.get(f"{KREA_BASE_URL}/jobs/train-1").mock(
            return_value=httpx.Response(
                200,
                json={
                    "job_id": "train-1",
                    "status": "completed",
                    "created_at": "2026-05-30T00:00:00Z",
                    "completed_at": "2026-05-30T00:05:00Z",
                    "result": {"style_id": "trained-style"},
                },
            )
        )
        share = respx.post(f"{KREA_BASE_URL}/styles/trained-style/share/workspace").mock(
            return_value=httpx.Response(200, json={"success": True, "style_id": "trained-style"})
        )

        with patch("handlers.krea.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_krea_style_train(
                _node(
                    "krea-style-train",
                    {
                        "name": "Ink Style",
                        "model": "flux_dev",
                        "training_type": "Style",
                        "trigger_word": "INK",
                        "max_train_steps": 1200,
                        "learning_rate": 0.0002,
                        "batch_size": 2,
                        "generation_strength": 0.9,
                        "share_with_workspace": True,
                    },
                ),
                {"images": PortValueDict(type="Image", value=str(image_path))},
                {"KREA_API_TOKEN": "krea-token"},
                emit=AsyncMock(),
            )

    assert captured["body"] == {
        "model": "flux_dev",
        "type": "Style",
        "name": "Ink Style",
        "urls": ["https://krea.assets/train.png"],
        "trigger_word": "INK",
        "max_train_steps": 1200,
        "learning_rate": 0.0002,
        "batch_size": 2,
    }
    assert share.called
    assert result["style"]["value"] == {"kind": "krea_style", "id": "trained-style", "strength": 0.9}
    assert result["style_id"]["value"] == "trained-style"


@pytest.mark.asyncio
async def test_missing_krea_api_key_raises() -> None:
    with pytest.raises(ValueError, match="KREA_API_TOKEN"):
        await handle_krea_style_search(_node("krea-style-search"), {}, {})
