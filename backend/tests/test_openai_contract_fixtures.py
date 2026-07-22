"""Golden JSON fixtures for OpenAI handler request bodies.

Loads from contracts/fixtures/handlers/openai/*.json and asserts handlers emit
matching upstream payloads for pinned node params + inputs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.openai_audio import handle_openai_stt, handle_openai_translate, handle_openai_tts
from handlers.openai_chat import handle_openai_chat
from handlers.openai_image import handle_openai_image_generate
from handlers.openai_image_edit import handle_openai_image_edit
from handlers.openai_image_v2 import build_generate_body, handle_gpt_image_2_edit
from models.graph import GraphNode, PortValueDict

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "contracts" / "fixtures" / "handlers" / "openai"

RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
GPT2_EDIT_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "YAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


def _load_fixture(name: str) -> dict[str, Any]:
    data = json.loads((FIXTURES / name).read_text())
    data.pop("_comment", None)
    return data


def _normalize_gpt_image_1_multipart(files: list[tuple[Any, ...]]) -> dict[str, Any]:
    fields: list[dict[str, Any]] = []
    for item in files:
        name, rest = item[0], item[1]
        if isinstance(rest, tuple) and len(rest) == 2 and rest[0] is None:
            fields.append({"field": name, "value": rest[1]})
        elif isinstance(rest, tuple) and len(rest) == 3:
            fields.append({"field": name, "filename": rest[0], "content_type": rest[2]})
        else:
            fields.append({"field": name, "value": str(rest)})
    return {"transport": "multipart", "fields": fields}


def _normalize_stt_like_multipart(call_kwargs: dict[str, Any]) -> dict[str, Any]:
    return {
        "transport": "multipart",
        "data": dict(call_kwargs["data"]),
        "file_fields": list(call_kwargs["files"].keys()),
    }


class _FakeGpt2EditStream:
    status_code = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def aiter_lines(self):
        yield "event: image_edit.completed"
        yield f'data: {{"b64_json": "{GPT2_EDIT_B64}"}}'
        yield ""
        yield "data: [DONE]"
        yield ""


async def _capture_openai_body(fixture_name: str) -> dict[str, Any]:
    if fixture_name == "gpt-image-2-generate-request.json":
        node = GraphNode(
            id="fixture-gpt2-gen",
            definitionId="gpt-image-2-generate",
            params={"size": "1024x1024", "quality": "low"},
        )
        return build_generate_body(node, prompt_text="a cat")

    if fixture_name == "gpt-image-2-edit-multipart.json":
        img = Path("/tmp/nebula-openai-gpt2-edit.png")
        img.write_bytes(PNG_BYTES)
        run_dir = Path("/tmp/nebula-openai-gpt2-edit-run")
        run_dir.mkdir(parents=True, exist_ok=True)
        captured: dict[str, Any] = {}

        class _CapturingClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def stream(self, method, url, *, headers=None, data=None, files=None):
                captured["form"] = dict(data or {})
                captured["file_fields"] = [name for name, _file_part in (files or [])]
                return _FakeGpt2EditStream()

        with patch("httpx.AsyncClient", return_value=_CapturingClient()):
            await handle_gpt_image_2_edit(
                GraphNode(
                    id="fixture-gpt2-edit",
                    definitionId="gpt-image-2-edit",
                    params={"size": "1024x1024", "quality": "low"},
                ),
                {
                    "images": PortValueDict(type="Image", value=[str(img)]),
                    "prompt": PortValueDict(type="Text", value="make it blue"),
                },
                {"OPENAI_API_KEY": "sk-test"},
                emit=None,
                run_dir=run_dir,
            )
        return {
            "transport": "multipart",
            "form": captured["form"],
            "file_fields": captured["file_fields"],
        }

    if fixture_name == "gpt-image-1-generate-request.json":
        mock_resp = MagicMock(status_code=200, raise_for_status=MagicMock())
        mock_resp.json.return_value = {"data": [{"b64_json": RED_PIXEL_B64}]}
        with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = mock_resp
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            await handle_openai_image_generate(
                GraphNode(
                    id="fixture-gpt1-gen",
                    definitionId="gpt-image-1-generate",
                    params={
                        "model": "gpt-image-1",
                        "size": "1024x1024",
                        "quality": "high",
                        "output_format": "jpeg",
                    },
                ),
                {"prompt": PortValueDict(type="Text", value="a red pixel")},
                {"OPENAI_API_KEY": "sk-test"},
            )
            return inst.post.call_args.kwargs["json"]

    if fixture_name == "gpt-image-1-edit-multipart.json":
        img = Path("/tmp/nebula-openai-gpt1-edit.png")
        img.write_bytes(PNG_BYTES)
        mock_resp = MagicMock(status_code=200, raise_for_status=MagicMock())
        mock_resp.json.return_value = {"data": [{"b64_json": RED_PIXEL_B64}]}
        with patch("handlers.openai_image_edit.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = mock_resp
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            await handle_openai_image_edit(
                GraphNode(
                    id="fixture-gpt1-edit",
                    definitionId="gpt-image-1-edit",
                    params={"model": "gpt-image-1", "size": "1024x1024", "quality": "high"},
                ),
                {
                    "image": PortValueDict(type="Image", value=str(img)),
                    "prompt": PortValueDict(type="Text", value="make it blue"),
                },
                {"OPENAI_API_KEY": "sk-test"},
            )
            return _normalize_gpt_image_1_multipart(inst.post.call_args.kwargs["files"])

    if fixture_name == "gpt-4o-chat-request.json":
        with patch("handlers.openai_chat.stream_execute", new_callable=AsyncMock) as mock_stream:
            mock_stream.return_value = "ok"
            await handle_openai_chat(
                GraphNode(
                    id="fixture-chat",
                    definitionId="gpt-4o-chat",
                    params={
                        "model": "gpt-5.4",
                        "reasoning_effort": "medium",
                        "max_completion_tokens": 4096,
                    },
                ),
                {"messages": PortValueDict(type="Text", value="Hello")},
                {"OPENAI_API_KEY": "sk-test"},
            )
            return mock_stream.call_args.kwargs["request_body"]

    if fixture_name == "openai-tts-request.json":
        mock_resp = MagicMock(status_code=200, content=b"audio")
        run_dir = Path("/tmp/nebula-openai-tts")
        run_dir.mkdir(parents=True, exist_ok=True)
        with patch("handlers.openai_audio.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = mock_resp
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            with patch("handlers.openai_audio.get_run_dir", return_value=run_dir):
                await handle_openai_tts(
                    GraphNode(
                        id="fixture-tts",
                        definitionId="openai-tts",
                        params={
                            "model": "tts-1",
                            "voice": "nova",
                            "speed": 1.5,
                            "response_format": "mp3",
                        },
                    ),
                    {"text": PortValueDict(type="Text", value="Hello world")},
                    {"OPENAI_API_KEY": "sk-test"},
                )
            return inst.post.call_args.kwargs["json"]

    if fixture_name == "openai-stt-request.json":
        audio = Path("/tmp/nebula-openai-stt.mp3")
        audio.write_bytes(b"fake-audio")
        with patch("handlers.openai_audio.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = MagicMock(status_code=200, json=lambda: {"text": "hi"}, text="hi")
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            await handle_openai_stt(
                GraphNode(
                    id="fixture-stt",
                    definitionId="openai-stt",
                    params={"model": "whisper-1", "response_format": "json", "language": "en"},
                ),
                {"audio": PortValueDict(type="Audio", value=str(audio))},
                {"OPENAI_API_KEY": "sk-test"},
            )
            return _normalize_stt_like_multipart(inst.post.call_args.kwargs)

    if fixture_name == "openai-translate-request.json":
        audio = Path("/tmp/nebula-openai-translate.mp3")
        audio.write_bytes(b"fake-audio")
        with patch("handlers.openai_audio.httpx.AsyncClient") as MockClient:
            inst = AsyncMock()
            inst.post.return_value = MagicMock(
                status_code=200, json=lambda: {"text": "hello"}, text="hello"
            )
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = inst
            await handle_openai_translate(
                GraphNode(
                    id="fixture-translate",
                    definitionId="openai-translate",
                    params={"response_format": "json"},
                ),
                {"audio": PortValueDict(type="Audio", value=str(audio))},
                {"OPENAI_API_KEY": "sk-test"},
            )
            return _normalize_stt_like_multipart(inst.post.call_args.kwargs)

    raise AssertionError(f"Unknown fixture scenario: {fixture_name}")


JSON_FIXTURE_NAMES = sorted(
    p.name for p in FIXTURES.glob("*.json")
)


@pytest.mark.parametrize("fixture_name", JSON_FIXTURE_NAMES)
@pytest.mark.asyncio
async def test_openai_request_body_matches_fixture(fixture_name: str) -> None:
    expected = _load_fixture(fixture_name)
    actual = await _capture_openai_body(fixture_name)
    assert actual == expected
