"""QuiverAI Arrow API client.

Wraps the four endpoints surfaced by https://api.quiver.ai:

- POST /v1/svgs/generations    (text + optional image refs -> SVG)
- POST /v1/svgs/vectorizations (raster -> SVG, faithful trace)
- GET  /v1/models              (list models with capabilities + pricing)
- GET  /v1/models/{id}         (model detail, exposed via get_model)

Both POST endpoints support SSE streaming with four event types:
generating, reasoning, draft, content. The terminator is `data: [DONE]`.

Rate limit: 20 requests / 60s, shared across both POST endpoints.
The client retries 429 once honoring `Retry-After`, then bubbles
QuiverRateLimitError. Other errors map to typed exceptions so handlers
can surface clear user-facing messages instead of generic 500s.

API surface verified against canonical docs.quiver.ai on 2026-05-19.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, AsyncIterator, Literal

import httpx


DEFAULT_BASE_URL = "https://api.quiver.ai"
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 1  # one retry on 429, then bubble


QuiverEventType = Literal["generating", "reasoning", "draft", "content"]


# ---------- Exceptions ----------


class QuiverError(Exception):
    """Base for any Quiver-specific failure. Carries HTTP status + body when present."""

    def __init__(self, message: str, status_code: int | None = None, body: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class QuiverAuthError(QuiverError):
    """401 (invalid/missing API key) or 403 (account frozen)."""


class QuiverInsufficientCreditsError(QuiverError):
    """402 — caller is out of Quiver credits. User-actionable: top up or upgrade plan."""


class QuiverRateLimitError(QuiverError):
    """429 after retry budget exhausted. Caller should back off and retry later."""


class QuiverServerError(QuiverError):
    """5xx — Quiver-side or upstream transient failure."""


# ---------- Data shapes ----------


@dataclass
class RateLimitInfo:
    """Parsed X-RateLimit-* headers. Any field may be None if the header was absent."""

    limit: int | None
    remaining: int | None
    reset_ms: int | None


@dataclass
class QuiverEvent:
    """One SSE event from a /v1/svgs/{generations,vectorizations} stream."""

    type: QuiverEventType
    id: str | None
    svg: str | None
    credits: int | None
    index: int | None
    text: str | None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class QuiverSvg:
    mime_type: str
    svg: str


@dataclass
class QuiverResponse:
    """Decoded /v1/svgs/* response when stream=False."""

    id: str
    created: int
    credits: int
    data: list[QuiverSvg]
    usage: dict[str, int]
    rate_limit: RateLimitInfo | None = None


@dataclass
class QuiverModel:
    """One entry from GET /v1/models."""

    id: str
    name: str | None
    description: str | None
    owned_by: str | None
    context_length: int | None
    max_output_length: int | None
    input_modalities: list[str]
    output_modalities: list[str]
    supported_operations: list[str]
    supported_sampling_parameters: list[str]
    pricing_credits: dict[str, int]


# ---------- Helpers ----------


def _parse_retry_after(value: str | None, *, fallback: float = 1.0) -> float:
    """Honor RFC 9110 Retry-After: integer seconds OR HTTP-date. Fallback on parse failure."""
    if value is None:
        return fallback
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return fallback
    if when is None:
        return fallback
    import datetime as _dt
    now = _dt.datetime.now(when.tzinfo) if when.tzinfo else _dt.datetime.now()
    delta = (when - now).total_seconds()
    return max(0.0, delta)


def _rate_limit_from_headers(headers: httpx.Headers) -> RateLimitInfo:
    def _parse(key: str) -> int | None:
        v = headers.get(key)
        if v is None:
            return None
        try:
            return int(v)
        except ValueError:
            return None
    return RateLimitInfo(
        limit=_parse("X-RateLimit-Limit"),
        remaining=_parse("X-RateLimit-Remaining"),
        reset_ms=_parse("X-RateLimit-Reset"),
    )


def _raise_for_status(status_code: int, body_preview: str = "") -> None:
    if 200 <= status_code < 300:
        return
    if status_code in (401, 403):
        raise QuiverAuthError(f"Quiver auth failed ({status_code})", status_code=status_code, body=body_preview)
    if status_code == 402:
        raise QuiverInsufficientCreditsError("Insufficient Quiver credits", status_code=status_code, body=body_preview)
    if status_code == 429:
        raise QuiverRateLimitError("Quiver rate limit exceeded", status_code=status_code, body=body_preview)
    if 500 <= status_code < 600:
        raise QuiverServerError(f"Quiver server error ({status_code})", status_code=status_code, body=body_preview)
    raise QuiverError(f"Quiver request failed ({status_code})", status_code=status_code, body=body_preview)


def event_from_payload(payload: dict[str, Any]) -> QuiverEvent:
    """Map one SSE `data:` JSON payload to a QuiverEvent. Exposed for tests."""
    ev_type = payload.get("type")
    if ev_type not in ("generating", "reasoning", "draft", "content"):
        raise ValueError(f"Unknown Quiver event type: {ev_type!r}")
    return QuiverEvent(
        type=ev_type,
        id=payload.get("id"),
        svg=payload.get("svg"),
        credits=payload.get("credits"),
        index=payload.get("index"),
        text=payload.get("text"),
        raw=payload,
    )


def response_from_payload(payload: dict[str, Any], *, rate_limit: RateLimitInfo | None = None) -> QuiverResponse:
    """Map non-stream JSON to QuiverResponse. Exposed for tests."""
    data_items: list[QuiverSvg] = []
    for item in payload.get("data", []) or []:
        if not isinstance(item, dict):
            continue
        svg = item.get("svg")
        if not isinstance(svg, str):
            continue
        data_items.append(QuiverSvg(mime_type=str(item.get("mime_type", "image/svg+xml")), svg=svg))
    return QuiverResponse(
        id=str(payload.get("id", "")),
        created=int(payload.get("created", 0) or 0),
        credits=int(payload.get("credits", 0) or 0),
        data=data_items,
        usage=payload.get("usage") or {},
        rate_limit=rate_limit,
    )


def model_from_payload(payload: dict[str, Any]) -> QuiverModel:
    """Map one /v1/models entry to QuiverModel. Exposed for tests."""
    return QuiverModel(
        id=str(payload.get("id", "")),
        name=payload.get("name"),
        description=payload.get("description"),
        owned_by=payload.get("owned_by"),
        context_length=payload.get("context_length"),
        max_output_length=payload.get("max_output_length"),
        input_modalities=list(payload.get("input_modalities") or []),
        output_modalities=list(payload.get("output_modalities") or []),
        supported_operations=list(payload.get("supported_operations") or []),
        supported_sampling_parameters=list(payload.get("supported_sampling_parameters") or []),
        pricing_credits=dict(payload.get("pricing_credits") or {}),
    )


async def parse_sse_lines(lines: AsyncIterator[str]) -> AsyncIterator[QuiverEvent]:
    """Decode an SSE stream into QuiverEvent objects.

    Exposed at module scope so tests can feed a hand-crafted line iterator
    without spinning up a real HTTP response.
    """
    async for raw in lines:
        line = raw.rstrip("\r")
        if not line.startswith("data:"):
            # `event:` lines are informational only — the `type` field inside the
            # JSON payload is authoritative.
            continue
        data_str = line[len("data:"):].lstrip()
        if data_str == "[DONE]":
            return
        try:
            payload = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        try:
            yield event_from_payload(payload)
        except ValueError:
            # Unknown event type — skip rather than crash the whole stream.
            continue


# ---------- Client ----------


class QuiverClient:
    """Async client for the four QuiverAI endpoints.

    Lifecycle: a fresh httpx.AsyncClient is created per call, so the
    client itself is cheap to construct and safe to share across requests.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        if not api_key:
            raise QuiverAuthError("QUIVER_API_KEY is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max(0, max_retries)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    # ----- body builders (pure functions; useful for tests) -----

    @staticmethod
    def build_generate_body(
        *,
        model: str,
        prompt: str,
        references: list[str | dict[str, str]] | None = None,
        n: int | None = None,
        instructions: str | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        presence_penalty: float | None = None,
        max_output_tokens: int | None = None,
        stream: bool = True,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"model": model, "prompt": prompt, "stream": stream}
        if references:
            body["references"] = list(references)
        if n is not None:
            body["n"] = n
        if instructions:
            body["instructions"] = instructions
        if temperature is not None:
            body["temperature"] = temperature
        if top_p is not None:
            body["top_p"] = top_p
        if presence_penalty is not None:
            body["presence_penalty"] = presence_penalty
        if max_output_tokens is not None:
            body["max_output_tokens"] = max_output_tokens
        return body

    @staticmethod
    def build_vectorize_body(
        *,
        model: str,
        image_url: str | None = None,
        image_base64: str | None = None,
        auto_crop: bool | None = None,
        target_size: int | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        presence_penalty: float | None = None,
        max_output_tokens: int | None = None,
        stream: bool = True,
    ) -> dict[str, Any]:
        if (image_url is None) == (image_base64 is None):
            raise ValueError("Exactly one of image_url or image_base64 must be provided")
        image: dict[str, Any] = {"url": image_url} if image_url else {"base64": image_base64}
        body: dict[str, Any] = {"model": model, "image": image, "stream": stream}
        if auto_crop is not None:
            body["auto_crop"] = auto_crop
        if target_size is not None:
            body["target_size"] = target_size
        if temperature is not None:
            body["temperature"] = temperature
        if top_p is not None:
            body["top_p"] = top_p
        if presence_penalty is not None:
            body["presence_penalty"] = presence_penalty
        if max_output_tokens is not None:
            body["max_output_tokens"] = max_output_tokens
        return body

    # ----- transport -----

    async def _post_json(self, path: str, body: dict[str, Any]) -> tuple[dict[str, Any], RateLimitInfo]:
        """Non-streaming POST with single 429 retry honoring Retry-After."""
        url = f"{self._base_url}{path}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for attempt in range(self._max_retries + 1):
                response = await client.post(url, headers=self._headers(), json=body)
                rate = _rate_limit_from_headers(response.headers)
                if response.status_code == 429 and attempt < self._max_retries:
                    delay = _parse_retry_after(response.headers.get("Retry-After"))
                    await asyncio.sleep(delay)
                    continue
                _raise_for_status(response.status_code, body_preview=response.text[:500])
                return response.json(), rate
        # Unreachable: _raise_for_status raises on the final 429 attempt.
        raise QuiverRateLimitError("Quiver rate limit exceeded")

    async def _post_stream(self, path: str, body: dict[str, Any]) -> AsyncIterator[QuiverEvent]:
        """Streaming POST with single 429 retry honoring Retry-After.

        Returns an async iterator of QuiverEvent. Errors surface as typed
        exceptions raised from the iterator on first awaited iteration.
        """
        url = f"{self._base_url}{path}"
        async with httpx.AsyncClient(timeout=httpx.Timeout(self._timeout, read=None)) as client:
            for attempt in range(self._max_retries + 1):
                async with client.stream("POST", url, headers=self._headers(), json=body) as response:
                    if response.status_code == 429 and attempt < self._max_retries:
                        retry_after = response.headers.get("Retry-After")
                        await response.aread()
                        await asyncio.sleep(_parse_retry_after(retry_after))
                        continue
                    if response.status_code != 200:
                        body_text = (await response.aread()).decode("utf-8", errors="replace")
                        _raise_for_status(response.status_code, body_preview=body_text[:500])
                    async for event in parse_sse_lines(response.aiter_lines()):
                        yield event
                    return
            raise QuiverRateLimitError("Quiver rate limit exceeded")

    # ----- public API -----

    async def generate(
        self,
        *,
        model: str,
        prompt: str,
        references: list[str | dict[str, str]] | None = None,
        n: int | None = None,
        instructions: str | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        presence_penalty: float | None = None,
        max_output_tokens: int | None = None,
    ) -> QuiverResponse:
        """Non-streaming text-to-SVG generation."""
        body = self.build_generate_body(
            model=model, prompt=prompt, references=references, n=n,
            instructions=instructions, temperature=temperature, top_p=top_p,
            presence_penalty=presence_penalty, max_output_tokens=max_output_tokens,
            stream=False,
        )
        payload, rate = await self._post_json("/v1/svgs/generations", body)
        return response_from_payload(payload, rate_limit=rate)

    def generate_stream(
        self,
        *,
        model: str,
        prompt: str,
        references: list[str | dict[str, str]] | None = None,
        n: int | None = None,
        instructions: str | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        presence_penalty: float | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[QuiverEvent]:
        """Streaming text-to-SVG generation. Yields generating/reasoning/draft/content events."""
        body = self.build_generate_body(
            model=model, prompt=prompt, references=references, n=n,
            instructions=instructions, temperature=temperature, top_p=top_p,
            presence_penalty=presence_penalty, max_output_tokens=max_output_tokens,
            stream=True,
        )
        return self._post_stream("/v1/svgs/generations", body)

    async def vectorize(
        self,
        *,
        model: str,
        image_url: str | None = None,
        image_base64: str | None = None,
        auto_crop: bool | None = None,
        target_size: int | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        presence_penalty: float | None = None,
        max_output_tokens: int | None = None,
    ) -> QuiverResponse:
        """Non-streaming raster-to-SVG vectorization."""
        body = self.build_vectorize_body(
            model=model, image_url=image_url, image_base64=image_base64,
            auto_crop=auto_crop, target_size=target_size, temperature=temperature,
            top_p=top_p, presence_penalty=presence_penalty,
            max_output_tokens=max_output_tokens, stream=False,
        )
        payload, rate = await self._post_json("/v1/svgs/vectorizations", body)
        return response_from_payload(payload, rate_limit=rate)

    def vectorize_stream(
        self,
        *,
        model: str,
        image_url: str | None = None,
        image_base64: str | None = None,
        auto_crop: bool | None = None,
        target_size: int | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        presence_penalty: float | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncIterator[QuiverEvent]:
        """Streaming raster-to-SVG vectorization."""
        body = self.build_vectorize_body(
            model=model, image_url=image_url, image_base64=image_base64,
            auto_crop=auto_crop, target_size=target_size, temperature=temperature,
            top_p=top_p, presence_penalty=presence_penalty,
            max_output_tokens=max_output_tokens, stream=True,
        )
        return self._post_stream("/v1/svgs/vectorizations", body)

    async def list_models(self) -> list[QuiverModel]:
        """GET /v1/models. Returns all models available to the authenticated org."""
        url = f"{self._base_url}/v1/models"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(url, headers=self._headers())
            _raise_for_status(response.status_code, body_preview=response.text[:500])
            payload = response.json()
            return [model_from_payload(m) for m in payload.get("data", []) if isinstance(m, dict)]

    async def get_model(self, model_id: str) -> QuiverModel:
        """GET /v1/models/{id}. 404 surfaces as QuiverError."""
        url = f"{self._base_url}/v1/models/{model_id}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(url, headers=self._headers())
            _raise_for_status(response.status_code, body_preview=response.text[:500])
            return model_from_payload(response.json())
