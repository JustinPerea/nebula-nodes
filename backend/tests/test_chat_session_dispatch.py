"""Tests that AGENT_RUNNERS dispatches to the right runner per agent name."""
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.chat_session import AGENT_RUNNERS, claude_login_status, run_claude
from services.codex_session import run_codex
from services.hermes_session import run_hermes


def test_dispatch_registers_chat_agents():
    assert "claude" in AGENT_RUNNERS
    assert "codex" in AGENT_RUNNERS
    assert "daedalus" in AGENT_RUNNERS
    assert AGENT_RUNNERS["claude"] is run_claude
    assert AGENT_RUNNERS["codex"] is run_codex
    assert AGENT_RUNNERS["daedalus"] is run_hermes


@pytest.mark.asyncio
async def test_claude_login_status_parses_json_status():
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(
        b'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"user@example.com"}',
        b"",
    ))
    proc.returncode = 0

    with patch("services.chat_session.asyncio.create_subprocess_exec", return_value=proc):
        status = await claude_login_status()

    assert status["installed"] is True
    assert status["loggedIn"] is True
    assert status["authMethod"] == "claude.ai"
    assert status["subscriptionType"] == "max"
    assert status["email"] == "user@example.com"
