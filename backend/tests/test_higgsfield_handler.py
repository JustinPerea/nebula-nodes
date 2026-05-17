from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.higgsfield import handle_higgsfield, HIGGSFIELD_BASE, _DEFAULT_MODEL
from models.graph import GraphNode, PortValueDict


def _make_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="higgsfield-test",
        definitionId="higgsfield",
        params=params or {},
    )


def _mock_client(submit_json: dict, poll_json: dict) -> AsyncMock:
    """Return a mock AsyncClient wired with submit + one poll response."""
    submit_resp = MagicMock()
    submit_resp.status_code = 200
    submit_resp.json.return_value = submit_json

    poll_resp = MagicMock()
    poll_resp.status_code = 200
    poll_resp.json.return_value = poll_json

    dl_resp = MagicMock()
    dl_resp.raise_for_status = MagicMock()
    dl_resp.content = b"fake-video-bytes"

    mock_client = AsyncMock()
    mock_client.post.return_value = submit_resp
    mock_client.get.side_effect = [poll_resp, dl_resp]
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


_SUBMIT_OK = {"request_id": "req-abc123", "status": "queued"}
_POLL_COMPLETED = {"status": "completed", "video": {"url": "https://cdn.higgsfield.ai/out.mp4"}}
_API_KEYS = {"HIGGSFIELD_API_KEY": "hf-test-key"}


# ---------------------------------------------------------------------------
# Base URL and auth
# ---------------------------------------------------------------------------


def test_base_url_constant() -> None:
    """HIGGSFIELD_BASE must point to platform.higgsfield.ai, not api.higgsfield.ai."""
    assert HIGGSFIELD_BASE == "https://platform.higgsfield.ai", (
        f"Wrong base URL: {HIGGSFIELD_BASE}. Canonical: https://platform.higgsfield.ai"
    )


@pytest.mark.asyncio
async def test_submit_url_uses_model_path() -> None:
    """POST endpoint must be {base}/{model_id}, not a fixed /v1/video/generate path."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_higgsfield(
            _make_node({"model": "higgsfield-ai/dop/standard"}),
            {"prompt": PortValueDict(type="Text", value="a sunset timelapse")},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert url == "https://platform.higgsfield.ai/higgsfield-ai/dop/standard", (
        f"Wrong submit URL: {url}"
    )


@pytest.mark.asyncio
async def test_auth_header_uses_key_scheme() -> None:
    """Authorization header must be 'Key <token>', not 'Bearer <token>'."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="ocean waves")},
            _API_KEYS,
        )

    headers = mock_client.post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Key hf-test-key", (
        f"Wrong auth: {headers['Authorization']}. Must be 'Key <token>' not 'Bearer <token>'"
    )


# ---------------------------------------------------------------------------
# Request body
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_body_shape() -> None:
    """Body must include prompt and duration; no spurious 'model' field in body."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_higgsfield(
            _make_node({"model": "higgsfield-ai/dop/standard", "duration": 7, "aspect_ratio": "16:9"}),
            {"prompt": PortValueDict(type="Text", value="a forest in fog")},
            _API_KEYS,
        )

    body = mock_client.post.call_args.kwargs["json"]
    assert body["prompt"] == "a forest in fog"
    assert body["duration"] == 7
    assert body["aspect_ratio"] == "16:9"
    # Model is encoded in the URL path, not the body
    assert "model" not in body


@pytest.mark.asyncio
async def test_default_model_path_used_when_no_model_param() -> None:
    """When no model param set, handler must use the default model path."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="city at night")},
            _API_KEYS,
        )

    url = mock_client.post.call_args.args[0]
    assert _DEFAULT_MODEL in url
    assert url == f"{HIGGSFIELD_BASE}/{_DEFAULT_MODEL}"


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_poll_endpoint_uses_requests_status_path() -> None:
    """Poll must hit /requests/{request_id}/status, not /v1/video/{id}."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="a timelapse")},
            _API_KEYS,
        )

    # First GET call is the poll (second is the video download)
    poll_url = mock_client.get.call_args_list[0].args[0]
    assert poll_url == "https://platform.higgsfield.ai/requests/req-abc123/status", (
        f"Wrong poll URL: {poll_url}"
    )


@pytest.mark.asyncio
async def test_reads_request_id_field_not_id_or_job_id() -> None:
    """Handler must read 'request_id' from submit response, not 'id' or 'job_id'."""
    # Submit response has no 'id' or 'job_id' — only 'request_id'
    submit_resp_data = {"request_id": "req-specific-id", "status": "queued"}
    mock_client = _mock_client(submit_resp_data, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="waves")},
            _API_KEYS,
        )

    poll_url = mock_client.get.call_args_list[0].args[0]
    assert "req-specific-id" in poll_url


@pytest.mark.asyncio
async def test_reads_video_url_from_nested_video_object() -> None:
    """Video URL must be read from poll_data['video']['url'], not top-level 'url'."""
    # Poll response has nested video object — no top-level 'url' or 'video_url'
    poll_data = {"status": "completed", "video": {"url": "https://cdn.higgsfield.ai/result.mp4"}}
    mock_client = _mock_client(_SUBMIT_OK, poll_data)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        result = await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="fog")},
            _API_KEYS,
        )

    assert result["video"]["type"] == "Video"
    assert result["video"]["value"].endswith(".mp4")


# ---------------------------------------------------------------------------
# Status values
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_nsfw_status_raises_content_policy_error() -> None:
    """'nsfw' status must raise RuntimeError mentioning content policy."""
    poll_data = {"status": "nsfw"}
    mock_client = _mock_client(_SUBMIT_OK, poll_data)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="content policy"):
            await handle_higgsfield(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


@pytest.mark.asyncio
async def test_failed_status_raises() -> None:
    poll_data = {"status": "failed", "error": "something broke"}
    mock_client = _mock_client(_SUBMIT_OK, poll_data)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="Higgsfield failed"):
            await handle_higgsfield(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_api_key_raises() -> None:
    with pytest.raises(ValueError, match="HIGGSFIELD_API_KEY"):
        await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            {},
        )


@pytest.mark.asyncio
async def test_missing_prompt_raises() -> None:
    with pytest.raises(ValueError, match="Prompt"):
        await handle_higgsfield(
            _make_node(),
            {},
            _API_KEYS,
        )


@pytest.mark.asyncio
async def test_missing_request_id_in_response_raises() -> None:
    """If submit response has no 'request_id', handler must raise RuntimeError."""
    # Old-style response with 'id' only — handler must not accept this
    bad_submit = {"id": "old-style-id", "status": "queued"}
    mock_client = _mock_client(bad_submit, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock):

        with pytest.raises(RuntimeError, match="unexpected response"):
            await handle_higgsfield(
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="test")},
                _API_KEYS,
            )


# ---------------------------------------------------------------------------
# Output contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_output_port_id_is_video() -> None:
    """Handler must return {'video': ...}, not {'output': ...} or similar."""
    mock_client = _mock_client(_SUBMIT_OK, _POLL_COMPLETED)

    with patch("handlers.higgsfield.httpx.AsyncClient", return_value=mock_client), \
         patch("handlers.higgsfield.asyncio.sleep", new_callable=AsyncMock), \
         patch("handlers.higgsfield.get_run_dir", return_value=__import__("pathlib").Path("/tmp")):

        result = await handle_higgsfield(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="test")},
            _API_KEYS,
        )

    assert "video" in result
    assert result["video"]["type"] == "Video"
