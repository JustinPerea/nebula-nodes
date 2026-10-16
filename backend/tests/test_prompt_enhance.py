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

    def test_google_uses_gemini_36_flash(self) -> None:
        # gemini-3.5-flash was deprecated 2026-10-08 and now routes to 3.6 Flash.
        assert select_enhance_provider({"GOOGLE_API_KEY": "g"}) == ("google", "g", "gemini-3.6-flash")


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
        url, headers, body = build_enhance_request("google", "k", "gemini-3.6-flash", "a cat")
        assert "gemini-3.6-flash:generateContent" in url
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


# -- POST /api/enhance-prompt: the person's Create button only ------------------

AGENT_MARKERS = [{"Authorization": "Agent x"}, {"X-Nebula-Agent": "codex"},
                 {"X-Nebula-Client": "nebula-cli"}]


@pytest.fixture
def enhance_api(monkeypatch, person):
    from fastapi.testclient import TestClient

    import main

    calls: list[tuple[str, dict]] = []

    async def stub(prompt, api_keys):
        calls.append((prompt, api_keys))
        return {"enhanced": f"vivid {prompt}", "provider": "openai"}

    monkeypatch.setattr(main, "enhance_prompt", stub)
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": {"OPENAI_API_KEY": "synthetic-key"}})
    monkeypatch.setattr(main, "_enhance_calls", main.deque())
    return TestClient(main.app), calls, person, main


def _enhance(client, headers=None, prompt="a cat"):
    return client.post("/api/enhance-prompt", json={"prompt": prompt}, headers=headers or {})


@pytest.mark.parametrize("headers", [{}, {"Origin": "http://localhost:5173"}, {"Origin": "file://"},
                                     {"X-Nebula-Person": "x" * 43}])
def test_route_refuses_anyone_without_the_person_token(enhance_api, headers):
    client, calls, _person, _main = enhance_api
    response = _enhance(client, headers)
    assert response.status_code == 403
    assert response.json()["code"] == "person_required"
    assert "Rewrite the prompt yourself" in response.json()["detail"]
    assert calls == []


@pytest.mark.parametrize("marker", AGENT_MARKERS)
def test_route_refuses_agent_markers_even_with_the_person_token(enhance_api, marker):
    client, calls, person, _main = enhance_api
    response = _enhance(client, {**person.headers, **marker})
    assert response.status_code in (401, 403)  # a bad agent token is turned away before the route
    assert calls == []


@pytest.mark.parametrize("origin", ["https://evil.example", "null"])
def test_route_refuses_foreign_or_null_origin(enhance_api, origin):
    client, calls, person, _main = enhance_api
    # LocalRequestGuard refuses these first; the stub is never reached either way.
    assert _enhance(client, {**person.headers, "Origin": origin}).status_code == 403
    assert calls == []


def test_route_refusal_happens_before_reading_keys(enhance_api, monkeypatch):
    client, calls, _person, main = enhance_api
    monkeypatch.setattr(main, "load_settings", lambda: pytest.fail("keys must not be read for a refused caller"))
    response = _enhance(client, {})
    assert response.status_code == 403 and "No LLM API key" not in response.text
    assert calls == []


def test_route_allows_the_person(enhance_api):
    client, calls, person, _main = enhance_api
    response = _enhance(client, person.headers)
    assert response.status_code == 200
    assert response.json() == {"enhanced": "vivid a cat", "provider": "openai"}
    assert calls == [("a cat", {"OPENAI_API_KEY": "synthetic-key"})]


@pytest.mark.parametrize("origin", [None, "file://"])
def test_route_allows_the_desktop_renderer_by_token(enhance_api, monkeypatch, origin):
    client, calls, person, _main = enhance_api
    monkeypatch.setenv("NEBULA_DESKTOP_MODE", "1")
    headers = {"X-Nebula-Person": person.token}
    if origin:
        headers["Origin"] = origin
    assert _enhance(client, headers).status_code == 200
    assert _enhance(client, {**headers, "X-Nebula-Person": "wrong"}).status_code == 403
    assert len(calls) == 1


def test_route_rejects_an_oversized_prompt_readably(enhance_api):
    client, calls, person, main = enhance_api
    response = _enhance(client, person.headers, prompt="x" * (main.ENHANCE_PROMPT_MAX_CHARS + 1))
    assert response.status_code == 413
    assert isinstance(response.json()["detail"], str) and "too long" in response.json()["detail"]
    assert calls == []
    # The cap applies after the gate: a refused caller learns nothing more.
    assert _enhance(client, {}, prompt="x" * 10_000).status_code == 403
    assert _enhance(client, person.headers, prompt="x" * main.ENHANCE_PROMPT_MAX_CHARS).status_code == 200


def test_route_is_rate_limited_and_logs_each_call(enhance_api, caplog):
    client, calls, person, main = enhance_api
    with caplog.at_level("INFO", logger="nebula.enhance_prompt"):
        for _ in range(main.ENHANCE_RATE_LIMIT):
            assert _enhance(client, person.headers).status_code == 200
        limited = _enhance(client, person.headers)
    assert limited.status_code == 429 and "Wait a moment" in limited.json()["detail"]
    assert len(calls) == main.ENHANCE_RATE_LIMIT
    logged = [r.getMessage() for r in caplog.records if r.name == "nebula.enhance_prompt"]
    assert sum("outcome=ok" in line for line in logged) == main.ENHANCE_RATE_LIMIT
    assert any("refused" in line for line in logged)
    assert all("a cat" not in line for line in logged)  # length, not the prompt
