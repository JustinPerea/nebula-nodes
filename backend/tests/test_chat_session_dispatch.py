"""Tests that AGENT_RUNNERS dispatches to the right runner per agent name."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.chat_session import AGENT_RUNNERS, run_claude
from services.hermes_session import run_hermes


def test_dispatch_registers_both_agents():
    assert "claude" in AGENT_RUNNERS
    assert "hephaestus" in AGENT_RUNNERS
    assert AGENT_RUNNERS["claude"] is run_claude
    assert AGENT_RUNNERS["hephaestus"] is run_hermes
