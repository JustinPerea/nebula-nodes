"""Prompt enhancement — a single, cheap LLM round-trip that rewrites a Create
prompt to be more vivid and specific while preserving intent.

Standalone (not graph-execution-shaped): picks whichever supported provider key
is configured and makes one chat call. The provider-selection, request-building,
and response-parsing are pure functions so they're unit-testable without network.
"""

from __future__ import annotations

from typing import Any

import httpx

SYSTEM_PROMPT = (
    "You are a prompt enhancer for an AI image and video generation studio. "
    "Rewrite the user's prompt to be more vivid, specific, and visually descriptive "
    "while preserving their original intent and subject. Keep it concise (one paragraph). "
    "Return ONLY the enhanced prompt text — no preamble, no quotes, no explanation."
)

# (provider, api-key name, model). Order = selection priority. Models are the
# cheap/fast tier of each provider, taken from the verified node registry defaults.
_PROVIDERS: list[tuple[str, str, str]] = [
    ("openai", "OPENAI_API_KEY", "gpt-5.4-mini"),
    ("anthropic", "ANTHROPIC_API_KEY", "claude-haiku-4-5-20251001"),
    ("google", "GOOGLE_API_KEY", "gemini-3.5-flash"),
]


class NoEnhanceProviderError(Exception):
    """No supported LLM API key is configured."""


class EnhanceProviderError(Exception):
    """The provider call failed or returned an unparseable response."""


def available_providers(api_keys: dict[str, str]) -> list[tuple[str, str, str]]:
    """All configured providers as (provider, key, model), in priority order."""
    out: list[tuple[str, str, str]] = []
    for provider, key_name, model in _PROVIDERS:
        key = api_keys.get(key_name)
        if key:
            out.append((provider, key, model))
    return out


def select_enhance_provider(api_keys: dict[str, str]) -> tuple[str, str, str] | None:
    """Return (provider, key, model) for the first configured provider, or None."""
    providers = available_providers(api_keys)
    return providers[0] if providers else None


def build_enhance_request(
    provider: str, key: str, model: str, prompt: str
) -> tuple[str, dict[str, str], dict[str, Any]]:
    """Build (url, headers, json_body) for a one-shot enhance call. Pure."""
    if provider == "openai":
        return (
            "https://api.openai.com/v1/chat/completions",
            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
            },
        )
    if provider == "anthropic":
        return (
            "https://api.anthropic.com/v1/messages",
            {
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            {
                "model": model,
                "max_tokens": 1024,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    if provider == "google":
        return (
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            {"x-goog-api-key": key, "Content-Type": "application/json"},
            {
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            },
        )
    raise EnhanceProviderError(f"Unknown provider: {provider}")


def extract_enhanced(provider: str, data: dict[str, Any]) -> str:
    """Pull the enhanced text out of a provider response. Pure. Raises on shape."""
    try:
        if provider == "openai":
            text = data["choices"][0]["message"]["content"]
        elif provider == "anthropic":
            # content is a list of blocks; concatenate the text blocks.
            blocks = data["content"]
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        elif provider == "google":
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
        else:
            raise EnhanceProviderError(f"Unknown provider: {provider}")
    except (KeyError, IndexError, TypeError) as exc:
        raise EnhanceProviderError(f"Unexpected {provider} response shape") from exc
    text = (text or "").strip()
    if not text:
        raise EnhanceProviderError(f"{provider} returned an empty enhancement")
    return text


async def _call_provider(
    client: httpx.AsyncClient, provider: str, key: str, model: str, prompt: str
) -> str:
    """One provider call. Raises EnhanceProviderError on any failure."""
    url, headers, body = build_enhance_request(provider, key, model, prompt)
    try:
        resp = await client.post(url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise EnhanceProviderError(f"Could not reach {provider}") from exc
    if resp.status_code >= 400:
        raise EnhanceProviderError(f"{provider} call failed ({resp.status_code})")
    return extract_enhanced(provider, resp.json())


async def enhance_prompt(
    prompt: str, api_keys: dict[str, str], *, client: httpx.AsyncClient | None = None
) -> dict[str, str]:
    """Enhance `prompt`, trying each configured provider in priority order and
    falling through to the next on failure (so a single bad/expired key doesn't
    block the feature). Returns {enhanced, provider}."""
    providers = available_providers(api_keys)
    if not providers:
        raise NoEnhanceProviderError(
            "No LLM API key configured (OpenAI, Anthropic, or Google)."
        )

    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=30.0)
    last_error: EnhanceProviderError | None = None
    try:
        for provider, key, model in providers:
            try:
                enhanced = await _call_provider(client, provider, key, model, prompt)
                return {"enhanced": enhanced, "provider": provider}
            except EnhanceProviderError as exc:
                last_error = exc  # try the next configured provider
    finally:
        if owns_client:
            await client.aclose()

    raise last_error or EnhanceProviderError("All providers failed")
