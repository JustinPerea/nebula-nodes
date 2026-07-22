from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from handlers.gemini_omni import handle_gemini_omni
from models.graph import GraphNode, PortValueDict
from services.provider_capabilities import GEMINI_OMNI_EXTENSION_ERROR


def _make_node(params=None):
    return GraphNode(
        id="test-omni-1",
        definitionId="gemini-omni-flash",
        params=params or {},
    )


class _Resp:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _BytesResp(_Resp):
    def __init__(self, status_code: int, content: bytes):
        super().__init__(status_code, {})
        self.content = content


@pytest.mark.asyncio
async def test_gemini_omni_text_to_video_submits_interaction():
    completed = {
        "id": "v1_abc123",
        "status": "completed",
        "steps": [{
            "type": "model_output",
            "content": [{
                "type": "video",
                "mime_type": "video/mp4",
                "data": "ZmFrZQ==",
            }],
        }],
    }

    with patch("handlers.gemini_omni.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(200, completed)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.gemini_omni.get_run_dir") as mock_run_dir:
            from pathlib import Path
            tmp = Path("/tmp/omni-test-run")
            tmp.mkdir(parents=True, exist_ok=True)
            mock_run_dir.return_value = tmp

            result = await handle_gemini_omni(
                _make_node({"aspect_ratio": "9:16", "task": "text_to_video"}),
                {"prompt": PortValueDict(type="Text", value="a marble rolling")},
                {"GOOGLE_API_KEY": "test-key"},
            )

    body = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert body["model"] == "gemini-omni-flash-preview"
    assert body["input"] == "a marble rolling"
    assert body["background"] is False
    assert body["response_format"]["aspect_ratio"] == "9:16"
    assert body["generation_config"]["video_config"]["task"] == "text_to_video"
    assert result["video"]["type"] == "Video"
    assert result["interaction_id"]["value"] == "v1_abc123"


@pytest.mark.asyncio
async def test_gemini_omni_connected_previous_interaction_takes_precedence():
    completed = {
        "id": "v1_chained",
        "status": "completed",
        "steps": [{
            "type": "model_output",
            "content": [{"type": "video", "data": "ZmFrZQ=="}],
        }],
    }

    with patch("handlers.gemini_omni.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(200, completed)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.gemini_omni.get_run_dir") as mock_run_dir:
            from pathlib import Path
            tmp = Path("/tmp/omni-chained-run")
            tmp.mkdir(parents=True, exist_ok=True)
            mock_run_dir.return_value = tmp

            await handle_gemini_omni(
                _make_node({"previous_interaction_id": "v1_manual"}),
                {
                    "prompt": PortValueDict(type="Text", value="make it dusk"),
                    "previous_interaction_id": PortValueDict(type="Text", value="v1_connected"),
                },
                {"GOOGLE_API_KEY": "test-key"},
            )

    body = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert body["previous_interaction_id"] == "v1_connected"


@pytest.mark.asyncio
async def test_gemini_omni_extension_is_blocked_before_provider_submit():
    with patch("handlers.gemini_omni.httpx.AsyncClient") as MockClient:
        with pytest.raises(ValueError, match="cannot extend") as exc_info:
            await handle_gemini_omni(
                _make_node({"previous_interaction_id": "v1_manual"}),
                {
                    "prompt": PortValueDict(
                        type="Text",
                        value="Continue the same clip: make the circle shrink to a dot.",
                    ),
                    "previous_interaction_id": PortValueDict(
                        type="Text",
                        value="v1_connected",
                    ),
                },
                {"GOOGLE_API_KEY": "test-key"},
            )

    assert str(exc_info.value) == GEMINI_OMNI_EXTENSION_ERROR
    MockClient.assert_not_called()


@pytest.mark.asyncio
async def test_gemini_omni_polls_when_processing():
    processing = {"id": "v1_poll", "status": "processing"}
    completed = {
        "id": "v1_poll",
        "status": "completed",
        "steps": [{
            "type": "model_output",
            "content": [{"type": "video", "data": "ZmFrZQ=="}],
        }],
    }

    with patch("handlers.gemini_omni.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(200, processing)
        mock_client.get.return_value = _Resp(200, completed)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.gemini_omni.asyncio.sleep", new_callable=AsyncMock):
            with patch("handlers.gemini_omni.get_run_dir") as mock_run_dir:
                from pathlib import Path
                tmp = Path("/tmp/omni-poll-run")
                tmp.mkdir(parents=True, exist_ok=True)
                mock_run_dir.return_value = tmp

                await handle_gemini_omni(
                    _make_node({"delivery": "inline"}),
                    {"prompt": PortValueDict(type="Text", value="sunset")},
                    {"GOOGLE_API_KEY": "test-key"},
                )

    body = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert body["background"] is True
    assert mock_client.get.call_args.args[0].endswith("/v1_poll")


@pytest.mark.asyncio
async def test_gemini_omni_uri_delivery_uses_initial_response(tmp_path):
    completed = {
        "id": "v1_uri",
        "status": "completed",
        "steps": [{
            "type": "model_output",
            "content": [{
                "type": "video",
                "mime_type": "video/mp4",
                "uri": "https://generativelanguage.googleapis.com/v1beta/files/file-123:download?alt=media",
            }],
        }],
    }

    with patch("handlers.gemini_omni.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = _Resp(200, completed)
        mock_client.get.side_effect = [
            _Resp(200, {"state": "ACTIVE"}),
            _BytesResp(200, b"fake-video"),
        ]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.gemini_omni.get_run_dir", return_value=tmp_path):
            result = await handle_gemini_omni(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="sunset")},
                {"GOOGLE_API_KEY": "test-key"},
            )

    body = mock_client.post.call_args.kwargs.get("json") or mock_client.post.call_args[1].get("json")
    assert body["background"] is False
    assert body["response_format"]["delivery"] == "uri"
    assert mock_client.get.call_args_list[0].args[0].endswith("/files/file-123")
    assert result["interaction_id"]["value"] == "v1_uri"
    assert (tmp_path / result["video"]["value"].split("/")[-1]).read_bytes() == b"fake-video"
