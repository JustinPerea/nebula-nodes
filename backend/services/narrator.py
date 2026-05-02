"""Daedalus narrator — synthesizes chat-bubble prose when Kimi K2.6 emits
empty `content` alongside `tool_calls` (a known model behavior).

Reads SOUL.md as the persona/voice contract, makes a single Kimi K2.6 call
via OpenRouter with the buffered canvas actions, and streams text deltas.

This exists because Kimi K2.6 routes its narrative prose to `reasoning_content`
instead of `content`; three rule-prompt variants in SKILL.md/SOUL.md failed
to shift the channel. The fix is a render-layer translator: same model,
focused single-shot call, no tool-calling pressure.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import AsyncIterator

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
NARRATOR_MODEL = "moonshotai/kimi-k2.6"
SOUL_PATH = Path.home() / ".hermes" / "profiles" / "daedalus" / "SOUL.md"
HERMES_AUTH_PATH = Path.home() / ".hermes" / "auth.json"


def _resolve_openrouter_key() -> str | None:
    """Find an OpenRouter API key: env var first, then Hermes auth.json
    `credential_pool.openrouter[*].access_token` as a fallback.

    The fallback exists so users who configured the key via Hermes don't need
    to also export it into the uvicorn shell. Hermes caches the key in
    auth.json on first run.
    """
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    try:
        data = json.loads(HERMES_AUTH_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    pool = data.get("credential_pool", {}).get("openrouter", [])
    for entry in pool:
        token = entry.get("access_token")
        if token:
            return token
    return None

# Keep the prompt scaffolding outside SOUL.md so editing the persona doesn't
# require updating narrator instructions.
_NARRATION_DIRECTIVE = (
    "\n\nYou just performed these canvas actions in a Nebula Nodes session. "
    "Narrate them in your voice — 2-4 sentences, past tense, like you're "
    "telling the user what you just built. Speak in `content`. Do not call "
    "any tools."
)


async def narrate_actions(actions: list[str]) -> AsyncIterator[str]:
    """Yield text deltas of Daedalus' narration of the given actions.

    Fail-silent: if `OPENROUTER_API_KEY` is missing, SOUL.md is unreadable,
    or the HTTP call errors, this yields nothing. The caller (hermes_session)
    treats absence as 'leave the chat bubble empty' — same as pre-fix.
    """
    print(f"[narrator] called with {len(actions)} actions", flush=True)
    api_key = _resolve_openrouter_key()
    if not api_key:
        print(
            "[narrator] no OpenRouter key (env OPENROUTER_API_KEY or "
            "~/.hermes/auth.json credential_pool.openrouter); skipping narration",
            flush=True,
        )
        return

    try:
        soul_md = SOUL_PATH.read_text(encoding="utf-8")
    except Exception as e:
        print(f"[narrator] could not read SOUL.md: {e}; skipping narration", flush=True)
        return

    system_prompt = soul_md + _NARRATION_DIRECTIVE
    user_message = "\n".join(f"{i + 1}. {a}" for i, a in enumerate(actions))

    payload = {
        "model": NARRATOR_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "stream": True,
        "max_tokens": 300,
        "temperature": 0.7,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    print(f"[narrator] POST {OPENROUTER_URL} model={NARRATOR_MODEL}", flush=True)
    delta_count = 0
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream(
                "POST", OPENROUTER_URL, json=payload, headers=headers
            ) as response:
                print(f"[narrator] HTTP {response.status_code}", flush=True)
                if response.status_code != 200:
                    body = await response.aread()
                    snippet = body[:500].decode("utf-8", errors="replace")
                    print(
                        f"[narrator] OpenRouter returned {response.status_code}: {snippet}",
                        flush=True,
                    )
                    return

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {}).get("content")
                    if delta:
                        delta_count += 1
                        yield delta
    except Exception as e:
        print(f"[narrator] streaming error: {e}", flush=True)
        return
    finally:
        print(f"[narrator] yielded {delta_count} deltas", flush=True)
