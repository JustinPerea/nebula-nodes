"""A TLS error mid-response counts as a failed connection (services/http_errors.py).

anyio re-raises such an error as a raw ssl.SSLError, outside httpx's exception
tree. Only the transport is mocked: no provider is contacted.
"""
from __future__ import annotations

import ssl
from pathlib import Path

import httpx
import pytest
from PIL import Image

from services import http_errors
from services.vision_llm import VisionProviderError, call_vision_llm

BAD_RECORD_MAC = "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] ssl/tls alert bad record mac (_ssl.c:2559)"


@pytest.mark.parametrize("exc", [
    ssl.SSLError(1, BAD_RECORD_MAC),
    httpx.ConnectError("refused"),
    httpx.ReadError("reset"),
    httpx.ReadTimeout("slow"),
])
def test_transport_failures_include_a_raw_tls_error(exc):
    assert http_errors.is_transport_error(exc)
    assert isinstance(exc, http_errors.TRANSPORT_ERRORS) and isinstance(exc, http_errors.HTTP_ERRORS)


def test_other_errors_are_not_transport_failures():
    request = httpx.Request("GET", "https://example.test")
    status = httpx.HTTPStatusError("503", request=request, response=httpx.Response(503, request=request))
    assert not http_errors.is_transport_error(status)
    assert isinstance(status, http_errors.HTTP_ERRORS)
    assert not http_errors.is_transport_error(ValueError("bad json"))


def test_a_tls_error_is_described_as_a_connection_failure():
    text = http_errors.describe(ssl.SSLError(1, BAD_RECORD_MAC))
    assert text.startswith("connection failed") and "_ssl.c" not in text
    assert http_errors.describe(httpx.ConnectError("refused")) == "refused"


@pytest.mark.asyncio
async def test_vision_reports_a_tls_error_as_its_own_readable_error(tmp_path: Path):
    frame = tmp_path / "frame.png"
    Image.new("RGB", (8, 8), "red").save(frame)

    def handler(request: httpx.Request) -> httpx.Response:
        raise ssl.SSLError(1, BAD_RECORD_MAC)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(VisionProviderError) as caught:
            await call_vision_llm({"ANTHROPIC_API_KEY": "test-key"}, system_prompt="s", images=[frame],
                                  user_prompt="u", client=client)
    message = str(caught.value)
    assert message.startswith("anthropic vision request failed: connection failed")
    assert "_ssl.c" not in message
