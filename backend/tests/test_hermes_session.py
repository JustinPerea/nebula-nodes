"""Tests for run_hermes — mirrors the run_claude event contract."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.hermes_session import run_hermes


async def _collect(agen):
    return [event async for event in agen]


@pytest.mark.asyncio
async def test_happy_path_yields_text_and_done():
    """Minimal successful turn: Hermes prints a response, wrapper emits text + done."""
    fake_stdout = b"HELLO\n"
    fake_stderr = b""

    proc = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=fake_stdout)
    proc.stderr.read = AsyncMock(return_value=fake_stderr)
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    with patch("services.hermes_session.asyncio.create_subprocess_exec",
               return_value=proc):
        events = await _collect(run_hermes("hi", None, autonomy="auto"))

    types = [e["type"] for e in events]
    assert "text" in types
    assert events[-1]["type"] == "done"
    text_event = next(e for e in events if e["type"] == "text")
    assert "HELLO" in text_event["text"]
