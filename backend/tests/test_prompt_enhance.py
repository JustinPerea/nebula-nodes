from __future__ import annotations

import asyncio

import pytest

from services.prompt_enhance import (
    select_enhance_provider,
    available_providers,
    build_enhance_request,
    extract_enhanced,
    enhance_prompt,
    SYSTEM_PROMPT,
    EnhanceProviderError,
    NoEnhanceProviderError,
)


class _FakeResp:
    def __init__(self, status: int, data: dict) -> None:
        self.status_code = status
        self._data = data

    def json(self) -> dict:
        return self._data


class _FakeClient:
    """Routes post() by URL substring to a canned (status, data) response."""

    def __init__(self, behavior: dict[str, tuple[int, dict]]) -> None:
        self._behavior = behavior

    async def post(self, url: str, headers=None, json=None) -> _FakeResp:  # noqa: A002
        for substr, (status, data) in self._behavior.items():
            if substr in url:
                return _FakeResp(status, data)
        return _FakeResp(404, {})

    async def aclose(self) -> None:
        pass


class TestSelectProvider:
    def test_none_when_no_keys(self) -> None:
        assert select_enhance_provider({}) is None
        assert select_enhance_provider({"FAL_KEY": "x"}) is None

    def test_openai_first(self) -> None:
        sel = select_enhance_provider(
            {"OPENAI_API_KEY": "o", "ANTHROPIC_API_KEY": "a", "GOOGLE_API_KEY": "g"}
        )
        assert sel == ("openai", "o", "gpt-5.4-mini")

    def test_falls_through_to_anthropic_then_google(self) -> None:
        assert select_enhance_provider({"ANTHROPIC_API_KEY": "a", "GOOGLE_API_KEY": "g"})[0] == "anthropic"
        assert select_enhance_provider({"GOOGLE_API_KEY": "g"})[0] == "google"


class TestBuildRequest:
    def test_openai_shape(self) -> None:
        url, headers, body = build_enhance_request("openai", "k", "gpt-5.4-mini", "a cat")
        assert url.endswith("/v1/chat/completions")
        assert headers["Authorization"] == "Bearer k"
        assert body["model"] == "gpt-5.4-mini"
        assert body["messages"][0]["role"] == "system"
        assert body["messages"][0]["content"] == SYSTEM_PROMPT
        assert body["messages"][1]["content"] == "a cat"

    def test_anthropic_shape(self) -> None:
        url, headers, body = build_enhance_request("anthropic", "k", "claude-haiku-4-5-20251001", "a cat")
        assert url.endswith("/v1/messages")
        assert headers["x-api-key"] == "k"
        assert headers["anthropic-version"]
        assert body["system"] == SYSTEM_PROMPT
        assert body["messages"][0]["content"] == "a cat"
        assert body["max_tokens"] > 0

    def test_google_shape(self) -> None:
        url, headers, body = build_enhance_request("google", "k", "gemini-3.5-flash", "a cat")
        assert "gemini-3.5-flash:generateContent" in url
        assert headers["x-goog-api-key"] == "k"
        assert body["systemInstruction"]["parts"][0]["text"] == SYSTEM_PROMPT
        assert body["contents"][0]["parts"][0]["text"] == "a cat"

    def test_unknown_provider_raises(self) -> None:
        with pytest.raises(EnhanceProviderError):
            build_enhance_request("bogus", "k", "m", "p")


class TestExtract:
    def test_openai(self) -> None:
        data = {"choices": [{"message": {"content": "  enhanced cat  "}}]}
        assert extract_enhanced("openai", data) == "enhanced cat"

    def test_anthropic_concats_text_blocks(self) -> None:
        data = {"content": [{"type": "text", "text": "enhanced "}, {"type": "text", "text": "cat"}]}
        assert extract_enhanced("anthropic", data) == "enhanced cat"

    def test_google(self) -> None:
        data = {"candidates": [{"content": {"parts": [{"text": "enhanced cat"}]}}]}
        assert extract_enhanced("google", data) == "enhanced cat"

    def test_bad_shape_raises(self) -> None:
        with pytest.raises(EnhanceProviderError):
            extract_enhanced("openai", {"nope": 1})

    def test_empty_raises(self) -> None:
        with pytest.raises(EnhanceProviderError):
            extract_enhanced("openai", {"choices": [{"message": {"content": "   "}}]})


class TestAvailableProviders:
    def test_ordered_subset(self) -> None:
        provs = available_providers({"ANTHROPIC_API_KEY": "a", "GOOGLE_API_KEY": "g"})
        assert [p[0] for p in provs] == ["anthropic", "google"]

    def test_empty(self) -> None:
        assert available_providers({}) == []


class TestEnhancePromptFallthrough:
    def test_falls_through_to_next_provider_on_failure(self) -> None:
        # OpenAI key is bad (401) → must fall through to Anthropic (200).
        api_keys = {"OPENAI_API_KEY": "bad", "ANTHROPIC_API_KEY": "good"}
        client = _FakeClient(
            {
                "api.openai.com": (401, {}),
                "api.anthropic.com": (200, {"content": [{"type": "text", "text": "enhanced cat"}]}),
            }
        )
        result = asyncio.run(enhance_prompt("a cat", api_keys, client=client))
        assert result == {"enhanced": "enhanced cat", "provider": "anthropic"}

    def test_raises_when_all_providers_fail(self) -> None:
        api_keys = {"OPENAI_API_KEY": "bad", "ANTHROPIC_API_KEY": "bad"}
        client = _FakeClient({"api.openai.com": (401, {}), "api.anthropic.com": (500, {})})
        with pytest.raises(EnhanceProviderError):
            asyncio.run(enhance_prompt("a cat", api_keys, client=client))

    def test_no_keys_raises(self) -> None:
        with pytest.raises(NoEnhanceProviderError):
            asyncio.run(enhance_prompt("a cat", {}, client=_FakeClient({})))
