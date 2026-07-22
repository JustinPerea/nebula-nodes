"""Golden JSON fixtures for Google handler request bodies.

Loads from contracts/fixtures/handlers/google/ and asserts handlers emit
matching upstream JSON for pinned node params + inputs.
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import respx
from httpx import Response

from handlers.gemini_omni import handle_gemini_omni
from handlers.google_gemini import (
    handle_gemini_chat,
    handle_gemini_embeddings,
    handle_gemini_tts,
    handle_imagen4,
    handle_lyria3,
    handle_nano_banana,
)
from handlers.style_reference import _STYLE_PROMPTS, handle_style_reference
from handlers.veo import handle_veo
from models.graph import GraphNode, PortValueDict

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "fixtures" / "handlers" / "google"

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)

STYLE_PNG_B64 = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )
).decode("ascii")


def _load_fixture(name: str) -> dict[str, Any]:
    data = json.loads((FIXTURES / name).read_text())
    data.pop("_comment", None)
    return data


class _FakeStreamResponse:
    def __init__(self, text: str = "ok") -> None:
        self.status_code = 200
        self._lines = [
            f'data: {json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}}]})}',
            "",
        ]

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        yield ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class _MagicPostResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.status_code = 200
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _VeoMock:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        self.posts.append(json)
        return _MagicPostResponse({"name": "operations/abc"})

    async def get(self, url, headers=None, timeout=None, follow_redirects=None):
        if "files" in url and "download" in url:
            return type("BytesResp", (), {"status_code": 200, "content": b"FAKE", "raise_for_status": lambda self: None})()
        return _MagicPostResponse({
            "done": True,
            "response": {
                "generateVideoResponse": {
                    "generatedSamples": [{
                        "video": {"uri": "https://generativelanguage.googleapis.com/v1beta/files/out:download"},
                    }],
                },
            },
        })


async def _capture_google_body(fixture_name: str) -> dict[str, Any]:
    """Run the handler scenario pinned to fixture_name and return the request JSON."""
    if fixture_name == "gemini-chat-generate-request.json":
        with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.stream = MagicMock(return_value=_FakeStreamResponse())
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client
            await handle_gemini_chat(
                GraphNode(
                    id="fixture-gemini-chat",
                    definitionId="gemini-chat",
                    params={"model": "gemini-2.5-pro", "temperature": 0.7, "max_tokens": 2048},
                ),
                {"messages": PortValueDict(type="Text", value="test")},
                {"GOOGLE_API_KEY": "test-key"},
            )
            return mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")

    if fixture_name == "imagen-4-generate-request.json":
        payload = {"predictions": [{"bytesBase64Encoded": RED_PIXEL_B64, "mimeType": "image/png"}]}
        with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
            inst = _mock_http_client(payload)
            MockClient.return_value = inst
            await handle_imagen4(
                GraphNode(
                    id="fixture-imagen",
                    definitionId="imagen-4-generate",
                    params={"model": "imagen-4.0-generate-001", "aspectRatio": "1:1", "numberOfImages": 1},
                ),
                {"prompt": PortValueDict(type="Text", value="a red pixel")},
                {"GOOGLE_API_KEY": "test-key"},
            )
            return _post_json(inst)

    if fixture_name == "nano-banana-generate-request.json":
        payload = {
            "candidates": [{
                "content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": RED_PIXEL_B64}}]},
            }],
        }
        with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
            inst = _mock_http_client(payload)
            MockClient.return_value = inst
            await handle_nano_banana(
                GraphNode(
                    id="fixture-nano",
                    definitionId="nano-banana",
                    params={"model": "gemini-3.1-flash-image", "aspect_ratio": "16:9", "imageSize": "2K"},
                ),
                {"prompt": PortValueDict(type="Text", value="a sunset")},
                {"GOOGLE_API_KEY": "test-key"},
            )
            return _post_json(inst)

    if fixture_name == "nano-banana-edit-request.json":
        payload = {
            "candidates": [{
                "content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": RED_PIXEL_B64}}]},
            }],
        }
        with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
            inst = _mock_http_client(payload)
            MockClient.return_value = inst
            await handle_nano_banana(
                GraphNode(
                    id="fixture-nano-edit",
                    definitionId="nano-banana",
                    params={"model": "gemini-3.1-flash-image", "aspect_ratio": "9:16", "imageSize": "1K"},
                ),
                {
                    "prompt": PortValueDict(type="Text", value="make the sky purple"),
                    "images": PortValueDict(
                        type="Image",
                        value=["https://example.com/ref1.png", "https://example.com/ref2.png"],
                    ),
                },
                {"GOOGLE_API_KEY": "test-key"},
            )
            return _post_json(inst)

    if fixture_name == "lyria-3-generate-request.json":
        silence = base64.b64encode(b"\xff\xfb" + b"\x00" * 26).decode()
        payload = {
            "candidates": [{
                "content": {"parts": [{"inlineData": {"mimeType": "audio/wav", "data": silence}}]},
            }],
        }
        with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
            inst = _mock_http_client(payload)
            MockClient.return_value = inst
            await handle_lyria3(
                GraphNode(
                    id="fixture-lyria",
                    definitionId="lyria-3",
                    params={"model": "lyria-3-pro-preview", "outputFormat": "wav"},
                ),
                {"prompt": PortValueDict(type="Text", value="upbeat jazz")},
                {"GOOGLE_API_KEY": "test-key"},
            )
            return _post_json(inst)

    if fixture_name == "gemini-tts-generate-request.json":
        pcm_b64 = base64.b64encode(struct.pack("<h", 0)).decode()
        payload = {
            "candidates": [{
                "content": {"parts": [{"inlineData": {"mimeType": "audio/pcm", "data": pcm_b64}}]},
            }],
        }
        with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
            inst = _mock_http_client(payload)
            MockClient.return_value = inst
            await handle_gemini_tts(
                GraphNode(
                    id="fixture-tts",
                    definitionId="gemini-tts",
                    params={"model": "gemini-2.5-flash-preview-tts", "voiceName": "Kore"},
                ),
                {"text": PortValueDict(type="Text", value="Hello world")},
                {"GOOGLE_API_KEY": "test-key"},
            )
            return _post_json(inst)

    if fixture_name == "gemini-embeddings-request.json":
        payload = {"embedding": {"values": [0.1, 0.2]}}
        with patch("handlers.google_gemini.httpx.AsyncClient") as MockClient:
            inst = _mock_http_client(payload)
            MockClient.return_value = inst
            await handle_gemini_embeddings(
                GraphNode(
                    id="fixture-emb",
                    definitionId="gemini-embeddings",
                    params={"model": "gemini-embedding-001", "outputDimensionality": "768"},
                ),
                {"text": PortValueDict(type="Text", value="hello")},
                {"GOOGLE_API_KEY": "test-key"},
            )
            return _post_json(inst)

    if fixture_name == "veo-3-text-to-video-request.json":
        mock = _VeoMock()
        run_dir = Path("/tmp/nebula-veo-fixture-run")
        run_dir.mkdir(parents=True, exist_ok=True)
        with patch("handlers.veo.httpx.AsyncClient", return_value=mock), patch(
            "handlers.veo.asyncio.sleep", new=AsyncMock()
        ), patch("handlers.veo.get_run_dir", return_value=run_dir):
            await handle_veo(
                GraphNode(
                    id="fixture-veo",
                    definitionId="veo-3",
                    params={"model": "veo-3.1-generate-preview", "aspectRatio": "16:9"},
                ),
                {"prompt": PortValueDict(type="Text", value="a sunset")},
                {"GOOGLE_API_KEY": "test-key"},
            )
        return mock.posts[0]

    if fixture_name == "gemini-omni-flash-submit-request.json":
        completed = {
            "id": "v1_abc",
            "status": "completed",
            "steps": [{"type": "model_output", "content": [{"type": "video", "data": "ZmFrZQ=="}]}],
        }
        run_dir = Path("/tmp/nebula-omni-fixture-run")
        run_dir.mkdir(parents=True, exist_ok=True)
        with patch("handlers.gemini_omni.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = _MagicPostResponse(completed)
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            with patch("handlers.gemini_omni.get_run_dir", return_value=run_dir):
                await handle_gemini_omni(
                    GraphNode(
                        id="fixture-omni",
                        definitionId="gemini-omni-flash",
                        params={"aspect_ratio": "9:16", "task": "text_to_video"},
                    ),
                    {"prompt": PortValueDict(type="Text", value="a marble rolling")},
                    {"GOOGLE_API_KEY": "test-key"},
                )
            return inst.post.call_args.kwargs.get("json") or inst.post.call_args[1].get("json")

    if fixture_name == "veo-3-fal-request.json":
        from execution.sync_runner import get_handler_registry

        emit = AsyncMock()
        registry = get_handler_registry(emit=emit)
        handler = registry["veo-3"]
        mock_submit = MagicMock(status_code=200)
        mock_submit.json.return_value = {"request_id": "req-test", "response_url": "https://queue.fal.run/fal-ai/veo3/requests/req-test"}
        run_dir = Path("/tmp/nebula-veo-fal-fixture-run")
        run_dir.mkdir(parents=True, exist_ok=True)

        async def _fake_get(url, **kwargs):
            if "fal.ai" in str(url) and str(url).endswith(".mp4"):
                resp = MagicMock(status_code=200, content=b"FAKEMP4")
                resp.raise_for_status = lambda: None
                return resp
            if "requests" in str(url):
                resp = MagicMock(status_code=200)
                resp.json.return_value = {"status": "COMPLETED"}
                return resp
            resp = MagicMock(status_code=200)
            resp.json.return_value = {"video": {"url": "https://fal.ai/out.mp4"}}
            return resp

        with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = mock_submit
            inst.get.side_effect = _fake_get
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
                with patch("handlers.fal_universal.get_run_dir", return_value=run_dir):
                    await handler(
                        GraphNode(
                            id="fixture-veo-fal",
                            definitionId="veo-3",
                            params={
                                "aspectRatio": "16:9",
                                "duration": "8",
                                "resolution": "720p",
                                "negative_prompt": "blurry",
                                "model": "veo-3.1-generate-preview",
                            },
                        ),
                        {"prompt": PortValueDict(type="Text", value="a sunset over mountains")},
                        {"FAL_KEY": "fal_test"},
                    )
            return inst.post.call_args.kwargs.get("json") or inst.post.call_args[1].get("json")

    if fixture_name == "style-reference-auto-request.json":
        captured: dict[str, Any] = {}

        def _capture(request) -> Response:
            captured["body"] = json.loads(request.content)
            return Response(200, json={
                "candidates": [{
                    "content": {"parts": [{"text": "muted earth palette"}]},
                }],
            })

        with respx.mock:
            respx.post(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
            ).mock(side_effect=_capture)

            ref_path = Path("/tmp/nebula-style-ref.png")
            ref_path.write_bytes(base64.b64decode(STYLE_PNG_B64))

            await handle_style_reference(
                GraphNode(
                    id="fixture-style",
                    definitionId="style-reference",
                    params={"filePath": str(ref_path), "mode": "auto", "focus": "palette", "strength": 1.0},
                ),
                inputs={},
                api_keys={"GOOGLE_API_KEY": "test-key"},
            )
        return captured["body"]

    raise AssertionError(f"Unknown fixture scenario: {fixture_name}")


def _mock_http_client(json_payload: dict[str, Any]) -> AsyncMock:
    inst = AsyncMock()
    inst.post.return_value = _MagicPostResponse(json_payload)
    inst.__aenter__ = AsyncMock(return_value=inst)
    inst.__aexit__ = AsyncMock(return_value=False)
    return inst


def _post_json(client: AsyncMock) -> dict[str, Any]:
    return client.post.call_args.kwargs.get("json") or client.post.call_args[1].get("json")


FIXTURE_NAMES = sorted(p.name for p in FIXTURES.glob("*.json"))


@pytest.mark.parametrize("fixture_name", FIXTURE_NAMES)
@pytest.mark.asyncio
async def test_google_request_body_matches_fixture(fixture_name: str) -> None:
    expected = _load_fixture(fixture_name)
    actual = await _capture_google_body(fixture_name)
    assert actual == expected


@pytest.mark.asyncio
@respx.mock
async def test_style_reference_fixture_uses_palette_prompt() -> None:
    """Sanity: fixture text part matches _STYLE_PROMPTS for focus=palette."""
    fixture = _load_fixture("style-reference-auto-request.json")
    text_part = next(p for p in fixture["contents"][0]["parts"] if "text" in p)
    assert text_part["text"] == _STYLE_PROMPTS["palette"]
